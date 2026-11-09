/**
 * Tool usage persistence (spec 2026-09-16 §4/§8): one raw row per tool per request, a daily
 * aggregate per user, day, identity and facet, and the nightly retention whose windows come
 * from platform.toolGovernance.retention in the active API configuration (file fallback).
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
const cds = require('@sap/cds');

const logger = getDefaultLogger();
export const TOOL_USAGE = 'sap.llm.gateway.admin.ToolUsage';
export const TOOL_USAGE_DAILY = 'sap.llm.gateway.admin.ToolUsageDaily';
export const TOOL_USAGE_AGENT_DAILY = 'sap.llm.gateway.admin.ToolUsageAgentDaily';
export const UNKNOWN_AGENT = 'unknown';
/**
 * The owner a tool row falls back to when the usage event's credential has no owner on record.
 * ONE constant for both batches: the API key batch and the AWS credential batch used to disagree
 * ('unknown@example.com' vs 'unknown-user'), which split one unknown owner into two rows in the
 * daily aggregates and the inventory. Both spellings are in usageCounters' OWNER_EMAIL_FALLBACKS,
 * so neither ever counted towards a real user's quota.
 */
export const UNKNOWN_TOOL_OWNER = 'unknown@example.com';
export const DEFAULT_RAW_DAYS = 30;
export const DEFAULT_DAILY_DAYS = 400;
const DECISIONS = ['allowed', 'monitored', 'stripped', 'rejected', 'unlisted', 'detected'] as const;
type Decision = typeof DECISIONS[number];

export interface ToolEntryLike { identity: string; facet: 'declared' | 'invoked' | 'source'; count?: number; decision: Decision; reason?: 'policy' | 'trust_chain'; }
export interface UsageEventLike {
  requestId?: string; timestamp?: number; authType?: string; credentialId?: string; provider?: string; model?: string; endpoint?: string;
  userAgent?: string;
  tools?: ToolEntryLike[];
}
export interface RetentionSettings { rawDays: number; dailyDays: number; }

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The client program behind a User-Agent: its first token, lower-cased ("claude-cli/2.0.1 (external)"
 * -> "claude-cli"). Keeps the per-agent breakdown's cardinality bounded - versions and platform
 * details stay on the raw ToolUsage row, which holds the header verbatim.
 */
export function normaliseAgent(userAgent?: string): string {
  const raw = String(userAgent ?? '').trim();
  if (!raw) return UNKNOWN_AGENT;
  const token = raw.split(/[\s/]/)[0].trim().toLowerCase();
  return token ? token.slice(0, 60) : UNKNOWN_AGENT;
}

/** Raw rows and daily upserts for the events that carry tools; runs inside the caller's transaction. */
export async function recordToolUsage(tx: any, events: UsageEventLike[], emailOf: (e: UsageEventLike) => string): Promise<number> {
  const { INSERT, SELECT, UPDATE } = cds.ql;
  const rows: any[] = [];
  const daily = new Map<string, { email: string; day: string; identity: string; facet: string; requests: number; counts: Record<Decision, number>; trustChained: number; lastSeen: string }>();
  const perAgent = new Map<string, { email: string; day: string; identity: string; facet: string; agent: string; requests: number; lastSeen: string }>();
  for (const e of events) {
    const tools = Array.isArray(e.tools) ? e.tools : [];
    if (tools.length === 0) continue;
    const email = emailOf(e);
    const at = new Date((e.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
    const validFrom = at.toISOString();
    const agent = normaliseAgent(e.userAgent);
    for (const t of tools) {
      if (!t?.identity || !DECISIONS.includes(t.decision)) continue;
      const count = Math.max(1, Number(t.count) || 1);
      rows.push({ ID: uuidv4(), requestId: e.requestId ?? null, email, credentialId: e.credentialId ?? null, authType: e.authType ?? null, provider: e.provider ?? null,
        model: e.model ?? null, endpoint: e.endpoint ?? null, identity: t.identity, facet: t.facet, count, decision: t.decision,
        reason: t.reason === 'policy' || t.reason === 'trust_chain' ? t.reason : null, validFrom,
        userAgent: e.userAgent ? String(e.userAgent).slice(0, 500) : null });
      const key = `${email}|${utcDay(at)}|${t.identity}|${t.facet}`;
      const agg = daily.get(key) ?? { email, day: utcDay(at), identity: t.identity, facet: t.facet, requests: 0, counts: { allowed: 0, monitored: 0, stripped: 0, rejected: 0, unlisted: 0, detected: 0 }, trustChained: 0, lastSeen: validFrom };
      agg.requests += 1;
      agg.counts[t.decision] += count;
      if (t.reason === 'trust_chain') agg.trustChained += count;
      if (validFrom > agg.lastSeen) agg.lastSeen = validFrom;
      daily.set(key, agg);
      const agentKey = `${key}|${agent}`;
      const byAgent = perAgent.get(agentKey) ?? { email, day: utcDay(at), identity: t.identity, facet: t.facet, agent, requests: 0, lastSeen: validFrom };
      byAgent.requests += 1;
      if (validFrom > byAgent.lastSeen) byAgent.lastSeen = validFrom;
      perAgent.set(agentKey, byAgent);
    }
  }
  if (rows.length === 0) return 0;
  await tx.run(INSERT.into(TOOL_USAGE).entries(rows));
  for (const agg of daily.values()) {
    const where = { email: agg.email, day: agg.day, identity: agg.identity, facet: agg.facet };
    const existing = (await tx.run(SELECT.from(TOOL_USAGE_DAILY).where(where)))[0];
    if (existing) {
      await tx.run(UPDATE(TOOL_USAGE_DAILY).set({
        requests: (existing.requests ?? 0) + agg.requests,
        allowed: (existing.allowed ?? 0) + agg.counts.allowed, monitored: (existing.monitored ?? 0) + agg.counts.monitored,
        stripped: (existing.stripped ?? 0) + agg.counts.stripped, rejected: (existing.rejected ?? 0) + agg.counts.rejected,
        unlisted: (existing.unlisted ?? 0) + agg.counts.unlisted,
        detected: (existing.detected ?? 0) + agg.counts.detected,
        trustChained: (existing.trustChained ?? 0) + agg.trustChained,
        lastSeen: existing.lastSeen && existing.lastSeen > agg.lastSeen ? existing.lastSeen : agg.lastSeen
      }).where(where));
    } else {
      await tx.run(INSERT.into(TOOL_USAGE_DAILY).entries([{ ...where, requests: agg.requests, ...agg.counts, trustChained: agg.trustChained, lastSeen: agg.lastSeen }]));
    }
  }
  for (const agg of perAgent.values()) {
    const where = { email: agg.email, day: agg.day, identity: agg.identity, facet: agg.facet, agent: agg.agent };
    const existing = (await tx.run(SELECT.from(TOOL_USAGE_AGENT_DAILY).where(where)))[0];
    if (existing) {
      await tx.run(UPDATE(TOOL_USAGE_AGENT_DAILY).set({
        requests: (existing.requests ?? 0) + agg.requests,
        lastSeen: existing.lastSeen && existing.lastSeen > agg.lastSeen ? existing.lastSeen : agg.lastSeen
      }).where(where));
    } else {
      await tx.run(INSERT.into(TOOL_USAGE_AGENT_DAILY).entries([{ ...where, requests: agg.requests, lastSeen: agg.lastSeen }]));
    }
  }
  return rows.length;
}

/**
 * A refused request's tools, recorded as ATTEMPTS in the inventory.
 *
 * A rejected request never reached a model, so it emits no usage event and must not produce a usage
 * or billing row: the refused identities ride the `tool_not_entitled` security event instead
 * (`metadata.tools`, reject mode only - a stripped request continues and its own usage event already
 * records the stripped tools). The aggregate decides what a second rejection of a known tool means:
 * the daily row for that identity, facet and day already exists, so its `rejected` counter is bumped
 * rather than a new entry created, while a tool nobody has used yet appears for the first time.
 */
export async function recordRejectedTools(
  db: { run: (arg: any) => Promise<any> },
  event: { requestId?: string; timestamp?: string; authType?: string; credentialId?: string; endpoint?: string; userAgent?: string; metadata?: any },
  email: string
): Promise<number> {
  const meta = event.metadata ?? {};
  if (meta.mode !== 'reject') return 0;
  const tools = (Array.isArray(meta.tools) ? meta.tools : []).filter((t: any) => t?.identity && t?.facet && t?.decision === 'rejected');
  if (tools.length === 0 || !email) return 0;
  const at = event.timestamp ? Date.parse(event.timestamp) : Date.now();
  const usageEvent: UsageEventLike = {
    requestId: event.requestId, timestamp: Math.floor((Number.isNaN(at) ? Date.now() : at) / 1000),
    authType: event.authType, credentialId: event.credentialId, endpoint: event.endpoint,
    model: typeof meta.model === 'string' ? meta.model : undefined, userAgent: event.userAgent, tools
  };
  return db.run(async (tx: any) => recordToolUsage(tx, [usageEvent], () => email));
}

// ---- retention settings: platform.toolGovernance.retention, active configuration first, file fallback, 60 s cache ----
const CACHE_MS = 60_000;
let cached: { at: number; settings: RetentionSettings } | null = null;
export function invalidateToolRetentionDefaults(): void { cached = null; }

async function activePlatform(db?: any): Promise<any> {
  const unwrap = (o: any) => (o && typeof o === 'object' ? (o.api_config ?? o) : {});
  if (db) {
    try {
      const rows = await db.run(cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations').columns('configData').where({ isActive: true }).orderBy('version desc').limit(1));
      if (rows.length > 0 && rows[0].configData) return unwrap(JSON.parse(rows[0].configData))?.platform ?? {};
    } catch { /* fall through to the file */ }
  }
  try { return unwrap(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../api_config.json'), 'utf8')))?.platform ?? {}; } catch { return {}; }
}

const days = (v: any, fallback: number): number => (Number.isInteger(v) && v >= 1 ? v : fallback);

export async function retentionSettings(db?: any): Promise<RetentionSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;
  const r = (await activePlatform(db))?.toolGovernance?.retention ?? {};
  const settings = { rawDays: days(r.rawDays, DEFAULT_RAW_DAYS), dailyDays: days(r.dailyDays, DEFAULT_DAILY_DAYS) };
  cached = { at: Date.now(), settings };
  return settings;
}

/** Deletes raw rows older than rawDays and daily rows older than dailyDays. Nightly, never per request. */
export async function applyRetention(db: any, now: Date = new Date(), settings?: RetentionSettings): Promise<{ rawDeleted: number; dailyDeleted: number }> {
  const s = settings ?? (await retentionSettings(db));
  const { DELETE } = cds.ql;
  const rawBefore = new Date(now.getTime() - s.rawDays * 86_400_000).toISOString();
  const dailyBefore = utcDay(new Date(now.getTime() - s.dailyDays * 86_400_000));
  const rawDeleted = await db.run(DELETE.from(TOOL_USAGE).where({ validFrom: { '<': rawBefore } }));
  const dailyDeleted = await db.run(DELETE.from(TOOL_USAGE_DAILY).where({ day: { '<': dailyBefore } }));
  const agentDeleted = await db.run(DELETE.from(TOOL_USAGE_AGENT_DAILY).where({ day: { '<': dailyBefore } }));
  logger.info('ToolUsage', `retention: ${rawDeleted} raw rows, ${dailyDeleted} daily rows and ${agentDeleted} per-agent rows removed (raw ${s.rawDays} d, daily ${s.dailyDays} d)`);
  return { rawDeleted: Number(rawDeleted) || 0, dailyDeleted: Number(dailyDeleted) || 0 };
}
