import { useEffect, useMemo, useRef, useState } from 'react';
import { ArthurShip } from './arthur/ArthurShip';
import type { Pun } from '@scrapyard/shared';

/**
 * The top prompter. Puns scroll continuously right-to-left with a spinning
 * Arthur between each one, exactly like a stadium ticker.
 *
 * Implementation notes:
 *  - The track is duplicated and translated -50%, which gives a seam-free
 *    infinite loop without measuring anything.
 *  - Duration scales with content length so 5 puns and 50 puns scroll at the
 *    same *speed*, not the same *rate*.
 *  - Pauses on hover and when the tab is hidden, so it isn't burning frames
 *    behind your back.
 */
export interface PunTickerProps {
  puns: Pun[];
  /** Pixels per second. */
  speed?: number;
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

export function PunTicker({ puns, speed = 72 }: PunTickerProps) {
  /*
   * The two-copy loop leaves visible dead space if the content is narrower than
   * the viewport, so repeat a short list until there's enough to fill it.
   */
  const items = useMemo(() => {
    const source = puns.length > 0 ? puns : FALLBACK;
    const MIN_ITEMS = 6;
    if (source.length >= MIN_ITEMS) return source;
    const repeated: Pun[] = [];
    while (repeated.length < MIN_ITEMS) {
      repeated.push(...source.map((pun, i) => ({ ...pun, id: `${pun.id}-r${repeated.length + i}` })));
    }
    return repeated;
  }, [puns]);

  const trackRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(40);
  const [paused, setPaused] = useState(false);

  // Accent cycles through the palette so consecutive Arthurs differ.
  const accents = useMemo(() => ['#00E5FF', '#FF6A00', '#B6FF3C', '#FF2D95', '#7C5CFF'], []);

  useEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      if (!track) return;
      // scrollWidth covers both copies; one loop travels half of it.
      const loopDistance = track.scrollWidth / 2;
      if (loopDistance > 0) setDuration(Math.max(12, loopDistance / speed));
    };

    measure();
    // Re-measure when fonts land or the viewport changes width.
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => observer.disconnect();
  }, [items, speed]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const sequence = (keyPrefix: string) =>
    items.map((pun, i) => (
      <div key={`${keyPrefix}-${pun.id}`} className="flex shrink-0 items-center">
        <span className="whitespace-nowrap px-5 font-body text-[0.78rem] font-medium tracking-wide text-[#cfd8ff] sm:text-sm 3xl:text-base">
          {pun.text}
        </span>
        {/* The separator: Arthur, spinning. */}
        <span className="grid shrink-0 place-items-center px-2" aria-hidden="true">
          <ArthurShip size={34} spin accent={accents[i % accents.length]} />
        </span>
      </div>
    ));

  return (
    <div
      className="scanlines relative isolate w-full overflow-hidden border-b border-hairline bg-[#06080f]/90 backdrop-blur"
      style={{ height: 'var(--ticker-h)' }}
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

      <div
        ref={trackRef}
        className="flex h-full w-max items-center"
        style={{
          /*
           * Longhand, not the `animation` shorthand. React only writes changed
           * style keys — with the shorthand, a duration change rewrites it and
           * silently resets play-state to `running`, un-pausing a hover that
           * the user is still holding.
           */
          animationName: 'ticker-scroll',
          animationDuration: `${duration}s`,
          animationTimingFunction: 'linear',
          animationIterationCount: 'infinite',
          animationPlayState: paused ? 'paused' : 'running',
          willChange: 'transform',
        }}
      >
        {sequence('a')}
        {/* Second copy makes the wrap invisible. */}
        <div aria-hidden="true" className="flex">
          {sequence('b')}
        </div>
      </div>

      <style>{`
        @keyframes ticker-scroll {
          from { transform: translate3d(0, 0, 0); }
          to   { transform: translate3d(-50%, 0, 0); }
        }
      `}</style>
    </div>
  );
}

export default PunTicker;
