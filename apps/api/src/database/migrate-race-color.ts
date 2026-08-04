/**
 * One-off: give every racer a `raceColor` and drop the retired `accentColor`.
 *
 * Colour used to be two fields — a free-hex `accentColor` that themed the UI,
 * and a nullable `raceColor` for which car you drive. They've been merged into
 * the one that means something in the game, so existing documents need:
 *
 *   - `raceColor` set, if it's missing or null. Whatever an admin already chose
 *     is kept; anyone without a choice becomes green.
 *   - `accentColor` unset, because the field no longer exists on `UserDoc` and
 *     leaving it behind would quietly desync the schema from the data.
 *
 *   MONGODB_URI="mongodb+srv://..." npm run migrate:race-color
 *
 * Idempotent: a second run reports zero to do. Safe to run before or after a
 * deploy, and safe to re-run after assigning more colours by hand.
 *
 * Nothing here can lose data. `accentColor` was a decorative hex that no longer
 * has anywhere to live, and this only ever ADDS a raceColor where one is absent
 * — an existing pick is never overwritten.
 */
import '../common/load-env';
import { MongoClient } from 'mongodb';
import type { RaceColor } from '@scrapyard/shared';

const DEFAULT_RACE_COLOR: RaceColor = 'green';
const VALID: RaceColor[] = ['blue', 'red', 'green', 'yellow'];

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Add it to apps/api/.env, or inline it.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'scrapyard');
    const users = db.collection('users');

    const total = await users.countDocuments({});
    console.log(`${total} racer${total === 1 ? '' : 's'} in ${db.databaseName}.\n`);

    /*
     * Anything that isn't one of the four valid values needs fixing, which
     * covers three separate cases in one filter: the field missing entirely
     * (pre-merge documents), explicitly null (post-merge but never chosen), and
     * a stray value that somehow isn't in the set.
     */
    const needsColor = await users
      .find(
        { $or: [{ raceColor: { $exists: false } }, { raceColor: { $nin: VALID } }] },
        { projection: { displayName: 1, raceColor: 1 } },
      )
      .toArray();

    if (needsColor.length === 0) {
      console.log(`Every racer already has a colour — nothing to set.`);
    } else {
      console.log(`Setting ${DEFAULT_RACE_COLOR} on ${needsColor.length}:`);
      for (const doc of needsColor) {
        const had = doc.raceColor === undefined ? 'unset' : String(doc.raceColor);
        console.log(`  ${String(doc.displayName ?? doc._id)} (was ${had})`);
      }
      const result = await users.updateMany(
        { $or: [{ raceColor: { $exists: false } }, { raceColor: { $nin: VALID } }] },
        { $set: { raceColor: DEFAULT_RACE_COLOR } },
      );
      console.log(`  → ${result.modifiedCount} updated.`);
    }

    const stale = await users.countDocuments({ accentColor: { $exists: true } });
    if (stale === 0) {
      console.log('No leftover accentColor fields.');
    } else {
      const dropped = await users.updateMany(
        { accentColor: { $exists: true } },
        { $unset: { accentColor: '' } },
      );
      console.log(`Dropped accentColor from ${dropped.modifiedCount} racer(s).`);
    }

    // Prove the end state rather than trusting the writes above reported truly.
    const remaining = await users.countDocuments({
      $or: [{ raceColor: { $exists: false } }, { raceColor: { $nin: VALID } }],
    });
    const remainingStale = await users.countDocuments({ accentColor: { $exists: true } });
    if (remaining > 0 || remainingStale > 0) {
      console.error(
        `\nIncomplete: ${remaining} still without a valid colour, ` +
          `${remainingStale} still carrying accentColor.`,
      );
      process.exit(1);
    }

    const byColor = await users
      .aggregate([{ $group: { _id: '$raceColor', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
      .toArray();
    console.log('\nDone. Roster by colour:');
    for (const row of byColor) console.log(`  ${String(row._id)}: ${row.n}`);
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
