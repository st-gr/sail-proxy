/**
 * Per-credential rate limits (spec §2, §4). Rows live in RateLimits linked by apiKey_ID or
 * awsCredential_ID — the ApiKeys.rateLimits_ID composition key has never been written, so the
 * link column is the source of truth. A credential without a row has no per-key limit.
 */
import { v4 as uuidv4 } from 'uuid';

const cds = require('@sap/cds');
const RL = 'sap.llm.gateway.admin.RateLimits';
const CHUNK = 200;

export interface CredentialRateLimits { requestsPerMinute: number | null; requestsPerHour: number | null; requestsPerDay: number | null; }
export type RateLimitTarget = { apiKeyId: string; awsCredentialId?: undefined } | { awsCredentialId: string; apiKeyId?: undefined };
type DbLike = { run(q: any): Promise<any> };

const whereOf = (t: RateLimitTarget) => (t.apiKeyId ? { apiKey_ID: t.apiKeyId } : { awsCredential_ID: t.awsCredentialId });
const NO_LIMITS: CredentialRateLimits = { requestsPerMinute: null, requestsPerHour: null, requestsPerDay: null };

export async function credentialRateLimits(db: DbLike, target: RateLimitTarget): Promise<CredentialRateLimits> {
  const { SELECT } = cds.ql;
  const row = await db.run(SELECT.one.from(RL).columns('requestsPerMinute', 'requestsPerHour', 'requestsPerDay').where(whereOf(target)));
  return {
    requestsPerMinute: row?.requestsPerMinute ?? null,
    requestsPerHour: row?.requestsPerHour ?? null,
    requestsPerDay: row?.requestsPerDay ?? null
  };
}

/**
 * `credentialRateLimits` for many credentials of the same kind in one SELECT (chunked at 200,
 * same pattern as the notification-context backfill) rather than one query per row - the
 * ApiKeys/AwsCredentials list is an existing main screen on the admin's single SQLite connection,
 * so an `after READ` handler must not await one query per row. An id with no row maps to the
 * three nulls, same default as `credentialRateLimits`.
 */
export async function credentialRateLimitsFor(db: DbLike, kind: 'apiKey' | 'awsCredential', ids: string[]): Promise<Map<string, CredentialRateLimits>> {
  const col = kind === 'apiKey' ? 'apiKey_ID' : 'awsCredential_ID';
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, CredentialRateLimits>(unique.map((id) => [id, NO_LIMITS]));
  if (unique.length === 0) return out;
  const { SELECT } = cds.ql;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows: any[] = await db.run(SELECT.from(RL).columns(col, 'requestsPerMinute', 'requestsPerHour', 'requestsPerDay').where({ [col]: { in: chunk } }));
    for (const row of rows) {
      out.set(row[col], { requestsPerMinute: row.requestsPerMinute ?? null, requestsPerHour: row.requestsPerHour ?? null, requestsPerDay: row.requestsPerDay ?? null });
    }
  }
  return out;
}

/** Upsert the row; only the provided fields change. Values must be integers >= 1 (validated by the caller). */
export async function setCredentialRateLimits(db: DbLike, target: RateLimitTarget, values: Partial<CredentialRateLimits>): Promise<CredentialRateLimits> {
  const { SELECT, INSERT, UPDATE } = cds.ql;
  const patch: any = {};
  for (const f of ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay'] as const) if (values[f] !== undefined) patch[f] = values[f];
  const existing = await db.run(SELECT.one.from(RL).columns('ID').where(whereOf(target)));
  if (existing) await db.run(UPDATE(RL).set(patch).where({ ID: existing.ID }));
  else await db.run(INSERT.into(RL).entries({ ID: uuidv4(), ...whereOf(target), ...patch }));
  return credentialRateLimits(db, target);
}
