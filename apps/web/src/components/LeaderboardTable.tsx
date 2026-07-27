import { Link } from 'react-router-dom';
import { Crown, Minus, Trophy } from 'lucide-react';
import { Avatar, Label, Panel } from './ui/primitives';
import type { LeaderboardEntry, Scoreboard } from '@scrapyard/shared';

/**
 * The leaderboard. Podium cards for the top three, then a dense rank list.
 * On very wide screens the list splits into two columns so a long roster
 * doesn't leave half the wall empty.
 */
export function LeaderboardTable({
  board,
  highlightUserId,
  emptyHint,
}: {
  board: Scoreboard;
  highlightUserId?: string;
  emptyHint?: string;
}) {
  const scored = board.entries.filter((entry) => entry.points > 0);
  const podium = scored.slice(0, 3);
  const rest = scored.slice(3);
  const unscored = board.entries.filter((entry) => entry.points === 0);

  if (scored.length === 0) {
    return (
      <Panel accent="#7C5CFF" lit className="p-10 text-center">
        <Trophy className="mx-auto mb-4 opacity-30" size={40} />
        <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-[var(--text-dim)]">
          No scores yet
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--text-faint)]">
          {emptyHint ?? 'Hit Add Score once someone actually wins something.'}
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      {/* Podium. */}
      {podium.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          {podium.map((entry, i) => (
            <PodiumCard
              key={entry.userId}
              entry={entry}
              /* Layout position drives the visual lift; the medal and the label
                 come from the server's tie-aware rank, so a three-way tie shows
                 three golds rather than gold/silver/bronze. */
              slot={i + 1}
              leaderPoints={podium[0].points}
              isMe={entry.userId === highlightUserId}
            />
          ))}
        </div>
      )}

      {/* The rest, in rank order. */}
      {rest.length > 0 && (
        <Panel accent="#00E5FF" className="overflow-hidden">
          <div className="grid grid-cols-1 3xl:grid-cols-2 3xl:gap-x-px 3xl:[&>*:nth-child(even)]:border-l 3xl:[&>*:nth-child(even)]:border-hairline">
            {rest.map((entry) => (
              <RankRow
                key={entry.userId}
                entry={entry}
                isMe={entry.userId === highlightUserId}
              />
            ))}
          </div>
        </Panel>
      )}

      {/* Everyone with zero, collapsed into a quiet strip. */}
      {unscored.length > 0 && (
        <div>
          <Label className="mb-2">
            Yet to score this period · {unscored.length}
          </Label>
          <div className="flex flex-wrap gap-2">
            {unscored.map((entry) => (
              <Link
                key={entry.userId}
                to={`/racer/${entry.userId}`}
                className={`flex items-center gap-2 border border-hairline bg-white/[0.015] px-2.5 py-1.5 transition hover:border-white/25 hover:bg-white/[0.05] ${
                  entry.userId === highlightUserId ? 'border-blaze/50' : ''
                }`}
              >
                <Avatar
                  src={entry.avatarUrl}
                  name={entry.displayName}
                  size={22}
                  accent={entry.accentColor}
                />
                <span className="max-w-[10rem] truncate text-xs text-[var(--text-dim)]">
                  {entry.displayName}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PodiumCard({
  entry,
  slot,
  leaderPoints,
  isMe,
}: {
  entry: LeaderboardEntry;
  /** 1-3 layout position. Drives size and vertical lift only. */
  slot: number;
  leaderPoints: number;
  isMe: boolean;
}) {
  // Medal colour follows the server's rank, so ties share a colour.
  const medal = ['#FFB020', '#CFE3FF', '#FF8A3D'][Math.min(entry.rank, 3) - 1];
  // First slot sits slightly higher and larger — a real podium.
  const lift = slot === 1 ? 'sm:-translate-y-3' : slot === 2 ? 'sm:translate-y-0' : 'sm:translate-y-2';
  const share = leaderPoints > 0 ? (entry.points / leaderPoints) * 100 : 0;

  return (
    <Link to={`/racer/${entry.userId}`} className={`group block transition-transform ${lift}`}>
      <Panel
        accent={medal}
        lit
        className={`relative h-full overflow-hidden p-5 transition-all duration-300 group-hover:-translate-y-1 ${
          slot === 1 ? 'sm:p-7' : ''
        } ${isMe ? 'ring-1 ring-blaze/50' : ''}`}
      >
        {/* Oversized ghost rank digit. */}
        <span
          className="pointer-events-none absolute -right-3 -top-6 font-display text-[7rem] font-black leading-none opacity-[0.07] sm:text-[9rem]"
          style={{ color: medal }}
        >
          {entry.rank}
        </span>

        {entry.rank === 1 && (
          <Crown
            size={20}
            className="absolute right-4 top-4 animate-pulse-glow"
            style={{ color: medal }}
          />
        )}

        <div className="relative flex items-center gap-4">
          <Avatar
            src={entry.avatarUrl}
            name={entry.displayName}
            size={slot === 1 ? 68 : 56}
            accent={entry.accentColor}
            rank={entry.rank}
          />
          <div className="min-w-0 flex-1">
            <Label>
              {entry.rank === 1 ? 'Leader' : `#${entry.rank}`}
              {entry.tied && ' · tied'}
            </Label>
            <p className="mt-0.5 truncate font-display text-base font-black uppercase tracking-wide text-white sm:text-lg">
              {entry.displayName}
            </p>
            <p className="truncate font-mono text-[0.65rem] text-[var(--text-faint)]">
              {entry.favoriteRacer}
            </p>
          </div>
        </div>

        <div className="relative mt-5 flex items-end justify-between">
          <span
            className="stat-number text-[clamp(2rem,1.4rem+2vw,3.4rem)] leading-none"
            style={{ color: '#fff', textShadow: `0 0 24px ${medal}` }}
          >
            {entry.points}
          </span>
          <span className="label pb-1.5">{entry.points === 1 ? 'win' : 'wins'}</span>
        </div>

        {/* Bar filled relative to the leader — the visual weight of the gap. */}
        <div className="relative mt-3 h-1 w-full overflow-hidden bg-white/5">
          <span
            className="absolute inset-y-0 left-0 transition-[width] duration-700"
            style={{
              width: `${share}%`,
              background: `linear-gradient(90deg, ${medal}, ${medal}55)`,
              boxShadow: `0 0 12px ${medal}`,
            }}
          />
        </div>
      </Panel>
    </Link>
  );
}

function RankRow({ entry, isMe }: { entry: LeaderboardEntry; isMe: boolean }) {
  return (
    <Link
      to={`/racer/${entry.userId}`}
      className={`group flex items-center gap-3 border-b border-hairline/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-white/[0.04] sm:gap-4 sm:px-5 ${
        isMe ? 'bg-blaze/[0.07]' : ''
      }`}
      style={{ ['--glow' as string]: entry.accentColor }}
    >
      <span className="w-8 shrink-0 text-center font-display text-sm font-black tabular-nums text-[var(--text-dim)] sm:w-10 sm:text-base">
        {entry.tied ? (
          <Minus size={14} className="mx-auto opacity-50" />
        ) : (
          entry.rank
        )}
      </span>

      <Avatar
        src={entry.avatarUrl}
        name={entry.displayName}
        size={36}
        accent={entry.accentColor}
      />

      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-[0.8rem] font-bold uppercase tracking-wide text-white transition group-hover:neon-soft sm:text-sm">
          {entry.displayName}
          {isMe && <span className="ml-2 text-[0.6rem] text-blaze">you</span>}
        </span>
        <span className="block truncate font-mono text-[0.62rem] text-[var(--text-faint)]">
          {entry.favoriteRacer}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <span
          className="stat-number text-lg sm:text-xl"
          style={{ color: '#fff', textShadow: `0 0 16px ${entry.accentColor}` }}
        >
          {entry.points}
        </span>
      </span>
    </Link>
  );
}

export default LeaderboardTable;
