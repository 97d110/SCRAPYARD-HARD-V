/**
 * The BlazeRush roster — the canonical list, with a URL-safe slug per racer.
 *
 * ── Why slugs exist ────────────────────────────────────────────────────────
 *
 * This used to be a flat tuple of display names, which was fine while
 * `favoriteRacer` was decorative text. It can't key an image file: "Mr. Shnek"
 * has a period and a space, "Old Rowdy" has a space, and the art was cut out
 * under inconsistent casing ("Driftking", "tailfin"). The slug is the stable
 * identifier art is named by; the display name stays free to change.
 *
 * ── Why it lives in common/ ────────────────────────────────────────────────
 *
 * A leaf module with no dependencies of its own, deliberately. The race colour
 * constants started life on `UsersService` and created a circular import the
 * moment the scoreboard repository needed them — see `common/race-colors.ts`.
 * Anything several layers need belongs somewhere that cannot import them back.
 *
 * ── The slug is NOT sent to the database ───────────────────────────────────
 *
 * A racer's art is resolved on the client from the slug, so nothing stores an
 * image path. Re-optimising, renaming or adding art therefore needs no
 * migration, and art added later applies itself to everyone who opted in.
 */

export interface Racer {
  /** As shown, and what `favoriteRacer` stores. Free to change. */
  name: string;
  /** URL-safe, stable, and what art files are named by. Don't change these. */
  slug: string;
}

/**
 * Slugs are written out rather than derived at runtime. A helper would look
 * tidier, but these strings are filenames on disk — seeing them literally is
 * the point, and a subtle change to a slugify function must not silently
 * repoint every racer at missing art.
 */
export const RACERS: Racer[] = [
  { name: 'Arthur', slug: 'arthur' },
  { name: 'Turboboy', slug: 'turboboy' },
  { name: 'Hotty', slug: 'hotty' },
  { name: 'Tailfin', slug: 'tailfin' },
  { name: 'Old Rowdy', slug: 'old-rowdy' },
  { name: 'Beast', slug: 'beast' },
  { name: 'Pushback', slug: 'pushback' },
  { name: 'Arrow', slug: 'arrow' },
  { name: 'Predator', slug: 'predator' },
  { name: 'Dipnoi', slug: 'dipnoi' },
  { name: 'DriftKing', slug: 'driftking' },
  { name: 'Rex', slug: 'rex' },
  { name: 'Panzerflachbagger', slug: 'panzerflachbagger' },
  { name: 'Dee', slug: 'dee' },
  { name: 'Twins', slug: 'twins' },
  { name: 'UFO', slug: 'ufo' },
  { name: 'Mr. Shnek', slug: 'mr-shnek' },
  { name: 'Matthew Hell', slug: 'matthew-hell' },
];

/**
 * Display names only — what `favoriteRacer` is validated against, so existing
 * stored values keep working untouched.
 */
export const RACER_NAMES: string[] = RACERS.map((racer) => racer.name);

/**
 * Display name → slug. Built once, because `toPublic` runs per racer per request
 * and a linear scan of 18 entries each time is needless work.
 *
 * Unknown names fall back to '' rather than throwing: `favoriteRacer` is only
 * validated on write, so a name retired from the roster could still be sitting
 * in an old document, and a profile page is the wrong place to discover that.
 * An empty slug simply resolves to no art.
 */
const SLUG_BY_NAME = new Map(RACERS.map((racer) => [racer.name, racer.slug]));

export function racerSlug(name: string): string {
  return SLUG_BY_NAME.get(name) ?? '';
}

/** Every slug, for the asset script to check its filenames against. */
export const RACER_SLUGS: string[] = RACERS.map((racer) => racer.slug);
