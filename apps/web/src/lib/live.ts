import type { LiveEventType, LiveFrame, LivePollResponse } from '@scrapyard/shared';
import { CLIENT_ID } from './client-id';

/**
 * The live channel, browser side: a poll of `/api/live/events`, handing every
 * frame to whoever subscribed.
 *
 * Transport only — it holds no application state and knows nothing about
 * leaderboards. What to do with a frame is decided in AppStore (see the refresh
 * map there) and in `useLiveEvent` for page-local data.
 *
 * A singleton, and deliberately never torn down: it lives exactly as long as
 * the page does. Subscribers come and go with React's lifecycle; the poll loop
 * underneath them does not, so a route change never costs a round trip.
 *
 * ── Why this is a poll and not a socket ─────────────────────────────────────
 *
 * It used to be one WebSocket per tab. That is the better design when a server
 * is a process that is always running anyway — and the worse one when it isn't.
 * The server is now a function that exists only while it is handling a request,
 * billed for as long as anything is held open, so a socket per tab meant paying
 * around the clock for a room that was usually empty. The previous host's free
 * tier ran out for exactly this reason: the socket's own keep-alive heartbeat
 * was enough inbound traffic to stop the instance ever going to sleep.
 *
 * A poll costs something only when it happens. Which makes *not polling* the
 * thing worth engineering — see the keep-alive rules below.
 */

/** Duplicated from `apps/api/src/live/live.constants.ts` — see client-id.ts. */
const LIVE_PATH = '/api/live/events';

/**
 * How often to ask, while the tab is awake and someone is using it.
 *
 * Ten seconds is the compromise: fast enough that a race scored on a phone
 * reaches the room before anyone talks about it, slow enough that a day of a
 * dozen people using the app costs a rounding error against the monthly
 * invocation allowance.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * How long a focused tab may sit untouched before it stops polling.
 *
 * The tab in the background of somebody's afternoon is the expensive case:
 * focused, technically visible, and generating a request every ten seconds for
 * hours on behalf of nobody. Eight minutes is long enough to cover reading a
 * profile page or being interrupted mid-thought, and short enough that a
 * forgotten tab goes quiet within the same coffee break.
 */
const IDLE_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * Reconnect delays after a failed poll, in order, holding at the last one.
 * Capped at 15s because the common reason to be here is a redeploy, which is
 * quick — long enough that giving up on fast retries would leave the board
 * stale, short enough that backing off to minutes would be pointless.
 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * What counts as "somebody is using this tab".
 *
 * `pointermove` is in the list because reading without clicking is still using
 * it, but it fires continuously, so it is throttled below rather than treated
 * like the others.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'pointermove'] as const;

/** Ignore repeat activity within this window — one timestamp write is enough. */
const ACTIVITY_THROTTLE_MS = 1_000;

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

/**
 * `paused` is not a failure and must not be shown as one.
 *
 * The other three mean something went wrong or is about to be right. `paused`
 * means this tab stopped on purpose because nobody is watching it, and the one
 * thing the indicator must never do is imply the board is broken when it is
 * merely asleep — that is the same confusion the indicator exists to prevent,
 * pointed the other way.
 */
export type LiveStatus = 'connecting' | 'live' | 'paused' | 'offline';

export type LiveFrameListener = (frame: LiveFrame) => void;
export type LiveStatusListener = (status: LiveStatus) => void;

class LiveChannel {
  /** The highest sequence number applied. `undefined` until the first answer. */
  private since: number | undefined;

  /** Which build answered last, so a new one can be noticed. */
  private deployment: string | null = null;

  private timer: number | undefined;
  private attempt = 0;
  private inFlight = false;
  private state: LiveStatus = 'connecting';
  private wired = false;
  private stopped = false;
  private lastActivity = Date.now();
  private lastActivityWrite = 0;

  private readonly frameListeners = new Set<LiveFrameListener>();
  private readonly statusListeners = new Set<LiveStatusListener>();

  get status(): LiveStatus {
    return this.state;
  }

  /** Listen for frames. Starts polling on the first subscriber. */
  subscribe(listener: LiveFrameListener): () => void {
    this.frameListeners.add(listener);
    this.start();
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** Listen for channel state, called once immediately with the current one. */
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
     * A backgrounded tab — and an installed PWA in particular — may be frozen
     * rather than merely hidden. Stopping here is the tidy half of the deal
     * that `onVisibilityChange` completes on the way back.
     */
    window.addEventListener('pagehide', this.suspend);

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, this.onActivity, { passive: true });
    }

    this.schedule(0);
  }

  /** Whether this tab should be asking the server anything right now. */
  private shouldPoll(): boolean {
    if (this.stopped) return false;
    // Rule one: nobody is looking at this tab.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    // Rule two: it is in front of them, but they have not touched it in a while.
    if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) return false;
    return true;
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.shouldPoll()) {
      /*
       * Deliberately does not reschedule. Nothing is running now, and nothing
       * will until an event says something changed — which is the entire point:
       * an idle tab must cost nothing at all, not one cheap request a minute.
       * `wake` is the only way back.
       */
      this.setStatus('paused');
      return;
    }

    // A slow answer must not stack a second request on top of the first.
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('offline');
      }

      const query = this.since === undefined ? '' : `?since=${this.since}`;
      const response = await fetch(`${LIVE_PATH}${query}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (response.status === 401 || response.status === 403) {
        /*
         * The session went away while this tab sat there. Stop for good rather
         * than retrying: every further poll would 401 identically, and AppStore
         * already redirects to /login the moment any other request notices.
         */
        this.stopped = true;
        this.setStatus('offline');
        return;
      }

      if (!response.ok) throw new Error(`live poll failed: ${response.status}`);

      const payload = (await response.json()) as LivePollResponse;

      this.attempt = 0;
      this.apply(payload);
      this.setStatus('live');
    } catch {
      this.setStatus('offline');
      const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      // Jitter, so a redeploy doesn't bring the whole crew back in lockstep and
      // hand the waking instance every request in the same millisecond.
      this.schedule(base + Math.random() * base * 0.4);
      return;
    } finally {
      this.inFlight = false;
    }

    this.schedule(POLL_INTERVAL_MS);
  }

  /**
   * Turn one answer into frames.
   *
   * `resync` means the server could not tell us what we missed — a first poll,
   * or a gap longer than the retained history. The synthetic `live:hello` is
   * how that is expressed, because it is already exactly what AppStore does
   * with a reconnection: re-read everything rather than guess.
   */
  private apply(payload: LivePollResponse): void {
    const firstAnswer = this.deployment === null;
    const redeployed = !firstAnswer && this.deployment !== payload.deploymentId;

    this.deployment = payload.deploymentId;
    this.since = payload.seq;

    if (payload.resync || redeployed) {
      this.dispatch({
        type: 'live:hello',
        at: new Date().toISOString(),
        userId: '',
        serverId: payload.deploymentId,
      });
      // A resync supersedes whatever else came back — AppStore is refetching
      // all of it anyway, so replaying individual events would be duplicate work.
      return;
    }

    for (const event of payload.events) this.dispatch(event);
  }

  private dispatch(frame: LiveFrame): void {
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

  /**
   * Somebody is using this tab.
   *
   * Throttled because `pointermove` fires far more often than this needs to
   * know, and the only thing being recorded is "recently".
   */
  private readonly onActivity = (): void => {
    const now = Date.now();
    if (now - this.lastActivityWrite < ACTIVITY_THROTTLE_MS) return;
    this.lastActivityWrite = now;

    const wasIdle = now - this.lastActivity > IDLE_TIMEOUT_MS;
    this.lastActivity = now;

    // Coming back from the idle cutoff is a resume, not just a timestamp bump.
    if (wasIdle) this.wake();
  };

  /** Poll now, and reset the backoff — something changed for the better. */
  private readonly wake = (): void => {
    if (this.stopped) return;
    this.lastActivity = Date.now();
    this.attempt = 0;
    if (!this.shouldPoll()) return;
    this.setStatus('connecting');
    this.schedule(0);
  };

  /** Stop asking, without treating it as a failure. */
  private readonly suspend = (): void => {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.setStatus('paused');
  };

  private readonly markOffline = (): void => {
    this.setStatus('offline');
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      this.suspend();
      return;
    }

    /*
     * Back in front of somebody. Treat that as activity in its own right —
     * deliberately choosing the tab is a stronger signal than the pointer
     * drifting across it — and poll immediately rather than waiting out an
     * interval, because the whole point of the return is to see what changed.
     */
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
