import type {
  AwardResponse,
  ContentTypeDescriptor,
  CurrentBoards,
  ExportSummary,
  ProfileBundle,
  PublicUser,
  Pun,
  Scoreboard,
} from '@scrapyard/shared';

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
  const response = await fetch(`${BASE}${path}`, {
    // Session lives in an httpOnly cookie, so every call must carry it.
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
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
  profileOptions: () => request<{ racers: string[]; accents: string[] }>('/users/options'),
  profile: (id: string) => request<ProfileBundle>(`/users/${encodeURIComponent(id)}`),
  updateProfile: (id: string, patch: Record<string, unknown>) =>
    request<PublicUser>(`/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // --- scores -------------------------------------------------------------
  boards: () => request<CurrentBoards>('/scores'),
  board: (key: string) => request<Scoreboard>(`/scores/board/${encodeURIComponent(key)}`),
  boardIndex: () =>
    request<Array<{ kind: string; key: string; label: string; totalPoints: number }>>('/scores/boards'),
  award: (winnerId: string, note?: string) =>
    request<AwardResponse>('/scores/award', {
      method: 'POST',
      body: JSON.stringify(note ? { winnerId, note } : { winnerId }),
    }),

  // --- content ------------------------------------------------------------
  puns: () => request<Pun[]>('/content/puns'),

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
