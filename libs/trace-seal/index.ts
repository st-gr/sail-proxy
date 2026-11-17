/**
 * Trace sealing: the gateway seals captured payload text, the admin service opens it.
 *
 * Key: HKDF-SHA256(METADATA_ENCRYPTION_KEY, salt 'sail-proxy-payload-traces', info 'trace-seal-v1', 32 bytes).
 * Cipher: AES-256-GCM with a fresh 12-byte IV. Envelope: {"v":1,"iv":…,"tag":…,"ct":…} (base64).
 * A missing secret falls back to the development key, so sealing never refuses; sealKeyStatus tells
 * the caller how much that seal is worth.
 */
import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

export type SealKeyStatus = 'strong' | 'missing' | 'too-short' | 'publicly-known';

export type OpenSealedResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'keys-differ' | 'malformed' };

const SALT = 'sail-proxy-payload-traces';
const INFO = 'trace-seal-v1';
const DEV_FALLBACK_SECRET = 'dev-key-change-in-production';
const MIN_SECRET_LENGTH = 32;

/**
 * Values that ship in the repository: the dev fallback and the METADATA_ENCRYPTION_KEY lines of
 * services/admin/.env.sample and services/gateway/.env.sample (a test keeps this list in step).
 */
export const PUBLICLY_KNOWN_SEAL_SECRETS: readonly string[] = [
  DEV_FALLBACK_SECRET,
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  'generate-a-secure-64-character-hex-string',
];

/**
 * Precedence when several apply: missing, then publicly-known, then too-short.
 * Judged on the trimmed value (padding adds no strength); the key itself is derived from the value as given.
 */
export function sealKeyStatus(env: NodeJS.ProcessEnv): SealKeyStatus {
  const raw = env.METADATA_ENCRYPTION_KEY ?? '';
  if (!raw) return 'missing';
  const secret = raw.trim();
  if (PUBLICLY_KNOWN_SEAL_SECRETS.includes(secret)) return 'publicly-known';
  if (secret.length < MIN_SECRET_LENGTH) return 'too-short';
  return 'strong';
}

function sealKey(env: NodeJS.ProcessEnv): Buffer {
  const secret = env.METADATA_ENCRYPTION_KEY || DEV_FALLBACK_SECRET;
  return Buffer.from(hkdfSync('sha256', secret, SALT, INFO, 32));
}

export function sealText(plain: string, env: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(env), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  });
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ENVELOPE_KEYS = 'ct,iv,tag,v';

/**
 * Whether a value has the shape sealText gives: JSON of exactly {v: 1, iv, tag, ct}, each a base64
 * string, a 12-byte IV and a 16-byte tag. Opens nothing; lets a store refuse a value that cannot be a seal.
 */
export function isSealEnvelope(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let parsed: any;
  try { parsed = JSON.parse(value); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) return false;
  if (Object.keys(parsed).sort().join(',') !== ENVELOPE_KEYS) return false;
  if (![parsed.iv, parsed.tag, parsed.ct].every((f) => typeof f === 'string' && f.length % 4 === 0 && BASE64.test(f))) return false;
  return Buffer.from(parsed.iv, 'base64').length === 12 && Buffer.from(parsed.tag, 'base64').length === 16;
}

/** Never throws. A wrong key and a changed byte are indistinguishable (GCM), both are 'keys-differ'. */
export function openSealed(envelope: string, env: NodeJS.ProcessEnv): OpenSealedResult {
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    const parsed = JSON.parse(envelope);
    if (!parsed || parsed.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.tag !== 'string' || typeof parsed.ct !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    iv = Buffer.from(parsed.iv, 'base64');
    tag = Buffer.from(parsed.tag, 'base64');
    ct = Buffer.from(parsed.ct, 'base64');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (iv.length !== 12 || tag.length !== 16) return { ok: false, reason: 'malformed' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(env), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'keys-differ' };
  }
}
