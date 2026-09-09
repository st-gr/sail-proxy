/**
 * Per-user usage counters (spec docs/superpowers/specs/2026-09-07-user-usage-counters-design.md):
 * one bucket per user, UTC calendar day and cost currency (UserUsageDaily). `tokens` is fresh
 * tokens (input + output + cache writes); cache reads are priced, not counted. The usage processor
 * adds to the buckets in the transaction that persists the usage rows; rebuild() recomputes them
 * from the rows. The quota windows (day / ISO week / month) are derived from the buckets, so
 * nothing but rebuild() ever aggregates the usage tables. Raw SQL only where CQN cannot express
 * it (the upsert, the grouped rebuild reads), dialect-detected like usageEventProcessor.
 */
import { getDefaultLogger } from '@libs/logger';
import { WindowName, windowStarts } from './quotaWindows';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const BUCKETS = 'sap.llm.gateway.admin.UserUsageDaily';
export const BUCKETS_TABLE = 'sap_llm_gateway_admin_UserUsageDaily';
export const RETENTION_DAYS = 62;
/** Owner values the usage processor writes when it cannot resolve a credential's owner. */
export const OWNER_EMAIL_FALLBACKS = new Set(['unknown@example.com', 'unknown-user']);
const WINDOWS: WindowName[] = ['day', 'week', 'month'];

export interface Increment { email: string; day: string; currency: string; requests: number; tokens: number; sapCost: number; }   // tokens: fresh tokens (input + output + cache writes)
export type BucketRow = Increment;
export interface WindowUsage { requests: number; tokens: number; sapCost: number; sapCostByCurrency: Record<string, number>; }   // tokens: fresh tokens (input + output + cache writes)

export const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
/** 'YYYY-MM-DD' of a Date or ISO string in UTC — the bucket key and the unit every window compares on. */
export const utcDay = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);
/** A bucket's `day` as the driver returns it: SQLite the stored text, Postgres possibly a Date. */
export const dayOf = (v: any): string => (typeof v === 'string' ? v.slice(0, 10) : utcDay(v));
/** Every window starts on or after this instant: the buckets a read needs, the days a rebuild rewrites. */
export function windowHorizon(now: Date): Date {
  const s = windowStarts(now);
  return s.week < s.month ? s.week : s.month;
}
export function isPostgres(db: any): boolean {
  const kind = (db?.options ?? db?.service?.options)?.credentials?.kind;
  return kind === 'postgres' || process.env.CDS_ENV === 'pg' || process.env.NODE_CONFIG_ENV === 'pg';
}
const bucketKey = (email: string, day: string, currency: string) => `${email}|${day}|${currency}`;

/**
 * Folds usage records (the objects the processor inserts, or grouped rebuild rows carrying
 * `requests`/`tokens` already summed) into one increment per (owner, day, currency).
 * `ownerOf(record)` returns the owner e-mail or null; null and the fallback owners fold into nothing.
 */
export function foldIncrements(records: Array<Record<string, any>>, ownerOf: (r: Record<string, any>) => string | null | undefined): Increment[] {
  const out = new Map<string, Increment>();
  for (const r of records) {
    const email = ownerOf(r);
    if (!email || OWNER_EMAIL_FALLBACKS.has(email)) continue;
    const day = utcDay(r.validFrom);
    const currency = r.sapCostCurrency ?? '';
    const key = bucketKey(email, day, currency);
    const inc = out.get(key) ?? { email, day, currency, requests: 0, tokens: 0, sapCost: 0 };
    inc.requests += r.requests !== undefined ? Number(r.requests) || 0 : 1;
    inc.tokens += r.tokens !== undefined
      ? Number(r.tokens) || 0
      : (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheCreationInputTokens ?? 0);   // fresh tokens: cache reads are priced, not counted
    inc.sapCost = round(inc.sapCost + (Number(r.sapCost) || 0));
    out.set(key, inc);
  }
  return [...out.values()];
}

/** Upserts the increments, one statement per bucket, through `db.run(sql, params)` (a service or a transaction). */
export async function applyIncrements(db: any, increments: Increment[], now: Date = new Date()): Promise<number> {
  if (increments.length === 0) return 0;
  const pg = isPostgres(db);
  const values = pg ? '($1, $2, $3, $4, $5, $6, $7)' : '(?, ?, ?, ?, ?, ?, ?)';
  const sql = `INSERT INTO ${BUCKETS_TABLE} (email, day, currency, requests, tokens, sapCost, updatedAt) VALUES ${values}
    ON CONFLICT (email, day, currency) DO UPDATE SET requests = ${BUCKETS_TABLE}.requests + excluded.requests,
    tokens = ${BUCKETS_TABLE}.tokens + excluded.tokens, sapCost = ${BUCKETS_TABLE}.sapCost + excluded.sapCost, updatedAt = excluded.updatedAt`;
  const at = now.toISOString();
  for (const i of increments) await db.run(sql, [i.email, i.day, i.currency, i.requests, i.tokens, i.sapCost, at]);
  return increments.length;
}

/** The buckets of `emails` from `since` (a Date, compared on its UTC day) on, numbers normalised. */
export async function readBuckets(db: any, emails: string[], since: Date): Promise<BucketRow[]> {
  if (emails.length === 0) return [];
  const { SELECT } = cds.ql;
  const rows = await db.run(SELECT.from(BUCKETS).columns('email', 'day', 'currency', 'requests', 'tokens', 'sapCost')
    .where({ email: { in: emails }, day: { '>=': utcDay(since) } }));
  return (rows ?? []).map((r: any) => ({
    email: r.email, day: dayOf(r.day), currency: r.currency ?? '',
    requests: Number(r.requests) || 0, tokens: Number(r.tokens) || 0, sapCost: Number(r.sapCost) || 0
  }));
}

/** Day / ISO week / month usage from bucket rows; `currency` is the quota currency `sapCost` reports. */
export function windowsFromBuckets(rows: BucketRow[], now: Date, currency: string): Record<WindowName, WindowUsage> {
  const starts = windowStarts(now);
  const since: Record<WindowName, string> = { day: utcDay(starts.day), week: utcDay(starts.week), month: utcDay(starts.month) };
  const out = {} as Record<WindowName, WindowUsage>;
  for (const w of WINDOWS) {
    const u: WindowUsage = { requests: 0, tokens: 0, sapCost: 0, sapCostByCurrency: {} };
    for (const r of rows) {
      if (dayOf(r.day) < since[w]) continue;
      u.requests += r.requests; u.tokens += r.tokens;
      if (r.currency) u.sapCostByCurrency[r.currency] = round((u.sapCostByCurrency[r.currency] ?? 0) + r.sapCost);
    }
    u.sapCost = round(u.sapCostByCurrency[currency] ?? 0);
    out[w] = u;
  }
  return out;
}

// ---- rebuild from the rows (spec §3.5) ------------------------------------------------------
const USERS = 'sap.llm.gateway.admin.Users';
const AWS = 'sap.llm.gateway.admin.AwsCredentials';
const KEY_USAGE_TABLE = 'sap_llm_gateway_admin_ApiKeyUsage';
const AWS_USAGE_TABLE = 'sap_llm_gateway_admin_AwsCredentialUsage';
const TOKENS_SUM = 'coalesce(sum(inputTokens),0) + coalesce(sum(outputTokens),0) + coalesce(sum(cacheCreationInputTokens),0)';
const isEmail = (s: any) => typeof s === 'string' && s.includes('@');

export interface RebuildResult { users: number; buckets: number; bucketsByUser: Record<string, number>; durationMs: number; }

/**
 * A raw-SQL result field, whatever case the driver returned it in. The quoted aliases in
 * groupedUsage below keep the mixed-case names on both dialects; this is the braces to that belt —
 * an alias that ever lost its quotes would come back folded on Postgres and must not silently zero
 * the spend or drop an AWS row's owner. `??` only, so a legitimate 0 or '' survives.
 */
const pick = (row: any, name: string) => row[name] ?? row[name.toLowerCase()];
const normaliseRows = (rows: any[]): any[] => (rows ?? []).map((r) => ({
  owner: pick(r, 'owner'), credential_ID: pick(r, 'credential_ID'), day: pick(r, 'day'),
  sapCostCurrency: pick(r, 'sapCostCurrency'), requests: pick(r, 'requests'),
  tokens: pick(r, 'tokens'), sapCost: pick(r, 'sapCost')
}));

/**
 * Grouped usage of one table since `since`, one row per (owner column, credential, day, currency).
 * `credentialIds`, given only for the AWS table, scopes the SQL to rows whose owner-column value
 * IS one of `emails` OR whose `credential_ID` is one of those e-mails' own credentials — an AWS
 * row is owned through either — so a scoped rebuild does not scan the whole table.
 */
async function groupedUsage(tx: any, table: string, ownerColumn: 'email' | 'userId', since: Date, emails: string[] | undefined, pg: boolean, credentialIds?: string[]): Promise<any[]> {
  const p = (i: number) => (pg ? `$${i}` : '?');
  const dayExpr = pg ? `to_char(validFrom, 'YYYY-MM-DD')` : `substr(validFrom, 1, 10)`;   // CAP stores Timestamps in UTC on both dialects
  const credential = table === AWS_USAGE_TABLE ? 'credential_ID AS "credential_ID"' : `'' AS "credential_ID"`;   // ApiKeyUsage has no credential column
  const groupCredential = table === AWS_USAGE_TABLE ? 'credential_ID, ' : '';
  const params: any[] = [since.toISOString()];
  let scope = '';
  if (emails) {
    if (emails.length === 0) return [];
    const emailPlaceholders = emails.map((_, i) => p(i + 2)).join(', ');
    if (credentialIds && credentialIds.length > 0) {
      const credPlaceholders = credentialIds.map((_, i) => p(i + 2 + emails.length)).join(', ');
      scope = ` AND (${ownerColumn} IN (${emailPlaceholders}) OR credential_ID IN (${credPlaceholders}))`;
      params.push(...emails, ...credentialIds);
    } else {
      scope = ` AND ${ownerColumn} IN (${emailPlaceholders})`;
      params.push(...emails);
    }
  }
  // Aliases are double-quoted (valid on SQLite too): Postgres folds an unquoted alias to lower
  // case, and a raw result bypasses CAP's name mapping, so `sapCostCurrency`/`sapCost`/
  // `credential_ID` would come back as `sapcostcurrency`/`sapcost`/`credential_id`. Column
  // REFERENCES stay unquoted on purpose — CAP's Postgres DDL creates them folded, so quoting
  // them would look for columns that do not exist.
  return normaliseRows(await tx.run(
    `SELECT ${ownerColumn} AS "owner", ${credential}, ${dayExpr} AS "day", coalesce(sapCostCurrency, '') AS "sapCostCurrency",
            count(*) AS "requests", ${TOKENS_SUM} AS "tokens", coalesce(sum(sapCost), 0) AS "sapCost"
       FROM ${table}
      WHERE validFrom >= ${p(1)} AND usageSignature IS NOT NULL${scope}
      GROUP BY ${ownerColumn}, ${groupCredential}${dayExpr}, coalesce(sapCostCurrency, '')`, params));
}

/** Buckets for one owner scope from `since`: API-key rows by e-mail, AWS rows by userId or the credential's owner. */
async function bucketsFromRows(tx: any, since: Date, emails: string[] | undefined, pg: boolean): Promise<Increment[]> {
  const keyRows = await groupedUsage(tx, KEY_USAGE_TABLE, 'email', since, emails, pg);
  const owners = new Map<string, string>();
  // Scoped: resolve the scope's own credentials first (one query), so the AWS grouped read below
  // can be scoped in SQL too, and reuse this same map for attribution — no second query for it.
  const scopedCredentials: any[] = emails ? await tx.run(cds.ql.SELECT.from(AWS).columns('ID', 'email').where({ email: { in: emails } })) : [];
  for (const c of scopedCredentials) owners.set(c.ID, c.email);
  const awsRows = await groupedUsage(tx, AWS_USAGE_TABLE, 'userId', since, emails, pg, scopedCredentials.map((c) => c.ID));
  if (!emails) {
    // Unscoped (a full rebuild): only now do we know which credentials the returned rows reference.
    const credentialIds = [...new Set(awsRows.map((r: any) => r.credential_ID).filter(Boolean))];
    if (credentialIds.length > 0) {
      for (const c of await tx.run(cds.ql.SELECT.from(AWS).columns('ID', 'email').where({ ID: { in: credentialIds } }))) owners.set(c.ID, c.email);
    }
  }
  const attributed = awsRows.map((r: any) => ({ ...r, owner: isEmail(r.owner) ? r.owner : owners.get(r.credential_ID) ?? null }))
    .filter((r: any) => r.owner && (!emails || emails.includes(r.owner)));
  const rows = [...keyRows, ...attributed].map((r: any) => ({ ...r, validFrom: `${dayOf(r.day)}T00:00:00.000Z` }));
  return foldIncrements(rows, (r) => r.owner);
}

/**
 * Recomputes the buckets from the usage rows for `emails` (every user when omitted) from the
 * window horizon on, re-does users with a reset watermark inside that range from their watermark,
 * and — for a full rebuild — applies the retention. One transaction, so a usage batch committing
 * meanwhile is counted exactly once (spec §3.5).
 */
export async function rebuild(db: any, opts: { emails?: string[]; now?: Date } = {}): Promise<RebuildResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const horizon = windowHorizon(now);
  const scope = opts.emails ? [...new Set(opts.emails.filter(Boolean))] : undefined;
  const { SELECT, DELETE, INSERT } = cds.ql;
  let buckets = 0; let users = 0; let bucketsByUser: Record<string, number> = {};
  // db.tx(fn) would open a root transaction and deadlock the single connection from inside a
  // request (rebuildUsageCounters); db.run(fn) joins the ambient one or opens its own.
  await db.run(async (tx: any) => {
    const pg = isPostgres(tx);
    const dayFilter: any = { day: { '>=': utcDay(horizon) } };
    if (scope) dayFilter.email = { in: scope };
    await tx.run(DELETE.from(BUCKETS).where(dayFilter));
    const increments = await bucketsFromRows(tx, horizon, scope, pg);
    // Users with a reset inside the range count only from their watermark (spec §3.4/§3.5).
    // Bounded above by `now` — the rebuild's clock (a test seam, not always wall-clock) — so a
    // watermark stored after `now` (an explicit-now replay) has not happened yet and is ignored:
    // otherwise this filter would delete that user's buckets without restoring them below.
    // Chained `.where({a}).and({b})`, NOT a single `{ quotaResetAt: { '>=': x, '<=': y } }` object:
    // the latter renders as `quotaResetAt >= ? <= ?` with no `and` — a SQLite no-op (always true)
    // and a Postgres type error (`boolean <= timestamp`) — verified with DEBUG=sql (see the report).
    let resetQuery = SELECT.from(USERS).columns('email', 'quotaResetAt')
      .where({ quotaResetAt: { '>=': horizon.toISOString() } })
      .and({ quotaResetAt: { '<=': now.toISOString() } });
    if (scope) resetQuery = resetQuery.and({ email: { in: scope } });
    const resetUsers: any[] = await tx.run(resetQuery);
    const resetEmails = new Set(resetUsers.map((u) => u.email));
    const kept = increments.filter((i) => !resetEmails.has(i.email));
    for (const u of resetUsers) kept.push(...await bucketsFromRows(tx, new Date(u.quotaResetAt), [u.email], pg));
    const at = now.toISOString();
    if (kept.length > 0) await tx.run(INSERT.into(BUCKETS).entries(kept.map((i) => ({ ...i, updatedAt: at }))));
    if (!scope) await tx.run(DELETE.from(BUCKETS).where({ day: { '<': utcDay(new Date(windowStarts(now).day.getTime() - RETENTION_DAYS * 86_400_000)) } }));
    buckets = kept.length;
    users = new Set(kept.map((i) => i.email)).size;
    for (const i of kept) bucketsByUser[i.email] = (bucketsByUser[i.email] ?? 0) + 1;
  });
  const durationMs = Date.now() - started;
  logger.info('UsageCounters', `Rebuilt usage buckets: ${users} users, ${buckets} buckets in ${durationMs} ms${scope ? ` (${scope.length} requested)` : ''}`);
  return { users, buckets, bucketsByUser, durationMs };
}

/** The migration for an existing deployment: an empty bucket table with usage rows behind it is rebuilt once. */
export async function rebuildIfEmpty(db: any, now: Date = new Date()): Promise<boolean> {
  const { SELECT } = cds.ql;
  const [{ n }] = await db.run(SELECT.from(BUCKETS).columns('count(*) as n'));
  if (Number(n) > 0) return false;
  const hasRows = async (t: string) => (await db.run(SELECT.from(t).columns('ID').limit(1))).length > 0;
  if (!(await hasRows('sap.llm.gateway.admin.ApiKeyUsage')) && !(await hasRows('sap.llm.gateway.admin.AwsCredentialUsage'))) return false;
  await rebuild(db, { now });
  return true;
}
