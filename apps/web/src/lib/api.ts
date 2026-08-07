import type {
  AchievementRule,
  AchievementScope,
  AchievementTier,
  ContentTypeDescriptor,
  CurrentBoards,
  DeleteGameResponse,
  UpdateGameResponse,
  ExportSummary,
  FormulaTerm,
  GameResultInput,
  GameResultPatch,
  GamesPage,
  KillEventInput,
  MetricAggregation,
  MetricDef,
  ProfileBundle,
  PublicUser,
  Pun,
  PushSubscriptionInput,
  RecordGameResponse,
  Scoreboard,
  VoiceDraft,
} from '@scrapyard/shared';
import { CLIENT_ID, CLIENT_ID_HEADER } from './client-id';

/**
 * Request bodies for the admin metric/achievement editors. Kept here rather
 * than imported from shared because they mirror the server-side DTOs (which
 * are validation classes, not exported types) — the fields an editor sends,
 * not a stored document.
 */
export interface CreateMetricInput {
  id: string;
  label: string;
  kind: 'captured' | 'formula';
  icon?: string;
  unit?: string;
  description?: string;
  aggregation?: MetricAggregation;
  formula?: FormulaTerm[];
}

export interface UpdateMetricInput {
  label?: string;
  icon?: string;
  unit?: string;
  description?: string;
  aggregation?: MetricAggregation;
  formula?: FormulaTerm[];
  enabled?: boolean;
  order?: number;
}

export interface CreateRuleInput {
  name: string;
  description?: string;
  tier?: AchievementTier;
  icon?: string;
  metricId: string;
  scope: AchievementScope;
  threshold: number;
}

export interface UpdateRuleInput {
  name?: string;
  description?: string;
  tier?: AchievementTier;
  icon?: string;
  metricId?: string;
  scope?: AchievementScope;
  threshold?: number;
  enabled?: boolean;
  order?: number;
}

/** Mirrors the `Racer` shape in apps/api/src/common/racers.ts. */
export interface RacerOption {
  name: string;
  slug: string;
}

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};

  if (init.body) headers['Content-Type'] = 'application/json';

  /*
   * Tag mutations with this tab's id. The server echoes it onto the live event
   * the write produces, so the frame comes back recognisable as our own and we
   * skip refetching state we already applied from the response. Reads carry no
   * such tag — they cause no events.
   */
  if (method !== 'GET' && method !== 'HEAD') headers[CLIENT_ID_HEADER] = CLIENT_ID;

  const response = await fetch(`${BASE}${path}`, {
    // Session lives in an httpOnly cookie, so every call must carry it.
    credentials: 'include',
    ...init,
    headers,
  });

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      }
    } catch {
      // Non-JSON error body — the status text will do.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  // --- auth ---------------------------------------------------------------
  me: () => request<PublicUser>('/auth/me'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  // --- boot ---------------------------------------------------------------
  /**
   * The client's cold-start payload: the whole roster plus all three current
   * leaderboards, fetched in parallel. Everything else is lazy.
   */
  boot: async (): Promise<{ users: PublicUser[]; boards: CurrentBoards; puns: Pun[] }> => {
    const [users, boards, puns] = await Promise.all([
      request<PublicUser[]>('/users'),
      request<CurrentBoards>('/scores'),
      request<Pun[]>('/content/puns'),
    ]);
    return { users, boards, puns };
  },

  // --- users --------------------------------------------------------------
  users: () => request<PublicUser[]>('/users'),
  /**
   * Racers as `{ name, slug }`. The slug keys character art; it comes from the
   * server rather than being derived here so two slugify implementations can't
   * drift apart and silently stop resolving one racer's images.
   */
  profileOptions: () => request<{ racers: RacerOption[] }>('/users/options'),
  profile: (id: string) => request<ProfileBundle>(`/users/${encodeURIComponent(id)}`),
  updateProfile: (id: string, patch: Record<string, unknown>) =>
    request<PublicUser>(`/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // --- scores -------------------------------------------------------------
  boards: () => request<CurrentBoards>('/scores'),
  board: (key: string) => request<Scoreboard>(`/scores/board/${encodeURIComponent(key)}`),
  boardIndex: () => request<Array<{ kind: string; key: string }>>('/scores/boards'),
  /**
   * Record a whole race — 2–4 finishers with their place, in-game score and
   * captured stats. Replaces the old single-winner `award`. The response
   * carries all three freshly-derived boards plus the first-place finisher so
   * the celebration can fire without a refetch.
   */
  recordGame: (results: GameResultInput[], events: KillEventInput[] = [], note?: string) =>
    request<RecordGameResponse>('/scores/record', {
      method: 'POST',
      body: JSON.stringify({ results, events, ...(note ? { note } : {}) }),
    }),

  // --- metrics ------------------------------------------------------------
  /** Enabled metric registry — the race-entry form reads the captured ones. */
  metrics: () => request<MetricDef[]>('/metrics'),

  // --- voice entry ----------------------------------------------------------
  voice: {
    /** False when GROQ_API_KEY isn't set — the overlay hides the mic entirely. */
    status: () => request<{ available: boolean }>('/voice/status'),
    /**
     * A recording in, draft form fields out — transcription and extraction both
     * happen server-side in one round trip. Records nothing: the caller drops
     * the result into the grid, where it's edited and submitted by hand through
     * the normal path.
     */
    draft: (audio: string) =>
      request<VoiceDraft>('/voice/draft', {
        method: 'POST',
        body: JSON.stringify({ audio }),
      }),
  },

  // --- content ------------------------------------------------------------
  puns: () => request<Pun[]>('/content/puns'),

  // --- push notifications ---------------------------------------------------
  push: {
    /** Null when the server has no VAPID keys configured. */
    publicKey: () => request<{ publicKey: string | null }>('/push/public-key'),
    subscribe: (subscription: PushSubscriptionInput) =>
      request<void>('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
    unsubscribe: (endpoint: string) =>
      request<void>('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  },

  // --- admin --------------------------------------------------------------
  admin: {
    contentTypes: () => request<ContentTypeDescriptor[]>('/admin/content/types'),
    preview: (id: string) =>
      request<{ id: string; items: unknown[] }>(
        `/admin/content/types/${encodeURIComponent(id)}/preview`,
      ),
    puns: () => request<Pun[]>('/admin/content/puns'),
    createPun: (text: string) =>
      request<Pun>('/admin/content/puns', { method: 'POST', body: JSON.stringify({ text }) }),
    updatePun: (id: string, patch: { text?: string; enabled?: boolean }) =>
      request<Pun>(`/admin/content/puns/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deletePun: (id: string) =>
      request<void>(`/admin/content/puns/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    reorderPuns: (ids: string[]) =>
      request<Pun[]>('/admin/content/puns/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),

    // --- race log -----------------------------------------------------------
    games: {
      /** Newest-first, optionally scoped to one day. `before` is a cursor, not an offset. */
      list: (params: { limit?: number; before?: string; day?: string } = {}) => {
        const query = new URLSearchParams();
        if (params.limit) query.set('limit', String(params.limit));
        if (params.before) query.set('before', params.before);
        if (params.day) query.set('day', params.day);
        const suffix = query.toString() ? `?${query.toString()}` : '';
        return request<GamesPage>(`/admin/games${suffix}`);
      },
      /**
       * Corrects the finishing order and scores of one of today's races.
       *
       * Rejected server-side for any race that isn't from today, and for any
       * change to which racers took part — the same racers, reordered and
       * rescored, is the whole contract.
       */
      update: (id: string, results: GameResultPatch[]) =>
        request<UpdateGameResponse>(`/admin/games/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ results }),
        }),
      /** Deletes the game and recomputes same-day revenge tags server-side. */
      remove: (id: string) =>
        request<DeleteGameResponse>(`/admin/games/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
    },

    // --- metrics registry -------------------------------------------------
    metrics: {
      /** The full registry, built-ins included, for the editor. */
      list: () => request<MetricDef[]>('/admin/metrics'),
      create: (input: CreateMetricInput) =>
        request<MetricDef>('/admin/metrics', { method: 'POST', body: JSON.stringify(input) }),
      update: (id: string, patch: UpdateMetricInput) =>
        request<MetricDef>(`/admin/metrics/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      remove: (id: string) =>
        request<void>(`/admin/metrics/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    },

    // --- achievement rules ------------------------------------------------
    achievementRules: {
      list: () => request<AchievementRule[]>('/admin/achievement-rules'),
      create: (input: CreateRuleInput) =>
        request<AchievementRule>('/admin/achievement-rules', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: UpdateRuleInput) =>
        request<AchievementRule>(`/admin/achievement-rules/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      remove: (id: string) =>
        request<void>(`/admin/achievement-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    },

    /**
     * Add a teammate who hasn't signed in yet. The seat can hold wins
     * immediately; their first Google login attaches to it by email.
     */
    createRacer: (email: string, displayName: string) =>
      request<PublicUser>('/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, displayName }),
      }),

    /** Only permitted while the seat is unclaimed and has no wins. */
    deleteRacer: (id: string) =>
      request<void>(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    /**
     * Edit any racer's profile. Same payload and same server-side validation as
     * a racer editing their own — the difference is only who's allowed to call
     * it. Exists because the fields voice entry depends on are useless if a
     * racer who hasn't signed in yet can't have them filled in for them.
     */
    updateRacer: (id: string, patch: Record<string, unknown>) =>
      request<PublicUser>(`/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    exportSummary: () => request<ExportSummary>('/admin/export/summary'),

    /**
     * Download the whole JSON database as a zip.
     *
     * Done via fetch + blob rather than a plain <a href> so a 403 or a server
     * error surfaces as a real error in the UI instead of the browser silently
     * saving an HTML error page named `database.zip`.
     */
    exportDatabase: async (): Promise<{ filename: string; bytes: number }> => {
      const response = await fetch(`${BASE}/admin/export/database.zip`, {
        credentials: 'include',
      });

      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // Non-JSON error body — the status text will do.
        }
        throw new ApiError(message, response.status);
      }

      const blob = await response.blob();
      const filename =
        response.headers.get('X-Scrapyard-Filename') ??
        `scrapyard-database-${new Date().toISOString().slice(0, 10)}.zip`;

      // Trigger the save dialog, then release the object URL.
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoking immediately can cancel the download in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

      return { filename, bytes: blob.size };
    },
  },
};
