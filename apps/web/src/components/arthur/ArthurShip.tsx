import { memo } from 'react';

/**
 * ARTHUR — an original saucer-class racer drawn to match BlazeRush's chunky
 * toy-futurist silhouette (fat hull, oversized glass dome, exposed thruster)
 * filtered through the site's neon language.
 *
 * Pure inline SVG, no external assets, so it scales cleanly from a 20px
 * inline glyph in the ticker to a 400px hero on a 4K screen, and every part
 * is animatable with CSS.
 *
 * `spin` tilts it into a slow yaw rotation for the ticker separators.
 * `thrust` lights the engine and drops a plasma trail for the flyby.
 */
export interface ArthurShipProps {
  size?: number;
  spin?: boolean;
  thrust?: boolean;
  /** Hull accent. Defaults to the plasma cyan. */
  accent?: string;
  className?: string;
  title?: string;
}

export const ArthurShip = memo(function ArthurShip({
  size = 48,
  spin = false,
  thrust = false,
  accent = '#00E5FF',
  className = '',
  title = 'Arthur',
}: ArthurShipProps) {
  // Scoped ids so multiple Arthurs on one page don't collide in <defs>.
  const uid = `arthur-${accent.replace('#', '')}-${spin ? 's' : 'n'}-${thrust ? 't' : 'n'}`;

  return (
    <svg
      width={size}
      height={size * 0.62}
      viewBox="0 0 200 124"
      className={className}
      role="img"
      aria-label={title}
      style={
        spin
          ? {
              animation: 'arthur-yaw 3.4s ease-in-out infinite',
              transformStyle: 'preserve-3d',
              overflow: 'visible',
            }
          : { overflow: 'visible' }
      }
    >
      <defs>
        {/* Hull: lit from above, dark underbelly — reads as a solid object. */}
        <linearGradient id={`${uid}-hull`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b4570" />
          <stop offset="45%" stopColor="#1d2340" />
          <stop offset="100%" stopColor="#0a0d1c" />
        </linearGradient>

        {/* Glass dome. */}
        <radialGradient id={`${uid}-dome`} cx="38%" cy="26%" r="78%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="34%" stopColor={accent} stopOpacity="0.7" />
          <stop offset="100%" stopColor="#08122b" stopOpacity="0.95" />
        </radialGradient>

        {/* Under-ring glow that makes it read as hovering. */}
        <radialGradient id={`${uid}-under`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.85" />
          <stop offset="60%" stopColor={accent} stopOpacity="0.25" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>

        {/* Engine flame: white core → blaze orange tips. */}
        <linearGradient id={`${uid}-flame`} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="30%" stopColor="#FFB020" />
          <stop offset="70%" stopColor="#FF6A00" />
          <stop offset="100%" stopColor="#FF2D95" stopOpacity="0" />
        </linearGradient>

        <filter id={`${uid}-bloom`} x="-60%" y="-120%" width="220%" height="340%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Hover glow beneath the saucer. */}
      <ellipse cx="100" cy="96" rx="78" ry="20" fill={`url(#${uid}-under)`} opacity="0.7" />

      {/* Engine: only lit under thrust. */}
      {thrust && (
        <g filter={`url(#${uid}-bloom)`}>
          <path d="M30 62 L-52 55 L-52 69 Z" fill={`url(#${uid}-flame)`} opacity="0.95">
            <animate
              attributeName="opacity"
              values="0.6;1;0.72;1"
              dur="0.22s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M32 62 L-14 58 L-14 66 Z" fill="#fff" opacity="0.9" />
        </g>
      )}

      {/* Lower hull rim — the wide saucer skirt. */}
      <ellipse cx="100" cy="74" rx="86" ry="24" fill={`url(#${uid}-hull)`} />
      <ellipse
        cx="100"
        cy="74"
        rx="86"
        ry="24"
        fill="none"
        stroke={accent}
        strokeWidth="2"
        opacity="0.55"
      />

      {/* Running lights around the skirt. */}
      {[18, 52, 100, 148, 182].map((cx, i) => (
        <circle key={cx} cx={cx} cy={i % 2 === 0 ? 78 : 80} r="3" fill={accent}>
          <animate
            attributeName="opacity"
            values="0.25;1;0.25"
            dur="1.6s"
            begin={`${i * 0.28}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}

      {/* Upper hull — chunkier, catches the light. */}
      <ellipse cx="100" cy="62" rx="72" ry="22" fill="#252c4d" />
      <ellipse cx="100" cy="60" rx="72" ry="21" fill={`url(#${uid}-hull)`} />

      {/* Hot blaze-orange racing stripe across the hull. */}
      <path
        d="M34 58 Q100 44 166 58 Q100 50 34 58 Z"
        fill="#FF6A00"
        opacity="0.9"
      />

      {/* Cockpit dome. */}
      <ellipse cx="100" cy="40" rx="38" ry="30" fill={`url(#${uid}-dome)`} />
      <ellipse
        cx="100"
        cy="40"
        rx="38"
        ry="30"
        fill="none"
        stroke={accent}
        strokeWidth="2.5"
        opacity="0.85"
      />
      {/* Specular highlight — sells the glass. */}
      <ellipse cx="86" cy="28" rx="13" ry="8" fill="#fff" opacity="0.6" transform="rotate(-22 86 28)" />

      {/* Dorsal fin. */}
      <path d="M100 12 L118 32 L82 32 Z" fill="#FF6A00" opacity="0.95" />
      <path d="M100 12 L118 32 L82 32 Z" fill="none" stroke="#FFB020" strokeWidth="1.5" />

      {/* Side stabiliser wings. */}
      <path d="M16 68 L-6 84 L26 80 Z" fill="#1d2340" stroke={accent} strokeWidth="1.5" opacity="0.9" />
      <path d="M184 68 L206 84 L174 80 Z" fill="#1d2340" stroke={accent} strokeWidth="1.5" opacity="0.9" />

      {/* Thruster nacelle. */}
      <rect x="26" y="55" width="14" height="14" rx="3" fill="#0d1122" stroke={accent} strokeWidth="1.5" />
      <circle cx="33" cy="62" r="3.5" fill={thrust ? '#FFB020' : accent} opacity="0.95">
        {!thrust && (
          <animate attributeName="opacity" values="0.4;1;0.4" dur="2.4s" repeatCount="indefinite" />
        )}
      </circle>

      {/* Hull plate seams — a touch of the game's mechanical grubbiness. */}
      <g stroke="#000" strokeOpacity="0.35" strokeWidth="1.5" fill="none">
        <path d="M52 66 Q100 76 148 66" />
        <path d="M64 52 Q100 58 136 52" />
      </g>

      <style>{`
        @keyframes arthur-yaw {
          0%, 100% { transform: perspective(420px) rotateY(0deg)   translateY(0px); }
          25%      { transform: perspective(420px) rotateY(90deg)  translateY(-2px); }
          50%      { transform: perspective(420px) rotateY(180deg) translateY(0px); }
          75%      { transform: perspective(420px) rotateY(270deg) translateY(2px); }
        }
      `}</style>
    </svg>
  );
});

export default ArthurShip;
