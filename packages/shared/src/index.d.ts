/**
 * Shared domain types — the single source of truth for both apps.
 *
 * Imported as `@scrapyard/shared` via the `paths` mapping in tsconfig.base.json.
 *
 * ── Why this is a .d.ts, and why it contains only types ─────────────────────
 *
 * Two properties fall out of that, and both matter:
 *
 *  1. **It erases completely.** Type-only imports leave no `require()` in the
 *     compiled API output, so there is nothing to resolve at runtime — no
 *     tsc-alias step, no tsconfig-paths loader, no bundler. `node dist/main.js`
 *     just works.
 *
 *  2. **It is exempt from `rootDir`.** TypeScript excludes declaration files
 *     from the rootDir containment check, so the API can keep
 *     `rootDir: src` and emit a flat `dist/main.js` while still importing
 *     from outside its own directory.
 *
 * The trade-off: no runtime values can live here — no `const`, no `enum`, no
 * functions. Shared constants (the racer roster, accent palette) therefore stay
 * in `apps/api/src/users/users.service.ts` and are delivered to the client over
 * `GET /api/users/options`. If you ever need genuine shared runtime code, this
 * becomes a real `.ts` module and the API build has to bundle or alias-rewrite.
 */

export type UserRole = 'racer' | 'admin';

/** Period keys: 'all-time' | 'YYYY-MM' | 'YYYY-MM-DD'. */
export type PeriodKind = 'all-time' | 'monthly' | 'daily';

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'plasma';

export interface UserScores {
  allTime: number;
  /** 'YYYY-MM' -> wins */
  monthly: Record<string, number>;
  /** 'YYYY-MM-DD' -> wins */
  daily: Record<string, number>;
}

export interface WinEntry {
  /** Unique id for the win, so a mis-entry can be traced. */
  id: string;
  /** ISO timestamp of when the win was recorded. */
  at: string;
  /** Period keys this win was filed under, cached for cheap auditing. */
  monthKey: string;
  dayKey: string;
  /** User id of whoever pressed the button. */
  awardedBy: string;
  /** Optional free-text, e.g. the track it happened on. */
  note?: string;
}

/**
 * One file per user, at `database/users/<id>.json`. **Server-side only** —
 * this is the source of truth and carries the full win log. The client never
 * sees it; it gets `PublicUser`.
 */
export interface UserRecord {
  id: string;
  /** Google `sub` claim — the stable account identifier. */
  googleId: string;
  email: string;
  domain: string;
  role: UserRole;

  /** Straight from Google, never edited. Used as the reset target. */
  googleFullName: string;
  googleAvatarUrl: string;

  /** User-editable profile. */
  displayName: string;
  avatarUrl: string;
  tagline: string;
  /** One of the 16 BlazeRush pilots — pure flavour. */
  favoriteRacer: string;
  /** Hex accent used for the user's neon glow across the UI. */
  accentColor: string;

  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;

  scores: UserScores;
  wins: WinEntry[];
}

/** Public projection — no domain internals, no win log. */
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

/** One file per period, at `database/scores/<slug>.json`. */
export interface ScoreboardFile {
  kind: PeriodKind;
  /** 'all-time' | 'YYYY-MM' | 'YYYY-MM-DD' */
  key: string;
  label: string;
  generatedAt: string;
  totalPoints: number;
  entries: LeaderboardEntry[];
}

/** The three boards the main page opens with. */
export interface CurrentBoards {
  allTime: ScoreboardFile;
  monthly: ScoreboardFile;
  daily: ScoreboardFile;
  periods: { month: string; day: string };
}

/** `database/index/index.json` — pointers to every other file. */
export interface IndexFile {
  version: number;
  updatedAt: string;
  counts: {
    users: number;
    scoreboards: number;
    content: number;
  };
  users: Array<{
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    file: string;
  }>;
  scoreboards: Array<{
    kind: PeriodKind;
    key: string;
    entryCount: number;
    file: string;
  }>;
  content: Array<{
    id: string;
    label: string;
    itemCount: number;
    file: string;
  }>;
}

export interface Pun {
  id: string;
  text: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `database/content/puns.json` */
export interface PunsFile {
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
  /** Consecutive calendar days with at least one win, ending today or yesterday. */
  currentWinStreak: number;
  longestWinStreak: number;
  /** Consecutive days finishing #1 on the daily board. */
  currentDailyLeadStreak: number;
  longestDailyLeadStreak: number;
  /** Total days this user topped the daily board. */
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
  /** Search terms the admin grid matches against. */
  keywords: string[];
  editable: boolean;
  itemCount: number;
  /** 'content' opens an editor; 'action' fires a one-shot operation. */
  kind: 'content' | 'action';
  /** Unit shown next to itemCount, e.g. "puns", "files". */
  unit?: string;
}

export interface ExportSummary {
  users: number;
  scoreboards: number;
  content: number;
  index: number;
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
  boards: { allTime: ScoreboardFile; monthly: ScoreboardFile; daily: ScoreboardFile };
}
