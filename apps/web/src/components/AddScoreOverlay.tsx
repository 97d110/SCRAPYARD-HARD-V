import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronUp, GripVertical, Plus, Search, Skull, Trophy, X } from 'lucide-react';
import { Avatar, Label, Panel, withGlow } from './ui/primitives';
import { api } from '../lib/api';
import type { GameResultInput, KillEventInput, MetricDef, PublicUser } from '@scrapyard/shared';

/**
 * The race-entry overlay — a full-screen, two-pane workspace.
 *
 *   left   the racer picker (search + roster). On mobile it collapses so the
 *          crew can pick the field, fold it away, and focus on the numbers.
 *   right  the race itself: the running order (drag to reorder → that's the
 *          placement), per-racer score and captured stats, the kill log, note.
 *
 * A winner alone is a valid race; everything past first place is optional.
 * Submit still puts on the full show and hands off to Arthur's flyby.
 */

/** Per-racer draft. Numbers are held as strings so the inputs stay controlled. */
interface Finisher {
  racerId: string;
  gameScore: string;
  /** Captured metric values, keyed by metric id. Blank reads as 0. */
  stats: Record<string, string>;
}

/** Medal tint by finishing place (1-indexed). Beyond the podium goes faint. */
const PLACE_COLOR = ['#FFB020', '#CFE3FF', '#FF8A3D', '#5b6688'];

/**
 * The scoring ground rules — mirrored from the server (`ScoresService.validate`)
 * so the overlay can validate and preview them live, without waiting on a
 * round trip. Kept in sync deliberately; if the server's numbers change, these
 * must too.
 */
const DEFAULT_SCORE_BY_PLACE = [15, 10, 5, 0];
const WINNER_MIN_SCORE = 15;

/**
 * What a finisher's score actually resolves to: blank/0 falls back to the
 * standard purse for that place, and the winner's purse is never allowed
 * below the minimum — silently topped up rather than flagged as an error.
 */
function effectiveScore(raw: string, place: number): number {
  const typed = raw.trim() === '' ? 0 : Math.max(0, Number(raw) || 0);
  let score = typed === 0 ? DEFAULT_SCORE_BY_PLACE[place - 1] ?? 0 : typed;
  if (place === 1 && score < WINNER_MIN_SCORE) score = WINNER_MIN_SCORE;
  return score;
}

export function AddScoreOverlay({
  open,
  users,
  onClose,
  onSubmit,
}: {
  open: boolean;
  users: PublicUser[];
  onClose: () => void;
  /** Resolve to launch the celebration; reject to show the error. */
  onSubmit: (results: GameResultInput[], events: KillEventInput[], note?: string) => Promise<unknown>;
}) {
  const [query, setQuery] = useState('');
  const [finishers, setFinishers] = useState<Finisher[]>([]);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<'idle' | 'charging' | 'launched'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Captured metrics drive one numeric input per racer. Fetched on open.
  const [captured, setCaptured] = useState<MetricDef[]>([]);
  // The kill log — killer→victim pairs. Drives kills/deaths and revenge.
  const [kills, setKills] = useState<KillEventInput[]>([]);
  const [killer, setKiller] = useState('');
  const [victim, setVictim] = useState('');
  // Mobile: the racer picker collapses once the field is chosen.
  const [pickerOpen, setPickerOpen] = useState(true);
  // Mobile: the kill log is optional, so it stays folded away until wanted.
  const [killsOpen, setKillsOpen] = useState(false);
  // Plays the collapse animation before the parent unmounts us.
  const [closing, setClosing] = useState(false);
  // The finisher row currently being dragged, for reorder + visual feedback.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragPointerId = useRef<number | null>(null);

  /**
   * Close with the collapse animation: mark closing, then unmount (via the
   * parent's onClose) once it has played. A launch is already running its own
   * exit, so leave that alone.
   */
  const requestClose = useCallback(() => {
    if (phase !== 'idle') return;
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [phase, onClose]);

  // Reset every time the overlay opens so it never resumes a stale state.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFinishers([]);
    setNote('');
    setPhase('idle');
    setError(null);
    setKills([]);
    setKiller('');
    setVictim('');
    setPickerOpen(true);
    setKillsOpen(false);
    setDragIndex(null);
    setClosing(false);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 220);
    return () => window.clearTimeout(timer);
  }, [open]);

  // A kill can only involve racers still on the grid — drop any whose killer or
  // victim was removed, so the log can never reference a car that isn't racing.
  useEffect(() => {
    const ids = new Set(finishers.map((f) => f.racerId));
    setKills((prev) => prev.filter((k) => ids.has(k.killerId) && ids.has(k.victimId)));
  }, [finishers]);

  // The captured-metric list only changes when an admin edits it, so a fetch
  // per open is cheap and keeps the form honest without a store subscription.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .metrics()
      .then((metrics) => {
        // kills/deaths are derived from the kill log, so no typed input for them.
        if (live) {
          setCaptured(metrics.filter((m) => m.kind === 'captured' && m.id !== 'kills' && m.id !== 'deaths'));
        }
      })
      .catch(() => {
        // A missing metric list just means no stat inputs — the race still records.
        if (live) setCaptured([]);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Escape closes, unless we're mid-launch.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, requestClose]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...users].sort(
      (a, b) => b.scores.allTime - a.scores.allTime || a.displayName.localeCompare(b.displayName),
    );
    if (!needle) return sorted;
    return sorted.filter(
      (user) =>
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle) ||
        user.favoriteRacer.toLowerCase().includes(needle),
    );
  }, [users, query]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  /** Toggle a racer in or out of the field. New racers join at the back. */
  const toggleRacer = (racerId: string) => {
    if (phase !== 'idle') return;
    setError(null);
    setFinishers((prev) => {
      const existing = prev.findIndex((f) => f.racerId === racerId);
      if (existing !== -1) return prev.filter((f) => f.racerId !== racerId);
      if (prev.length >= 4) return prev; // a race tops out at four cars
      return [...prev, { racerId, gameScore: '', stats: {} }];
    });
  };

  const move = (index: number, direction: -1 | 1) => {
    if (phase !== 'idle') return;
    setFinishers((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  /** Move a finisher from one slot to another — the placement is the row order. */
  const reorder = (from: number, to: number) => {
    if (phase !== 'idle' || from === to) return;
    setFinishers((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  /*
   * Pointer-based drag reorder — Pointer Events fire identically for mouse and
   * touch, so this works on phones where native HTML5 drag-and-drop does not.
   * The grip captures the pointer, and each move re-homes the dragged row to
   * whichever slot the pointer is over (by the rows' vertical midpoints).
   */
  const beginDrag = (index: number, event: ReactPointerEvent) => {
    if (phase !== 'idle') return;
    dragPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragIndex(index);
  };

  const dragOverMove = (event: ReactPointerEvent) => {
    if (dragIndex === null || !gridRef.current) return;
    const rows = Array.from(gridRef.current.children) as HTMLElement[];
    let target = rows.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (target === -1) target = rows.length - 1;
    if (target !== dragIndex) {
      reorder(dragIndex, target);
      setDragIndex(target);
    }
  };

  const endDrag = (event: ReactPointerEvent) => {
    const id = dragPointerId.current;
    if (id !== null) {
      try {
        event.currentTarget.releasePointerCapture?.(id);
      } catch {
        // Pointer already released — nothing to do.
      }
    }
    dragPointerId.current = null;
    setDragIndex(null);
  };

  const setGameScore = (racerId: string, value: string) => {
    setFinishers((prev) =>
      prev.map((f) => (f.racerId === racerId ? { ...f, gameScore: value } : f)),
    );
  };

  const setStat = (racerId: string, metricId: string, value: string) => {
    setFinishers((prev) =>
      prev.map((f) =>
        f.racerId === racerId ? { ...f, stats: { ...f.stats, [metricId]: value } } : f,
      ),
    );
  };

  const winner = finishers[0] ? usersById.get(finishers[0].racerId) ?? null : null;
  const accent = winner?.accentColor ?? '#FF6A00';

  // Client-side gate, mirroring the server DTO. A winner alone is enough;
  // scores are optional (a blank reads as 0). Only a *typed* score has to be a
  // valid non-negative number. Places are always unique 1..N by construction.
  const scoresValid = finishers.every((f) => {
    if (f.gameScore.trim() === '') return true;
    const n = Number(f.gameScore);
    return Number.isFinite(n) && n >= 0;
  });

  // What actually gets submitted per finisher, after defaults + the winner
  // floor — computed once so validation and submission never disagree.
  const effectiveScores = useMemo(
    () => finishers.map((f, i) => effectiveScore(f.gameScore, i + 1)),
    [finishers],
  );

  /**
   * Lower places must score the same or less than the place ahead of them —
   * ties are fine, an increase isn't. Keyed by the *offending* (lower-placed)
   * racer, since that's the row that needs fixing.
   */
  const scoreOrderIssues = useMemo(() => {
    const issues = new Map<string, string>();
    for (let i = 1; i < finishers.length; i += 1) {
      if (effectiveScores[i] > effectiveScores[i - 1]) {
        const below = usersById.get(finishers[i].racerId)?.displayName ?? 'This racer';
        const above = usersById.get(finishers[i - 1].racerId)?.displayName ?? 'the place above';
        issues.set(
          finishers[i].racerId,
          `${below} (P${i + 1}) can't outscore ${above} (P${i}) — lower places must score the same or less.`,
        );
      }
    }
    return issues;
  }, [finishers, effectiveScores, usersById]);

  const canSubmit =
    finishers.length >= 1 && finishers.length <= 4 && scoresValid && scoreOrderIssues.size === 0;

  const addKill = () => {
    const ids = new Set(finishers.map((f) => f.racerId));
    if (!killer || !victim || killer === victim || !ids.has(killer) || !ids.has(victim)) return;
    setKills((prev) => [...prev, { killerId: killer, victimId: victim }]);
    setKiller('');
    setVictim('');
  };

  const removeKill = (index: number) => setKills((prev) => prev.filter((_, i) => i !== index));

  const submit = async () => {
    if (!canSubmit || phase !== 'idle') return;
    setError(null);
    setPhase('charging');

    const results: GameResultInput[] = finishers.map((finisher, index) => {
      // Only carry captured stats that were actually typed; the server treats
      // absent keys as 0, so there's no need to send a wall of zeros.
      const stats: Record<string, number> = {};
      for (const metric of captured) {
        const raw = finisher.stats[metric.id];
        if (raw !== undefined && raw.trim() !== '') {
          const value = Number(raw);
          if (Number.isFinite(value)) stats[metric.id] = Math.max(0, value);
        }
      }
      return {
        racerId: finisher.racerId,
        place: index + 1,
        gameScore: effectiveScores[index],
        stats,
      };
    });

    // Let the charge animation actually be seen before the request lands.
    const minimumCharge = new Promise((resolve) => window.setTimeout(resolve, 620));

    try {
      const [result] = await Promise.all([onSubmit(results, kills, note || undefined), minimumCharge]);
      void result;
      setPhase('launched');
      // Close just after the flyby starts, so Arthur flies over the leaderboard.
      window.setTimeout(onClose, 420);
    } catch (caught) {
      setPhase('idle');
      setError(caught instanceof Error ? caught.message : 'Could not record the race');
    }
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label="Record a race"
    >
      {/* Backdrop. */}
      <button
        className="absolute inset-0 bg-[#02030a]/85 backdrop-blur-md"
        style={{
          animation: closing
            ? 'overlay-backdrop-out 200ms ease forwards'
            : 'overlay-backdrop-in 240ms ease both',
        }}
        onClick={requestClose}
        aria-label="Close"
      />

      {/* Full-screen panel: header · two-pane body · footer. */}
      <Panel
        accent={accent}
        lit
        className="relative flex h-full w-full flex-col overflow-hidden"
        style={{
          transformOrigin: 'center',
          animation: closing
            ? 'overlay-collapse 200ms cubic-bezier(0.4,0,1,1) forwards'
            : 'overlay-expand 300ms cubic-bezier(0.16,1,0.3,1) both',
        }}
      >
        {/* Header. */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-5 py-4 sm:px-8 sm:py-5">
          <div className="min-w-0">
            <Label>Race result</Label>
            <h2 className="headline mt-1 text-2xl sm:text-4xl">Log the race</h2>
            <p className="mt-1.5 max-w-2xl text-xs text-[var(--text-dim)]">
              Pick the winner — that's all you need. Add up to three more racers,
              scores and a kill log if you have them. Every board recalculates itself.
            </p>
          </div>
          <button
            className="btn btn-ghost shrink-0 !px-2.5 !py-2"
            onClick={requestClose}
            disabled={phase !== 'idle'}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — racers on the left, the race on the right. */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* LEFT · racer picker (collapsible on mobile). */}
          <div className="flex min-h-0 shrink-0 flex-col border-b border-hairline lg:w-[380px] lg:border-b-0 lg:border-r xl:w-[420px]">
            {/* Mobile toggle. */}
            <button
              className="flex shrink-0 items-center justify-between px-5 py-3 lg:hidden"
              onClick={() => setPickerOpen((o) => !o)}
              aria-expanded={pickerOpen}
            >
              <Label>Racers · {finishers.length} selected</Label>
              {pickerOpen ? (
                <ChevronUp size={16} className="text-[var(--text-faint)]" />
              ) : (
                <ChevronDown size={16} className="text-[var(--text-faint)]" />
              )}
            </button>

            <div
              className={`min-h-0 flex-1 flex-col px-5 pb-5 lg:flex lg:px-6 lg:py-6 ${
                pickerOpen ? 'flex' : 'hidden'
              }`}
            >
              <Label className="mb-2 hidden lg:block">Add racers</Label>

              {/* Search. */}
              <div className="relative shrink-0">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
                />
                <input
                  ref={searchRef}
                  className="field !pl-10"
                  placeholder={
                    finishers.length >= 4
                      ? 'Grid full — remove a car to swap one in'
                      : 'Name, email or ride…'
                  }
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={phase !== 'idle'}
                />
              </div>

              {/* Roster. */}
              <div
                className="no-scrollbar mt-3 max-h-[42vh] flex-1 overflow-y-auto pr-1 lg:max-h-none"
                style={{ scrollbarGutter: 'stable' }}
              >
                {filtered.length === 0 ? (
                  <p className="py-10 text-center text-sm text-[var(--text-faint)]">
                    Nobody matches “{query}”.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2">
                    {filtered.map((user) => {
                      const selected = finishers.some((f) => f.racerId === user.id);
                      const full = finishers.length >= 4;
                      return (
                        <button
                          key={user.id}
                          onClick={() => toggleRacer(user.id)}
                          disabled={phase !== 'idle' || (!selected && full)}
                          className={`group relative flex items-center gap-3 border p-2.5 text-left transition-all duration-200 disabled:opacity-40 ${
                            selected
                              ? 'border-transparent'
                              : 'border-hairline bg-white/[0.015] hover:border-white/25 hover:bg-white/[0.05]'
                          }`}
                          style={
                            selected
                              ? {
                                  ...withGlow(user.accentColor),
                                  background: `linear-gradient(135deg, ${user.accentColor}2e, ${user.accentColor}0d)`,
                                  boxShadow: `inset 0 0 0 1px ${user.accentColor}, 0 0 30px -12px ${user.accentColor}`,
                                }
                              : undefined
                          }
                        >
                          <Avatar
                            src={user.avatarUrl}
                            name={user.displayName}
                            size={38}
                            accent={user.accentColor}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-display text-[0.75rem] font-bold uppercase tracking-wide text-white">
                              {user.displayName}
                            </span>
                            <span className="block truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
                              {user.scores.allTime} all-time · {user.favoriteRacer}
                            </span>
                          </span>
                          {selected && (
                            <span
                              className="grid h-6 w-6 shrink-0 place-items-center rounded-full"
                              style={{
                                background: user.accentColor,
                                boxShadow: `0 0 16px ${user.accentColor}`,
                              }}
                            >
                              <Check size={13} className="text-black" strokeWidth={3.5} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT · the race. */}
          <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5 sm:px-8 sm:py-6">
            {finishers.length === 0 ? (
              <div className="grid flex-1 place-items-center px-6 text-center">
                <div>
                  <Trophy className="mx-auto mb-3 opacity-25" size={38} />
                  <p className="mx-auto max-w-xs text-sm text-[var(--text-faint)]">
                    Pick the winner from the racers list to start logging the race.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* The grid — drag or use the arrows to set the running order. */}
                <div>
                  <Label className="mb-2">
                    The grid · {finishers.length} {finishers.length === 1 ? 'car' : 'cars'}
                    {finishers.length === 1 ? ' · winner only' : ' · drag to reorder'}
                  </Label>
                  <div ref={gridRef} className="space-y-2">
                    {finishers.map((finisher, index) => {
                      const user = usersById.get(finisher.racerId);
                      if (!user) return null;
                      const medal = PLACE_COLOR[Math.min(index, PLACE_COLOR.length - 1)];
                      const scoreIssue = scoreOrderIssues.get(finisher.racerId);
                      return (
                        <div
                          key={finisher.racerId}
                          className={`border bg-white/[0.015] p-3 transition ${
                            dragIndex === index
                              ? 'border-plasma/60 opacity-50'
                              : scoreIssue
                                ? 'score-order-flicker border-danger/70'
                                : 'border-hairline'
                          }`}
                          style={withGlow(user.accentColor)}
                        >
                          <div className="flex items-center gap-2 sm:gap-3">
                            {/* Drag handle — works on touch and mouse via Pointer Events. */}
                            <span
                              onPointerDown={(event) => beginDrag(index, event)}
                              onPointerMove={dragOverMove}
                              onPointerUp={endDrag}
                              onPointerCancel={endDrag}
                              className="shrink-0 cursor-grab text-[var(--text-faint)] transition hover:text-plasma active:cursor-grabbing"
                              style={{ touchAction: 'none' }}
                              title="Drag to reorder"
                              aria-label="Drag to reorder"
                            >
                              <GripVertical size={16} />
                            </span>

                            {/* Reorder arrows — the touch-friendly path. */}
                            <span className="flex shrink-0 flex-col">
                              <button
                                className="px-0.5 text-[var(--text-faint)] transition hover:text-plasma disabled:opacity-20"
                                disabled={index === 0 || phase !== 'idle'}
                                onClick={() => move(index, -1)}
                                aria-label="Move up"
                              >
                                <ChevronUp size={15} />
                              </button>
                              <button
                                className="px-0.5 text-[var(--text-faint)] transition hover:text-plasma disabled:opacity-20"
                                disabled={index === finishers.length - 1 || phase !== 'idle'}
                                onClick={() => move(index, 1)}
                                aria-label="Move down"
                              >
                                <ChevronDown size={15} />
                              </button>
                            </span>

                            {/* Place medal. */}
                            <span
                              className="grid h-8 w-8 shrink-0 place-items-center font-display text-sm font-black text-black"
                              style={{ background: medal, boxShadow: `0 0 14px ${medal}`, borderRadius: 4 }}
                              title={`Place ${index + 1}`}
                            >
                              {index + 1}
                            </span>

                            <Avatar
                              src={user.avatarUrl}
                              name={user.displayName}
                              size={34}
                              accent={user.accentColor}
                            />

                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-display text-[0.75rem] font-bold uppercase tracking-wide text-white">
                                {user.displayName}
                                {index === 0 && (
                                  <span className="ml-2 text-[0.55rem] tracking-widest" style={{ color: medal }}>
                                    winner
                                  </span>
                                )}
                              </span>
                              <span className="block truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
                                {user.favoriteRacer}
                              </span>
                            </span>

                            {/* Score. */}
                            <label className="flex shrink-0 flex-col items-end gap-0.5">
                              <span className="label !text-[0.5rem]">Score</span>
                              <input
                                type="number"
                                min={0}
                                max={999}
                                inputMode="numeric"
                                className={`field !w-[4.5rem] !px-2 !py-1.5 text-right font-mono text-sm ${
                                  scoreIssue ? '!border-danger/70' : ''
                                }`}
                                placeholder={String(DEFAULT_SCORE_BY_PLACE[index] ?? 0)}
                                value={finisher.gameScore}
                                disabled={phase !== 'idle'}
                                onChange={(event) => setGameScore(finisher.racerId, event.target.value)}
                              />
                            </label>

                            <button
                              className="shrink-0 p-1.5 text-[var(--text-faint)] transition hover:text-danger disabled:opacity-30"
                              disabled={phase !== 'idle'}
                              onClick={() => toggleRacer(finisher.racerId)}
                              aria-label={`Remove ${user.displayName}`}
                            >
                              <X size={15} />
                            </button>
                          </div>

                          {/* Captured stats — one input per admin-defined metric. */}
                          {captured.length > 0 && (
                            <div className="mt-2.5 grid grid-cols-2 gap-2 pl-9 sm:grid-cols-3 sm:pl-11 lg:grid-cols-4">
                              {captured.map((metric) => (
                                <label key={metric.id} className="flex flex-col gap-0.5">
                                  <span className="label !text-[0.5rem] truncate">
                                    {metric.label}
                                    {metric.unit ? ` · ${metric.unit}` : ''}
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    inputMode="numeric"
                                    className="field !px-2 !py-1.5 font-mono text-xs"
                                    placeholder="0"
                                    value={finisher.stats[metric.id] ?? ''}
                                    disabled={phase !== 'idle'}
                                    onChange={(event) =>
                                      setStat(finisher.racerId, metric.id, event.target.value)
                                    }
                                  />
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Kill log — who took out whom. Sets kills/deaths; revenge auto-tags. */}
                {finishers.length >= 2 && (
                  <div>
                    {/* Optional, so it folds away on mobile until tapped open. */}
                    <button
                      type="button"
                      className="flex w-full items-center justify-between lg:pointer-events-none"
                      onClick={() => setKillsOpen((o) => !o)}
                      aria-expanded={killsOpen}
                    >
                      <Label>Kill log · optional{kills.length > 0 ? ` · ${kills.length}` : ''}</Label>
                      <ChevronDown
                        size={16}
                        className={`text-[var(--text-faint)] transition-transform lg:hidden ${
                          killsOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    <div className={`mt-2 lg:block ${killsOpen ? 'block' : 'hidden'}`}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <RacerSelect
                        className="sm:flex-1"
                        value={killer}
                        onChange={setKiller}
                        placeholder="Killer…"
                        disabled={phase !== 'idle'}
                        racers={
                          finishers
                            .map((f) => usersById.get(f.racerId))
                            .filter((u): u is PublicUser => u !== undefined)
                        }
                      />
                      <span className="shrink-0 text-center text-[0.62rem] uppercase tracking-widest text-[var(--text-faint)]">
                        took out
                      </span>
                      <RacerSelect
                        className="sm:flex-1"
                        value={victim}
                        onChange={setVictim}
                        placeholder="Victim…"
                        disabled={phase !== 'idle' || !killer}
                        racers={
                          finishers
                            .map((f) => usersById.get(f.racerId))
                            .filter((u): u is PublicUser => u !== undefined && u.id !== killer)
                        }
                      />
                      <button
                        className="btn btn-ghost shrink-0"
                        disabled={phase !== 'idle' || !killer || !victim || killer === victim}
                        onClick={addKill}
                      >
                        <Plus size={14} strokeWidth={3} /> Add kill
                      </button>
                    </div>

                    {kills.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {kills.map((kill, index) => {
                          const killerUser = usersById.get(kill.killerId);
                          const victimUser = usersById.get(kill.victimId);
                          return (
                            <li
                              key={`${kill.killerId}-${kill.victimId}-${index}`}
                              className="flex items-center gap-2 border border-hairline bg-white/[0.015] px-3 py-1.5 text-xs"
                            >
                              <Skull size={13} className="shrink-0 text-[var(--text-faint)]" />
                              <span className="truncate font-display uppercase tracking-wide text-white">
                                {killerUser?.displayName ?? '—'}
                              </span>
                              <span className="text-[var(--text-faint)]">→</span>
                              <span className="truncate font-display uppercase tracking-wide text-white">
                                {victimUser?.displayName ?? '—'}
                              </span>
                              <button
                                className="ml-auto shrink-0 text-[var(--text-faint)] transition hover:text-danger disabled:opacity-30"
                                disabled={phase !== 'idle'}
                                onClick={() => removeKill(index)}
                                aria-label="Remove kill"
                              >
                                <X size={13} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <p className="mt-1.5 font-mono text-[0.6rem] text-[var(--text-faint)]">
                      Each kill sets the racers' kills &amp; deaths. Revenge — a same-day
                      payback — is tagged automatically.
                    </p>
                    </div>
                  </div>
                )}

                {/* Optional note. */}
                <div>
                  <Label className="mb-1.5">Note · optional</Label>
                  <input
                    className="field"
                    placeholder="e.g. Volcano Loop, photo finish"
                    maxLength={140}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    disabled={phase !== 'idle'}
                  />
                </div>
              </>
            )}

            {scoreOrderIssues.size > 0 && (
              <div className="space-y-1.5">
                {[...scoreOrderIssues.values()].map((message) => (
                  <p
                    key={message}
                    className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
                  >
                    {message}
                  </p>
                ))}
              </div>
            )}

            {error && (
              <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        </div>

        {/* Footer — actions pinned to the bottom. */}
        <div className="flex shrink-0 flex-col-reverse items-stretch gap-3 border-t border-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <button className="btn btn-ghost" onClick={requestClose} disabled={phase !== 'idle'}>
            Cancel
          </button>
          <SubmitButton
            accent={accent}
            phase={phase}
            armed={canSubmit}
            winnerName={winner?.displayName}
            onClick={() => void submit()}
          />
        </div>
      </Panel>
    </div>,
    document.body,
  );
}

/**
 * The fancy bit. Three visual states:
 *  - disarmed: flat, waiting for a valid grid
 *  - armed:    rotating conic ring, drifting gradient, hover sparks
 *  - charging: fills left-to-right, shockwave, then flashes white on launch
 */
function SubmitButton({
  accent,
  phase,
  armed,
  winnerName,
  onClick,
}: {
  accent: string;
  phase: 'idle' | 'charging' | 'launched';
  armed: boolean;
  winnerName?: string;
  onClick: () => void;
}) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: i,
        left: 8 + i * 9,
        dx: Math.round(Math.sin(i * 1.9) * 34),
        dy: -22 - (i % 4) * 12,
        delay: (i % 5) * 0.11,
      })),
    [],
  );

  const busy = phase !== 'idle';
  const label =
    phase === 'launched'
      ? 'Launched'
      : phase === 'charging'
        ? 'Recording…'
        : armed
          ? `Crown ${winnerName?.split(' ')[0] ?? 'them'}`
          : 'Pick a winner';

  return (
    <button
      onClick={onClick}
      disabled={!armed || busy}
      className={`btn relative isolate min-w-[13rem] overflow-visible !py-3.5 !text-[0.72rem] sm:!text-xs ${
        armed ? 'ring-spin text-white' : 'text-[var(--text-faint)]'
      }`}
      style={{
        ...withGlow(accent),
        background: armed
          ? `linear-gradient(115deg, ${accent}, #FF2D95 55%, ${accent} 110%)`
          : 'rgb(255 255 255 / 0.03)',
        backgroundSize: '220% 100%',
        border: armed ? 'none' : '1px solid var(--hairline)',
        boxShadow: armed
          ? `0 0 0 1px rgb(255 255 255 / 0.2), 0 12px 40px -14px ${accent}`
          : 'none',
        animation: armed && !busy ? 'submit-drift 3.4s ease-in-out infinite' : undefined,
        cursor: armed && !busy ? 'pointer' : undefined,
      }}
    >
      {/* Charge fill. */}
      {phase === 'charging' && (
        <span
          className="absolute inset-0 -z-10 origin-left"
          style={{
            background: 'linear-gradient(90deg, #fff, rgb(255 255 255 / 0.2))',
            animation: 'charge-fill 620ms linear forwards',
            mixBlendMode: 'overlay',
          }}
        />
      )}

      {/* Launch flash + shockwave. */}
      {phase === 'launched' && (
        <>
          <span
            className="absolute inset-0 -z-10 bg-white"
            style={{ animation: 'flash-out 420ms ease-out forwards' }}
          />
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{ borderColor: '#fff', animation: 'shockwave 620ms ease-out forwards' }}
          />
        </>
      )}

      {/* Hover sparks, armed state only. */}
      {armed && !busy && (
        <span className="pointer-events-none absolute inset-0 overflow-visible opacity-0 transition-opacity duration-300 hover:opacity-100 group-hover:opacity-100 [button:hover>&]:opacity-100">
          {sparks.map((spark) => (
            <span
              key={spark.id}
              className="absolute bottom-1 h-1 w-1 rounded-full bg-white"
              style={{
                left: `${spark.left}%`,
                boxShadow: '0 0 8px #fff',
                ['--dx' as string]: `${spark.dx}px`,
                ['--dy' as string]: `${spark.dy}px`,
                animation: `spark-fly 900ms ${spark.delay}s ease-out infinite`,
              }}
            />
          ))}
        </span>
      )}

      <Trophy
        size={15}
        className={phase === 'charging' ? 'animate-spin' : armed ? 'animate-hover' : ''}
      />
      <span className="relative">{label}</span>

      <style>{`
        @keyframes submit-drift {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }
        @keyframes charge-fill {
          from { transform: scaleX(0); }
          to   { transform: scaleX(1); }
        }
        @keyframes flash-out {
          from { opacity: 0.95; }
          to   { opacity: 0; }
        }
      `}</style>
    </button>
  );
}

/**
 * A themed racer picker — avatar + name, not a bare native <select>. Opens a
 * neon option list, closes on outside-click or Escape. Only a handful of
 * options (the race's finishers), so a simple absolute panel is plenty.
 */
function RacerSelect({
  value,
  onChange,
  racers,
  placeholder,
  disabled,
  className = '',
}: {
  value: string;
  onChange: (id: string) => void;
  racers: PublicUser[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A disabled control must never hang open (e.g. victim before a killer is set).
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selected = racers.find((r) => r.id === value) ?? null;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="field flex w-full items-center gap-2 !py-2 text-left disabled:opacity-50"
      >
        {selected ? (
          <>
            <Avatar src={selected.avatarUrl} name={selected.displayName} size={22} accent={selected.accentColor} />
            <span className="min-w-0 flex-1 truncate font-display text-[0.72rem] font-bold uppercase tracking-wide text-white">
              {selected.displayName}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[var(--text-faint)]">{placeholder}</span>
        )}
        <ChevronDown
          size={15}
          className={`shrink-0 text-[var(--text-faint)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto border border-hairline bg-[#0a0e1c] shadow-[0_18px_50px_-12px_rgba(0,0,0,0.85)]"
        >
          {racers.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--text-faint)]">No racers to pick</p>
          ) : (
            racers.map((racer) => {
              const active = racer.id === value;
              return (
                <button
                  key={racer.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(racer.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/[0.06] ${
                    active ? 'bg-white/[0.05]' : ''
                  }`}
                >
                  <Avatar src={racer.avatarUrl} name={racer.displayName} size={22} accent={racer.accentColor} />
                  <span className="min-w-0 flex-1 truncate font-display text-[0.72rem] font-bold uppercase tracking-wide text-white">
                    {racer.displayName}
                  </span>
                  {active && (
                    <Check size={13} className="shrink-0" style={{ color: racer.accentColor }} strokeWidth={3} />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default AddScoreOverlay;
