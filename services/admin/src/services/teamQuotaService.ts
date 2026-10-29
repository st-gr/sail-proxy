// services/admin/src/services/teamQuotaService.ts
/**
 * Per-team pool figures (spec 2026-10-14 §5/§6): the document the gateway reads from Valkey
 * (quota:team:<id>), the status the Teams page shows, publish/reset. Mirrors userQuotaService;
 * reads only, chunked fan-outs, never a transaction across a gateway call (there is none).
 */
import { getDefaultLogger } from '@libs/logger';
import { TEAMS, DbLike, TeamRow, PoolLimitSource, getTeam, getTeamsByIds, poolLimits } from './teamLookups';
import { getProfilesByIds, ProfileRow } from './quotaProfilesService';
import { Limits } from './quotaLimits';
import { WindowName, windowStarts, nextResets } from './quotaWindows';
import { quotaStateStore, teamQuotaKeyFor, teamMinuteKey, QUOTA_DOCUMENT_TTL_SECONDS } from './quotaStateStore';
import { quotaCurrency, WindowUsage } from './userQuotaService';
import { readTeamBuckets, windowsFromBuckets, windowHorizon, TEAM_BUCKETS, TeamBucketRow } from './usageCounters';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const FANOUT_CHUNK = 25;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export interface TeamQuotaStateDocument {
  teamId: string; teamName: string; limits: Limits; sapCostCurrency: string;
  used: Record<WindowName, WindowUsage>; windowStart: Record<WindowName, string>;
  quotaResetAt: string | null; updatedAt: string;
}
export interface TeamQuotaStatus {
  teamId: string; name: string; limits: Limits; limitSource: PoolLimitSource; quotaProfileName: string | null; sapCostCurrency: string;
  used: { minuteRequests: number } & Record<WindowName, WindowUsage>;
  remaining: { spendDay: number | null; spendWeek: number | null; spendMonth: number | null; tokensDay: number | null; tokensWeek: number | null; tokensMonth: number | null };
  resetsAt: Record<WindowName, Date>; quotaResetAt: string | null;
}

export async function computeTeamUsageMany(db: DbLike, teamIds: string[], now: Date, currency: string): Promise<Map<string, Record<WindowName, WindowUsage>>> {
  const out = new Map<string, Record<WindowName, WindowUsage>>();
  const list = [...new Set(teamIds.filter(Boolean))];
  if (list.length === 0) return out;
  const byTeam = new Map<string, TeamBucketRow[]>();
  for (const r of await readTeamBuckets(db, list, windowHorizon(now))) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r]);
  for (const id of list) out.set(id, windowsFromBuckets(byTeam.get(id) ?? [], now, currency));
  return out;
}

/** Requests in the sliding minute from the gateway's rl:team buckets (0 without Valkey). */
export async function currentTeamMinuteRequests(teamId: string, now: Date): Promise<number> {
  const minute = Math.floor(now.getTime() / 60_000);
  const [current, previous] = await Promise.all([quotaStateStore.getNumber(teamMinuteKey(teamId, minute)), quotaStateStore.getNumber(teamMinuteKey(teamId, minute - 1))]);
  const elapsed = (now.getTime() % 60_000) / 60_000;
  return Math.round((current + previous * (1 - elapsed)) * 100) / 100;
}

async function poolProfile(db: DbLike, team: TeamRow, profiles?: Map<string, ProfileRow>): Promise<ProfileRow | null> {
  if (!team.quotaProfile_ID) return null;
  if (profiles) return profiles.get(team.quotaProfile_ID) ?? null;
  return (await getProfilesByIds(db, [team.quotaProfile_ID])).get(team.quotaProfile_ID) ?? null;
}

export async function buildTeamDocument(db: DbLike, team: TeamRow, now: Date = new Date(), currency?: string, used?: Record<WindowName, WindowUsage>): Promise<TeamQuotaStateDocument> {
  const { limits } = poolLimits(team, await poolProfile(db, team));
  const starts = windowStarts(now);
  const sapCostCurrency = currency ?? await quotaCurrency(now);
  return {
    teamId: team.ID, teamName: team.name, limits, sapCostCurrency,
    used: used ?? (await computeTeamUsageMany(db, [team.ID], now, sapCostCurrency)).get(team.ID)!,
    windowStart: { day: starts.day.toISOString(), week: starts.week.toISOString(), month: starts.month.toISOString() },
    quotaResetAt: team.quotaResetAt ? new Date(team.quotaResetAt).toISOString() : null,
    updatedAt: now.toISOString()
  };
}

async function statusOf(db: DbLike, team: TeamRow, now: Date, currency: string, used: Record<WindowName, WindowUsage>, profile: ProfileRow | null): Promise<TeamQuotaStatus> {
  const { limits, limitSource } = poolLimits(team, profile);
  const rem = (limit: number | null, value: number) => (limit === null ? null : round(Math.max(0, limit - value)));
  return {
    teamId: team.ID, name: team.name, limits, limitSource, quotaProfileName: profile?.name ?? null, sapCostCurrency: currency,
    used: { minuteRequests: await currentTeamMinuteRequests(team.ID, now), ...used },
    remaining: {
      spendDay: rem(limits.spendPerDay, used.day.sapCost), spendWeek: rem(limits.spendPerWeek, used.week.sapCost), spendMonth: rem(limits.spendPerMonth, used.month.sapCost),
      tokensDay: rem(limits.tokensPerDay, used.day.tokens), tokensWeek: rem(limits.tokensPerWeek, used.week.tokens), tokensMonth: rem(limits.tokensPerMonth, used.month.tokens)
    },
    resetsAt: nextResets(now), quotaResetAt: team.quotaResetAt ? new Date(team.quotaResetAt).toISOString() : null
  };
}

export async function teamStatus(db: DbLike, teamId: string, now: Date = new Date()): Promise<TeamQuotaStatus | null> {
  const team = await getTeam(db, teamId);
  if (!team) return null;
  const currency = await quotaCurrency(now);
  const used = (await computeTeamUsageMany(db, [teamId], now, currency)).get(teamId)!;
  return statusOf(db, team, now, currency, used, await poolProfile(db, team));
}

/**
 * One bucket read, one profile read and one currency for a page of teams; a team whose status failed is absent.
 * `unsaved` stands in for a team with no saved row yet (a never-activated draft): its status is computed from it.
 */
export async function teamStatusMany(db: DbLike, teamIds: string[], now: Date = new Date(), unsaved: TeamRow[] = []): Promise<Map<string, TeamQuotaStatus>> {
  const out = new Map<string, TeamQuotaStatus>();
  const list = [...new Set(teamIds.filter(Boolean))];
  if (list.length === 0) return out;
  const currency = await quotaCurrency(now);
  const teams = await getTeamsByIds(db, list);
  for (const row of unsaved) if (row?.ID && list.includes(row.ID) && !teams.has(row.ID)) teams.set(row.ID, row);
  const profiles = await getProfilesByIds(db, [...teams.values()].map((t) => t.quotaProfile_ID).filter(Boolean) as string[]);
  const usage = await computeTeamUsageMany(db, list, now, currency);
  for (let i = 0; i < list.length; i += FANOUT_CHUNK) {
    await Promise.all(list.slice(i, i + FANOUT_CHUNK).map(async (id) => {
      const team = teams.get(id);
      if (!team) return;
      try { out.set(id, await statusOf(db, team, now, currency, usage.get(id)!, await poolProfile(db, team, profiles))); }
      catch (error) { logger.warn('TeamQuotaService', `status failed for ${id}: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    if (i + FANOUT_CHUNK < list.length) await yieldToEventLoop();
  }
  return out;
}

const publishedDay = new Map<string, string>();
export async function publishTeam(db: DbLike, teamId: string, now: Date = new Date(), currency?: string, used?: Record<WindowName, WindowUsage>): Promise<boolean> {
  try {
    const team = await getTeam(db, teamId);
    if (!team) { publishedDay.delete(teamId); return false; }
    const doc = await buildTeamDocument(db, team, now, currency, used);
    const ok = await quotaStateStore.setJson(teamQuotaKeyFor(teamId), doc, QUOTA_DOCUMENT_TTL_SECONDS);
    if (ok) publishedDay.set(teamId, doc.windowStart.day);
    return ok;
  } catch (error) {
    logger.warn('TeamQuotaService', `publish failed for ${teamId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
/** The teams the rollover timer still republishes at the next UTC day (tests and diagnostics). */
export function trackedTeamIds(): string[] { return [...publishedDay.keys()]; }
async function publishChunked(db: DbLike, teamIds: string[], currency: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < teamIds.length; i += FANOUT_CHUNK) {
    const chunk = teamIds.slice(i, i + FANOUT_CHUNK);
    const usage = await computeTeamUsageMany(db, chunk, new Date(), currency);
    for (const id of chunk) if (await publishTeam(db, id, new Date(), currency, usage.get(id))) n += 1;
    if (i + FANOUT_CHUNK < teamIds.length) await yieldToEventLoop();
  }
  return n;
}
export async function publishTeams(db: DbLike, teamIds: Iterable<string>): Promise<void> {
  const list = [...new Set(teamIds)].filter(Boolean);
  if (list.length === 0) return;
  await publishChunked(db, list, await quotaCurrency(new Date()));
}
export async function republishAllTeams(): Promise<number> {
  const db = await cds.connect.to('db');
  const rows: any[] = await db.run(cds.ql.SELECT.from(TEAMS).columns('ID'));
  return publishChunked(db, rows.map((r) => r.ID), await quotaCurrency(new Date()));
}
export async function unpublishTeam(teamId: string): Promise<void> {
  publishedDay.delete(teamId);
  await quotaStateStore.del(teamQuotaKeyFor(teamId));
}

/** The watermark and the buckets move together; rows are never deleted. Sequential statements on the ambient transaction. */
export async function resetTeamQuota(db: DbLike, teamId: string, now: Date = new Date()): Promise<{ quotaResetAt: Date }> {
  await db.run(cds.ql.UPDATE(TEAMS).set({ quotaResetAt: now }).where({ ID: teamId }));
  await db.run(cds.ql.DELETE.from(TEAM_BUCKETS).where({ teamId }));
  await publishTeam(db, teamId, now);
  return { quotaResetAt: now };
}

let timer: NodeJS.Timeout | null = null;
export function startTeamRolloverTimer(): void {
  if (timer) return;
  timer = setInterval(async () => {
    const today = windowStarts(new Date()).day.toISOString();
    const stale = [...publishedDay].filter(([, day]) => day !== today).map(([id]) => id);
    if (stale.length === 0) return;
    try { const db = await cds.connect.to('db'); await publishTeams(db, stale); }
    catch (error) { logger.warn('TeamQuotaService', `rollover failed: ${error instanceof Error ? error.message : String(error)}`); }
  }, 60_000);
  timer.unref?.();
}
export function stopTeamRolloverTimer(): void { if (timer) { clearInterval(timer); timer = null; } }
