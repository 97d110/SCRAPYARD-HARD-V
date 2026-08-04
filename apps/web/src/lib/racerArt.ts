/**
 * Character and vehicle art, keyed by racer slug.
 *
 * ── Why a glob and not 36 imports ──────────────────────────────────────────
 *
 * Coverage is partial — 9 of 18 racers have art, the rest are still being cut
 * out of video by hand. `import.meta.glob` picks up whatever files exist at
 * build time, so adding a racer's art is `npm run art:racers` and a commit, with
 * no code change anywhere. A hand-written import list would need editing every
 * time and would fail the build the moment a file was missing, which is the
 * opposite of what partial coverage needs.
 *
 * It also gives the self-healing behaviour for free: nothing stores an image
 * path, so the moment a slug gains files, everyone who ticked "use my racer's
 * art" starts seeing it. No migration, no re-picking.
 *
 * ── Why two sizes ─────────────────────────────────────────────────────────
 *
 * Portraits fill an avatar (up to 112px, so 256 covers 2×). Vehicles ride as a
 * small badge on the avatar's corner at 20–30% of its size, so they're the
 * smaller asset, not the larger one. See scripts/build-racer-art.mjs.
 */

/*
 * Eager on purpose. These are URL strings, not image data — a few hundred bytes
 * of bundle for the whole map, and it has to be synchronous because `Avatar`
 * resolves art during render.
 */
const FILES = import.meta.glob<string>('../assets/racers/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

export interface RacerArt {
  portraitSmall: string;
  portraitLarge: string;
  vehicleSmall: string;
  vehicleLarge: string;
}

/** slug → art, containing only slugs whose files are actually present. */
const ART: Record<string, RacerArt> = {};

for (const [path, url] of Object.entries(FILES)) {
  // e.g. ../assets/racers/beast-portrait-256.webp
  const match = /\/([a-z0-9-]+)-(portrait|vehicle)-(\d+)\.webp$/.exec(path);
  if (!match) continue;
  const [, slug, kind, size] = match;

  const entry = (ART[slug] ??= {
    portraitSmall: '',
    portraitLarge: '',
    vehicleSmall: '',
    vehicleLarge: '',
  });

  if (kind === 'portrait') {
    if (size === '96') entry.portraitSmall = url;
    if (size === '256') entry.portraitLarge = url;
  } else {
    if (size === '48') entry.vehicleSmall = url;
    if (size === '96') entry.vehicleLarge = url;
  }
}

/*
 * A racer half-processed (portrait but no vehicle, or one size missing) would
 * otherwise render a broken image, which is worse than rendering nothing: the
 * fallback chain exists precisely so missing art is invisible. Dropping the
 * incomplete entry keeps `racerArt()` a straight "have it or don't".
 */
for (const [slug, art] of Object.entries(ART)) {
  const complete = art.portraitSmall && art.portraitLarge && art.vehicleSmall && art.vehicleLarge;
  if (!complete) delete ART[slug];
}

/** Null when this racer's art hasn't been cut out yet. */
export function racerArt(slug: string | undefined | null): RacerArt | null {
  if (!slug) return null;
  return ART[slug] ?? null;
}

/** Every slug with complete art — the picker uses it to mark what's available. */
export function slugsWithArt(): string[] {
  return Object.keys(ART);
}

/** The minimum needed to resolve an avatar. PublicUser and LeaderboardEntry both satisfy it. */
export interface AvatarSubject {
  avatarUrl: string;
  racerSlug: string;
  useRacerArt: boolean;
}

/**
 * What to actually draw for a racer, in priority order:
 *
 *   1. character art, when they ticked the box AND their racer has art
 *   2. their photo — an upload, or the Google one the server falls back to
 *   3. nothing, which `Avatar` renders as initials
 *
 * One function because there are ~15 `Avatar` call sites, and a chain
 * re-implemented at each of them is a chain implemented *differently* at some of
 * them.
 *
 * `racerSlug` arrives on the wire rather than being derived here — see the field
 * comment in shared. That's what lets this be a plain synchronous lookup with no
 * roster fetch and no chance of two slugify implementations disagreeing.
 */
export function avatarFor(subject: AvatarSubject): {
  src: string | undefined;
  /** True when the src is character art, which needs `contain` rather than `cover`. */
  isRacerArt: boolean;
  /** The car for the corner badge, or null. Only present alongside racer art. */
  vehicle: string | null;
} {
  if (subject.useRacerArt) {
    const art = racerArt(subject.racerSlug);
    if (art) {
      // vehicleSmall, not Large: the badge never draws above ~22px, so the
      // 48px asset already covers a 2x display and the 96 would be waste.
      return { src: art.portraitLarge, isRacerArt: true, vehicle: art.vehicleSmall };
    }
  }
  return { src: subject.avatarUrl || undefined, isRacerArt: false, vehicle: null };
}
