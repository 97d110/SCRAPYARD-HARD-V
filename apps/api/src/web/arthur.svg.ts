/**
 * ARTHUR, as a standalone SVG string for server-rendered pages.
 *
 * This is a hand-kept mirror of apps/web/src/components/arthur/ArthurShip.tsx.
 * The login page is deliberately framework-free — no React, no bundle — so it
 * can't import the component. If you restyle Arthur, restyle him in both.
 */
export interface ArthurOptions {
  size?: number;
  accent?: string;
  thrust?: boolean;
  /** Unique suffix so multiple Arthurs on one page don't collide in <defs>. */
  uid?: string;
}

export function arthurSvg({
  size = 180,
  accent = '#FF6A00',
  thrust = false,
  uid = 'a',
}: ArthurOptions = {}): string {
  const id = `arthur-${uid}`;

  return `
<svg width="${size}" height="${Math.round(size * 0.62)}" viewBox="0 0 200 124"
     role="img" aria-label="Arthur" style="overflow:visible">
  <defs>
    <linearGradient id="${id}-hull" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3b4570"/>
      <stop offset="45%" stop-color="#1d2340"/>
      <stop offset="100%" stop-color="#0a0d1c"/>
    </linearGradient>
    <radialGradient id="${id}-dome" cx="38%" cy="26%" r="78%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="34%" stop-color="${accent}" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#08122b" stop-opacity="0.95"/>
    </radialGradient>
    <radialGradient id="${id}-under" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.85"/>
      <stop offset="60%" stop-color="${accent}" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}-flame" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#FFB020"/>
      <stop offset="70%" stop-color="#FF6A00"/>
      <stop offset="100%" stop-color="#FF2D95" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <ellipse cx="100" cy="96" rx="78" ry="20" fill="url(#${id}-under)" opacity="0.7"/>

  ${
    thrust
      ? `<path d="M30 62 L-52 55 L-52 69 Z" fill="url(#${id}-flame)" opacity="0.95"/>
         <path d="M32 62 L-14 58 L-14 66 Z" fill="#fff" opacity="0.9"/>`
      : ''
  }

  <ellipse cx="100" cy="74" rx="86" ry="24" fill="url(#${id}-hull)"/>
  <ellipse cx="100" cy="74" rx="86" ry="24" fill="none" stroke="${accent}" stroke-width="2" opacity="0.55"/>

  <circle cx="18"  cy="78" r="3" fill="${accent}"/>
  <circle cx="52"  cy="80" r="3" fill="${accent}"/>
  <circle cx="100" cy="78" r="3" fill="${accent}"/>
  <circle cx="148" cy="80" r="3" fill="${accent}"/>
  <circle cx="182" cy="78" r="3" fill="${accent}"/>

  <ellipse cx="100" cy="62" rx="72" ry="22" fill="#252c4d"/>
  <ellipse cx="100" cy="60" rx="72" ry="21" fill="url(#${id}-hull)"/>

  <path d="M34 58 Q100 44 166 58 Q100 50 34 58 Z" fill="#FF6A00" opacity="0.9"/>

  <ellipse cx="100" cy="40" rx="38" ry="30" fill="url(#${id}-dome)"/>
  <ellipse cx="100" cy="40" rx="38" ry="30" fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.85"/>
  <ellipse cx="86" cy="28" rx="13" ry="8" fill="#fff" opacity="0.6" transform="rotate(-22 86 28)"/>

  <path d="M100 12 L118 32 L82 32 Z" fill="#FF6A00" opacity="0.95"/>
  <path d="M100 12 L118 32 L82 32 Z" fill="none" stroke="#FFB020" stroke-width="1.5"/>

  <path d="M16 68 L-6 84 L26 80 Z"    fill="#1d2340" stroke="${accent}" stroke-width="1.5" opacity="0.9"/>
  <path d="M184 68 L206 84 L174 80 Z" fill="#1d2340" stroke="${accent}" stroke-width="1.5" opacity="0.9"/>

  <rect x="26" y="55" width="14" height="14" rx="3" fill="#0d1122" stroke="${accent}" stroke-width="1.5"/>
  <circle cx="33" cy="62" r="3.5" fill="${thrust ? '#FFB020' : accent}" opacity="0.95"/>

  <g stroke="#000" stroke-opacity="0.35" stroke-width="1.5" fill="none">
    <path d="M52 66 Q100 76 148 66"/>
    <path d="M64 52 Q100 58 136 52"/>
  </g>
</svg>`.trim();
}
