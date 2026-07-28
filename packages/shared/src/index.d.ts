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
 * Shared constants (the racer roster, the accent palette, the built-in metric
 * and achievement definitions) live under `apps/api/src` and reach the client
 * through the API.
 *
 * ── The data model, in one paragraph ────────────────────────────────────────
 *
 * A race is one immutable `GameEntry`: up to four `GameResult` rows, each a
 * racer's finishing place (1–4) plus their in-game score and a bag of captured
 * stats (kills, etc.). Everything sortable or award-able is a *metric*: derived
 * from the placement (points, wins, podiums…), captured per race (kills…), or a
 * formula combining others. Leaderboards aggregate every metric per racer on
 * read; achievements are threshold rules over those metrics plus a few coded
 * specials. Nothing derived is ever stored — see ScoreboardRepository.
 */

export type UserRole = 'racer' | 'admin';

/** Period keys: 'all-time' | 'YYYY-MM' | 'YYYY-MM-DD'. */
export type PeriodKind = 'all-time' | 'monthly' | 'daily';

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'plasma';

// ─── Metrics ─────────────────────────────────────────────────────────────────

/**
 *  - `derived`  computed from a race result itself (points, wins, podiums,
 *               races, gameScore, bestScore, avgPlace). Built in; not editable.
 *  - `captured` a number typed in per racer per race (kills, deaths, …).
 *               Admin-created. Stored on `GameResult.stats[id]`.
 *  - `formula`  a weighted combination of other metrics (a "scoring system"),
 *               e.g. Combat = 2·kills − 1·deaths. Admin-created.
 */
export type MetricKind = 'derived' | 'captured' | 'formula';

/** How a metric's per-race values roll up into a period total. */
export type MetricAggregation = 'sum' | 'max' | 'avg' | 'last';

/** One term of a formula metric: `weight` × the value of `metricId`. */
export interface FormulaTerm {
  metricId: string;
  weight: number;
}

/**
 * A metric definition. Derived metrics are built-in constants; captured and
 * formula metrics are documents in the `metrics` collection, editable by admins.
 */
export interface MetricDef {
  /** Slug, e.g. 'kills'. Stable — stats and rules reference it. */
  id: string;
  label: string;
  /** Lucide icon key, resolved on the client. */
  icon: string;
  /** Short suffix shown after the value, e.g. 'pts', 'kills'. */
  unit?: string;
  description?: string;
  kind: MetricKind;
  /** Roll-up strategy for captured metrics; ignored for derived/formula. */
  aggregation: MetricAggregation;
  /** Present only for formula metrics. References derived/captured metrics. */
  formula?: FormulaTerm[];
  /** Higher shows/sorts later; built-ins occupy the low range. */
  order: number;
  enabled: boolean;
  /** Built-in metrics can't be deleted or have their kind changed. */
  builtin: boolean;
}

/** A metric as it appears in a leaderboard header — the render contract. */
export interface MetricColumn {
  id: string;
  label: string;
  icon: string;
  unit?: string;
  kind: MetricKind;
}

// ─── Games ───────────────────────────────────────────────────────────────────

/** One racer's finish in a race. `place` 1 is the winner. */
export interface GameResult {
  racerId: string;
  /** 1 = first … up to the field size (max 4). */
  place: number;
  /** In-game final score (BlazeRush races run to ~15). */
  gameScore: number;
  /** Captured metric values, keyed by metric id. Absent keys read as 0. */
  stats: Record<string, number>;
}

/** The client's payload for one row when recording a race. */
export interface GameResultInput {
  racerId: string;
  place: number;
  /** Optional — a winner-only entry can omit it; the server defaults it to 0. */
  gameScore?: number;
  stats?: Record<string, number>;
}

/** A "who got whom" the client sends when recording a race. */
export interface KillEventInput {
  killerId: string;
  victimId: string;
}

/**
 * One directed kill inside a race: `killerId` took out `victimId`. `revenge`
 * is decided server-side against a same-day grudge ledger — it's true when the
 * killer was themselves killed by this victim earlier the same day and that
 * death was still unavenged. From the kill log we derive each racer's kills
 * (as killer) and deaths (as victim), so those stats are never typed by hand.
 */
export interface KillEvent {
  killerId: string;
  victimId: string;
  revenge: boolean;
}

/**
 * One document in the `games` collection.
 *
 * Games are **immutable events** — the load-bearing idea of the whole data
 * model. Recording a race is a single `insertOne`, atomic by definition, with
 * no read-modify-write and no lock. Every board and every achievement is a
 * fresh aggregation over this collection, so nothing derived can drift from it.
 */
export interface GameEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  monthKey: string;
  dayKey: string;
  /** Who recorded the race. */
  awardedBy: string;
  /** Optional free text, e.g. the track. */
  note?: string;
  /** 2–4 finishers, sorted by place ascending. */
  results: GameResult[];
  /** The kill log — every killer→victim event, revenge already resolved. */
  events: KillEvent[];
}

/** One racer's slice of a race, for their profile timeline. */
export interface GameParticipation {
  gameId: string;
  at: string;
  dayKey: string;
  monthKey: string;
  note?: string;
  place: number;
  fieldSize: number;
  gameScore: number;
  /** Metric values this racer earned in the race (derived + captured). */
  metrics: Record<string, number>;
  /** This racer's kills and deaths in the race, with revenge tags. */
  events: KillEvent[];
}

/**
 * One head-to-head rivalry for a racer's profile. `theyKilledYou` is what makes
 * a nemesis; `youKilledThem` is the flip side. `yourRevenges` counts how many
 * of your kills on them settled a same-day score.
 */
export interface Rival {
  userId: string;
  displayName: string;
  avatarUrl: string;
  accentColor: string;
  youKilledThem: number;
  theyKilledYou: number;
  yourRevenges: number;
}

// ─── Users ─────────────────────────────────────────────────────────────────

/**
 * Win counts for the periods currently on screen. A "win" is a first-place
 * finish. Historical figures come from the scoreboard endpoints.
 */
export interface UserScores {
  allTime: number;
  /** 'YYYY-MM' -> wins. Current month only. */
  monthly: Record<string, number>;
  /** 'YYYY-MM-DD' -> wins. Today only. */
  daily: Record<string, number>;
}

/**
 * One document in the `users` collection. `_id` is the Google `sub` claim.
 * Server-side only — the client receives `PublicUser`.
 */
export interface UserRecord {
  id: string;
  googleId?: string;
  email: string;
  domain: string;
  role: UserRole;
  googleFullName: string;
  googleAvatarUrl: string;
  displayName: string;
  avatarUrl: string;
  tagline: string;
  favoriteRacer: string;
  accentColor: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
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
  claimed: boolean;
  scores: UserScores;
}

// ─── Leaderboards ─────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  /** Rank by the board's default metric (in-game score), tie-aware. */
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string;
  accentColor: string;
  favoriteRacer: string;
  /** Convenience mirror of `metrics[defaultMetric]` — the value rows rank by. */
  primary: number;
  /** Every metric's period total for this racer, keyed by metric id. */
  metrics: Record<string, number>;
  /** True when tied with the entry above on the default metric. */
  tied: boolean;
}

/** A leaderboard for one period. Computed on read; never stored. */
export interface Scoreboard {
  kind: PeriodKind;
  /** 'all-time' | 'YYYY-MM' | 'YYYY-MM-DD' */
  key: string;
  label: string;
  generatedAt: string;
  /** The metric id rows are ranked by server-side. Defaults to 'gameScore'. */
  defaultMetric: string;
  /** Column definitions, in display order — the client sorts by any of them. */
  columns: MetricColumn[];
  /** Sum of the default metric across the board — the headline total. */
  total: number;
  entries: LeaderboardEntry[];
}

export interface CurrentBoards {
  allTime: Scoreboard;
  monthly: Scoreboard;
  daily: Scoreboard;
  periods: { month: string; day: string };
}

// ─── Content ─────────────────────────────────────────────────────────────

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

// ─── Achievements ─────────────────────────────────────────────────────────

/** The window a metric threshold is measured over. */
export type AchievementScope = 'all-time' | 'monthly' | 'daily' | 'game';

/**
 * A data-driven achievement: unlocked when `metricId` reaches `threshold`
 * within `scope`. 'daily'/'monthly' mean the racer's best single day/month;
 * 'game' means a single race. Admin-editable in the `achievementRules`
 * collection. Covers the win / points / day-count / kills families.
 */
export interface AchievementRule {
  id: string;
  name: string;
  description: string;
  tier: AchievementTier;
  icon: string;
  metricId: string;
  scope: AchievementScope;
  threshold: number;
  order: number;
  enabled: boolean;
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  tier: AchievementTier;
  /** Lucide icon key resolved on the client. */
  icon: string;
  /**
   * 'rule'    — data-driven metric threshold (editable by admins).
   * 'special' — coded logic that isn't a simple threshold (happy hour,
   *             back-to-back, streaks, comeback). Read-only.
   */
  source: 'rule' | 'special';
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
  /** All-time period totals for every metric, keyed by metric id. */
  totals: Record<string, number>;
  /** The metric columns, so the profile can label `totals`. */
  columns: MetricColumn[];
  ranks: {
    allTime: number | null;
    monthly: number | null;
    daily: number | null;
  };
  /** Most recent races this racer was in, newest first. */
  recentGames: GameParticipation[];
  /** Head-to-head rivalries, worst nemesis first. Empty when no kills logged. */
  rivals: Rival[];
  /** 'YYYY-MM-DD' -> wins, last 90 days, for the heat strip. */
  activity: Record<string, number>;
}

// ─── Admin ─────────────────────────────────────────────────────────────────

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
  games: number;
  content: number;
  totalBytes: number;
  filename: string;
}

/** Response from POST /api/scores/record. */
export interface RecordGameResponse {
  game: { id: string; at: string };
  /** The first-place finisher — drives the celebration flyby. */
  winner: {
    id: string;
    displayName: string;
    avatarUrl: string;
    accentColor: string;
    allTime: number;
  };
  boards: { allTime: Scoreboard; monthly: Scoreboard; daily: Scoreboard };
}
