/**
 * Day-scoped SigV4 signing keys (kSigning) the admin service returned with a validation, held in
 * this process's memory only: never written to Valkey, never logged. Keyed by access key id plus
 * scope (date, region, service). An entry is dropped once its scope date is more than a day old,
 * since no request with a fresh x-amz-date can be signed for that day any more.
 */
import type { AwsSigningKey } from '../clients/adminServiceClient';
import type { SigningScope } from '../utils/sigv4Verifier';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 1;
/** Upper bound on cached keys; the oldest insert is evicted beyond it. */
export const MAX_SIGNING_KEYS = 10_000;

const keys = new Map<string, { day: number; key: Buffer }>();

function entryKey(accessKeyId: string, scope: SigningScope): string {
  return `${accessKeyId}\n${scope.date}\n${scope.region}\n${scope.service}`;
}

function scopeDay(date: unknown): number | null {
  if (typeof date !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / DAY_MS : null;
}

function tooOld(day: number, nowMs: number): boolean {
  return Math.floor(nowMs / DAY_MS) - day > MAX_AGE_DAYS;
}

/** Store the keys an admin validation returned for accessKeyId, and drop entries past their day. */
export function rememberSigningKeys(accessKeyId: string, signingKeys: AwsSigningKey[] | undefined): void {
  const now = Date.now();
  for (const [k, entry] of keys) {
    if (tooOld(entry.day, now)) keys.delete(k);
  }
  for (const sk of signingKeys ?? []) {
    const day = scopeDay(sk?.date);
    if (day === null || tooOld(day, now) || typeof sk.key !== 'string' || !/^[0-9a-f]{64}$/.test(sk.key)) continue;
    const k = entryKey(accessKeyId, sk);
    // Map iteration is insertion order: the first key is the oldest insert.
    if (!keys.has(k) && keys.size >= MAX_SIGNING_KEYS) keys.delete(keys.keys().next().value!);
    keys.set(k, { day, key: Buffer.from(sk.key, 'hex') });
  }
}

/** The cached kSigning for accessKeyId and scope, or null. */
export function cachedSigningKey(accessKeyId: string, scope: SigningScope): Buffer | null {
  const k = entryKey(accessKeyId, scope);
  const entry = keys.get(k);
  if (!entry) return null;
  if (tooOld(entry.day, Date.now())) {
    keys.delete(k);
    return null;
  }
  return entry.key;
}

/** Test hook: empty the cache. */
export function clearSigningKeys(): void {
  keys.clear();
}
