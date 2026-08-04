import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpDown, Search } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { Avatar, Label, Panel, Segmented } from '../components/ui/primitives';
import { RACE_COLOR_HEX } from '../lib/raceColors';

type SortKey = 'wins' | 'name' | 'newest';

/**
 * Racers page — the roster with all-time scores, reachable from the side menu.
 * Table on desktop, cards on mobile.
 */
export function UsersPage() {
  const { users, me, boards } = useApp();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('wins');

  const monthKey = boards?.periods.month ?? '';
  const dayKey = boards?.periods.day ?? '';

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = users.filter(
      (user) =>
        !needle ||
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle) ||
        user.favoriteRacer.toLowerCase().includes(needle),
    );

    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.displayName.localeCompare(b.displayName);
      if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt);
      return b.scores.allTime - a.scores.allTime || a.displayName.localeCompare(b.displayName);
    });
  }, [users, query, sort]);

  const maxWins = Math.max(1, ...users.map((user) => user.scores.allTime));

  return (
    <div className="space-y-6">
      <div>
        <Label>Roster</Label>
        <h1 className="headline mt-1">Racers</h1>
        <p className="mt-2 text-sm text-[var(--text-dim)]">
          Everyone who has signed in, with their all-time score.
        </p>
      </div>

      {/* Controls. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <input
            className="field !pl-10"
            placeholder="Search racers…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Segmented<SortKey>
          value={sort}
          onChange={setSort}
          accent="#00E5FF"
          className="sm:w-auto"
          options={[
            { value: 'wins', label: 'Wins' },
            { value: 'name', label: 'Name' },
            { value: 'newest', label: 'Newest' },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <Panel className="p-10 text-center">
          <p className="text-sm text-[var(--text-faint)]">Nobody matches “{query}”.</p>
        </Panel>
      ) : (
        <>
          {/* Desktop table. */}
          <Panel accent="#00E5FF" className="hidden overflow-hidden lg:block">
            <div className="grid grid-cols-[3rem_1fr_7rem_7rem_1fr] items-center gap-4 border-b border-hairline bg-white/[0.02] px-5 py-3">
              <Label>#</Label>
              <Label>Racer</Label>
              <Label className="text-right">Month</Label>
              <Label className="text-right">Today</Label>
              <Label className="text-right">All time</Label>
            </div>
            {rows.map((user, i) => (
              <Link
                key={user.id}
                to={`/racer/${user.id}`}
                className={`grid grid-cols-[3rem_1fr_7rem_7rem_1fr] items-center gap-4 border-b border-hairline/60 px-5 py-3 transition-colors last:border-b-0 hover:bg-white/[0.04] ${
                  user.id === me?.id ? 'bg-blaze/[0.06]' : ''
                }`}
              >
                <span className="font-display text-sm font-black tabular-nums text-[var(--text-faint)]">
                  {i + 1}
                </span>

                <span className="flex min-w-0 items-center gap-3">
                  <Avatar
                    src={user.avatarUrl}
                    name={user.displayName}
                    size={36}
                    accent={RACE_COLOR_HEX[user.raceColor]}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-display text-sm font-bold uppercase tracking-wide text-white">
                      {user.displayName}
                      {user.id === me?.id && <span className="ml-2 text-[0.6rem] text-blaze">you</span>}
                      {user.role === 'admin' && (
                        <span className="ml-2 border border-violet/50 px-1.5 py-px text-[0.5rem] tracking-widest text-violet">
                          ADMIN
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[0.62rem] text-[var(--text-faint)]">
                      {user.favoriteRacer} · {user.email}
                    </span>
                  </span>
                </span>

                <span className="text-right font-display text-sm tabular-nums text-[var(--text-dim)]">
                  {user.scores.monthly[monthKey] ?? 0}
                </span>
                <span className="text-right font-display text-sm tabular-nums text-[var(--text-dim)]">
                  {user.scores.daily[dayKey] ?? 0}
                </span>

                {/* All-time with an inline bar for at-a-glance comparison. */}
                <span className="flex items-center justify-end gap-3">
                  <span className="hidden h-1.5 w-full max-w-[10rem] overflow-hidden bg-white/[0.06] 3xl:block">
                    <span
                      className="block h-full"
                      style={{
                        width: `${(user.scores.allTime / maxWins) * 100}%`,
                        background: `linear-gradient(90deg, ${RACE_COLOR_HEX[user.raceColor]}, transparent)`,
                        boxShadow: `0 0 12px ${RACE_COLOR_HEX[user.raceColor]}`,
                      }}
                    />
                  </span>
                  <span
                    className="stat-number w-10 text-right text-lg"
                    style={{ color: '#fff', textShadow: `0 0 16px ${RACE_COLOR_HEX[user.raceColor]}` }}
                  >
                    {user.scores.allTime}
                  </span>
                </span>
              </Link>
            ))}
          </Panel>

          {/* Mobile cards. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:hidden">
            {rows.map((user, i) => (
              <Link key={user.id} to={`/racer/${user.id}`}>
                <Panel
                  accent={RACE_COLOR_HEX[user.raceColor]}
                  tight
                  className={`flex items-center gap-3 p-4 ${
                    user.id === me?.id ? 'ring-1 ring-blaze/40' : ''
                  }`}
                >
                  <span className="w-5 shrink-0 font-display text-xs font-black text-[var(--text-faint)]">
                    {i + 1}
                  </span>
                  <Avatar
                    src={user.avatarUrl}
                    name={user.displayName}
                    size={42}
                    accent={RACE_COLOR_HEX[user.raceColor]}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[0.8rem] font-bold uppercase tracking-wide text-white">
                      {user.displayName}
                    </span>
                    <span className="block truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
                      {user.favoriteRacer}
                    </span>
                  </span>
                  <span
                    className="stat-number shrink-0 text-xl"
                    style={{ color: '#fff', textShadow: `0 0 16px ${RACE_COLOR_HEX[user.raceColor]}` }}
                  >
                    {user.scores.allTime}
                  </span>
                </Panel>
              </Link>
            ))}
          </div>
        </>
      )}

      <p className="flex items-center gap-2 text-[0.65rem] text-[var(--text-faint)]">
        <ArrowUpDown size={12} />
        {rows.length} of {users.length} racers shown
      </p>
    </div>
  );
}

export default UsersPage;
