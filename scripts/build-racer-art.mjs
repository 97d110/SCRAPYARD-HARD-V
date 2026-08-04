/**
 * Turn hand-cut racer art into web-sized WebP.
 *
 *   node scripts/build-racer-art.mjs
 *   npm run art:racers
 *
 * Reads   assets-src/racers/<Name>_portrait.png   full-body cut-out on transparency
 *         assets-src/racers/<Name>_headshot.png  the game's own square avatar icon
 *         assets-src/racers/<Name>_vehicle.png
 * Writes  apps/web/src/assets/racers/<slug>-<kind>-<size>.webp
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The sources are ~900px and average 760 KB each, because they were cut out of
 * video and screenshots at whatever size was available. Nothing renders them
 * above 112px (an avatar) or ~67px (the vehicle badge), so
 * shipping them as-is would mean roughly 27 MB of avatars — on a free-tier host,
 * for images displayed 30-50× smaller than they're stored.
 *
 * Rerunnable on purpose. More art gets cut out over time, so this is a step you
 * repeat rather than a migration you perform once: drop new PNGs in, run it
 * again, commit what changed.
 *
 * ── Why ImageMagick ────────────────────────────────────────────────────────
 *
 * `sharp` would be the usual choice but it isn't installed here and pulls a
 * platform-specific binary; `convert` is already present. This is a build-time
 * script that never runs in production, so a system tool is the lighter answer
 * than a dependency in package.json.
 *
 * ── Why the sources are committed ──────────────────────────────────────────
 *
 * They're in git alongside the output. That art was cut by hand from video and
 * is expensive to recreate — gitignoring it would mean one dead laptop loses
 * the lot. ~14 MB of history is a cheap insurance premium.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets-src', 'racers');
const OUT = join(ROOT, 'apps', 'web', 'src', 'assets', 'racers');

/**
 * Two sizes per image, chosen from what actually renders rather than round
 * numbers.
 *
 * Portraits fill an avatar, which tops out at 112px in the profile editor
 * preview — 224 on a 2× display, so 256 is the ceiling worth keeping.
 *
 * The vehicle badge draws at 60% of the avatar, so 67px on the largest (112px)
 * and 134 on a 2× display. One size at 192 covers that with headroom — and it's
 * ONE size rather than two because only one is ever rendered: two variants meant
 * shipping a file nothing referenced.
 */
const VARIANTS = {
  portrait: [96, 256],
  vehicle: [192],
};
const QUALITY = 82;

/**
 * Two kinds of source fill the portrait slot, and they need opposite framing.
 *
 * A `_portrait` is official full-body art on transparency — tall, and it wants
 * to be fitted by height so the character stands on the bottom of the avatar
 * circle. That is what `Avatar`'s `object-contain object-bottom` is for.
 *
 * A `_headshot` is the game's own avatar icon: a painted face on a backdrop,
 * roughly but not exactly square (119x116, 117x118). Fitted by contain, that
 * "roughly" is the whole problem — a 119x116 image in a square box letterboxes
 * by 3px, and `object-bottom` puts the entire shortfall at the top as a black
 * sliver. So head-shots are squared HERE, at build time, by filling the box and
 * centre-cropping the overflow. An exactly square image in a square box has
 * nothing left to letterbox, which fixes the gap without `Avatar` needing to
 * know which kind of art it was handed.
 */
const PORTRAIT_SLOT = { portrait: 'portrait', headshot: 'portrait', vehicle: 'vehicle' };

/** Mirrors RACER_SLUGS in apps/api/src/common/racers.ts. */
const KNOWN_SLUGS = [
  'arthur', 'turboboy', 'hotty', 'tailfin', 'old-rowdy', 'beast',
  'pushback', 'arrow', 'predator', 'dipnoi', 'driftking', 'rex',
  'panzerflachbagger', 'dee', 'twins', 'ufo', 'mr-shnek', 'matthew-hell',
  'natasha', 'vera',
];

/**
 * Filename → slug. The sources disagree on casing ("Driftking", "tailfin",
 * "UFO"), so this normalises rather than trusting what was typed.
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`No source folder at ${SRC}`);
    console.error('Expected files named <Name>_portrait.png / <Name>_vehicle.png.');
    process.exit(1);
  }

  try {
    execFileSync('convert', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error('ImageMagick `convert` not found. Install it, or switch this script to sharp.');
    process.exit(1);
  }

  const sources = readdirSync(SRC).filter((name) => name.toLowerCase().endsWith('.png'));
  if (sources.length === 0) {
    console.error(`No PNGs in ${SRC}`);
    process.exit(1);
  }

  /*
   * Rebuilt from scratch each run. Renaming a source would otherwise leave its
   * old output behind for the registry to keep importing — a stale asset that
   * still resolves is worse than a missing one, because nothing complains.
   */
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const seen = new Map();
  const unknown = [];
  let written = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const file of sources.sort()) {
    const match = /^(.+?)_(portrait|headshot|vehicle)\.png$/i.exec(file);
    if (!match) {
      console.warn(`  skipped ${file} — expected <Name>_portrait.png, _headshot.png or _vehicle.png`);
      continue;
    }
    const slug = slugify(match[1]);
    const kind = match[2].toLowerCase();
    // Head-shots and portraits are two framings of one slot, so they share an
    // output name and the registry never learns the difference.
    const slot = PORTRAIT_SLOT[kind];

    if (!KNOWN_SLUGS.includes(slug)) {
      unknown.push(`${file} → "${slug}"`);
      continue;
    }

    bytesIn += statSync(join(SRC, file)).size;
    const record = seen.get(slug) ?? { portrait: false, vehicle: false };
    /*
     * Both framings of the same racer would write the same output files, with
     * whichever sorted later silently winning. Loud, because the symptom would
     * otherwise be "the art looks wrong" with nothing pointing at the cause.
     */
    if (record[slot]) {
      unknown.push(`${file} → "${slug}" already has a ${slot}; pick one framing`);
      continue;
    }
    record[slot] = true;
    seen.set(slug, record);

    for (const size of VARIANTS[slot]) {
      const out = join(OUT, `${slug}-${slot}-${size}.webp`);
      /*
       * Full-body portraits are reliably taller than wide, so height is the
       * constraint.
       *
       * Head-shots FILL a square box and centre-crop the overflow — `^` means
       * "cover, not contain" — so the result is exactly square. See the note on
       * PORTRAIT_SLOT for why that squareness is load-bearing.
       *
       * Vehicles are NOT reliably either way — the cut-outs range from 1:1
       * (Beast) to 1.6:1 (Turboboy) — so they get a square box to fit inside.
       * Constraining width alone would let a car cut taller than wide come out
       * oversized, and that's a filename away from happening.
       */
      const geometry =
        kind === 'headshot' ? [`${size}x${size}^`, '-gravity', 'center', '-extent', `${size}x${size}`]
        : kind === 'portrait' ? [`x${size}`]
        : [`${size}x${size}`];
      execFileSync('convert', [
        join(SRC, file),
        '-resize', ...geometry,
        // Drop colour profiles and EXIF: a few KB of metadata nobody reads.
        '-strip',
        '-quality', String(QUALITY),
        out,
      ]);
      bytesOut += statSync(out).size;
      written += 1;
    }
  }

  const complete = [...seen.entries()].filter(([, r]) => r.portrait && r.vehicle).map(([s]) => s);
  const partial = [...seen.entries()].filter(([, r]) => !r.portrait || !r.vehicle);
  const missing = KNOWN_SLUGS.filter((slug) => !seen.has(slug));

  console.log(`\nWrote ${written} files to apps/web/src/assets/racers`);
  console.log(`  ${kb(bytesIn)} of sources → ${kb(bytesOut)} shipped  (${(bytesIn / bytesOut).toFixed(0)}× smaller)`);
  console.log(`\nComplete (portrait + vehicle): ${complete.length}/${KNOWN_SLUGS.length}`);
  console.log(`  ${complete.join(', ')}`);

  if (partial.length > 0) {
    console.log('\nHalf done — has one, needs the other:');
    for (const [slug, r] of partial) {
      console.log(`  ${slug} — missing ${r.portrait ? 'vehicle' : 'portrait'}`);
    }
  }

  if (missing.length > 0) {
    console.log(`\nStill to cut out (${missing.length}):`);
    console.log(`  ${missing.join(', ')}`);
  }

  /*
   * A slug that matches no racer is almost always a typo in a filename, and it
   * would otherwise fail silently — the art simply never appearing, with no
   * error to explain why. Loud, and non-zero exit so it can't be missed.
   */
  if (unknown.length > 0) {
    console.error(`\nUnrecognised — these match no racer slug, check the filename:`);
    for (const entry of unknown) console.error(`  ${entry}`);
    console.error('\nKnown slugs: ' + KNOWN_SLUGS.join(', '));
    process.exit(1);
  }
  console.log('');
}

main();
