import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Calendar, Flame, Medal, Pencil, RotateCcw, Save, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../state/AppStore';
import { AchievementGrid } from '../components/AchievementGrid';
import { ArthurShip } from '../components/arthur/ArthurShip';
import {
  Avatar,
  ErrorPlate,
  Label,
  LoadingRig,
  NeonButton,
  Panel,
  Stat,
} from '../components/ui/primitives';
import type { ProfileBundle, PublicUser } from '@scrapyard/shared';

/**
 * Racer profile. Public for everyone (achievements included); the edit panel
 * only renders when you're looking at your own page.
 */
export function UserPage() {
  const { id = '' } = useParams();
  const { me, patchMe } = useApp();
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

  if (error) return <ErrorPlate message={error} onRetry={() => void load()} />;
  if (!bundle) return <LoadingRig label="Pulling telemetry" />;

  const { user, streaks, ranks, achievements, recentWins, activity } = bundle;
  const accent = user.accentColor;

  return (
    <div className="space-y-8">
      {/* Hero. */}
      <Panel accent={accent} lit className="relative overflow-hidden p-6 sm:p-8 3xl:p-10">
        {/* Idling Arthur in the corner, tinted to the racer's accent. */}
        <div className="pointer-events-none absolute -right-6 -top-4 hidden opacity-25 sm:block">
          <div className="animate-hover">
            <ArthurShip size={200} accent={accent} />
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
              className="shrink-0"
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? <X size={15} /> : <Pencil size={15} />}
              {editing ? 'Close' : 'Edit profile'}
            </NeonButton>
          )}
        </div>
      </Panel>

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

      {/* 90-day activity strip. */}
      <ActivityStrip activity={activity} accent={accent} />

      {/* Achievements — visible to everyone. */}
      <AchievementGrid achievements={achievements} />

      {/* Recent wins log. */}
      {recentWins.length > 0 && (
        <div>
          <h2 className="headline-cold mb-3 font-display text-lg font-black uppercase sm:text-xl">
            Recent wins
          </h2>
          <Panel accent={accent} className="divide-y divide-hairline/60 overflow-hidden">
            {recentWins.slice(0, 12).map((win) => (
              <div key={win.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <Medal size={15} className="shrink-0" style={{ color: accent }} />
                <span className="font-mono text-[0.7rem] text-[var(--text-dim)]">
                  {new Date(win.at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {win.note && (
                  <span className="min-w-0 truncate text-xs italic text-[var(--text-faint)]">
                    {win.note}
                  </span>
                )}
                <span className="ml-auto shrink-0 font-display text-[0.6rem] uppercase tracking-widest text-[var(--text-faint)]">
                  +1
                </span>
              </div>
            ))}
          </Panel>
        </div>
      )}
    </div>
  );
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
  const [accentColor, setAccentColor] = useState(user.accentColor);
  const [options, setOptions] = useState<{ racers: string[]; accents: string[] } | null>(null);
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
        accentColor,
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
      accent={accentColor}
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
          <Avatar src={avatarUrl} name={displayName} size={112} accent={accentColor} />
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
              accent={accentColor}
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
                          background: `${accentColor}26`,
                          boxShadow: `inset 0 0 0 1px ${accentColor}`,
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
            <Label className="mb-1.5">Neon accent</Label>
            <div className="flex flex-wrap gap-2">
              {(options?.accents ?? [accentColor]).map((color) => (
                <button
                  key={color}
                  onClick={() => setAccentColor(color)}
                  aria-label={color}
                  className="h-9 w-9 rounded-full transition-transform hover:scale-110"
                  style={{
                    background: color,
                    boxShadow:
                      color.toUpperCase() === accentColor.toUpperCase()
                        ? `0 0 0 2px #fff, 0 0 22px ${color}`
                        : `0 0 12px ${color}88`,
                  }}
                />
              ))}
            </div>
          </div>

          {error && (
            <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <NeonButton
              variant="primary"
              accent={accentColor}
              ring
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
