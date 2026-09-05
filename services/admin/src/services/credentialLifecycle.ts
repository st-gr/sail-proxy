/**
 * Admin-only lifecycle rules shared by API keys and AWS credentials.
 *
 * Governing rule (maintainer): only an administrator may change isActive or the expiration of a
 * credential — not even its owner. Newly created keys are active by default. Expired credentials
 * are rejected on every validation path and auto-locked. The admin-only neverExpires flag makes
 * "never expires" explicit and clears the date; rows that predate the column (expiresAt = null)
 * are backfilled to it on startup, so a null date on its own is no longer the carrier of the rule.
 *
 * Pure functions, no CAP dependency, so the rules are unit-tested without a server.
 */
import fs from 'fs';
import path from 'path';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

export const DEFAULT_CREDENTIAL_EXPIRATION_DAYS = 90;

// Loaded once from api_config.json — same file and shape sapCapacityService reads.
let _apiConfig: any = null;
function apiConfig(): any {
  if (!_apiConfig) {
    try {
      const p = path.resolve(__dirname, '../../api_config.json');
      _apiConfig = JSON.parse(fs.readFileSync(p, 'utf8')).api_config ?? {};
    } catch (error) {
      logger.error('credentialLifecycle', 'Failed to load api_config.json', error instanceof Error ? error : new Error(String(error)));
      _apiConfig = {};
    }
  }
  return _apiConfig;
}

/** platform.security.credentialExpirationDays when an integer >= 1, else the 90-day default. */
export function credentialExpirationDays(): number {
  const v = apiConfig()?.platform?.security?.credentialExpirationDays;
  return Number.isInteger(v) && v >= 1 ? v : DEFAULT_CREDENTIAL_EXPIRATION_DAYS;
}

/** Expiration a credential gets when it is created or refreshed: now + the configured period. */
export function defaultExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + credentialExpirationDays() * 86_400_000);
}

export function isExpired(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t < now.getTime();
}

/**
 * True when a requested expiration lies before now. Absent/empty means "never expires" and is not
 * a past date; an unparseable value is left to the model's own type check.
 */
export function expiresAtInPast(expiresAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  return isExpired(expiresAt, now);
}

function timestampOrNull(v: string | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Expiration a newly created credential gets: only an administrator may pre-set a date, everyone
 * else (and an admin who supplied none) gets the caller's default. Shared by the API key and AWS
 * credential creation paths, which carry different defaults.
 */
export function creationExpiresAt(args: {
  isAdmin: boolean;
  requested: string | Date | null | undefined;
  fallback: string | Date;
}): string | Date {
  const { isAdmin, requested, fallback } = args;
  if (isAdmin && requested !== null && requested !== undefined && requested !== '') return requested;
  return fallback;
}

export interface StoredLifecycle {
  isActive?: boolean;
  expiresAt?: string | Date | null;
  neverExpires?: boolean | null;
}

/**
 * Whether a stored credential counts as expired. The admin-only neverExpires flag wins over the
 * date, so a flagged row stays valid even if it carries a stale date from before it was flagged.
 */
export function credentialExpired(
  row: { expiresAt?: string | Date | null; neverExpires?: boolean | null } | null | undefined,
  now: Date = new Date()
): boolean {
  if (!row) return false;
  if (row.neverExpires === true) return false;
  return isExpired(row.expiresAt, now);
}

/**
 * Message describing the first lifecycle field a non-admin request would change, or null.
 * Draft activation sends the full row, so a value equal to the stored one is not a change.
 */
export function lifecycleChangeViolation(args: {
  isAdmin: boolean;
  data: Record<string, any>;
  stored: StoredLifecycle;
}): string | null {
  if (args.isAdmin) return null;
  const { data, stored } = args;
  if ('isActive' in data && data.isActive !== undefined && Boolean(data.isActive) !== Boolean(stored.isActive)) {
    return 'Only an administrator can change the active state';
  }
  if ('neverExpires' in data && data.neverExpires !== undefined
    && Boolean(data.neverExpires) !== Boolean(stored.neverExpires)) {
    return 'Only an administrator can change the never-expires flag';
  }
  if ('expiresAt' in data && timestampOrNull(data.expiresAt) !== timestampOrNull(stored.expiresAt)) {
    return 'Only an administrator can change the expiration date';
  }
  return null;
}

/**
 * The lifecycle pair a write should persist. neverExpires is authoritative: a flagged credential
 * carries no date at all, and clearing the flag without supplying one falls back to the standard
 * period rather than leaving the credential dateless (which would silently never expire).
 */
export function normalizeLifecycle(args: {
  neverExpires?: boolean | null;
  expiresAt?: string | Date | null;
  now?: Date;
}): { neverExpires: boolean; expiresAt: string | Date | null } {
  const now = args.now ?? new Date();
  if (args.neverExpires === true) return { neverExpires: true, expiresAt: null };
  const hasDate = args.expiresAt !== null && args.expiresAt !== undefined && args.expiresAt !== '';
  return { neverExpires: false, expiresAt: hasDate ? args.expiresAt! : defaultExpiresAt(now).toISOString() };
}

export type RotationDecision =
  | { allowed: true; expiresAt: string | null }
  | { allowed: false; reason: 'inactive' | 'expired' };

/**
 * A refresh always moves the expiration forward: every permitted rotation, by the owner or by an
 * administrator, resets expiresAt to now + the configured period. An owner is still refused on an
 * inactive or already-expired credential, so a refresh can extend a live credential but never
 * resurrect a dead one — only an administrator can do that.
 *
 * A credential an administrator flagged as never-expiring keeps that state: the refresh leaves it
 * dateless rather than quietly reintroducing an expiration the flag is meant to suppress.
 */
export function rotationPolicy(args: { isAdmin: boolean; stored: StoredLifecycle; now?: Date }): RotationDecision {
  const now = args.now ?? new Date();
  if (!args.isAdmin) {
    if (args.stored.isActive === false) return { allowed: false, reason: 'inactive' };
    if (credentialExpired(args.stored, now)) return { allowed: false, reason: 'expired' };
  }
  if (args.stored.neverExpires === true) return { allowed: true, expiresAt: null };
  return { allowed: true, expiresAt: defaultExpiresAt(now).toISOString() };
}
