import { useMemo } from 'react';

/**
 * Ambient background: a receding perspective grid (the track floor), a drifting
 * starfield, and a horizon glow. Fixed and non-interactive — it sits behind
 * every page and never scrolls, which keeps the neon consistent while content
 * moves over it.
 */
export function Backdrop() {
  // Static star field, generated once. Cheap: plain divs, no canvas.
  const stars = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        id: i,
        left: (i * 37.7) % 100,
        top: (i * 61.3) % 100,
        size: i % 11 === 0 ? 2.5 : 1.2,
        delay: (i % 9) * 0.6,
        accent: i % 13 === 0 ? '#FF6A00' : i % 7 === 0 ? '#B6FF3C' : '#9fd8ff',
      })),
    [],
  );

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      {/* Starfield. */}
      {stars.map((star) => (
        <span
          key={star.id}
          className="absolute rounded-full"
          style={{
            left: `${star.left}%`,
            top: `${star.top}%`,
            width: star.size,
            height: star.size,
            background: star.accent,
            boxShadow: `0 0 ${star.size * 4}px ${star.accent}`,
            opacity: 0.5,
            animation: `pulse-glow ${2.4 + (star.id % 5) * 0.7}s ${star.delay}s ease-in-out infinite`,
          }}
        />
      ))}

      {/* Horizon line where the grid meets the sky. */}
      <div
        className="absolute left-0 right-0 h-px"
        style={{
          top: '58%',
          background: 'linear-gradient(90deg, transparent, #00E5FF, #FF6A00, transparent)',
          filter: 'blur(1px)',
          opacity: 0.5,
        }}
      />

      {/* Perspective grid floor. Rotated in 3D so the lines converge. */}
      <div
        className="absolute inset-x-[-50%] bottom-[-20%] top-[58%] grid-floor"
        style={{
          transform: 'perspective(420px) rotateX(66deg)',
          transformOrigin: 'top center',
          maskImage: 'linear-gradient(to bottom, #000 0%, transparent 78%)',
          WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, transparent 78%)',
          opacity: 0.65,
        }}
      />

      {/* Vignette to keep the edges from competing with content. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 50% 40%, transparent 40%, rgb(4 5 12 / 0.75) 100%)',
        }}
      />
    </div>
  );
}

export default Backdrop;
