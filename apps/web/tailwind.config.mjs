import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Tailwind resolves `content` globs relative to the *working directory*, and the
 * build now runs from the repo root (there's only one package.json). Absolute
 * paths derived from this file's own location are therefore required — relative
 * ones would silently match nothing, which fails loudly as
 * "the `bg-void` class does not exist".
 *
 * `.mjs` because the root manifest has no `"type": "module"` — the API's tsc
 * output is CommonJS, so the repo can't be flipped to ESM wholesale.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: [resolve(here, 'index.html'), resolve(here, 'src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      colors: {
        // Track surface — deep space asphalt.
        void: '#04050c',
        deep: '#080b16',
        panel: '#0d1122',
        rail: '#161c33',
        hairline: '#222a48',

        // Neon. Blaze is the game's fire/boost orange; plasma its cold twin.
        blaze: { DEFAULT: '#FF6A00', bright: '#FFB020', deep: '#C43C00' },
        plasma: { DEFAULT: '#00E5FF', bright: '#7DF9FF', deep: '#0093AD' },
        magenta: { DEFAULT: '#FF2D95', bright: '#FF7BC0' },
        toxic: { DEFAULT: '#B6FF3C', bright: '#DBFF8F' },
        violet: { DEFAULT: '#7C5CFF', bright: '#A98BFF' },
        danger: '#FF3B30',
      },
      fontFamily: {
        display: ['Orbitron', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['"Chakra Petch"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      screens: {
        // Bespoke breakpoints for the "huge screen" requirement.
        '3xl': '1920px',
        '4xl': '2560px',
      },
      boxShadow: {
        neon: '0 0 0 1px rgb(255 255 255 / 0.06), 0 0 24px -6px var(--glow, #00E5FF)',
        'neon-lg': '0 0 0 1px rgb(255 255 255 / 0.08), 0 0 60px -10px var(--glow, #00E5FF)',
        inset: 'inset 0 1px 0 0 rgb(255 255 255 / 0.05)',
      },
      animation: {
        'spin-slow': 'spin 7s linear infinite',
        hover: 'hover 3s ease-in-out infinite',
        flicker: 'flicker 4s steps(1) infinite',
        scan: 'scan 7s linear infinite',
        'pulse-glow': 'pulse-glow 2.2s ease-in-out infinite',
        'grid-drift': 'grid-drift 14s linear infinite',
        rise: 'rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
      keyframes: {
        hover: {
          '0%,100%': { transform: 'translateY(-3px)' },
          '50%': { transform: 'translateY(3px)' },
        },
        flicker: {
          '0%,96%,100%': { opacity: '1' },
          '97%': { opacity: '0.72' },
          '98%': { opacity: '1' },
          '99%': { opacity: '0.85' },
        },
        scan: {
          '0%': { transform: 'translateY(-110%)' },
          '100%': { transform: 'translateY(110%)' },
        },
        'pulse-glow': {
          '0%,100%': { filter: 'brightness(1)', opacity: '0.85' },
          '50%': { filter: 'brightness(1.5)', opacity: '1' },
        },
        'grid-drift': {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '0 200px' },
        },
        rise: {
          from: { opacity: '0', transform: 'translateY(14px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
