/**
 * Day-scoped AWS SigV4 signing keys for the gateway's signature verification. The gateway names
 * the scopes it needs (the one from the request's Authorization header plus the bedrock <->
 * bedrock-runtime variant it also tries); the admin answers with kSigning per scope and never
 * with the secret. A key signs any request of its day, region and service, so scopes are limited
 * to the UTC day(s) a request signed now could carry (now +/- the gateway's 15-minute x-amz-date
 * skew) and to a handful per request.
 */
import crypto from 'crypto';

export interface SigningScope {
  date: string;
  region: string;
  service: string;
}

export interface SigningKey extends SigningScope {
  /** hex(kSigning) */
  key: string;
}

export const MAX_SIGNING_SCOPES = 4;
/** The gateway's x-amz-date skew (sigv4Verifier MAX_CLOCK_SKEW_MS). */
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function scopeDay(date: unknown): number | null {
  if (typeof date !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // Date.UTC rolls 20150832 over into September; only a real calendar day round-trips.
  const d = new Date(ms);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return ms / DAY_MS;
}

/**
 * The reason the requested scopes are refused, or null when every scope is acceptable: at most
 * MAX_SIGNING_SCOPES, a real YYYYMMDD date that is the UTC day of now - 15 min or of now + 15 min,
 * and region and service matching ^[a-z0-9-]{1,32}$.
 */
export function invalidSigningScopes(scopes: unknown, nowMs: number = Date.now()): string | null {
  if (!Array.isArray(scopes)) return 'signingScopes must be an array';
  if (scopes.length > MAX_SIGNING_SCOPES) return `at most ${MAX_SIGNING_SCOPES} signingScopes`;
  const earliestDay = Math.floor((nowMs - MAX_CLOCK_SKEW_MS) / DAY_MS);
  const latestDay = Math.floor((nowMs + MAX_CLOCK_SKEW_MS) / DAY_MS);
  for (const scope of scopes) {
    const day = scopeDay(scope?.date);
    if (day === null) return 'scope date must be a YYYYMMDD calendar date';
    if (day < earliestDay || day > latestDay) return 'scope date is not a day a request signed now could carry';
    if (typeof scope.region !== 'string' || !NAME_PATTERN.test(scope.region)) return 'scope region is invalid';
    if (typeof scope.service !== 'string' || !NAME_PATTERN.test(scope.service)) return 'scope service is invalid';
  }
  return null;
}

/** AWS's derivation: kDate, kRegion, kService, kSigning. */
export function deriveSigningKeys(secret: string, scopes: SigningScope[]): SigningKey[] {
  return scopes.map(({ date, region, service }) => {
    const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(date).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return { date, region, service, key: kSigning.toString('hex') };
  });
}
