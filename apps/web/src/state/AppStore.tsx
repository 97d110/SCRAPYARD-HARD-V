import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from '../lib/api';
import type { CurrentBoards, PublicUser, Pun } from '@scrapyard/shared';

/**
 * One store for the whole app.
 *
 * Per the spec, boot is a single burst: session, then the full roster + all
 * three current leaderboards + the puns. After that everything is served from
 * memory and only mutations refetch.
 */
interface AppState {
  status: 'booting' | 'anonymous' | 'ready' | 'error';
  error: string | null;

  me: PublicUser | null;

  users: PublicUser[];
  boards: CurrentBoards | null;
  puns: Pun[];

  /** Bumped by Arthur-worthy events; consumers watch it to trigger the flyby. */
  celebration: { id: number; accent: string; caption: string } | null;
}

interface AppActions {
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  awardWin: (winnerId: string, note?: string) => Promise<PublicUser | null>;
  patchMe: (next: PublicUser) => void;
  refreshPuns: () => Promise<void>;
  clearCelebration: () => void;
  userById: (id: string) => PublicUser | undefined;
}

const AppContext = createContext<(AppState & AppActions) | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    status: 'booting',
    error: null,
    me: null,
    users: [],
    boards: null,
    puns: [],
    celebration: null,
  });

  const boot = useCallback(async () => {
    setState((prev) => ({ ...prev, status: 'booting', error: null }));

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
        error: error instanceof Error ? error.message : 'Could not reach the API',
      }));
      return;
    }

    try {
      const { users, boards, puns } = await api.boot();
      setState({
        status: 'ready',
        error: null,
        me,
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
   * Award a win. The API returns all three freshly-derived boards, so we swap
   * them in directly rather than refetching — then re-pull the roster so
   * per-user totals on the Users page stay honest.
   */
  const awardWin = useCallback(async (winnerId: string, note?: string) => {
    const result = await api.award(winnerId, note);

    setState((prev) => ({
      ...prev,
      /*
       * Take `periods` from the response too, not just the boards. The server
       * derives the month/day keys at award time, so on a long-lived tab (this
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
        id: Date.now(),
        accent: result.winner.accentColor,
        caption: `${result.winner.displayName} — ${result.winner.allTime} ${
          result.winner.allTime === 1 ? 'win' : 'wins'
        }`,
      },
    }));

    const users = await api.users().catch(() => null);
    if (users) setState((prev) => ({ ...prev, users }));

    return users?.find((user) => user.id === winnerId) ?? null;
  }, []);

  const patchMe = useCallback((next: PublicUser) => {
    setState((prev) => ({
      ...prev,
      me: next,
      users: prev.users.map((user) => (user.id === next.id ? next : user)),
    }));
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

  const value = useMemo(
    () => ({
      ...state,
      reload: boot,
      logout,
      awardWin,
      patchMe,
      refreshPuns,
      clearCelebration,
      userById,
    }),
    [state, boot, logout, awardWin, patchMe, refreshPuns, clearCelebration, userById],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState & AppActions {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}
