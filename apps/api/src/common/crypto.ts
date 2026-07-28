import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';

/**
 * Field-level encryption for the two genuinely sensitive fields Scrapyard
 * stores — email and Google id. Everything else on a racer (display name,
 * avatar, scores, kills) is already shown to every signed-in teammate, so
 * encrypting it would add cost with no real security benefit and would break
 * the aggregation pipelines the whole app is built on.
 *
 * Design, deliberately simple over "MongoDB-native":
 *
 *   - AES-256-GCM (authenticated encryption) for the ciphertext, via Node's
 *     built-in `crypto` — no new dependency.
 *   - A separate HMAC-SHA-256 "blind index" alongside it, so an exact-match
 *     Mongo query (`findOne`, a unique index) still works without the server
 *     ever seeing plaintext. This is the same lookup an equality query against
 *     a deterministically-encrypted field would give you with MongoDB CSFLE /
 *     Queryable Encryption, without the key-vault collection, crypt_shared
 *     library or schema map those require.
 *   - Two sub-keys, not one, derived from a single secret via HKDF: encryption
 *     and hashing must never share a key, so a weakness in one primitive can't
 *     bleed into the other.
 *
 * This protects against someone reading the database directly — a leaked
 * connection string, a stolen snapshot, a database export — not against the
 * app itself, which still decrypts and shows email to signed-in teammates
 * exactly as it always has (that's an intentional product decision, not a
 * bug). Atlas separately encrypts the whole volume/snapshot with AES-256 by
 * default; this is the layer underneath that one.
 */

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const IV_LENGTH = 12; // 96-bit, the recommended nonce size for GCM.

let cachedMasterKey: Buffer | undefined;

/** The one secret an operator supplies. Everything else is derived from it. */
function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'DATA_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` ' +
        'and put it in apps/api/.env — see the README. Losing this key makes every ' +
        "racer's email and Google id permanently undecryptable, so back it up the " +
        'same way you would JWT_SECRET.',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }

  cachedMasterKey = key;
  return key;
}

/** HKDF-derived, purpose-specific sub-key — never the master key itself. */
function deriveKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey(), Buffer.alloc(0), Buffer.from(purpose), 32));
}

function encryptionKey(): Buffer {
  return deriveKey('scrapyard.field-encryption.v1');
}

function blindIndexKey(): Buffer {
  return deriveKey('scrapyard.blind-index.v1');
}

/**
 * Encrypts a UTF-8 string for storage. Output is a single opaque string —
 * `v1.<iv>.<authTag>.<ciphertext>`, each part base64 — safe to store directly
 * in a Mongo field typed `string`. Never returns the same ciphertext twice for
 * the same input (random IV per call), which is exactly why lookups go
 * through `blindIndex()` instead of matching this field directly.
 */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [FORMAT_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

/**
 * Reverses `encryptField`. Throws if the value is malformed, was encrypted
 * under a different key, or was tampered with — GCM's auth tag check catches
 * that last one rather than silently returning garbage.
 */
export function decryptField(stored: string): string {
  const parts = stored.split('.');
  const [version, ivPart, authTagPart, ciphertextPart] = parts;
  if (parts.length !== 4 || version !== FORMAT_VERSION) {
    throw new Error(`Unrecognised encrypted field format (expected ${FORMAT_VERSION}.iv.tag.data)`);
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagPart, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Deterministic HMAC-SHA-256 of a value, hex-encoded. Not reversible — this
 * is the only thing an encrypted field can be looked up or uniquely indexed
 * by. Callers must normalise the input themselves (Scrapyard already
 * lowercases/trims email before this point) so the same logical value always
 * produces the same hash.
 */
export function blindIndex(value: string): string {
  return createHmac('sha256', blindIndexKey()).update(value).digest('hex');
}
