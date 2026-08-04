import type { RaceColor } from '@scrapyard/shared';

/**
 * The four in-game car colours and the hexes to draw them with.
 *
 * Lives here rather than in each component because three screens now render
 * the same swatches — a racer's own profile, the admin roster editor, and any
 * roster line that shows which car someone drives. Two copies were already one
 * too many.
 *
 * The hexes are picked to read as the game's colours on the dark backdrop, not
 * sampled from it; nothing matches against these, so they're free to be tuned
 * for legibility. They're applied as inline styles rather than Tailwind classes
 * on purpose — a generated class name like `bg-${color}` would be invisible to
 * Tailwind's scanner and get purged, which is exactly the bug that silently
 * removed `.btn-primary` from every build earlier in this project.
 */
export const RACE_COLORS: RaceColor[] = ['blue', 'red', 'green', 'yellow'];

export const RACE_COLOR_HEX: Record<RaceColor, string> = {
  blue: '#2F6FED',
  red: '#FF3B30',
  green: '#2ECC71',
  yellow: '#FFD60A',
};
