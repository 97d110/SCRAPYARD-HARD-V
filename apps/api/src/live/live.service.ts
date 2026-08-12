import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveEvent, LivePollResponse } from '@scrapyard/shared';
import { MongoService } from '../database/mongo.service';

/**
 * How many events the log keeps.
 *
 * A client that polls every 10 seconds needs only the handful written since its
 * last poll. This much history exists for the tab that stopped polling — one
 * unfocused, or idle past the cutoff — and comes back to find out what it
 * missed. Beyond it the client is told to resync instead, which is a full
 * refetch of three endpoints: correct, just not free, so the ring is sized to
 * make that rare rather than to avoid it entirely.
 */
const RING_SIZE = 100;

/** The single document every event is appended to. */
const LOG_ID = 'global';

/**
 * The live channel: database changes fanned out to every open tab, so a race
 * scored on somebody's phone reaches the leaderboard without a reload.
 *
 * ── Why this is a log in Mongo and not a WebSocket ──────────────────────────
 *
 * It used to be a `ws` server holding every socket in a Map, which is the right
 * shape for one long-lived process and the wrong one for everything else. Two
 * things killed it. Serverless has no shared memory, so an event written by the
 * instance handling a POST cannot reach a socket held by a different instance.
 * And an open connection pins an instance for its whole lifetime, which is
 * exactly the bill that exhausted the previous host's free tier — the socket
 * heartbeat kept the instance awake around the clock.
 *
 * A log inverts both. Writers append; readers poll for anything past the
 * sequence number they last saw; nothing is held open between requests, so an
 * idle screen costs nothing at all.
 *
 * ── What deliberately did not change ────────────────────────────────────────
 *
 * The `LiveEvent` vocabulary, the `origin` echo-suppression rule, and the
 * winner block on `game:recorded` are all untouched — this emits the same
 * frames the socket did, so every client-side consumer works as it did before.
 * Events are still notifications rather than data: they say *what* changed and
 * the client refetches, so two changes arriving out of order can never leave a
 * board wrong.
 *
 * ── One thing that got better ───────────────────────────────────────────────
 *
 * The socket could only see writes that went through the API. A write from
 * `npm run seed` or an edit in the Atlas console was invisible to it. This is
 * still true of anything that bypasses `broadcast`, but the log is now shared
 * state rather than one process's memory, so a second instance's traffic *is*
 * visible — which it never was before.
 */
@Injectable()
export class LiveService {
  private readonly logger = new Logger('Live');

  /**
   * Identifies the running build, so a client can tell "I lost track" from "a
   * new version shipped" and go looking for a new bundle.
   *
   * Vercel's deployment id is the honest source: it is stable across every
   * instance of one deployment and changes on the next, which a per-boot uuid
   * was only ever an approximation of — on serverless a per-boot value would
   * change per cold start and cry wolf. The uuid remains as the local-dev
   * fallback, where it means exactly what it always did.
   */
  private readonly deploymentId =
    process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? randomUUID();

  constructor(private readonly mongo: MongoService) {}

  /**
   * Append an event for every other tab to pick up.
   *
   * Awaited at the call sites, unlike the fire-and-forget socket write it
   * replaces, and the reason is the runtime: a serverless instance may freeze
   * the moment its response is sent, so work left running past that point
   * simply doesn't happen. An unawaited append would drop events under exactly
   * the conditions that matter.
   *
   * It swallows its own failures instead. Losing an event costs one poll's
   * worth of staleness; failing the caller's write because the *notification*
   * about it failed would be trading something that matters for something that
   * doesn't.
   */
  async broadcast(event: LiveEvent): Promise<void> {
    try {
      const log = await this.mongo.liveLog();

      /*
       * Drop absent fields rather than storing them.
       *
       * `origin` is optional — a change with no originating tab (a Google
       * sign-in redirect, a seed script) genuinely has none — and BSON encodes
       * an explicit `undefined` as `null`. That would come back to the client
       * as `origin: null`, which is neither what `LiveEvent` declares nor what
       * `'origin' in frame` is asking, so the absent case has to stay absent.
       */
      const stored = Object.fromEntries(
        Object.entries(event).filter(([, value]) => value !== undefined),
      );

      /*
       * An aggregation-pipeline update, because the appended event has to carry
       * the sequence number this same operation just minted. `$inc` plus
       * `$push` cannot do that — `$push` has no way to read the incremented
       * value — and doing it in two round trips would let a concurrent writer
       * interleave and hand two events the same number.
       *
       * `$literal` wraps the event because a pipeline reads any string starting
       * with `$` as a field path, and these carry user-supplied text: a racer
       * whose display name began with a `$` would otherwise be silently
       * rewritten into whatever that path resolved to.
       */
      await log.updateOne(
        { _id: LOG_ID },
        [
          { $set: { seq: { $add: [{ $ifNull: ['$seq', 0] }, 1] } } },
          {
            $set: {
              events: {
                $slice: [
                  {
                    $concatArrays: [
                      { $ifNull: ['$events', []] },
                      [
                        {
                          $mergeObjects: [
                            { $literal: stored },
                            { seq: '$seq', at: '$$NOW' },
                          ],
                        },
                      ],
                    ],
                  },
                  -RING_SIZE,
                ],
              },
            },
          },
        ],
        { upsert: true },
      );
    } catch (error) {
      this.logger.warn(
        `Could not record ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Everything that happened after `since`.
   *
   * `since` absent means the caller has no position yet — a tab that just
   * opened, or one resuming after long enough that it would rather be told to
   * start over than replay. Either way it gets the current head and no events,
   * with `resync` set so the client refetches instead of assuming it is current.
   */
  async poll(since: number | undefined): Promise<LivePollResponse> {
    const log = await this.mongo.liveLog();
    const doc = await log.findOne({ _id: LOG_ID });

    const seq = doc?.seq ?? 0;
    const events = doc?.events ?? [];

    if (since === undefined) {
      return { seq, deploymentId: this.deploymentId, resync: true, events: [] };
    }

    /*
     * The oldest event still in the ring. A caller asking for anything before
     * it has fallen out of the window, and the honest answer is "I can't tell
     * you what you missed" rather than a history with a hole in it.
     *
     * `since > seq` lands here too, which is the case where the log was reset
     * (a fresh database, a dropped collection) while a tab held a higher number
     * from the previous one.
     */
    const oldest = events.length > 0 ? events[0].seq : seq;
    if (since < oldest - 1 || since > seq) {
      return { seq, deploymentId: this.deploymentId, resync: true, events: [] };
    }

    return {
      seq,
      deploymentId: this.deploymentId,
      resync: false,
      events: events.filter(
        (event) => event.seq > since,
      ) as unknown as LivePollResponse['events'],
    };
  }
}
