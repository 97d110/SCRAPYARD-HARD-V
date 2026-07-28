import { useMemo, useState } from 'react';
import { Plus, Radio } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { LeaderboardTable } from '../components/LeaderboardTable';
import { AddScoreOverlay } from '../components/AddScoreOverlay';
import { RacerBadge } from '../components/RacerBadge';
import { NeonButton, Panel, Segmented, Stat } from '../components/ui/primitives';
import type { PeriodKind } from '@scrapyard/shared';

/**
 * Main page: the three leaderboards plus the Add Score entry point.
 * All three boards are already in memory from boot, so switching tabs is
 * instant — no fetch, no spinner.
 */
export function MainPage() {
  const { boards, users, me, recordGame } = useApp();
  const [tab, setTab] = useState<PeriodKind>('all-time');
  const [overlayOpen, setOverlayOpen] = useState(false);

  const board = useMemo(() => {
    if (!boards) return null;
    if (tab === 'monthly') return boards.monthly;
    if (tab === 'daily') return boards.daily;
    return boards.allTime;
  }, [boards, tab]);

  if (!boards || !board) return null;

  const scoredToday = boards.daily.entries.filter((entry) => entry.primary > 0).length;
  const leader = boards.allTime.entries.find((entry) => entry.primary > 0);
  const dailyLeader = boards.daily.entries.find((entry) => entry.primary > 0);

  return (
    <div className="space-y-7">
      {/* Hero row. */}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="headline">Leaderboard</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--text-dim)]">
            Ranked by wins. Sort by any stat. Boards recompute the moment a race lands.
          </p>
        </div>

        <NeonButton
          variant="primary"
          ring
          accent="#FF6A00"
          className="cta-nudge shrink-0 !py-3.5 !text-xs lg:!text-sm"
          onClick={() => setOverlayOpen(true)}
        >
          <Plus size={16} strokeWidth={3} />
          Record Race
        </NeonButton>
      </div>

      {/* Live stat strip. */}
      <Panel accent="#7C5CFF" lit className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4 sm:p-6">
        <Stat
          label="Racers"
          value={users.length}
          hint="signed in at least once"
          accent="#00E5FF"
        />
        <Stat
          label="All-time wins"
          value={boards.allTime.total}
          hint="recorded across the crew"
          accent="#FF6A00"
        />
        <Stat
          label="Today"
          value={boards.daily.total}
          hint={`${scoredToday} ${scoredToday === 1 ? 'racer' : 'racers'} on the board`}
          accent="#B6FF3C"
        />
        <Stat
          label="Reigning"
          value={leader ? leader.displayName.split(' ')[0] : '—'}
          hint={leader ? `${leader.primary} ${leader.primary === 1 ? 'win' : 'wins'}` : 'nobody yet'}
          accent="#FFB020"
        />
      </Panel>

      {/* Today's leader callout — the "daily leading" signal. */}
      {dailyLeader && (
        <div
          className="flex items-center gap-3 border-l-2 bg-white/[0.02] px-4 py-3"
          style={{
            borderColor: dailyLeader.accentColor,
            boxShadow: `inset 0 0 40px -30px ${dailyLeader.accentColor}`,
          }}
        >
          <Radio size={15} className="shrink-0 animate-pulse" style={{ color: dailyLeader.accentColor }} />
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-[var(--text-dim)]">
            <RacerBadge
              id={dailyLeader.userId}
              name={dailyLeader.displayName}
              avatarUrl={dailyLeader.avatarUrl}
              accentColor={dailyLeader.accentColor}
              size={20}
              className="font-display font-bold uppercase tracking-wider text-white"
            />
            <span>
              leads today with {dailyLeader.primary}{' '}
              {dailyLeader.primary === 1 ? 'win' : 'wins'}
              {dailyLeader.tied && ' (tied)'}.
            </span>
          </p>
        </div>
      )}

      {/* Period tabs. */}
      <Segmented<PeriodKind>
        value={tab}
        onChange={setTab}
        accent="#FF6A00"
        options={[
          { value: 'all-time', label: 'All Time', hint: `${boards.allTime.total}` },
          { value: 'monthly', label: 'This Month', hint: boards.periods.month },
          { value: 'daily', label: 'Today', hint: boards.periods.day },
        ]}
      />

      {/* The board. */}
      <div key={tab} style={{ animation: 'rise 380ms cubic-bezier(0.16,1,0.3,1) both' }}>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="headline-cold font-display text-lg font-black uppercase sm:text-xl">
            {board.label}
          </h2>
          <p className="font-mono text-[0.65rem] text-[var(--text-faint)]">
            derived {new Date(board.generatedAt).toLocaleString()}
          </p>
        </div>

        <LeaderboardTable
          board={board}
          highlightUserId={me?.id}
          emptyHint={
            tab === 'daily'
              ? "Nobody's won today. Yet."
              : tab === 'monthly'
                ? 'This month is a blank slate.'
                : 'Record the first win to open the books.'
          }
        />
      </div>

      <AddScoreOverlay
        open={overlayOpen}
        users={users}
        onClose={() => setOverlayOpen(false)}
        onSubmit={recordGame}
      />
    </div>
  );
}

export default MainPage;
