import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search, Trophy, X } from 'lucide-react';
import { Avatar, Label, Panel, withGlow } from './ui/primitives';
import type { PublicUser } from '@scrapyard/shared';

/**
 * The Add Score overlay: pick the winner, then hit a submit button that puts on
 * a considerable show — charging ring, sparks, a hold-to-fire arm state, and a
 * launch sequence that hands off to Arthur's flyby.
 */
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
  onSubmit: (winnerId: string, note?: string) => Promise<unknown>;
}) {
  const [query, setQuery] = useState('');
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<'idle' | 'charging' | 'launched'>('idle');
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset every time the overlay opens so it never resumes a stale state.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setWinnerId(null);
    setNote('');
    setPhase('idle');
    setError(null);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 220);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Escape closes, unless we're mid-launch.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase === 'idle') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, phase, onClose]);

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

  const winner = users.find((user) => user.id === winnerId) ?? null;
  const accent = winner?.accentColor ?? '#FF6A00';

  const submit = async () => {
    if (!winnerId || phase !== 'idle') return;
    setError(null);
    setPhase('charging');

    // Let the charge animation actually be seen before the request lands.
    const minimumCharge = new Promise((resolve) => window.setTimeout(resolve, 620));

    try {
      const [result] = await Promise.all([onSubmit(winnerId, note || undefined), minimumCharge]);
      void result;
      setPhase('launched');
      // Close just after the flyby starts, so Arthur flies over the leaderboard.
      window.setTimeout(onClose, 420);
    } catch (caught) {
      setPhase('idle');
      setError(caught instanceof Error ? caught.message : 'Could not record the score');
    }
  };

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Add score"
    >
      {/* Backdrop. */}
      <button
        className="fixed inset-0 bg-[#02030a]/85 backdrop-blur-md"
        onClick={() => phase === 'idle' && onClose()}
        aria-label="Close"
      />

      <Panel
        accent={accent}
        lit
        className="relative my-auto w-full max-w-3xl p-5 sm:p-8 3xl:max-w-4xl"
        style={{ animation: 'rise 320ms cubic-bezier(0.16,1,0.3,1) both' }}
      >
        {/* Header. */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label>Race result</Label>
            <h2 className="headline mt-1 text-2xl sm:text-4xl">Who took it?</h2>
            <p className="mt-1.5 text-xs text-[var(--text-dim)]">
              One winner, one point. Everything else recalculates itself.
            </p>
          </div>
          <button
            className="btn btn-ghost !px-2.5 !py-2"
            onClick={onClose}
            disabled={phase !== 'idle'}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search. */}
        <div className="relative mt-6">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <input
            ref={searchRef}
            className="field !pl-10"
            placeholder="Filter racers by name, email or ride…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={phase !== 'idle'}
          />
        </div>

        {/* Racer grid. */}
        <div
          className="no-scrollbar mt-4 max-h-[38vh] overflow-y-auto pr-1 sm:max-h-[42vh]"
          style={{ scrollbarGutter: 'stable' }}
        >
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-[var(--text-faint)]">
              Nobody matches “{query}”.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 3xl:grid-cols-3">
              {filtered.map((user) => {
                const selected = user.id === winnerId;
                return (
                  <button
                    key={user.id}
                    onClick={() => setWinnerId(selected ? null : user.id)}
                    disabled={phase !== 'idle'}
                    className={`group relative flex items-center gap-3 border p-2.5 text-left transition-all duration-200 ${
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

        {/* Optional note. */}
        <div className="mt-4">
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

        {error && (
          <p className="mt-4 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        {/* The submit button. */}
        <div className="mt-6 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={phase !== 'idle'}
          >
            Cancel
          </button>
          <SubmitButton
            accent={accent}
            phase={phase}
            armed={Boolean(winnerId)}
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
 *  - disarmed: flat, waiting for a winner
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

export default AddScoreOverlay;
