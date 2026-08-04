import type { GameResult, MetricAggregation, MetricDef } from '@scrapyard/shared';

/**
 * The metric engine's fixed vocabulary.
 *
 * Everything sortable or award-able is a "metric". Derived metrics (below) are
 * computed from a race result and can't be edited or deleted. Captured metrics
 * (kills, …) and formula metrics (Combat = 2·kills − deaths) are documents in
 * the `metrics` collection — see MetricsService.
 *
 * Boards rank on `wins` — first-place finishes, summed per period — with the
 * rest alongside as sortable columns. The client can re-sort any board by any
 * metric column.
 */

export const WINS_METRIC = 'wins';
/** The metric boards rank by, by default. */
export const DEFAULT_METRIC = 'wins';

/**
 * Built-in derived metrics, in display order. `order` 0–99 is reserved for
 * these; captured metrics start at 100 and formulas at 200 (see MetricsService).
 *
 * The first three lead deliberately, and in this exact sequence: wins, races,
 * score IS the board's tiebreak chain (most wins, then fewest races, then
 * highest score — see LeaderboardTable's comparator). Reading the columns left
 * to right therefore reads out why the rows are in the order they're in, and it
 * matches the `w / r / s` trio shown beside racers elsewhere.
 *
 * Anything after those three is genuinely supplementary — interesting, but not
 * part of deciding position. Renumbering here reorders columns on every board
 * and on the profile page at once, which is the point: one source of order.
 */
export const BUILT_IN_METRICS: MetricDef[] = [
  { id: 'wins', label: 'Wins', icon: 'crown', unit: 'wins', description: 'First-place finishes — the main ranking.', kind: 'derived', aggregation: 'sum', order: 0, enabled: true, builtin: true },
  { id: 'races', label: 'Races', icon: 'flag', unit: 'races', description: 'Races entered. Fewer races ranks higher when wins are tied.', kind: 'derived', aggregation: 'sum', order: 1, enabled: true, builtin: true },
  { id: 'gameScore', label: 'Score', icon: 'gauge', unit: 'pts', description: 'Total in-game score across all races. The last tiebreak.', kind: 'derived', aggregation: 'sum', order: 2, enabled: true, builtin: true },
  { id: 'bestScore', label: 'Best score', icon: 'zap', unit: 'pts', description: 'Highest in-game score in a single race.', kind: 'derived', aggregation: 'max', order: 3, enabled: true, builtin: true },
  { id: 'podiums', label: 'Podiums', icon: 'medal', unit: 'top-3', description: 'Finishes in the top three.', kind: 'derived', aggregation: 'sum', order: 4, enabled: true, builtin: true },
  { id: 'avgPlace', label: 'Avg place', icon: 'list-ordered', unit: 'place', description: 'Average finishing position (lower is better).', kind: 'derived', aggregation: 'avg', order: 5, enabled: true, builtin: true },
];

export const BUILT_IN_METRIC_IDS = new Set(BUILT_IN_METRICS.map((m) => m.id));

/** Metric ids a formula or rule may not reference as if they were additive. */
export const NON_ADDITIVE_METRICS = new Set(['bestScore', 'avgPlace']);

/**
 * One racer's derived base-metric values *for a single race*. Captured metrics
 * are merged on top from `result.stats`. Formula metrics are computed later,
 * from period totals, because they're combinations of these.
 */
export function derivedPerGame(result: GameResult): Record<string, number> {
  return {
    wins: result.place === 1 ? 1 : 0,
    podiums: result.place <= 3 ? 1 : 0,
    races: 1,
    gameScore: result.gameScore,
    bestScore: result.gameScore,
    avgPlace: result.place,
  };
}

/** Base (derived + captured) per-race values for one racer's result. */
export function basePerGame(result: GameResult, capturedIds: string[]): Record<string, number> {
  const values = derivedPerGame(result);
  for (const id of capturedIds) values[id] = Number(result.stats?.[id] ?? 0);
  return values;
}

/**
 * Fold a metric's per-race values into a single period total, honouring its
 * aggregation. `avgPlace` is the one metric that genuinely averages; sums cover
 * the additive majority and `max` covers "best single race".
 */
export function aggregate(values: number[], aggregation: MetricAggregation): number {
  if (values.length === 0) return 0;
  switch (aggregation) {
    case 'max':
      return Math.max(...values);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'last':
      return values[values.length - 1];
    case 'sum':
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}
