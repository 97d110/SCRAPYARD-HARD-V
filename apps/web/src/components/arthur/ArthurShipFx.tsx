import { useMemo } from 'react';
import { ArthurLottie } from './ArthurLottie';

/**
 * The "cool" ship: the animated Lottie hull with a soft breathing halo behind
 * it, plus a handful of sparks that idle for most of their cycle and only
 * occasionally flare outward and fade (see `.hero-ship-halo` / `.hero-spark`
 * in index.css). One shared component so every place that wants this effect —
 * the desktop header, the mobile menu, the admin hero, the pun ticker — tunes
 * it once instead of re-deriving the spark math per call site.
 *
 * Distances/blur scale off `size` so a 34px ticker ship and a 110px admin
 * ship both look proportionate rather than either buried or overshooting.
 */
export interface ArthurShipFxProps {
  size?: number;
  accent?: string;
  className?: string;
}

export function ArthurShipFx({ size = 56, accent = '#FF6A00', className = '' }: ArthurShipFxProps) {
  const sparks = useMemo(() => {
    const base = size * 0.36;
    const step = size * 0.14;
    return Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2 + i * 0.5;
      const dist = base + (i % 3) * step;
      return {
        id: i,
        dx: Math.round(Math.cos(angle) * dist),
        dy: Math.round(Math.sin(angle) * dist),
        delay: Number(((i * 0.35) % 2).toFixed(2)),
        duration: 2 + (i % 4) * 0.5,
        dotSize: i % 3 === 0 ? 3 : 2,
        white: i % 3 === 0,
      };
    });
  }, [size]);

  return (
    <span className={`relative inline-flex shrink-0 ${className}`} aria-hidden="true">
      <span
        className="hero-ship-halo pointer-events-none absolute rounded-full"
        style={{
          inset: '-8%',
          background: `radial-gradient(circle, ${accent}, transparent 60%)`,
          filter: `blur(${Math.max(2, size * 0.07)}px)`,
        }}
      />
      {sparks.map((spark) => (
        <span
          key={spark.id}
          className="hero-spark pointer-events-none absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: spark.dotSize,
            height: spark.dotSize,
            background: spark.white ? '#fff' : accent,
            boxShadow: `0 0 6px ${accent}`,
            ['--dx' as string]: `${spark.dx}px`,
            ['--dy' as string]: `${spark.dy}px`,
            ['--dur' as string]: `${spark.duration}s`,
            animationDelay: `${spark.delay}s`,
          }}
        />
      ))}
      <ArthurLottie size={size} accent={accent} className="relative" />
    </span>
  );
}

export default ArthurShipFx;
