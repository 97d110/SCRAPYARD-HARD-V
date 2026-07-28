import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { IncomingMessage, Server as HttpServer } from 'http';
import { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { LiveEvent, LiveFrame } from '@scrapyard/shared';
import { SessionReader } from '../web/session-reader.service';
import { LIVE_PATH } from './live.constants';

/**
 * How often the server pings each socket. Two jobs: notice a browser that
 * vanished without closing (a laptop lid, a dead Wi-Fi link) so its slot is
 * released, and keep the connection off any proxy's idle-timeout list — most
 * cut an idle socket at around 60 seconds, and Render's edge is one of them.
 */
const HEARTBEAT_MS = 30_000;

/** Nothing useful arrives from a client, so cap inbound frames small. */
const MAX_PAYLOAD_BYTES = 1024;

interface Connection {
  userId: string;
  /** Cleared before each ping, set again by the browser's automatic pong. */
  alive: boolean;
}

/**
 * The live channel: one WebSocket per open tab, fanning database changes out to
 * every *other* tab so a leaderboard on a wall display stays current without
 * polling. See `LiveEvent` in @scrapyard/shared for what goes down it.
 *
 * ── Why a raw `ws` server rather than @nestjs/websockets ────────────────────
 *
 * A Nest gateway would bring in @nestjs/websockets + a platform adapter to
 * deliver one server-to-client message type with no rooms, no acknowledgements
 * and no RPC. What is actually needed is an `upgrade` listener on the HTTP
 * server Nest already created, which is what this is — and it means the session
 * check is literally the same `SessionReader` the SPA gate uses, rather than a
 * second implementation living in an adapter.
 *
 * ── Why events are emitted from controllers, not services ───────────────────
 *
 * Broadcasting sits in the controllers (see any mutating handler) for two
 * reasons. The `X-Scrapyard-Client` header that suppresses a tab's own echo
 * only exists at the HTTP boundary; and injecting this into UsersService would
 * close a DI cycle, since the gateway needs SessionReader, which needs
 * UsersService. Controllers are leaves — nothing injects them — so the graph
 * stays acyclic.
 *
 * ── The one thing this does not cover ───────────────────────────────────────
 *
 * Writes that don't go through the API — `npm run seed`, an edit in the Atlas
 * console — are invisible here, and so is a second instance's traffic if this
 * ever scales past the single Render process it's built for. Both would want a
 * Mongo change stream feeding `broadcast` instead; neither is true today.
 */
@Injectable()
export class LiveGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Live');

  /**
   * Changes on every boot, so a client can tell "my connection dropped" from
   * "the service was redeployed" and reload itself for the new bundle.
   */
  private readonly serverId = randomUUID();

  private server?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly connections = new Map<WebSocket, Connection>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly session: SessionReader,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!httpServer) {
      this.logger.warn('No HTTP server to attach to — live updates are off');
      return;
    }

    // `noServer` because the HTTP server is Nest's, not ours: we only claim the
    // upgrades whose path is ours and hand the socket over by hand.
    this.server = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: MAX_PAYLOAD_BYTES,
      // Frames here are a few hundred bytes. Negotiating compression would cost
      // more CPU — on a 0.1-CPU instance — than it saves in bytes.
      perMessageDeflate: false,
    });

    httpServer.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket as Duplex, head);
    });

    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    // Never let the heartbeat be the reason the process won't exit.
    this.heartbeat.unref();

    this.logger.log(`Live updates ready on ${LIVE_PATH} (server ${this.serverId.slice(0, 8)})`);
  }

  /**
   * Authenticate an upgrade, then promote it to a WebSocket.
   *
   * A browser cannot set headers on a WebSocket handshake, so there is no
   * Authorization header to read and no bearer token to pass — the same-origin
   * session cookie rides along automatically, and that is what is checked here.
   * Failures are answered with a real HTTP status line: the browser surfaces a
   * 401 far more legibly than a socket that opens and then closes.
   */
  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const server = this.server;
    if (!server) return this.refuse(socket, 503, 'Service Unavailable');

    /*
     * Nothing else on this process claims an upgrade, and once *any* listener is
     * attached Node stops destroying unhandled ones for us — so an unknown path
     * would hang the socket open until it timed out. Close it ourselves.
     */
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== LIVE_PATH) return this.refuse(socket, 404, 'Not Found');

    if (!this.isAllowedOrigin(request)) {
      return this.refuse(socket, 403, 'Forbidden');
    }

    // The database round trip below can outlive the socket. Without a listener
    // an error on it here would be an unhandled 'error' event, which is fatal.
    socket.on('error', () => socket.destroy());

    const userId = await this.session.authenticate(request.headers);
    if (socket.destroyed) return;
    if (!userId) return this.refuse(socket, 401, 'Unauthorized');

    server.handleUpgrade(request, socket, head, (client) => {
      this.register(client, userId);
    });
  }

  private register(client: WebSocket, userId: string): void {
    this.connections.set(client, { userId, alive: true });

    client.on('pong', () => {
      const connection = this.connections.get(client);
      if (connection) connection.alive = true;
    });

    // Nothing a client says is acted on. Reading the socket at all is only so
    // `ws` drains it; the cap on maxPayload is what keeps that cheap.
    client.on('message', () => undefined);
    client.on('error', () => client.terminate());
    client.on('close', () => this.connections.delete(client));

    this.send(client, {
      type: 'live:hello',
      at: new Date().toISOString(),
      userId,
      serverId: this.serverId,
    });

    this.logger.log(`Socket open for ${userId} (${this.connections.size} live)`);
  }

  /**
   * Drop sockets that missed a heartbeat, then ping the rest.
   *
   * A browser answers a protocol-level ping automatically, so this needs no
   * cooperation from the client — which is exactly why it detects a tab that
   * disappeared without a close frame, something an application-level
   * ping/pong of our own could not distinguish from a slow tab.
   */
  private sweep(): void {
    for (const [client, connection] of this.connections) {
      if (!connection.alive) {
        this.connections.delete(client);
        client.terminate();
        continue;
      }
      connection.alive = false;
      try {
        client.ping();
      } catch {
        this.connections.delete(client);
        client.terminate();
      }
    }
  }

  /**
   * Fan an event out to every open tab.
   *
   * Serialised once for all recipients, and `origin` is left on the frame so
   * each client can decide for itself whether it caused this — filtering here
   * would need a socket-to-request mapping that doesn't exist, since the write
   * arrives over HTTP on a different connection entirely.
   *
   * Deliberately synchronous and unawaited at every call site: a write must
   * never fail, or slow down, because a listener's socket is wedged.
   */
  broadcast(event: LiveEvent): void {
    if (this.connections.size === 0) return;

    const frame: LiveFrame = { ...event, at: new Date().toISOString() };
    const payload = JSON.stringify(frame);

    let delivered = 0;
    for (const client of this.connections.keys()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(payload);
        delivered += 1;
      } catch {
        // A socket that can't be written to is already gone; the heartbeat
        // sweep will collect it.
      }
    }

    this.logger.log(`${event.type} → ${delivered} client(s)`);
  }

  /** How many tabs are currently listening. Surfaced on /api/health. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Cross-site WebSocket hijacking guard.
   *
   * A WebSocket handshake is not subject to CORS: the browser will happily open
   * one from any page to any host. `SameSite=Lax` on the session cookie already
   * means another site's handshake arrives without it and fails the check
   * above, but that is one flag away from being untrue, so the origin is
   * checked explicitly too.
   *
   * Same-origin is the deployed shape and needs no configuration. WEB_ORIGIN —
   * already the repo's "the app is on a different origin" switch, used for CORS
   * in main.ts — covers `npm run dev`, where Vite on :5173 proxies to Nest on
   * :3000 and the origin therefore genuinely differs.
   */
  private isAllowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    // Non-browser clients (curl, the smoke suite) send no Origin at all. The
    // session cookie is the gate for those.
    if (!origin) return true;

    const host = request.headers.host;
    if (host) {
      try {
        if (new URL(origin).host === host) return true;
      } catch {
        // A malformed Origin is not one of ours.
        return false;
      }
    }

    const configured = (process.env.WEB_ORIGIN ?? '')
      .split(',')
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean);

    if (configured.includes(origin.replace(/\/$/, ''))) return true;

    this.logger.warn(
      `Refused a live socket from ${origin} (this service answers to ${host ?? 'an unknown host'}). ` +
        'If the app is genuinely served from another origin, list it in WEB_ORIGIN.',
    );
    return false;
  }

  private send(client: WebSocket, frame: LiveFrame): void {
    try {
      client.send(JSON.stringify(frame));
    } catch {
      client.terminate();
    }
  }

  /**
   * Answer a rejected upgrade with a real HTTP status line, then hang up.
   *
   * `end` rather than write-then-destroy: destroying a socket immediately after
   * writing can discard what was still buffered, and then the browser reports a
   * connection that closed for no stated reason instead of the 401 or 403 that
   * would have told you exactly what to fix.
   */
  private refuse(socket: Duplex, status: number, reason: string): void {
    if (socket.destroyed || !socket.writable) return;
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  }

  /**
   * Drop every socket on the way out.
   *
   * `beforeApplicationShutdown`, not `onApplicationShutdown`, and the
   * distinction is load-bearing: Nest closes the HTTP server *between* the two,
   * and `server.close()` waits for its connections. Tear the sockets down after
   * that and the shutdown deadlocks — the process sits there until Render's
   * grace period runs out and SIGKILLs it, turning every deploy into half a
   * minute of downtime.
   *
   * `terminate` rather than a polite `close(1001, …)` for the same reason: a
   * close frame starts a handshake and then waits for the peer to answer, and
   * an unreachable browser never will. A destroyed socket reaches the client as
   * a closed connection just the same, which is all its reconnect logic needs.
   */
  beforeApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);

    for (const client of this.connections.keys()) client.terminate();
    this.connections.clear();
    this.server?.close();
  }
}
