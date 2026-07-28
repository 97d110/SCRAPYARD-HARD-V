/**
 * One-off: encrypts every existing racer's plaintext `email`/`googleId` into
 * `emailEnc`/`emailHash` (+ `googleIdEnc`/`googleIdHash`), then removes the
 * plaintext fields. Everything else on the document — `_id`, scores, games,
 * achievements — is untouched, since nothing else keys off email or googleId.
 *
 *   DATA_ENCRYPTION_KEY="..." MONGODB_URI="mongodb+srv://..." \
 *   npm run migrate:encrypt-users
 *
 * Run this once against a real cluster, before deploying the build that
 * expects the encrypted shape — the app can no longer read a plaintext
 * `email` field afterwards. Back up DATA_ENCRYPTION_KEY first: it's the only
 * way to ever decrypt these fields again, and it's what upsertFromGoogle uses
 * to look racers up on their next login.
 *
 * Idempotent. A document with no plaintext `email` left (already migrated,
 * or created after this script existed) is skipped, so re-running is safe.
 */
import '../common/load-env';
import { MongoClient } from 'mongodb';
import { blindIndex, encryptField } from '../common/crypto';

interface LegacyUserDoc {
  _id: string;
  email?: string;
  googleId?: string;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Point it at your Atlas cluster or a local mongod.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'scrapyard');
  const users = db.collection<LegacyUserDoc>('users');

  /*
   * The pre-encryption unique index sits directly on plaintext `email`
   * (non-sparse) and `googleId` (sparse). The moment a second document has
   * its `email` field unset below, that index sees two documents "missing"
   * the field and throws a duplicate-key error — so it has to go before the
   * loop, not after.
   */
  for (const legacyIndex of ['email', 'googleId']) {
    try {
      await users.dropIndex(legacyIndex);
      console.log(`Dropped legacy index: ${legacyIndex}`);
    } catch {
      console.log(`No legacy index named "${legacyIndex}" — nothing to drop.`);
    }
  }

  const pending = await users.find({ email: { $exists: true } }).toArray();
  console.log(`${pending.length} document(s) still on the plaintext schema.`);

  let migrated = 0;
  for (const doc of pending) {
    if (!doc.email) continue;
    const email = doc.email.trim().toLowerCase();

    const set: Record<string, string> = {
      emailEnc: encryptField(email),
      emailHash: blindIndex(email),
    };
    if (doc.googleId) {
      set.googleIdEnc = encryptField(doc.googleId);
      set.googleIdHash = blindIndex(doc.googleId);
    }

    await users.updateOne({ _id: doc._id }, { $set: set, $unset: { email: '', googleId: '' } });
    migrated += 1;
  }

  console.log(`Migrated ${migrated} document(s).`);

  await users.createIndexes([
    { key: { emailHash: 1 }, name: 'emailHash', unique: true },
    { key: { googleIdHash: 1 }, name: 'googleIdHash', unique: true, sparse: true },
  ]);
  console.log('Indexes ensured: emailHash (unique), googleIdHash (unique, sparse).');

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
