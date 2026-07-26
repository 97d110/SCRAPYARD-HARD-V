import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArthurShip } from './ArthurShip';

/**
 * The celebration: after a score is submitted, Arthur tears across the whole
 * viewport at full thrust, dragging a plasma trail and shedding sparks.
 *
 * Rendered into a portal on <body> so it flies over every layer — including
 * the Add Score overlay it was launched from.
 */
export interface ArthurFlybyProps {
  /** Bump this key to launch a fresh run. */
  runId: number | string | null;
  /** Winner's accent, so the trail matches whoever just scored. */
  accent?: string;
  /** Banner text that rides along under the ship. */
  caption?: string;
  durationMs?: number;
  onDone?: () => void;
}

export function ArthurFlyby({
  runId,
  accent = '#FF6A00',
  caption,
  durationMs = 2600,
  onDone,
}: ArthurFlybyProps) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (runId === null) return;
    setActive(true);
    const timer = window.setTimeout(() => {
      setActive(false);
      onDone?.();
    }, durationMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, durationMs]);

  // Deterministic per-run spark scatter — avoids re-randomising every frame.
  const sparks = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        id: i,
        dx: -60 - Math.round(Math.sin(i * 2.1) * 50 + 40),
        dy: Math.round(Math.cos(i * 1.7) * 46),
        delay: (i % 7) * 0.08,
        size: 2 + (i % 3),
      })),
    [runId],
  );

  if (!active || typeof document === 'undefined') return null;

  return createPortal(
    /*
     * `key={runId}` matters. Without it, a second celebration arriving while
     * the first is still in flight reconciles onto the same DOM nodes with an
     * unchanged `animation` string — so the finite `forwards` animation never
     * restarts and Arthur silently doesn't fly. Re-keying forces a remount.
     */
    <div
      key={String(runId)}
      className="pointer-events-none fixed inset-0 z-[120] overflow-hidden"
      aria-live="polite"
      aria-label={caption ?? 'Score recorded'}
    >
      {/* Screen-wide shockwave the instant the run begins. */}
      <div
        className="absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full border"
        style={{
          borderColor: accent,
          animation: 'shockwave 900ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
        }}
      />

      {/* Horizontal light-lane the ship rides in. */}
      <div
        className="absolute left-0 top-[46%] h-[2px] w-full opacity-70"
        style={{
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          filter: 'blur(1px)',
          animation: 'streak 1.1s ease-out forwards',
        }}
      />

      {/* Arthur. */}
      <div
        className="absolute top-[38%] left-0"
        style={{
          animation: `arthur-cross ${durationMs}ms cubic-bezier(0.35, 0, 0.65, 1) forwards`,
          willChange: 'transform',
        }}
      >
        <div className="relative">
          {/* Plasma trail behind the hull. */}
          <div
            className="absolute right-full top-1/2 h-3 w-[46vw] -translate-y-1/2 origin-right"
            style={{
              background: `linear-gradient(270deg, ${accent}, ${accent}55 40%, transparent)`,
              filter: 'blur(6px)',
            }}
          />
          <div
            className="absolute right-full top-1/2 h-[3px] w-[62vw] -translate-y-1/2 origin-right"
            style={{ background: `linear-gradient(270deg, #fff, ${accent}, transparent)` }}
          />

          {/* Sparks shedding off the engine. */}
          {sparks.map((spark) => (
            <span
              key={spark.id}
              className="absolute left-2 top-1/2 rounded-full"
              style={{
                width: spark.size,
                height: spark.size,
                background: spark.id % 3 === 0 ? '#fff' : accent,
                boxShadow: `0 0 8px ${accent}`,
                ['--dx' as string]: `${spark.dx}px`,
                ['--dy' as string]: `${spark.dy}px`,
                animation: `spark-fly 700ms ${spark.delay}s ease-out infinite`,
              }}
            />
          ))}

          <ArthurShip size={168} thrust accent={accent} />
        </div>
      </div>

      {/* Caption riding along the bottom, styled like a race announcement. */}
      {caption && (
        <div className="absolute inset-x-0 bottom-[14%] flex justify-center px-4">
          <div
            className="panel panel-tight px-6 py-3 text-center"
            style={{
              ['--glow' as string]: accent,
              animation: 'rise 420ms 260ms cubic-bezier(0.16, 1, 0.3, 1) both',
            }}
          >
            <p className="label mb-1">Score locked in</p>
            <p
              className="font-display text-lg font-black uppercase tracking-wider sm:text-2xl"
              style={{ color: '#fff', textShadow: `0 0 18px ${accent}` }}
            >
              {caption}
            </p>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

export default ArthurFlyby;
