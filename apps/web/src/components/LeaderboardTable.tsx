import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Crown, Trophy } from 'lucide-react';
import { Avatar, Label, Panel } from './ui/primitives';
import type { LeaderboardEntry, MetricColumn, Scoreboard } from '@scrapyard/shared';

/**
 * The leaderboard. Podium cards for the top three by in-game score, then a
 * dense sortable table with a column per metric — click any header to re-rank
 * the whole field by kills, best score, average place, a custom formula,
 * whatever the admin has defined. Score stays the headline number on the podium.
 */

/** Where the chosen sort is remembered between visits. */
const SORT_STORAGE_KEY = 'scrapyard:leaderboard-sort';

type SortDir = 'asc' | 'desc';
interface SortState {
  columnId: string;
  dir: SortDir;
}

/** A metric's value for a racer, straight from its per-period totals. */
function metricValue(entry: LeaderboardEntry, id: string): number {
  const value = entry.metrics[id];
  return typeof value === 'number' ? value : 0;
}

/** Integers as-is; the one averaged metric (avgPlace) to a single decimal. */
function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function readStoredSort(): SortState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SortState>;
    if (typeof parsed.columnId === 'string' && (parsed.dir === 'asc' || parsed.dir === 'desc')) {
      return { columnId: parsed.columnId, dir: parsed.dir };
    }
  } catch {
    // Corrupt value — fall back to the board default.
  }
  return null;
}

export function LeaderboardTable({
  board,
  highlightUserId,
  emptyHint,
}: {
  board: Scoreboard;
  highlightUserId?: string;
  emptyHint?: string;
}) {
  // Podium is always by the default metric (wins); the table below re-ranks.
  const podium = board.entries.filter((entry) => entry.primary > 0).slice(0, 3);
  const primaryLabel = (
    board.columns.find((column) => column.id === board.defaultMetric)?.label ?? 'Wins'
  ).toLowerCase();

  // A racer belongs in the standings the moment they've entered a race, even if
  // they scored zero doing it. "Yet to race" is the stricter "never raced":
  // no score and no races on the board.
  const racedCount = (entry: LeaderboardEntry) => metricValue(entry, 'races');
  const raced = board.entries.filter((entry) => entry.primary > 0 || racedCount(entry) > 0);
  const unraced = board.entries.filter((entry) => entry.primary === 0 && racedCount(entry) === 0);

  // Sort state, seeded from localStorage then validated against this board's
  // columns — a persisted column that no longer exists falls back to points.
  const [sort, setSort] = useState<SortState>(() => {
    const stored = readStoredSort();
    return stored ?? { columnId: board.defaultMetric, dir: 'desc' };
  });

  useEffect(() => {
    const valid = board.columns.some((column) => column.id === sort.columnId);
    if (!valid) setSort({ columnId: board.defaultMetric, dir: 'desc' });
  }, [board.columns, board.defaultMetric, sort.columnId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // Private mode / storage disabled — sorting still works, just isn't remembered.
    }
  }, [sort]);

  const onSort = (columnId: string) => {
    setSort((prev) =>
      prev.columnId === columnId
        ? { columnId, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { columnId, dir: 'desc' },
    );
  };

  const sorted = useMemo(() => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...raced].sort((a, b) => {
      const delta = (metricValue(a, sort.columnId) - metricValue(b, sort.columnId)) * dir;
      if (delta !== 0) return delta;
      // Stable, meaningful tiebreak: the default metric (score), then name.
      return b.primary - a.primary || a.displayName.localeCompare(b.displayName);
    });
    // `raced` is derived fresh each render; depend on the board identity instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.entries, sort]);

  if (raced.length === 0) {
    return (
      <Panel accent="#7C5CFF" lit className="p-10 text-center">
        <Trophy className="mx-auto mb-4 opacity-30" size={40} />
        <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-[var(--text-dim)]">
          No races yet
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--text-faint)]">
          {emptyHint ?? 'Hit Record Race once the crew actually runs one.'}
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      {/* Podium — top three by in-game score. */}
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
              leaderValue={podium[0].primary}
              label={primaryLabel}
              isMe={entry.userId === highlightUserId}
            />
          ))}
        </div>
      )}

      {/* Full standings — sortable by any metric column. */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <Label>Full standings · sort by any column</Label>
          <span className="hidden font-mono text-[0.6rem] text-[var(--text-faint)] sm:inline">
            sorted by {board.columns.find((c) => c.id === sort.columnId)?.label ?? sort.columnId}
            {' '}
            {sort.dir === 'desc' ? 'high → low' : 'low → high'}
          </span>
        </div>

        <Panel accent="#00E5FF" className="overflow-hidden">
          <div className="no-scrollbar overflow-x-auto">
            <SortableTable
              columns={board.columns}
              rows={sorted}
              sort={sort}
              onSort={onSort}
              highlightUserId={highlightUserId}
            />
          </div>
        </Panel>
      </div>

      {/* Everyone who hasn't raced this period, collapsed into a quiet strip. */}
      {unraced.length > 0 && (
        <div>
          <Label className="mb-2">Yet to race this period · {unraced.length}</Label>
          <div className="flex flex-wrap gap-2">
            {unraced.map((entry) => (
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

/**
 * The dense metric table. Built on CSS grid rather than <table> so each row can
 * be a single <Link> to the profile; the leading rank + racer cells are frozen
 * to the left while the metric columns scroll horizontally on narrow screens.
 */
function SortableTable({
  columns,
  rows,
  sort,
  onSort,
  highlightUserId,
}: {
  columns: MetricColumn[];
  rows: LeaderboardEntry[];
  sort: SortState;
  onSort: (columnId: string) => void;
  highlightUserId?: string;
}) {
  // rank + racer, then one column per metric. Tracks are content-INDEPENDENT
  // (fixed `1fr`, never `max-content`) and every grid shares the same explicit
  // `minWidth`, so the header and every row resolve to identical column widths
  // and actually line up. `max-content` here was the bug: each grid is its own
  // container, so it sized columns to its own content and nothing aligned.
  const template = `2.5rem minmax(9rem, 1.6fr) repeat(${columns.length}, minmax(4.5rem, 1fr))`;
  const minWidth = `${11.5 + columns.length * 5}rem`;

  return (
    <div className="no-scrollbar overflow-x-auto">
      {/* Header. */}
      <div
        className="grid items-stretch border-b border-hairline bg-white/[0.02]"
        style={{ gridTemplateColumns: template, minWidth }}
      >
        <span className="flex items-center justify-center px-2 py-2.5">
          <Label className="!text-[0.5rem]">#</Label>
        </span>
        <span className="flex items-center px-3 py-2.5">
          <Label className="!text-[0.5rem]">Racer</Label>
        </span>
        {columns.map((column) => {
          const active = column.id === sort.columnId;
          return (
            <button
              key={column.id}
              onClick={() => onSort(column.id)}
              title={`Sort by ${column.label}`}
              className={`flex items-center justify-end gap-1 px-2.5 py-2.5 text-right transition-colors hover:bg-white/[0.04] ${
                active ? 'bg-white/[0.05]' : ''
              }`}
            >
              <span className="flex flex-col items-end leading-tight">
                <span
                  className={`font-display text-[0.55rem] font-bold uppercase tracking-[0.12em] ${
                    active ? 'text-white' : 'text-[var(--text-dim)]'
                  }`}
                >
                  {column.label}
                </span>
                {column.unit && (
                  <span className="font-mono text-[0.5rem] text-[var(--text-faint)]">
                    {column.unit}
                  </span>
                )}
              </span>
              {active ? (
                sort.dir === 'desc' ? (
                  <ArrowDown size={12} className="shrink-0 text-plasma" />
                ) : (
                  <ArrowUp size={12} className="shrink-0 text-plasma" />
                )
              ) : (
                <ArrowUpDown size={11} className="shrink-0 text-[var(--text-faint)] opacity-50" />
              )}
            </button>
          );
        })}
      </div>

      {/* Rows, numbered by the current sort. */}
      {rows.map((entry, index) => {
        const isMe = entry.userId === highlightUserId;
        return (
          <Link
            key={entry.userId}
            to={`/racer/${entry.userId}`}
            className={`grid items-center border-b border-hairline/60 transition-colors last:border-b-0 hover:bg-white/[0.04] ${
              isMe ? 'bg-blaze/[0.07]' : ''
            }`}
            style={{ gridTemplateColumns: template, minWidth, ['--glow' as string]: entry.accentColor }}
          >
            <span className="px-2 py-3 text-center font-display text-xs font-black tabular-nums text-[var(--text-dim)] sm:text-sm">
              {index + 1}
            </span>

            <span className="flex min-w-0 items-center gap-2.5 px-3 py-3 sm:gap-3">
              <Avatar
                src={entry.avatarUrl}
                name={entry.displayName}
                size={32}
                accent={entry.accentColor}
              />
              <span className="min-w-0">
                <span className="block truncate font-display text-[0.75rem] font-bold uppercase tracking-wide text-white transition group-hover:neon-soft sm:text-[0.82rem]">
                  {entry.displayName}
                  {isMe && <span className="ml-2 text-[0.6rem] text-blaze">you</span>}
                </span>
                <span className="block truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
                  {entry.favoriteRacer}
                </span>
              </span>
            </span>

            {columns.map((column) => {
              const active = column.id === sort.columnId;
              const value = metricValue(entry, column.id);
              return (
                <span
                  key={column.id}
                  className={`px-2.5 py-3 text-right font-display tabular-nums ${
                    active
                      ? 'text-base font-black text-white'
                      : 'text-sm font-bold text-[var(--text-dim)]'
                  }`}
                  style={active ? { textShadow: `0 0 14px ${entry.accentColor}` } : undefined}
                >
                  {formatMetric(value)}
                </span>
              );
            })}
          </Link>
        );
      })}
    </div>
  );
}

function PodiumCard({
  entry,
  slot,
  leaderValue,
  label,
  isMe,
}: {
  entry: LeaderboardEntry;
  /** 1-3 layout position. Drives size and vertical lift only. */
  slot: number;
  leaderValue: number;
  /** The default metric's label, e.g. 'wins'. */
  label: string;
  isMe: boolean;
}) {
  // Medal colour follows the server's rank, so ties share a colour.
  const medal = ['#FFB020', '#CFE3FF', '#FF8A3D'][Math.min(entry.rank, 3) - 1];
  // First slot sits slightly higher and larger — a real podium.
  const lift = slot === 1 ? 'sm:-translate-y-3' : slot === 2 ? 'sm:translate-y-0' : 'sm:translate-y-2';
  const share = leaderValue > 0 ? (entry.primary / leaderValue) * 100 : 0;

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
            {entry.primary}
          </span>
          <span className="label pb-1.5">{label}</span>
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

export default LeaderboardTable;
