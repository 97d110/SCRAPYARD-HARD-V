import { useEffect, useRef, useState } from 'react';
import lottie, { type AnimationItem } from 'lottie-web';
import { ArthurShip } from './ArthurShip';

/**
 * ARTHUR, animated. The real "spaceship_spin" Lottie (fetched at runtime from
 * /arthur.lottie.json, so its ~1MB never enters the JS bundle) is the primary
 * ship across the app now. The source is authored upside-down, so the whole
 * thing is corrected with a `rotate(180deg)` on the container.
 *
 * ArthurShip — the pure inline-SVG saucer — stays as the guaranteed fallback:
 * it renders instantly while the JSON is in flight, and remains if the fetch
 * ever fails (offline, a bad deploy). That way the celebration never shows an
 * empty hole where the ship should be.
 */
export interface ArthurLottieProps {
  size?: number;
  className?: string;
  loop?: boolean;
  autoplay?: boolean;
  /** Passed to the SVG fallback so it matches the surrounding neon. */
  accent?: string;
  /** Lights the fallback's engine — used by the flyby. */
  thrust?: boolean;
}

export function ArthurLottie({
  size = 160,
  className = '',
  loop = true,
  autoplay = true,
  accent = '#00E5FF',
  thrust = false,
}: ArthurLottieProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 'ready' hides the fallback; 'failed' keeps it up for good.
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let animation: AnimationItem | null = null;
    try {
      animation = lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop,
        autoplay,
        // `path` lets lottie-web fetch and cache the JSON itself — no bundling.
        path: '/arthur.lottie.json',
        rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
      });
      animation.addEventListener('DOMLoaded', () => setStatus('ready'));
      animation.addEventListener('data_failed', () => setStatus('failed'));
    } catch {
      setStatus('failed');
    }

    return () => {
      animation?.destroy();
    };
  }, [loop, autoplay]);

  return (
    <span
      className={`relative inline-grid place-items-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* The Lottie itself, rotated to correct its upside-down authoring. */}
      <span
        ref={containerRef}
        className="absolute inset-0"
        style={{
          transform: 'rotate(180deg)',
          opacity: status === 'ready' ? 1 : 0,
          transition: 'opacity 200ms ease-out',
        }}
      />

      {/* Instant, always-safe fallback — fades out once the Lottie is live. */}
      {status !== 'ready' && (
        <ArthurShip size={size} accent={accent} thrust={thrust} className="relative" />
      )}
    </span>
  );
}

export default ArthurLottie;
