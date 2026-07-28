import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

/**
 * The celebration that replaces Arthur's flyby: the BlazeRush finish emblem
 * genies up out of a point, shimmers while sparks come off it, then launches
 * off-screen with a skew like a car dumping the clutch at the lights.
 *
 * Three acts, choreographed on one keyframe track so the phases can't drift
 * apart the way separately-timed animations do:
 *
 *   1. GENIE   0 → 0.33   a wisp at the bottom twists open into the full crest
 *   2. SHIMMER 0.33 → 0.77  glint sweeps across the gold, sparks shed off it
 *   3. LAUNCH  0.77 → 1    squat, lean, then 0-100 out of frame under skew
 *
 * The art is a transparent PNG with feathered edges, so it composites
 * normally — the glow is a `drop-shadow` that traces the crest's real alpha,
 * and the glint copy is the only layer that blends.
 */

const EMBLEM_SRC = '/finish-emblem.png';

/** Normalised stops shared by every property on the emblem's track. */
const STOPS = [0, 0.09, 0.18, 0.27, 0.33, 0.72, 0.77, 1];

/** Per-segment easing — the last one is the 0-100 pull. */
const EASES = ['easeOut', 'easeOut', 'easeOut', 'easeOut', 'linear', 'easeIn', [0.7, 0, 0.85, 0.15]];

export interface FinishFlourishProps {
  /** Bump this to launch a fresh run. */
  runId: number | string | null;
  /** Winner's accent — drives the glow, sparks and scrim tint. */
  accent?: string;
  /** Banner text that rides under the crest. */
  caption?: string;
  durationMs?: number;
  onDone?: () => void;
}

export function FinishFlourish({
  runId,
  accent = '#FF6A00',
  caption,
  durationMs = 3400,
  onDone,
}: FinishFlourishProps) {
  const seconds = durationMs / 1000;

  // Warm the browser cache well before the first race is logged — the emblem is
  // a big PNG and decoding it mid-launch would stutter the opening frames.
  useEffect(() => {
    const preload = new Image();
    preload.src = EMBLEM_SRC;
  }, []);

  useEffect(() => {
    if (runId === null) return;
    const timer = window.setTimeout(() => onDone?.(), durationMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, durationMs]);

  /* Deterministic spark scatter — seeded off the index so a re-render never
     reshuffles mid-flight. Angles fan out and up, the way debris would.
     Delays are fractions of the run, not absolute seconds, so the three acts
     stay in phase at any `durationMs`. */
  const sparks = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => {
        const angle = (i / 22) * Math.PI * 2;
        const reach = 120 + Math.abs(Math.sin(i * 1.7)) * 160;
        return {
          id: i,
          // Start along the crest's silhouette rather than dead centre.
          left: `${18 + Math.abs(Math.cos(i * 2.3)) * 64}%`,
          top: `${12 + Math.abs(Math.sin(i * 1.9)) * 66}%`,
          dx: Math.cos(angle) * reach,
          dy: Math.sin(angle) * reach - 60,
          size: 2 + (i % 4),
          delay: seconds * (0.3 + (i % 9) * 0.022),
          tint: i % 5 === 0 ? '#ffffff' : i % 3 === 0 ? '#FFB020' : accent,
        };
      }),
    [accent, seconds],
  );

  if (runId === null || typeof document === 'undefined') return null;

  return createPortal(
    /*
     * `key={runId}` forces a remount per run. Without it a second celebration
     * arriving mid-flight reconciles onto the same nodes and the finite
     * animation never restarts.
     *
     * `isolation: isolate` keeps the screen blending inside this overlay
     * instead of letting it composite against the whole page.
     */
    <motion.div
      key={String(runId)}
      className="pointer-events-none fixed inset-0 z-[120] overflow-hidden"
      style={{ isolation: 'isolate' }}
      aria-live="polite"
      aria-label={caption ?? 'Score recorded'}
      /*
       * The whole overlay fades as one group, and the scrim below stays fully
       * opaque. Fading the scrim instead leaves the art's opaque matte blocking
       * the page where the translucent scrim would have let it through — which
       * paints the art's rectangle as a patch *darker* than its surroundings.
       */
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 1, 0] }}
      transition={{ duration: seconds, times: [0, 0.05, 0.86, 1], ease: 'linear' }}
    >
      {/* Spotlight scrim: dims the page without hiding it. */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at 50% 46%, ${accent}22 0%, #04050cD9 45%, #04050cF2 100%)`,
        }}
      />

      {/* The lamp: genie smoke boiling up from the point the crest unfurls out of. */}
      <motion.div
        className="absolute left-1/2 top-[62%] h-40 w-40 rounded-full"
        /* Centring has to be an FM prop, not a Tailwind translate class: FM
           owns `transform` on this node and would overwrite the utility. */
        style={{ background: `radial-gradient(circle, ${accent} 0%, transparent 70%)`, filter: 'blur(22px)', x: '-50%' }}
        initial={{ opacity: 0, scaleX: 0.2, scaleY: 0.2 }}
        animate={{ opacity: [0, 0.95, 0.5, 0], scaleX: [0.2, 1.7, 2.6, 3.2], scaleY: [0.2, 1.2, 0.7, 0.4] }}
        transition={{ duration: seconds * 0.42, ease: 'easeOut' }}
      />

      {/* Shockwave ring at the moment the crest snaps to full size. */}
      <motion.div
        className="absolute left-1/2 top-[46%] h-56 w-56 rounded-full border-2"
        style={{ borderColor: accent, x: '-50%', y: '-50%' }}
        initial={{ opacity: 0, scale: 0.2 }}
        animate={{ opacity: [0, 0.85, 0], scale: [0.2, 2.4, 3.2] }}
        transition={{ duration: seconds * 0.27, delay: seconds * 0.27, ease: 'easeOut' }}
      />

      {/* ---- The crest ---------------------------------------------------- */}
      <motion.div
        className="absolute left-1/2 top-[46%] w-[min(88vw,880px)]"
        style={{ originX: 0.5, originY: 1, willChange: 'transform' }}
        initial={{ x: '-50%', y: '-16%', scaleX: 0.05, scaleY: 0.18, skewX: 26, rotate: -10 }}
        animate={{
          scaleX: [0.05, 0.22, 0.78, 1.05, 1, 1, 0.95, 1.42],
          scaleY: [0.18, 0.62, 1.02, 0.97, 1, 1, 1.05, 0.76],
          skewX: [26, -14, 6, -2, 0, 0, 9, -30],
          rotate: [-10, 7, -3, 1, 0, 0, -1.5, 2.5],
          // Offsets ride on top of the -50% centring.
          x: ['-50%', '-50%', '-50%', '-50%', '-50%', '-50%', '-53%', '115%'],
          y: ['-16%', '-37%', '-47%', '-50%', '-50%', '-50%', '-49%', '-52%'],
        }}
        transition={{ duration: seconds, times: STOPS, ease: EASES }}
      >
        <div className="relative">
          {/* Base art. The drop-shadow rides in the same filter list as the
              blur so the glow traces the crest's own alpha — feathered edges
              and all — rather than a box around it. */}
          <motion.img
            src={EMBLEM_SRC}
            alt=""
            draggable={false}
            decoding="async"
            className="relative block w-full select-none"
            style={{ willChange: 'filter, opacity' }}
            initial={{ opacity: 0, filter: `blur(12px) drop-shadow(0 0 18px ${accent}00)` }}
            animate={{
              opacity: [0, 1, 1, 1, 1, 1, 1, 1],
              filter: [
                `blur(12px) drop-shadow(0 0 18px ${accent}00)`,
                `blur(6px) drop-shadow(0 0 26px ${accent}66)`,
                `blur(1.5px) drop-shadow(0 0 34px ${accent}aa)`,
                `blur(0px) drop-shadow(0 0 40px ${accent}cc)`,
                `blur(0px) drop-shadow(0 0 34px ${accent}aa)`,
                `blur(0px) drop-shadow(0 0 34px ${accent}aa)`,
                `blur(0px) drop-shadow(0 0 46px ${accent}dd)`,
                `blur(3px) drop-shadow(0 0 60px ${accent}dd)`,
              ],
            }}
            transition={{ duration: seconds, times: STOPS, ease: EASES }}
          />

          {/* Shimmer: the same art, blown out and revealed through a narrow
              diagonal gradient window that sweeps across it. Because it is the
              art itself, the highlight follows the crest's shape instead of
              lighting a rectangle over it. */}
          <motion.img
            src={EMBLEM_SRC}
            alt=""
            draggable={false}
            aria-hidden
            className="pointer-events-none absolute inset-0 block w-full select-none"
            style={{
              mixBlendMode: 'screen',
              filter: 'brightness(2.6) saturate(1.35)',
              WebkitMaskImage:
                'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.55) 47%, #fff 50%, rgba(255,255,255,0.55) 53%, transparent 60%)',
              maskImage:
                'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.55) 47%, #fff 50%, rgba(255,255,255,0.55) 53%, transparent 60%)',
              WebkitMaskSize: '280% 100%',
              maskSize: '280% 100%',
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'var(--glint) 50%',
              maskPosition: 'var(--glint) 50%',
              ['--glint' as string]: '135%',
            }}
            animate={{ ['--glint' as string]: '-65%' }}
            transition={{
              duration: seconds * 0.28,
              delay: seconds * 0.3,
              ease: 'easeInOut',
              repeat: 1,
              repeatDelay: seconds * 0.09,
            }}
          />

          {/* Sparks shedding off the gold. */}
          {sparks.map((spark) => (
            <motion.span
              key={spark.id}
              className="absolute rounded-full"
              style={{
                left: spark.left,
                top: spark.top,
                width: spark.size,
                height: spark.size,
                background: spark.tint,
                boxShadow: `0 0 10px ${spark.tint}`,
              }}
              initial={{ opacity: 0, x: 0, y: 0, scale: 0.4 }}
              animate={{
                opacity: [0, 1, 1, 0],
                x: [0, spark.dx * 0.55, spark.dx],
                y: [0, spark.dy * 0.5, spark.dy + 90],
                scale: [0.4, 1, 0.2],
              }}
              transition={{
                duration: seconds * 0.34,
                delay: spark.delay,
                ease: 'easeOut',
                repeat: 1,
                repeatDelay: seconds * 0.03,
              }}
            />
          ))}
        </div>
      </motion.div>

      {/* Speed lines, struck the instant the crest launches. */}
      {[0, 1, 2, 3, 4].map((line) => (
        <motion.div
          key={line}
          className="absolute h-[2px]"
          style={{
            top: `${34 + line * 7}%`,
            left: 0,
            width: '60vw',
            background: `linear-gradient(90deg, transparent, ${line % 2 ? '#fff' : accent}, transparent)`,
            filter: 'blur(1px)',
          }}
          initial={{ opacity: 0, x: '-60vw', scaleX: 0.4 }}
          animate={{ opacity: [0, 0.9, 0], x: ['-60vw', '120vw'], scaleX: [0.4, 1.6] }}
          transition={{
            duration: seconds * 0.18,
            delay: seconds * (0.77 + line * 0.013),
            ease: 'easeIn',
          }}
        />
      ))}

      {/* Caption, styled like the old flyby's race announcement. */}
      {caption && (
        <motion.div
          className="absolute inset-x-0 bottom-[12%] flex justify-center px-4"
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: [0, 1, 1, 0], y: [26, 0, 0, 14] }}
          transition={{ duration: seconds * 0.85, times: [0, 0.22, 0.86, 1], ease: 'easeOut' }}
        >
          <div className="panel panel-tight px-6 py-3 text-center" style={{ ['--glow' as string]: accent }}>
            <p className="label mb-1">Score locked in</p>
            <p
              className="font-display text-lg font-black uppercase tracking-wider sm:text-2xl"
              style={{ color: '#fff', textShadow: `0 0 18px ${accent}` }}
            >
              {caption}
            </p>
          </div>
        </motion.div>
      )}
    </motion.div>,
    document.body,
  );
}

export default FinishFlourish;
