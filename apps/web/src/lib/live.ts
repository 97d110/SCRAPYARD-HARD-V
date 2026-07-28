import type { LiveEventType, LiveFrame } from '@scrapyard/shared';
import { CLIENT_ID } from './client-id';

/**
 * The live channel, browser side: one WebSocket to `/api/live`, reconnecting,
 * handing every frame to whoever subscribed.
 *
 * Transport only — it holds no application state and knows nothing about
 * leaderboards. What to do with a frame is decided in AppStore (see the refresh
 * map there) and in `useLiveEvent` for page-local data.
 *
 * A singleton, and deliberately never torn down: it lives exactly as long as
 * the page does. Subscribers come and go with React's lifecycle; the socket
 * underneath them does not, so a route change never costs a handshake.
 */

/** Duplicated from `apps/api/src/live/live.constants.ts` — see client-id.ts. */
const LIVE_PATH = '/api/live';

/**
 * Reconnect delays, in order, holding at the last one. Capped at 15s because
 * the common reason to be here is a redeploy, which takes about a minute — long
 * enough that giving up on fast retries would leave the wall display stale, and
 * short enough that backing off to minutes would be pointless.
 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * How long a tab must have been hidden before its socket is treated as
 * suspect. The server pings every 30 seconds, so a shorter absence than this
 * can't have gone unnoticed on the connection.
 */
const STALE_AFTER_HIDDEN_MS = 20_000;

/**
 * Events whose HTTP response carries the whole effect, so the tab that sent the
 * request has already applied it and its own echo is worth nothing.
 *
 * Only `game:recorded` qualifies: POST /scores/record answers with the three
 * recomputed boards, and `AppStore.recordGame` writes them straight in (and
 * runs the celebration, which must not fire twice).
 *
 * Every other event is processed even in the tab that caused it, because
 * `origin` only tells us who sent the request — not that they learned the
 * result. DELETE /admin/games/:id, for one, answers with `{ deletedId, dayKey,
 * recomputedGames }` and no boards at all, so suppressing that echo left the
 * deleting admin's own leaderboard, roster and win counts showing a race that
 * no longer existed.
 */
const SELF_APPLIED: ReadonlySet<LiveEventType> = new Set<LiveEventType>(['game:recorded']);

export type LiveStatus = 'connecting' | 'live' | 'offline';

export type LiveFrameListener = (frame: LiveFrame) => void;
export type LiveStatusListener = (status: LiveStatus) => void;

class LiveChannel {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private retry: number | undefined;
  private hiddenSince: number | null = null;
  private state: LiveStatus = 'connecting';
  private wired = false;

  private readonly frameListeners = new Set<LiveFrameListener>();
  private readonly statusListeners = new Set<LiveStatusListener>();

  get status(): LiveStatus {
    return this.state;
  }

  /** Listen for frames. Opens the socket on the first subscriber. */
  subscribe(listener: LiveFrameListener): () => void {
    this.frameListeners.add(listener);
    this.start();
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** Listen for connection state, called once immediately with the current one. */
  onStatus(listener: LiveStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.state);
    this.start();
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private start(): void {
    if (this.wired) return;
    this.wired = true;

    window.addEventListener('online', this.wake);
    window.addEventListener('offline', this.markOffline);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    /*
     * Mobile Safari — and an installed PWA in particular — freezes a
     * backgrounded page rather than merely hiding it, and the socket does not
     * survive that. Closing it here is the tidy half of the deal that
     * `onVisibilityChange` completes on the way back: the server frees the slot
     * immediately instead of waiting for a heartbeat to time out.
     */
    window.addEventListener('pagehide', this.drop);

    this.connect();
  }

  private connect(): void {
    // An existing socket is either OPEN or still handshaking; either way,
    // opening a second one would leave the first orphaned and still counted.
    if (this.socket) return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      /*
       * Don't spend a handshake we already know will fail — but keep the retry
       * ladder running anyway, rather than waiting to be told the link is back.
       * `navigator.onLine` is a hint, not a contract: it reads true behind a
       * captive portal, and its events don't reliably fire in every engine or
       * after a mobile PWA thaws out of a freeze. Treating it as the only way
       * back is how a wall display ends up stuck on "Offline" until somebody
       * walks over and reloads it.
       */
      this.setStatus('offline');
      this.scheduleRetry();
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}${LIVE_PATH}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      // Thrown synchronously for a malformed URL or a blocked scheme.
      this.setStatus('offline');
      this.scheduleRetry();
      return;
    }

    this.socket = socket;
    this.setStatus('connecting');

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('live');
    };

    socket.onmessage = (event: MessageEvent<unknown>) => this.dispatch(event.data);

    // An error is always followed by a close, which is where the retry lives.
    socket.onerror = () => undefined;

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setStatus('offline');
      this.scheduleRetry();
    };
  }

  private dispatch(data: unknown): void {
    if (typeof data !== 'string') return;

    let frame: LiveFrame;
    try {
      frame = JSON.parse(data) as LiveFrame;
    } catch {
      return;
    }
    if (typeof frame?.type !== 'string') return;

    // Our own echo, for an event we already applied from the response.
    if ('origin' in frame && frame.origin === CLIENT_ID && SELF_APPLIED.has(frame.type)) return;

    for (const listener of [...this.frameListeners]) {
      try {
        listener(frame);
      } catch (error) {
        // One bad subscriber must not cost the others their frame.
        console.error('Live listener failed', error);
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retry !== undefined) return;

    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    // Jitter, so a redeploy doesn't bring the whole crew back in lockstep and
    // hand the waking instance every handshake in the same millisecond.
    const delay = base + Math.random() * base * 0.4;

    this.retry = window.setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, delay);
  }

  /** Retry now, and reset the backoff — something changed for the better. */
  private readonly wake = (): void => {
    /*
     * Only an OPEN socket is worth keeping. Anything else is either a handshake
     * we're about to beat with a fresh one, or — the case that actually bites —
     * a socket whose close event never arrived, which `connect()` would keep
     * short-circuiting on forever. See `markOffline`.
     */
    if (this.socket && this.socket.readyState !== WebSocket.OPEN) this.drop();

    if (this.retry !== undefined) {
      window.clearTimeout(this.retry);
      this.retry = undefined;
    }
    this.attempt = 0;
    this.connect();
  };

  /**
   * The link went away.
   *
   * Dropping the socket here is not tidying up, it is the fix for a real wedge:
   * a connection the network stack loses can sit in `OPEN` indefinitely with no
   * close event ever delivered — a laptop lid, a phone leaving a tunnel, a
   * browser's own offline mode. `connect()` refuses to open a second socket
   * while one exists, so holding on to that corpse means the channel goes quiet
   * permanently and only a manual reload brings it back. Let it go, and let the
   * retry ladder do its job.
   */
  private readonly markOffline = (): void => {
    this.drop();
    this.setStatus('offline');
    this.scheduleRetry();
  };

  /** Close and forget the current socket without letting it schedule a retry. */
  private readonly drop = (): void => {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closing or closed.
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      this.hiddenSince = Date.now();
      return;
    }

    const hiddenFor = this.hiddenSince === null ? 0 : Date.now() - this.hiddenSince;
    this.hiddenSince = null;

    /*
     * A socket the operating system tore down while the tab was frozen still
     * reads as OPEN here, and no event will ever arrive to say otherwise — so
     * after a long absence the only trustworthy move is to replace it rather
     * than trust it. The fresh connection's `live:hello` is also what tells
     * AppStore to resync whatever it missed while it was away.
     */
    if (hiddenFor > STALE_AFTER_HIDDEN_MS) this.drop();

    this.wake();
  };

  private setStatus(status: LiveStatus): void {
    if (this.state === status) return;
    this.state = status;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status);
      } catch (error) {
        console.error('Live status listener failed', error);
      }
    }
  }
}

export const live = new LiveChannel();
