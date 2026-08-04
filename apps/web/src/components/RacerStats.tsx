import type { LeaderboardEntry, PublicUser } from '@scrapyard/shared';

/**
 * The three numbers that decide a racer's place, in the order they decide it:
 * `12 w / 40 r / 380 s`.
 *
 * Not an arbitrary summary — it's the leaderboard's tiebreak chain spelled out.
 * The board ranks by most wins, then FEWEST races, then highest score (see
 * `LeaderboardTable`'s comparator), so a racer sitting above another with the
 * same win count is explained entirely by the next number along. Showing these
 * together is what makes standings legible without opening the sortable table
 * and clicking through columns.
 *
 * The middle number reads "lower is better", which is worth knowing and is why
 * the tooltip spells it out rather than leaving `r` to be guessed.
 */

export interface RacerStatLine {
  wins: number;
  races: number;
  score: number;
}

/** From the roster/profile shape. */
export function statsFromUser(user: PublicUser): RacerStatLine {
  return {
    wins: user.scores.allTime,
    races: user.scores.races,
    score: user.scores.gameScore,
  };
}

/**
 * From a leaderboard row. Reads the same metric ids the comparator sorts on, so
 * the trio can never disagree with the ordering it's explaining.
 */
export function statsFromEntry(entry: LeaderboardEntry): RacerStatLine {
  const value = (id: string) => (typeof entry.metrics[id] === 'number' ? entry.metrics[id] : 0);
  return { wins: value('wins'), races: value('races'), score: value('gameScore') };
}

/** Plain text, for a `title` or an aria-label. */
export function formatRacerStats(stats: RacerStatLine): string {
  return `${stats.wins} w / ${stats.races} r / ${stats.score} s`;
}

const TOOLTIP = 'Wins / races / total score — the leaderboard tiebreak order (fewer races ranks higher)';

export function RacerStats({
  stats,
  className = '',
  /** Bumped up wherever it isn't crammed against other text. */
  size = 'xs',
}: {
  stats: RacerStatLine;
  className?: string;
  size?: 'xs' | 'sm';
}) {
  const text = size === 'sm' ? 'text-[0.66rem]' : 'text-[0.58rem]';
  return (
    <span
      className={`inline-flex shrink-0 items-baseline gap-[0.2rem] whitespace-nowrap font-mono tabular-nums ${text} text-[var(--text-dim)] ${className}`}
      title={TOOLTIP}
      aria-label={formatRacerStats(stats)}
    >
      {/* Numbers at full strength, units dimmed — the figures are what's being
          compared, and the letters are only there to say which is which. */}
      <span className="text-white/80">{stats.wins}</span>
      <span className="text-[var(--text-faint)]">w</span>
      <span className="text-[var(--text-faint)]">/</span>
      <span className="text-white/80">{stats.races}</span>
      <span className="text-[var(--text-faint)]">r</span>
      <span className="text-[var(--text-faint)]">/</span>
      <span className="text-white/80">{stats.score}</span>
      <span className="text-[var(--text-faint)]">s</span>
    </span>
  );
}
