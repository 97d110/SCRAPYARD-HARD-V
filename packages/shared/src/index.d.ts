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
 * Shared constants (the racer roster, the built-in metric and achievement
 * definitions) live under `apps/api/src` and reach the client through the API.
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

// ─── Voice entry ─────────────────────────────────────────────────────────────

/** One racer the extractor placed, in finishing order within `VoiceDraft`. */
export interface VoiceDraftRow {
  racerId: string;
  /**
   * The name as it was actually spoken, kept so a wrong match is visible.
   * With no separate review step, the grid itself is where someone catches
   * "heard יוסי, filled in Dana" — which needs both halves on screen.
   */
  heardAs: string;
  /** null when no score was said for this racer. Never inferred from placement. */
  gameScore: number | null;
}

/**
 * A draft, emphatically not a submission: every field lands in the form as an
 * ordinary editable value and nothing is recorded until the usual Add Score
 * flow is completed by hand.
 */
export interface VoiceDraft {
  /** What the browser heard, echoed back so it's obvious when speech was the problem. */
  transcript: string;
  /** Winner first. Array order is the finishing order. */
  finishers: VoiceDraftRow[];
  /**
   * Names heard but matched to nobody. Surfaced rather than swallowed: it's
   * the difference between "who is Yossi?" and a silently short list.
   */
  unmatched: string[];
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

/** A page of games for the admin race log, newest first. */
export interface GamesPage {
  games: GameEntry[];
  /** Pass as `before` to fetch the next page; absent once there's no more. */
  nextBefore?: string;
}

/**
 * Response from deleting a game. Boards/achievements need no cascade — they're
 * aggregated fresh on read — but same-day revenge tags are resolved at write
 * time, so removing a game can leave later-that-day games flagging a grudge
 * that, from the ledger's perspective, never happened. `recomputedGames` is
 * how many of that day's other games had their revenge tags corrected.
 */
export interface DeleteGameResponse {
  deletedId: string;
  dayKey: string;
  recomputedGames: number;
}

/**
 * A browser's Web Push subscription, exactly as `PushManager.subscribe()`
 * hands it back (`JSON.stringify`-ed). The endpoint doubles as its own unique
 * id — a push service never issues the same one twice.
 */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
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
  raceColor: RaceColor;
  youKilledThem: number;
  theyKilledYou: number;
  yourRevenges: number;
}

// ─── Users ─────────────────────────────────────────────────────────────────

/**
 * The in-game car colors. BlazeRush renders exactly these four — never more,
 * never any other hue — so it's a closed set, not free text.
 *
 * This is a racer's own standing preference ("I always drive blue"), not
 * per-race data, so duplicates across the roster are allowed and expected:
 * four colors can't go around eight-plus racers.
 */
export type RaceColor = 'blue' | 'red' | 'green' | 'yellow';

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
  /** Total races entered (any place), all-time. */
  races: number;
  /**
   * Total in-game score across every race, all-time.
   *
   * Present so the `w / r / s` summary beside a racer's name can render
   * anywhere, not just on a leaderboard row — those three numbers are exactly
   * the board's tiebreak chain (most wins, then fewest races, then highest
   * score), so showing them is what makes a racer's position explicable.
   */
  gameScore: number;
  /** ISO timestamp of this racer's most recent race, or null if they've never raced. */
  lastRaceAt: string | null;
}

/**
 * One document in the `users` collection. `_id` is the Google `sub` claim.
 * Server-side only — the client receives `PublicUser`.
 */
export interface UserRecord {
  id: string;
  googleId?: string;
  email: string;
  role: UserRole;
  googleFullName: string;
  googleAvatarUrl: string;
  displayName: string;
  avatarUrl: string;
  tagline: string;
  favoriteRacer: string;
    raceColor: RaceColor;
  /**
   * This racer's name in Hebrew — first name, surname, nicknames, however
   * people actually refer to them out loud. Fed to the voice-entry extractor
   * so spoken Hebrew can be matched back to a racer whose `displayName` is
   * Latin; plain string similarity can't bridge the two scripts.
   */
  hebrewAliases: string[];
  /** Show `favoriteRacer`'s character art instead of the photo in `avatarUrl`. */
  useRacerArt: boolean;
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
  raceColor: RaceColor;
  hebrewAliases: string[];
  useRacerArt: boolean;
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
  raceColor: RaceColor;
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

// ─── Live updates ──────────────────────────────────────────────────────────

/**
 * What the server pushes down the WebSocket at `/api/live` when the database
 * changes, so every other open tab catches up without polling.
 *
 * ── These are notifications, not data ───────────────────────────────────────
 *
 * An event says *what changed*, and the client refetches the affected read
 * endpoint. It deliberately does not carry the new leaderboards, because that
 * would put a second copy of derived state on the wire and two races landing
 * out of order could leave a board stale — the same drift the file-based design
 * suffered from. A refetch always lands on the current aggregation.
 *
 * The one exception is the winner block on `game:recorded`: the celebration
 * needs a name, an accent and a win count at the instant it fires, and none of
 * that is recoverable from "something changed".
 */
export type LiveEventType =
  | 'game:recorded'
  | 'game:deleted'
  | 'roster:changed'
  | 'puns:changed'
  | 'metrics:changed'
  | 'achievement-rules:changed';

/** Why the roster moved. Only `profile` can be triggered by a non-admin. */
export type RosterChangeReason = 'created' | 'deleted' | 'profile' | 'login';

interface LiveEventBase {
  /**
   * The `X-Scrapyard-Client` id of the tab whose request caused this, when the
   * change arrived over HTTP. Absent for changes with no originating tab (a
   * Google sign-in redirect).
   *
   * This says who sent the request — *not* that they already know the result.
   * A tab only skips its own echo for the events whose response carries the
   * whole effect; see `SELF_APPLIED` in `apps/web/src/lib/live.ts`. Most
   * responses don't (a game delete answers with ids, not boards), so those
   * echoes have to be processed by the originating tab like any other.
   */
  origin?: string;
}

export interface GameRecordedEvent extends LiveEventBase {
  type: 'game:recorded';
  gameId: string;
  /** The first-place finisher — everything the flyby needs, nothing more. */
  winner: {
    id: string;
    displayName: string;
    avatarUrl: string;
    raceColor: RaceColor;
    /** Their all-time win count after this race. */
    allTime: number;
  };
}

export interface GameDeletedEvent extends LiveEventBase {
  type: 'game:deleted';
  gameId: string;
  dayKey: string;
}

export interface RosterChangedEvent extends LiveEventBase {
  type: 'roster:changed';
  reason: RosterChangeReason;
  /** The racer that moved, when it was a single one. */
  userId?: string;
}

/*
 * Config and content changes, which carry nothing beyond "refetch this".
 *
 * Three separate declarations rather than one with a three-way `type`, so that
 * every member of `LiveEvent` is discriminated by a single literal. That is what
 * lets `switch (frame.type)` narrow, and what lets a caller pick one event out
 * of a mixed list by its type alone.
 */
export interface PunsChangedEvent extends LiveEventBase {
  type: 'puns:changed';
}

export interface MetricsChangedEvent extends LiveEventBase {
  type: 'metrics:changed';
}

export interface AchievementRulesChangedEvent extends LiveEventBase {
  type: 'achievement-rules:changed';
}

export type LiveEvent =
  | GameRecordedEvent
  | GameDeletedEvent
  | RosterChangedEvent
  | PunsChangedEvent
  | MetricsChangedEvent
  | AchievementRulesChangedEvent;

/**
 * The first frame on a fresh connection. Purely a handshake receipt: it proves
 * the cookie was accepted, and `serverId` changes on every boot so a client can
 * tell a dropped connection (same server) from a redeploy (new one).
 */
export interface LiveHelloFrame {
  type: 'live:hello';
  at: string;
  userId: string;
  serverId: string;
}

/** An event as it goes over the wire — plus when the server sent it. */
export type LiveFrame = (LiveEvent & { at: string }) | LiveHelloFrame;

/** Response from POST /api/scores/record. */
export interface RecordGameResponse {
  game: { id: string; at: string };
  /** The first-place finisher — drives the celebration flyby. */
  winner: {
    id: string;
    displayName: string;
    avatarUrl: string;
    raceColor: RaceColor;
    allTime: number;
  };
  boards: { allTime: Scoreboard; monthly: Scoreboard; daily: Scoreboard };
}
