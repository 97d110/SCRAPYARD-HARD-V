import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Bell, Calendar, Crosshair, Flame, LogOut, Pencil, RotateCcw, Save, Skull, Swords, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import {
  getPushSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/push';
import { useApp } from '../state/AppStore';
import { useLiveEvent } from '../state/useLiveEvent';
import { AchievementGrid } from '../components/AchievementGrid';
import { ArthurLottie } from '../components/arthur/ArthurLottie';
import { RacerBadge } from '../components/RacerBadge';
import {
  Avatar,
  ErrorPlate,
  Label,
  LoadingRig,
  NeonButton,
  Panel,
  Stat,
} from '../components/ui/primitives';
import { RACE_COLOR_HEX, RACE_COLORS } from '../lib/raceColors';
import type {
  GameParticipation,
  ProfileBundle,
  PublicUser,
  RaceColor,
  Rival,
} from '@scrapyard/shared';

/**
 * Racer profile. Public for everyone (achievements included); the edit panel
 * only renders when you're looking at your own page.
 */
export function UserPage() {
  const { id = '' } = useParams();
  const { me, patchMe, userById } = useApp();
  const [bundle, setBundle] = useState<ProfileBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const isMe = me?.id === id;

  const load = useCallback(async () => {
    setError(null);
    setBundle(null);
    try {
      setBundle(await api.profile(id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load that racer');
    }
  }, [id]);

  useEffect(() => {
    void load();
    setEditing(false);
  }, [load]);

  /**
   * Re-read the bundle in place, keeping what's on screen until the new one
   * lands. `load` blanks it first, which is right when you navigate here and
   * wrong for a live update — it would flash the spinner across this page every
   * time anybody, anywhere, recorded a race.
   */
  const refresh = useCallback(async () => {
    const next = await api.profile(id).catch(() => null);
    if (next) setBundle(next);
  }, [id]);

  /*
   * Everything a profile is derived from, and all of it computed on read: races
   * move the stats, streaks, rivals and heat strip; the roster carries rivals'
   * names and colours; metrics are the columns behind `totals`; and a retuned
   * achievement rule can lock or unlock a badge with no write to this racer at
   * all.
   */
  useLiveEvent(
    ['game:recorded', 'game:deleted', 'roster:changed', 'metrics:changed', 'achievement-rules:changed'],
    refresh,
  );

  if (error) return <ErrorPlate message={error} onRetry={() => void load()} />;
  if (!bundle) return <LoadingRig label="Pulling telemetry" />;

  const { user, streaks, ranks, achievements, totals, columns, recentGames, rivals, activity } = bundle;
  const accent = RACE_COLOR_HEX[user.raceColor];
  // Resolve a racer id to the fields RacerBadge needs (avatar + name + accent).
  const racerRef = (racerId: string) => {
    const other = userById(racerId);
    return {
      id: racerId,
      name: other?.displayName ?? 'a rival',
      avatarUrl: other?.avatarUrl ?? '',
      accent: other ? RACE_COLOR_HEX[other.raceColor] : '#7C5CFF',
    };
  };

  // Captured/formula columns are the interesting per-race stats — points and
  // placement are already spelled out, so these are what earns a chip on a game.
  const statColumns = columns.filter(
    (column) => column.kind === 'captured' || column.kind === 'formula',
  );

  return (
    <div className="space-y-8">
      {/* Hero. */}
      <Panel accent={accent} lit className="relative overflow-hidden p-6 sm:p-8 3xl:p-10">
        {/* Idling Arthur in the corner, tinted to the racer's accent. */}
        <div className="pointer-events-none absolute -right-6 -top-4 hidden opacity-25 sm:block">
          <div className="animate-hover">
            <ArthurLottie size={200} accent={accent} />
          </div>
        </div>

        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-start">
          <Avatar src={user.avatarUrl} name={user.displayName} size={104} accent={accent} />

          <div className="min-w-0 flex-1">
            <Label>
              {user.favoriteRacer} · joined {new Date(user.createdAt).toLocaleDateString()}
            </Label>
            <h1
              className="mt-1 break-words font-display text-[clamp(1.5rem,1rem+2.4vw,3rem)] font-black uppercase leading-none text-white"
              style={{ textShadow: `0 0 26px ${accent}` }}
            >
              {user.displayName}
            </h1>
            {user.tagline && (
              <p className="mt-2.5 max-w-xl text-sm italic text-[var(--text-dim)]">
                “{user.tagline}”
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <RankChip label="All time" rank={ranks.allTime} accent="#FFB020" />
              <RankChip label="This month" rank={ranks.monthly} accent="#00E5FF" />
              <RankChip label="Today" rank={ranks.daily} accent="#B6FF3C" />
              {user.role === 'admin' && (
                <span className="border border-violet/50 px-2.5 py-1 font-display text-[0.55rem] font-bold uppercase tracking-[0.2em] text-violet">
                  Admin
                </span>
              )}
            </div>
          </div>

          {isMe && (
            <NeonButton
              variant={editing ? 'ghost' : 'primary'}
              accent={accent}
              className={`shrink-0 ${editing ? '' : 'cta-nudge'}`}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? <X size={15} /> : <Pencil size={15} />}
              {editing ? 'Close' : 'Edit profile'}
            </NeonButton>
          )}
        </div>
      </Panel>

      {/* A device setting, not a profile field — visible without opening the
          editor, and it hides itself entirely on a browser that can't do this. */}
      {isMe && <NotificationsPanel accent={accent} />}

      {/* Editor. */}
      {isMe && editing && (
        <ProfileEditor
          user={user}
          onSaved={(next) => {
            patchMe(next);
            setBundle((prev) => (prev ? { ...prev, user: next } : prev));
            setEditing(false);
          }}
        />
      )}

      {/* Score + streak stats. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel accent="#FF6A00" className="p-5">
          <Stat label="All-time wins" value={user.scores.allTime} accent="#FF6A00" />
        </Panel>
        <Panel accent="#FF2D95" className="p-5">
          <Stat
            label="Win streak"
            value={
              <span className="inline-flex items-center gap-2">
                {streaks.currentWinStreak}
                {streaks.currentWinStreak > 0 && (
                  <Flame size={20} className="animate-pulse-glow text-blaze" />
                )}
              </span>
            }
            hint={`longest ${streaks.longestWinStreak} ${streaks.longestWinStreak === 1 ? 'day' : 'days'}`}
            accent="#FF2D95"
          />
        </Panel>
        <Panel accent="#B6FF3C" className="p-5">
          <Stat
            label="Daily lead streak"
            value={streaks.currentDailyLeadStreak}
            hint={`longest ${streaks.longestDailyLeadStreak} · ${streaks.daysAsDailyLeader} total days at #1`}
            accent="#B6FF3C"
          />
        </Panel>
        <Panel accent="#00E5FF" className="p-5">
          <Stat
            label="Last win"
            value={
              streaks.lastWinAt
                ? new Date(streaks.lastWinAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })
                : '—'
            }
            hint={
              streaks.lastWinAt
                ? new Date(streaks.lastWinAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'no wins recorded'
            }
            accent="#00E5FF"
          />
        </Panel>
      </div>

      {/* Career totals — every metric's all-time total, labelled from columns. */}
      {columns.length > 0 && (
        <div>
          <h2 className="headline-cold mb-3 font-display text-lg font-black uppercase sm:text-xl">
            Career totals
          </h2>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 3xl:grid-cols-7">
            {columns.map((column) => (
              <div
                key={column.id}
                className="border border-hairline bg-white/[0.015] px-3 py-3"
                style={{ ['--glow' as string]: accent }}
              >
                <p className="label truncate !text-[0.5rem]">{column.label}</p>
                <p
                  className="stat-number mt-1 text-xl leading-none text-white"
                  style={{ textShadow: `0 0 16px ${accent}` }}
                >
                  {formatMetricValue(totals[column.id] ?? 0, column.id)}
                </p>
                {column.unit && (
                  <p className="mt-0.5 truncate text-[0.55rem] text-[var(--text-faint)]">
                    {column.unit}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 90-day activity strip. */}
      <ActivityStrip activity={activity} accent={accent} />

      {/* Rivalries — who's been hunting this racer, and their revenge. */}
      {rivals.length > 0 && <NemesisPanel rivals={rivals} accent={accent} />}

      {/* Achievements — visible to everyone. */}
      <AchievementGrid achievements={achievements} />

      {/* Recent races log. */}
      {recentGames.length > 0 && (
        <div>
          <h2 className="headline-cold mb-3 font-display text-lg font-black uppercase sm:text-xl">
            Recent races
          </h2>
          <Panel accent={accent} className="divide-y divide-hairline/60 overflow-hidden">
            {recentGames.slice(0, 12).map((game) => {
              const podium = game.place <= 3;
              const chips = statColumns
                .filter((column) => (game.metrics[column.id] ?? 0) !== 0)
                .slice(0, 4);
              return (
                <div
                  key={game.gameId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:px-5"
                >
                  {/* Placement badge — the headline of the row. */}
                  <span
                    className="grid h-7 min-w-[3.4rem] shrink-0 place-items-center px-2 font-display text-[0.62rem] font-black uppercase tracking-wide"
                    style={{
                      color: podium ? '#000' : 'var(--text-dim)',
                      background: podium ? accent : 'rgb(255 255 255 / 0.04)',
                      boxShadow: podium ? `0 0 14px ${accent}` : 'none',
                      borderRadius: 3,
                    }}
                    title={`Finished ${game.place} of ${game.fieldSize}`}
                  >
                    P{game.place} of {game.fieldSize}
                  </span>

                  <span className="font-mono text-[0.7rem] text-[var(--text-dim)]">
                    {new Date(game.at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>

                  {/* A few key per-race stats. */}
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatChip label="score" value={formatMetricValue(game.gameScore)} accent={accent} />
                    {chips.map((column) => (
                      <StatChip
                        key={column.id}
                        label={column.label.toLowerCase()}
                        value={formatMetricValue(game.metrics[column.id] ?? 0, column.id)}
                        accent={accent}
                      />
                    ))}
                  </span>

                  {game.note && (
                    <span className="min-w-0 truncate text-xs italic text-[var(--text-faint)]">
                      {game.note}
                    </span>
                  )}

                  {/* This racer's kills and deaths in the race, revenge tagged. */}
                  {game.events.length > 0 && (
                    <span className="flex w-full flex-wrap items-center gap-1.5">
                      <KillChips game={game} userId={user.id} resolve={racerRef} />
                    </span>
                  )}
                </div>
              );
            })}
          </Panel>
        </div>
      )}

      {/*
        Sign out. Only on your own page, and deliberately last: it used to be a
        button in the title bar and another in the mobile menu, both of them one
        mis-tap away from something you actually wanted. Down here you have to
        mean it, and there is exactly one of it on both layouts.
      */}
      {isMe && <SignOutPanel email={user.email} />}
    </div>
  );
}

function SignOutPanel({ email }: { email: string }) {
  const { logout } = useApp();
  const [busy, setBusy] = useState(false);

  return (
    <Panel className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Label>Session</Label>
        <p className="mt-1 truncate font-mono text-xs text-[var(--text-dim)]">
          Signed in as {email}
        </p>
      </div>

      <NeonButton
        variant="ghost"
        accent="#FF3B30"
        className="shrink-0"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          // Deliberately not reset on failure: logout() navigates away on both
          // paths, so anything after this is a page that's already leaving.
          void logout();
        }}
      >
        <LogOut size={15} />
        {busy ? 'Signing out…' : 'Sign out'}
      </NeonButton>
    </Panel>
  );
}

/**
 * The rivalries panel. Leads with the nemesis (whoever's killed this racer
 * most), then the rest of the head-to-heads, each showing the two-way tally
 * and how many of the racer's kills were same-day revenge.
 */
function NemesisPanel({ rivals, accent }: { rivals: Rival[]; accent: string }) {
  const nemesis = rivals.find((rival) => rival.theyKilledYou > 0);

  return (
    <div>
      <h2 className="headline-cold mb-3 font-display text-lg font-black uppercase sm:text-xl">
        Rivalries
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rivals.map((rival) => {
          const isNemesis = nemesis?.userId === rival.userId;
          return (
            <Link
              key={rival.userId}
              to={`/racer/${rival.userId}`}
              title={`View ${rival.displayName}'s profile`}
              className="block transition hover:-translate-y-0.5"
            >
              <Panel
                accent={isNemesis ? '#FF3B30' : RACE_COLOR_HEX[rival.raceColor]}
                lit={isNemesis}
                className="flex items-center gap-3 p-3.5"
              >
              <Avatar src={rival.avatarUrl} name={rival.displayName} size={38} accent={RACE_COLOR_HEX[rival.raceColor]} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-display text-[0.8rem] font-bold uppercase tracking-wide text-white">
                    {rival.displayName}
                  </span>
                  {isNemesis && (
                    <span className="shrink-0 rounded-sm px-1.5 py-0.5 text-[0.5rem] uppercase tracking-widest text-[#FF3B30]" style={{ border: '1px solid #FF3B3055' }}>
                      nemesis
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-[0.66rem]">
                  <span
                    className="inline-flex items-center gap-1 text-[var(--text-dim)]"
                    title={`You've taken ${rival.displayName} out ${rival.youKilledThem} time${rival.youKilledThem === 1 ? '' : 's'}`}
                  >
                    <Crosshair size={12} style={{ color: accent }} aria-hidden /> {rival.youKilledThem}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 text-[var(--text-dim)]"
                    title={`${rival.displayName} has taken you out ${rival.theyKilledYou} time${rival.theyKilledYou === 1 ? '' : 's'}`}
                  >
                    <Skull size={12} className="text-[#FF6B6B]" aria-hidden /> {rival.theyKilledYou}
                  </span>
                  {rival.yourRevenges > 0 && (
                    <span
                      className="inline-flex items-center gap-1 text-[var(--text-dim)]"
                      title={`${rival.yourRevenges} same-day revenge kill${rival.yourRevenges === 1 ? '' : 's'} against ${rival.displayName}`}
                    >
                      <Swords size={12} style={{ color: '#B6FF3C' }} aria-hidden /> {rival.yourRevenges}
                    </span>
                  )}
                </div>
              </div>
              </Panel>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Per-race kill/death chips for one game, from this racer's point of view. */
function KillChips({
  game,
  userId,
  resolve,
}: {
  game: GameParticipation;
  userId: string;
  resolve: (id: string) => { id: string; name: string; avatarUrl: string; accent: string };
}) {
  const kills = game.events.filter((event) => event.killerId === userId);
  const deaths = game.events.filter((event) => event.victimId === userId);

  return (
    <>
      {kills.map((event, i) => {
        const victim = resolve(event.victimId);
        return (
          <span
            key={`k${i}`}
            className="inline-flex items-center gap-1 border border-hairline px-1.5 py-0.5 font-mono text-[0.6rem] text-[var(--text-dim)]"
            title={
              event.revenge
                ? `Revenge — you took out ${victim.name} after they'd killed you earlier the same day`
                : `You took out ${victim.name} in this race`
            }
          >
            <Crosshair size={11} className="text-toxic" aria-hidden />
            <RacerBadge {...victim} size={15} className="text-white" title={`View ${victim.name}'s profile`} />
            {event.revenge && (
              <span
                className="inline-flex items-center gap-0.5 font-display font-bold uppercase tracking-wider text-[#B6FF3C]"
                title="Revenge — a same-day payback: you took out a racer who had killed you earlier today"
              >
                <Swords size={10} aria-hidden /> revenge
              </span>
            )}
          </span>
        );
      })}
      {deaths.map((event, i) => {
        const killer = resolve(event.killerId);
        return (
          <span
            key={`d${i}`}
            className="inline-flex items-center gap-1 border border-hairline px-1.5 py-0.5 font-mono text-[0.6rem] text-[var(--text-faint)]"
            title={`${killer.name} took you out in this race`}
          >
            <Skull size={11} className="text-[#FF6B6B]" aria-hidden />
            <span className="text-[var(--text-dim)]">by</span>
            <RacerBadge {...killer} size={15} className="text-[var(--text-dim)]" title={`View ${killer.name}'s profile`} />
          </span>
        );
      })}
    </>
  );
}

/** A compact metric pill for the recent-races log. */
function StatChip({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 border border-hairline px-1.5 py-0.5 font-mono text-[0.6rem] text-[var(--text-dim)]"
      style={{ boxShadow: `inset 0 0 18px -14px ${accent}` }}
    >
      <span className="font-display font-bold text-white">{value}</span>
      <span className="text-[var(--text-faint)]">{label}</span>
    </span>
  );
}

/**
 * Integers as-is. `avgPlace` always floors to a whole place (1.5 → 1, never
 * shown as a decimal) — any other non-integer metric (e.g. a formula) still
 * gets a single decimal.
 */
function formatMetricValue(value: number, metricId?: string): string {
  if (!Number.isFinite(value)) return '0';
  if (metricId === 'avgPlace') return String(Math.floor(value));
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function RankChip({
  label,
  rank,
  accent,
}: {
  label: string;
  rank: number | null;
  accent: string;
}) {
  return (
    <span
      className="flex items-center gap-2 border px-2.5 py-1"
      style={{
        borderColor: rank ? `${accent}66` : 'var(--hairline)',
        background: rank ? `${accent}12` : 'transparent',
      }}
    >
      <span className="font-display text-[0.55rem] font-bold uppercase tracking-[0.18em] text-[var(--text-dim)]">
        {label}
      </span>
      <span
        className="font-display text-xs font-black tabular-nums"
        style={{ color: rank ? '#fff' : 'var(--text-faint)', textShadow: rank ? `0 0 12px ${accent}` : 'none' }}
      >
        {rank ? `#${rank}` : '—'}
      </span>
    </span>
  );
}

/** 90-day win heat strip — the "daily leading" rhythm at a glance. */
function ActivityStrip({
  activity,
  accent,
}: {
  activity: Record<string, number>;
  accent: string;
}) {
  // Sort by the day key rather than trusting JSON object insertion order, so
  // time always reads left to right regardless of how the payload was built.
  const days = useMemo(
    () => Object.entries(activity).sort(([a], [b]) => a.localeCompare(b)),
    [activity],
  );
  const max = Math.max(1, ...days.map(([, wins]) => wins));

  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between">
        <Label>
          <span className="inline-flex items-center gap-1.5">
            <Calendar size={11} /> Last 90 days
          </span>
        </Label>
        <span className="font-mono text-[0.6rem] text-[var(--text-faint)]">
          {days.filter(([, wins]) => wins > 0).length} active days
        </span>
      </div>
      <Panel accent={accent} tight className="overflow-x-auto p-3">
        <div className="flex min-w-max items-end gap-[3px]">
          {days.map(([day, wins]) => (
            <span
              key={day}
              title={`${day}: ${wins} ${wins === 1 ? 'win' : 'wins'}`}
              className="w-[7px] shrink-0 rounded-sm transition-all hover:scale-y-125 sm:w-[9px] 3xl:w-3"
              style={{
                height: wins === 0 ? 6 : 6 + (wins / max) * 34,
                background: wins === 0 ? 'rgb(255 255 255 / 0.06)' : accent,
                boxShadow: wins === 0 ? 'none' : `0 0 10px ${accent}aa`,
                opacity: wins === 0 ? 1 : 0.45 + (wins / max) * 0.55,
              }}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
}

/** Profile editor — own page only. */
/**
 * Push notifications, opted into (or out of) with a single toggle.
 *
 * Deliberately per-device, not per-account: the toggle reflects whether *this*
 * browser currently holds a subscription, and turning it off only ever
 * unsubscribes this browser. That's how Web Push works everywhere — there is
 * no server-side "account preference" to keep in sync with it, so this
 * component doesn't invent one.
 */
function NotificationsPanel({ accent }: { accent: string }) {
  const [supported] = useState(() => isPushSupported());
  const [checked, setChecked] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) {
      setChecked(true);
      return;
    }
    let live = true;
    void getPushSubscription().then((subscription) => {
      if (!live) return;
      setSubscribed(subscription !== null);
      setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [supported]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
      } else {
        await subscribeToPush();
        setSubscribed(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update notifications');
    } finally {
      setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'default');
      setBusy(false);
    }
  };

  // Not supported (most non-installed iOS Safari) or still checking — a
  // silent no-op is better than a toggle that would just error on first tap.
  if (!supported || !checked) return null;

  const denied = permission === 'denied';

  return (
    <Panel accent={accent} className="flex flex-wrap items-center justify-between gap-4 p-5">
      <div className="min-w-0 max-w-md">
        <Label>
          <span className="inline-flex items-center gap-1.5">
            <Bell size={10} style={{ color: accent }} /> Push notifications
          </span>
        </Label>
        <p className="mt-1.5 text-xs text-[var(--text-dim)]">
          {denied
            ? 'Blocked in this browser — re-enable notifications in its site settings to turn this back on.'
            : 'Get a ping on this device whenever a race is recorded.'}
        </p>
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={subscribed}
        aria-label="Push notifications"
        disabled={busy || denied}
        onClick={() => void toggle()}
        className="relative h-6 w-11 shrink-0 rounded-full border border-hairline transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: subscribed ? accent : 'rgb(255 255 255 / 0.06)' }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
          style={{ transform: `translateX(${subscribed ? '22px' : '2px'})` }}
        />
      </button>
    </Panel>
  );
}

function ProfileEditor({
  user,
  onSaved,
}: {
  user: PublicUser;
  onSaved: (next: PublicUser) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [tagline, setTagline] = useState(user.tagline);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [favoriteRacer, setFavoriteRacer] = useState(user.favoriteRacer);
  const [raceColor, setRaceColor] = useState<RaceColor>(user.raceColor);
  /*
   * Held as one comma-separated string rather than an array of inputs. Typing
   * "עמית, נינו" in a single box is how people naturally write a list of names,
   * and the server does the splitting, trimming and de-duplicating anyway — so
   * a tag-chip editor would be more machinery for the same result.
   */
  const [hebrewAliases, setHebrewAliases] = useState(user.hebrewAliases.join(', '));
  /* Live preview: the panel, avatar ring and Save button all take the colour
   * being previewed, not the saved one, so the choice is visible before saving. */
  const previewAccent = RACE_COLOR_HEX[raceColor];
  const [options, setOptions] = useState<{ racers: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.profileOptions().then(setOptions).catch(() => setOptions(null));
  }, []);

  /** Downscale to 256px and re-encode before storing as a data URL. */
  const onPickFile = async (file: File) => {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image');
      return;
    }
    try {
      const dataUrl = await downscaleImage(file, 256);
      setAvatarUrl(dataUrl);
    } catch {
      setError('Could not read that image');
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateProfile(user.id, {
        displayName,
        tagline,
        avatarUrl,
        favoriteRacer,
        raceColor,
        hebrewAliases: hebrewAliases
          .split(',')
          .map((alias) => alias.trim())
          .filter(Boolean),
      });
      onSaved(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      accent={previewAccent}
      lit
      className="p-6 sm:p-7"
      style={{ animation: 'rise 300ms cubic-bezier(0.16,1,0.3,1) both' }}
    >
      <Label>Your profile</Label>
      <h2 className="headline-cold mt-1 font-display text-xl font-black uppercase">
        Customise
      </h2>

      <div className="mt-6 grid gap-6 lg:grid-cols-[auto_1fr]">
        {/* Avatar column. */}
        <div className="flex flex-col items-center gap-3">
          <Avatar src={avatarUrl} name={displayName} size={112} accent={previewAccent} />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onPickFile(file);
            }}
          />
          <div className="flex gap-2">
            <NeonButton
              variant="ghost"
              accent={previewAccent}
              className="!px-3 !py-2 !text-[0.6rem]"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={13} /> Upload
            </NeonButton>
            <NeonButton
              variant="ghost"
              className="!px-3 !py-2 !text-[0.6rem]"
              onClick={() => setAvatarUrl(user.googleAvatarUrl)}
              title="Back to your Google picture"
            >
              <RotateCcw size={13} /> Google
            </NeonButton>
          </div>
          <p className="max-w-[12rem] text-center text-[0.6rem] leading-snug text-[var(--text-faint)]">
            Defaults to your Google photo. Uploads are resized to 256px.
          </p>
        </div>

        {/* Fields column. */}
        <div className="space-y-4">
          <div>
            <Label className="mb-1.5">Display name</Label>
            <input
              className="field"
              value={displayName}
              maxLength={40}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <p className="mt-1 text-[0.6rem] text-[var(--text-faint)]">
              From Google: {user.googleFullName}
              {displayName !== user.googleFullName && (
                <button
                  className="ml-2 text-plasma underline"
                  onClick={() => setDisplayName(user.googleFullName)}
                >
                  reset
                </button>
              )}
            </p>
          </div>

          <div>
            <Label className="mb-1.5">Tagline</Label>
            <input
              className="field"
              value={tagline}
              maxLength={120}
              placeholder="Something suitably reckless"
              onChange={(event) => setTagline(event.target.value)}
            />
          </div>

          <div>
            <Label className="mb-1.5">Your ride</Label>
            <div className="flex flex-wrap gap-1.5">
              {(options?.racers ?? [favoriteRacer]).map((racer) => (
                <button
                  key={racer}
                  onClick={() => setFavoriteRacer(racer)}
                  className={`border px-2.5 py-1.5 font-mono text-[0.65rem] transition ${
                    racer === favoriteRacer
                      ? 'border-transparent text-white'
                      : 'border-hairline text-[var(--text-dim)] hover:border-white/25 hover:text-white'
                  }`}
                  style={
                    racer === favoriteRacer
                      ? {
                          background: `${previewAccent}26`,
                          boxShadow: `inset 0 0 0 1px ${previewAccent}`,
                        }
                      : undefined
                  }
                >
                  {racer}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-1.5">Your colour</Label>
            <div className="flex flex-wrap items-center gap-2">
              {RACE_COLORS.map((color) => {
                const active = raceColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setRaceColor(color)}
                    aria-label={color}
                    aria-pressed={active}
                    title={color}
                    className="h-9 w-9 rounded-full transition-transform hover:scale-110"
                    style={{
                      background: RACE_COLOR_HEX[color],
                      boxShadow: active
                        ? `0 0 0 2px #fff, 0 0 22px ${RACE_COLOR_HEX[color]}`
                        : `0 0 12px ${RACE_COLOR_HEX[color]}88`,
                      opacity: active ? 1 : 0.45,
                    }}
                  />
                );
              })}
              <span className="font-mono text-[0.6rem] text-[var(--text-faint)]">
                your car, and your colour across the app
              </span>
            </div>
          </div>

          <div>
            <Label className="mb-1.5">Your name in Hebrew</Label>
            <input
              className="field"
              dir="rtl"
              placeholder="עמית, נינו, עמית נינו"
              value={hebrewAliases}
              onChange={(event) => setHebrewAliases(event.target.value)}
            />
            <p className="mt-1.5 text-[0.65rem] leading-relaxed text-[var(--text-faint)]">
              Comma-separated — first name, surname, nicknames, however the crew actually says it.
              Used when someone records a race by speaking it out loud: spoken Hebrew can&rsquo;t be
              matched against a Latin name automatically, so without this you won&rsquo;t be picked up.
            </p>
          </div>

          {error && (
            <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <NeonButton
              variant="primary"
              accent={previewAccent}
              ring
              className="cta-nudge"
              disabled={saving || displayName.trim().length < 2}
              onClick={() => void save()}
            >
              <Save size={15} />
              {saving ? 'Saving…' : 'Save changes'}
            </NeonButton>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Resize + re-encode client side so we never post a 5MB data URL. */
async function downscaleImage(file: File, max: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.toDataURL('image/jpeg', 0.86);
}

export default UserPage;
