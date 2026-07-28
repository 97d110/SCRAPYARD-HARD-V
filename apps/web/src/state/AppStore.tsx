import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from '../lib/api';
import { live } from '../lib/live';
import { checkForServiceWorkerUpdate } from '../lib/pwa';
import type { CurrentBoards, GameResultInput, KillEventInput, PublicUser, Pun } from '@scrapyard/shared';

/**
 * One store for the whole app.
 *
 * Per the spec, boot is a single burst: session, then the full roster + all
 * three current leaderboards + the puns. After that everything is served from
 * memory, and it is brought back up to date by two things: this tab's own
 * mutations, and the live channel telling it about everyone else's.
 */
interface AppState {
  status: 'booting' | 'anonymous' | 'ready' | 'error';
  error: string | null;
  /** True when the boot failure was "no network" rather than "the API said no". */
  offline: boolean;

  me: PublicUser | null;

  users: PublicUser[];
  boards: CurrentBoards | null;
  puns: Pun[];

  /** Bumped by Arthur-worthy events; consumers watch it to trigger the flyby. */
  celebration: { id: string; accent: string; caption: string } | null;
}

interface AppActions {
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  recordGame: (
    results: GameResultInput[],
    events?: KillEventInput[],
    note?: string,
  ) => Promise<PublicUser | null>;
  patchMe: (next: PublicUser) => void;
  refreshPuns: () => Promise<void>;
  /** Re-read the roster in place, without the full-screen boot spinner. */
  refreshUsers: () => Promise<void>;
  /** Re-derive all three current boards in place. */
  refreshBoards: () => Promise<void>;
  clearCelebration: () => void;
  userById: (id: string) => PublicUser | undefined;
}

const AppContext = createContext<(AppState & AppActions) | null>(null);

/** The shared reads a live event can invalidate. */
type RefreshKey = 'boards' | 'users' | 'puns';

/**
 * How long to gather events before refetching.
 *
 * One race produces one event, so this is normally a formality — but a pun
 * reorder, an admin working quickly, or the burst that arrives when a tab
 * reconnects after being asleep would otherwise each cost their own round trip.
 * Short enough that nobody perceives it as lag.
 */
const COALESCE_MS = 150;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    status: 'booting',
    error: null,
    offline: false,
    me: null,
    users: [],
    boards: null,
    puns: [],
    celebration: null,
  });

  /*
   * The live subscription is set up once and must not be rebuilt whenever
   * status changes, so it reads status through a ref instead of closing over it.
   * Refetching while the session is gone would just collect 401s.
   */
  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  const boot = useCallback(async () => {
    setState((prev) => ({ ...prev, status: 'booting', error: null, offline: false }));

    // No auth-config fetch: the login page is server-rendered, so the server
    // already knows which domains it permits. Nothing here needs to ask.
    let me: PublicUser;
    try {
      me = await api.me();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setState((prev) => ({ ...prev, status: 'anonymous', me: null }));
        return;
      }
      setState((prev) => ({
        ...prev,
        status: 'error',
        // A TypeError from fetch, or a browser that already knows it has no
        // link. Worth distinguishing: "you're offline" is actionable and "could
        // not reach the API" reads like the service is broken.
        offline: typeof navigator !== 'undefined' && navigator.onLine === false,
        error: error instanceof Error ? error.message : 'Could not reach the API',
      }));
      return;
    }

    try {
      const { users, boards, puns } = await api.boot();
      setState({
        status: 'ready',
        error: null,
        offline: false,
        /*
         * Prefer the roster's copy of ourselves. `/auth/me` resolves through the
         * JWT strategy, which has a user document but no win counts — joining
         * them there would put a scoreboard aggregation on every authenticated
         * request, for a number only the account badge reads. The roster is
         * already here and already carries them, so take it from that: it's the
         * difference between the badge in the side menu saying "0 wins" until
         * something else happens to refresh it, and it being right on first
         * paint.
         */
        me: users.find((user) => user.id === me.id) ?? me,
        users,
        boards,
        puns,
        celebration: null,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: 'error',
        me,
        offline: typeof navigator !== 'undefined' && navigator.onLine === false,
        error: error instanceof Error ? error.message : 'Boot failed',
      }));
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    // Hard navigation rather than a state change: the login page is served by
    // the API, and this also guarantees every trace of the session's data is
    // gone from memory.
    window.location.replace('/login');
  }, []);

  /**
   * Record a race. The API returns all three freshly-derived boards plus the
   * first-place finisher, so we swap the boards in directly rather than
   * refetching — then re-pull the roster so per-user totals on the Users page
   * stay honest. The celebration still rides on the winner alone: a race has
   * many finishers, but only the podium's top step earns the flyby.
   *
   * Every other tab learns about this from the `game:recorded` event instead.
   * This one won't: the server marks the event with our client id and the
   * channel drops it, because everything below is that event's effect already.
   */
  const recordGame = useCallback(
    async (results: GameResultInput[], events: KillEventInput[] = [], note?: string) => {
    const result = await api.recordGame(results, events, note);

    setState((prev) => ({
      ...prev,
      /*
       * Take `periods` from the response too, not just the boards. The server
       * derives the month/day keys at record time, so on a long-lived tab (this
       * app is meant to live on a wall display) this is what rolls the client
       * over midnight. Keeping the old `periods` would leave the "Today" tab
       * labelled with yesterday and the roster's Today column reading zero.
       */
      boards: {
        ...result.boards,
        periods: {
          month: result.boards.monthly.key,
          day: result.boards.daily.key,
        },
      },
      celebration: {
        // The game's own id, so two celebrations landing in the same
        // millisecond still remount the animation instead of sharing a run.
        id: result.game.id,
        accent: result.winner.accentColor,
        caption: `${result.winner.displayName} — ${result.winner.allTime} ${
          result.winner.allTime === 1 ? 'win' : 'wins'
        }`,
      },
    }));

    const users = await api.users().catch(() => null);
    if (users) setState((prev) => ({ ...prev, users }));

    return users?.find((user) => user.id === result.winner.id) ?? null;
  }, []);

  const patchMe = useCallback((next: PublicUser) => {
    setState((prev) => ({
      ...prev,
      me: next,
      users: prev.users.map((user) => (user.id === next.id ? next : user)),
    }));
  }, []);

  const refreshUsers = useCallback(async () => {
    const users = await api.users().catch(() => null);
    if (!users) return;
    setState((prev) => ({
      ...prev,
      users,
      /*
       * Keep `me` in step from the same payload. The roster carries every field
       * `/auth/me` does, so this costs nothing extra and it is what makes a
       * profile edit in another tab — or a role change — show up in this tab's
       * top bar rather than sitting stale until the next reload.
       */
      me: prev.me ? users.find((user) => user.id === prev.me?.id) ?? prev.me : prev.me,
    }));
  }, []);

  const refreshBoards = useCallback(async () => {
    // `periods` comes down with this response, so a board refresh is also what
    // rolls a long-lived tab over midnight.
    const boards = await api.boards().catch(() => null);
    if (boards) setState((prev) => ({ ...prev, boards }));
  }, []);

  const refreshPuns = useCallback(async () => {
    const puns = await api.puns().catch(() => null);
    if (puns) setState((prev) => ({ ...prev, puns }));
  }, []);

  const clearCelebration = useCallback(() => {
    setState((prev) => ({ ...prev, celebration: null }));
  }, []);

  const userById = useCallback(
    (id: string) => state.users.find((user) => user.id === id),
    [state.users],
  );

  // ── Live updates ─────────────────────────────────────────────────────────

  const pending = useRef(new Set<RefreshKey>());
  const flush = useRef<number | undefined>(undefined);

  const scheduleRefresh = useCallback(
    (keys: readonly RefreshKey[]) => {
      // Nothing to refresh into until boot has finished, and no session to
      // refresh with once it's gone.
      if (statusRef.current !== 'ready') return;

      for (const key of keys) pending.current.add(key);
      if (flush.current !== undefined) return;

      flush.current = window.setTimeout(() => {
        flush.current = undefined;
        const due = [...pending.current];
        pending.current.clear();

        void Promise.all(
          due.map((key) => {
            if (key === 'boards') return refreshBoards();
            if (key === 'users') return refreshUsers();
            return refreshPuns();
          }),
        );
      }, COALESCE_MS);
    },
    [refreshBoards, refreshUsers, refreshPuns],
  );

  /**
   * The last server we spoke to.
   *
   * Doubles as "have we ever been connected?". A `live:hello` while this is null
   * is the first connection, which boot already covered; a second one means we
   * were disconnected and have missed everything in between. A *different*
   * server id means the service was redeployed, so there is probably a new
   * bundle to pick up as well.
   */
  const seenServer = useRef<string | null>(null);

  useEffect(
    () =>
      live.subscribe((frame) => {
        if (frame.type === 'live:hello') {
          const previous = seenServer.current;
          seenServer.current = frame.serverId;

          if (previous === null) return;

          // Reconnected. Anything that changed while we were away arrived
          // nowhere, so re-read all of it rather than guessing what we missed.
          scheduleRefresh(['boards', 'users', 'puns']);
          if (previous !== frame.serverId) void checkForServiceWorkerUpdate();
          return;
        }

        switch (frame.type) {
          case 'game:recorded':
            // Boards move, and so do the roster's per-racer win counts.
            scheduleRefresh(['boards', 'users']);
            setState((prev) =>
              prev.status === 'ready'
                ? {
                    ...prev,
                    celebration: {
                      id: frame.gameId,
                      accent: frame.winner.accentColor,
                      caption: `${frame.winner.displayName} — ${frame.winner.allTime} ${
                        frame.winner.allTime === 1 ? 'win' : 'wins'
                      }`,
                    },
                  }
                : prev,
            );
            break;

          case 'game:deleted':
            scheduleRefresh(['boards', 'users']);
            break;

          case 'roster:changed':
            /*
             * Boards too, not just the roster: leaderboard rows join the user
             * document at query time, so a rename or a new accent colour
             * changes every board on screen without a single game moving.
             */
            scheduleRefresh(['boards', 'users']);
            break;

          case 'puns:changed':
            scheduleRefresh(['puns']);
            break;

          case 'metrics:changed':
            // A metric is a board *column*, so this changes their shape.
            scheduleRefresh(['boards']);
            break;

          case 'achievement-rules:changed':
            // Nothing in this store reads rules — they only surface on a
            // profile page, which subscribes for itself via useLiveEvent.
            break;
        }
      }),
    [scheduleRefresh],
  );

  // Retry the boot burst by itself once the browser says the link is back.
  useEffect(() => {
    const onOnline = () => {
      if (statusRef.current === 'error') void boot();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [boot]);

  useEffect(
    () => () => {
      if (flush.current !== undefined) window.clearTimeout(flush.current);
    },
    [],
  );

  const value = useMemo(
    () => ({
      ...state,
      reload: boot,
      logout,
      recordGame,
      patchMe,
      refreshPuns,
      refreshUsers,
      refreshBoards,
      clearCelebration,
      userById,
    }),
    [
      state,
      boot,
      logout,
      recordGame,
      patchMe,
      refreshPuns,
      refreshUsers,
      refreshBoards,
      clearCelebration,
      userById,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState & AppActions {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}
