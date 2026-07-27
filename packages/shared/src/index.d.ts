/**
 * Shared domain types — the single source of truth for both apps.
 *
 * Imported as `@scrapyard/shared` via the `paths` mapping in tsconfig.base.json.
 *
 * ── Why this is a .d.ts, and why it contains only types ─────────────────────
 *
 *  1. **It erases completely.** Type-only imports leave no `require()` in the
 *     compiled API output, so nothing needs to resolve the specifier at
 *     runtime — no tsc-alias step, no loader, no bundler.
 *
 *  2. **It is exempt from `rootDir`.** TypeScript excludes declaration files
 *     from the rootDir containment check, so the API keeps `rootDir: src` and
 *     emits a flat `dist/main.js` while importing from outside its own tree.
 *
 * The trade-off: no runtime values here — no `const`, no `enum`, no functions.
 * Shared constants (the racer roster, the accent palette) live in
 * `apps/api/src/users/users.service.ts` and reach the client via
 * `GET /api/users/options`.
 */

export type UserRole = 'racer' | 'admin';

/** Period keys: 'all-time' | 'YYYY-MM' | 'YYYY-MM-DD'. */
export type PeriodKind = 'all-time' | 'monthly' | 'daily';

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'plasma';

/**
 * Win counts for the periods currently on screen.
 *
 * `monthly` and `daily` are **not** full histories — they carry only the current
 * month and current day. Shipping every period to every client on every request
 * would grow without bound, and nothing renders more than "this month" and
 * "today". Historical figures come from the scoreboard endpoints.
 */
export interface UserScores {
  allTime: number;
  /** 'YYYY-MM' -> wins. Current month only. */
  monthly: Record<string, number>;
  /** 'YYYY-MM-DD' -> wins. Today only. */
  daily: Record<string, number>;
}

/**
 * One document in the `wins` collection.
 *
 * Wins are **immutable events**, and that is the load-bearing idea of the whole
 * data model. Recording a win is a single `insertOne` — atomic by definition,
 * no read-modify-write, so no lock and no cascade. Every scoreboard is derived
 * by aggregating this collection at read time, which means a board cannot drift
 * from the truth: there is no second copy to drift from.
 */
export interface WinEntry {
  id: string;
  /** The racer who won. */
  userId: string;
  /** ISO timestamp. */
  at: string;
  /** Denormalised at write time so aggregations group without recomputing. */
  monthKey: string;
  dayKey: string;
  /** Who pressed the button. */
  awardedBy: string;
  /** Optional free text, e.g. the track. */
  note?: string;
}

/**
 * One document in the `users` collection. `_id` is the Google `sub` claim.
 * Server-side only — the client receives `PublicUser`.
 */
export interface UserRecord {
  id: string;
  googleId: string;
  email: string;
  domain: string;
  role: UserRole;

  /** Straight from Google, never edited. The reset target. */
  googleFullName: string;
  googleAvatarUrl: string;

  /** User-editable profile. */
  displayName: string;
  avatarUrl: string;
  tagline: string;
  favoriteRacer: string;
  accentColor: string;

  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

/** Public projection, with win counts joined in. */
export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  displayName: string;
  googleFullName: string;
  avatarUrl: string;
  googleAvatarUrl: string;
  tagline: string;
  favoriteRacer: string;
  accentColor: string;
  createdAt: string;
  scores: UserScores;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string;
  accentColor: string;
  favoriteRacer: string;
  points: number;
  /** True when tied with the entry above. */
  tied: boolean;
}

/** A leaderboard for one period. Computed on read; never stored. */
export interface Scoreboard {
  kind: PeriodKind;
  /** 'all-time' | 'YYYY-MM' | 'YYYY-MM-DD' */
  key: string;
  label: string;
  generatedAt: string;
  totalPoints: number;
  entries: LeaderboardEntry[];
}

export interface CurrentBoards {
  allTime: Scoreboard;
  monthly: Scoreboard;
  daily: Scoreboard;
  periods: { month: string; day: string };
}

export interface Pun {
  id: string;
  text: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The single document in the `content` collection, `_id: 'puns'`. */
export interface PunsDocument {
  id: 'puns';
  label: string;
  updatedAt: string;
  items: Pun[];
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  tier: AchievementTier;
  /** Lucide icon key resolved on the client. */
  icon: string;
}

export interface AchievementState extends AchievementDef {
  unlocked: boolean;
  /** Progress toward the goal, 0..1. */
  progress: number;
  progressLabel: string;
  unlockedAt: string | null;
}

export interface StreakSummary {
  currentWinStreak: number;
  longestWinStreak: number;
  currentDailyLeadStreak: number;
  longestDailyLeadStreak: number;
  daysAsDailyLeader: number;
  lastWinAt: string | null;
}

export interface ProfileBundle {
  user: PublicUser;
  streaks: StreakSummary;
  achievements: AchievementState[];
  ranks: {
    allTime: number | null;
    monthly: number | null;
    daily: number | null;
  };
  /** Most recent wins, newest first. */
  recentWins: WinEntry[];
  /** 'YYYY-MM-DD' -> wins, last 90 days, for the heat strip. */
  activity: Record<string, number>;
}

/** A card in the admin grid. */
export interface ContentTypeDescriptor {
  id: string;
  label: string;
  description: string;
  icon: string;
  keywords: string[];
  editable: boolean;
  itemCount: number;
  /** 'content' opens an editor; 'action' fires a one-shot operation. */
  kind: 'content' | 'action';
  unit?: string;
}

export interface ExportSummary {
  users: number;
  wins: number;
  content: number;
  totalBytes: number;
  filename: string;
}

/** Response from POST /api/scores/award. */
export interface AwardResponse {
  win: { id: string; at: string };
  winner: {
    id: string;
    displayName: string;
    avatarUrl: string;
    accentColor: string;
    allTime: number;
  };
  boards: { allTime: Scoreboard; monthly: Scoreboard; daily: Scoreboard };
}
