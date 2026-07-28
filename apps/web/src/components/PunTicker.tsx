import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArthurShip } from './arthur/ArthurShip';
import type { Pun } from '@scrapyard/shared';

/**
 * The top prompter. **One pun at a time**: it enters from the right, crosses the
 * banner, exits fully on the left, and only then does the next one begin.
 *
 * Implementation notes:
 *  - Driven by the Web Animations API rather than CSS keyframes. The travel
 *    distance depends on the measured pun width, which varies per pun, so
 *    explicit pixel keyframes are simpler than trying to feed a CSS var into a
 *    @keyframes transform. It also gives us `onfinish`, which is what advances
 *    to the next pun — no timers to drift out of sync with the animation.
 *  - Duration is derived from distance, so every pun moves at the same *speed*
 *    regardless of how long the text is.
 *  - Pauses on hover and when the tab is hidden, so it isn't burning frames
 *    behind your back.
 *  - Under `prefers-reduced-motion` nothing moves: each pun is held still and
 *    cross-faded. This is load-bearing, not a nicety — the global reduced-motion
 *    rule in index.css collapses animations to 0.01ms, which with an
 *    onfinish-driven sequence would spin through every pun in a few frames.
 */
export interface PunTickerProps {
  puns: Pun[];
  /** Pixels per second. Lower is more readable; this thing may live on a wall. */
  speed?: number;
  /** How long each pun is held when motion is reduced. */
  holdMs?: number;
}

const FALLBACK: Pun[] = [
  {
    id: 'fallback',
    text: 'No health, no levelling, no brakes.',
    enabled: true,
    createdAt: '',
    updatedAt: '',
  },
];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export function PunTicker({ puns, speed = 90, holdMs = 5000 }: PunTickerProps) {
  const items = puns.length > 0 ? puns : FALLBACK;

  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const containerRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);

  // Accent cycles through the palette so consecutive Arthurs differ.
  const accents = useMemo(() => ['#00E5FF', '#FF6A00', '#B6FF3C', '#FF2D95', '#7C5CFF'], []);

  const current = items[index % items.length];
  const accent = accents[index % accents.length];

  const advance = useCallback(() => {
    setIndex((i) => (i + 1) % items.length);
  }, [items.length]);

  /*
   * One animation per pun. Re-running on `index` gives each pun a fresh
   * measurement, which matters because a long pun has further to travel.
   */
  useEffect(() => {
    if (reducedMotion) {
      if (paused) return;
      const timer = window.setTimeout(advance, holdMs);
      return () => window.clearTimeout(timer);
    }

    const container = containerRef.current;
    const item = itemRef.current;
    if (!container || !item) return;

    const containerWidth = container.offsetWidth;
    const itemWidth = item.offsetWidth;

    // Guard against a zero measurement on the very first paint — retry next frame.
    if (containerWidth === 0 || itemWidth === 0) {
      const raf = requestAnimationFrame(advance);
      return () => cancelAnimationFrame(raf);
    }

    // Fully off the right edge, to fully off the left edge.
    const distance = containerWidth + itemWidth;

    const animation = item.animate(
      [
        { transform: `translate3d(${containerWidth}px, 0, 0)` },
        { transform: `translate3d(${-itemWidth}px, 0, 0)` },
      ],
      {
        duration: (distance / speed) * 1000,
        easing: 'linear',
        fill: 'both',
      },
    );

    animationRef.current = animation;
    animation.onfinish = advance;

    return () => {
      animation.onfinish = null;
      animation.cancel();
      animationRef.current = null;
    };
    // `paused` is deliberately excluded: pausing must not restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length, reducedMotion, speed, holdMs, advance]);

  // Pause/resume without tearing down the animation.
  useEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;
    if (paused) animation.pause();
    else animation.play();
  }, [paused]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <div
      className="flex h-full w-full items-stretch border-b border-hairline bg-[#06080f]/90 backdrop-blur"
      style={{ height: 'var(--ticker-h)' }}
    >
      {/* Cytactic mark — a normal child of the bar, sharing its space with
          the marquee rather than floating above it. */}
      <Link
        to="/"
        className="flex shrink-0 items-center px-3 transition-transform hover:scale-105 sm:px-4"
        aria-label="Cytactic — home"
      >
        <img src="/cytactic-logo.png" alt="Cytactic" className="h-7 w-7 sm:h-8 sm:w-8" draggable={false} />
      </Link>
      <span className="my-2.5 w-px shrink-0 bg-white/10" aria-hidden="true" />

      {/* The marquee, confined to whatever width is left of the bar. */}
      <div
        ref={containerRef}
        className="scanlines relative isolate min-w-0 flex-1 overflow-hidden"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        role="marquee"
        aria-label="BlazeRush puns"
      >
        {/* Hot/cold wash behind the text. */}
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-70"
          style={{
            background:
              'linear-gradient(90deg, rgb(255 106 0 / 0.16), transparent 30%, transparent 70%, rgb(0 229 255 / 0.16))',
          }}
        />
        {/* Edge fades so text dissolves rather than clipping. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-[#06080f] to-transparent sm:w-28" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-[#06080f] to-transparent sm:w-28" />

        {/*
          Keyed on the pun id so React remounts per pun. That guarantees a clean
          element for each animation instead of reusing one mid-flight.
        */}
        <div
          key={current.id}
          ref={itemRef}
          className="absolute left-0 top-0 flex h-full w-max items-center"
          style={
            reducedMotion
              ? {
                  // Held still and centred; cross-fade handles the transition.
                  left: '50%',
                  transform: 'translateX(-50%)',
                  animation: 'pun-fade 600ms ease-out both',
                }
              : {
                  // Parked off-screen right until the animation takes over, so
                  // there's no flash of an unpositioned pun on the first frame.
                  transform: 'translate3d(100vw, 0, 0)',
                  willChange: 'transform',
                }
          }
        >
          <span className="whitespace-nowrap px-5 font-body text-[0.78rem] font-medium tracking-wide text-[#cfd8ff] sm:text-sm 3xl:text-base">
            {current.text}
          </span>
          {/* Arthur rides along behind each pun, spinning. */}
          <span className="grid shrink-0 place-items-center px-2" aria-hidden="true">
            <ArthurShip size={34} spin accent={accent} />
          </span>
        </div>

        <style>{`
          @keyframes pun-fade {
            from { opacity: 0; }
            to   { opacity: 1; }
          }
        `}</style>
      </div>
    </div>
  );
}

export default PunTicker;
