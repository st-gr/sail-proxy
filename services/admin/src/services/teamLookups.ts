// services/admin/src/services/teamLookups.ts
/**
 * Read-only team rules (spec 2026-10-14 §3/§4). This module imports nothing from usersService on
 * purpose: usersService reads the member-profile step for the wire block, so the write side
 * (teamsService.ts) is the module that imports both. Every function takes the db or transaction
 * to run on; nothing here opens a transaction.
 */
import { LIMIT_FIELDS, LimitField, Limits, TeamMemberLimits } from './quotaLimits';
import { getProfilesByIds, ProfileRow } from './quotaProfilesService';

const cds = require('@sap/cds');

export const TEAMS = 'sap.llm.gateway.admin.Teams';
export const MEMBERS = 'sap.llm.gateway.admin.TeamMembers';
export const KEYS = 'sap.llm.gateway.admin.ApiKeys';
export const AWS = 'sap.llm.gateway.admin.AwsCredentials';
export type DbLike = { run(q: any): Promise<any> };
export const ROLES = ['member', 'admin'] as const;
export type TeamRole = typeof ROLES[number];

export interface TeamRow {
  ID: string; name: string; description: string | null; quotaResetAt: string | null;
  quotaProfile_ID: string | null; memberQuotaProfile_ID: string | null; entitlementCatalog_ID: string | null; toolPolicy_ID: string | null;
  requestsPerMinute: number | null; spendPerDay: number | string | null; spendPerWeek: number | string | null; spendPerMonth: number | string | null;
  tokensPerDay: number | null; tokensPerWeek: number | null; tokensPerMonth: number | null;
  createdAt?: string; modifiedAt?: string;
}
export interface MembershipRow { ID: string; team_ID: string; email: string; role: TeamRole; isPrimary: boolean; createdAt: string; }
export type CredentialRef = { apiKeyId: string } | { awsCredentialId: string };
export interface TeamRef { teamId: string; name: string; }
export type PoolLimitSource = Record<LimitField, 'team' | 'profile' | 'unlimited'>;

/** SQLite stores booleans as 0/1 and Postgres as booleans; CAP normalises most reads, raw ones not. */
const bool = (v: any): boolean => v === true || v === 1 || v === '1' || v === 'true';
const membership = (r: any): MembershipRow => ({ ...r, role: r.role === 'admin' ? 'admin' : 'member', isPrimary: bool(r.isPrimary) });
const nullable = (r: any): TeamRow => ({
  ...r,
  quotaProfile_ID: r.quotaProfile_ID ?? null, memberQuotaProfile_ID: r.memberQuotaProfile_ID ?? null,
  entitlementCatalog_ID: r.entitlementCatalog_ID ?? null, toolPolicy_ID: r.toolPolicy_ID ?? null, quotaResetAt: r.quotaResetAt ?? null
});

export async function getTeam(db: DbLike, id: string): Promise<TeamRow | null> {
  if (!id) return null;
  const row = await db.run(cds.ql.SELECT.one.from(TEAMS).where({ ID: id }));
  return row ? nullable(row) : null;
}
export async function getTeamByName(db: DbLike, name: string): Promise<TeamRow | null> {
  const row = await db.run(cds.ql.SELECT.one.from(TEAMS).where({ name }));
  return row ? nullable(row) : null;
}
export async function getTeamsByIds(db: DbLike, ids: Iterable<string>): Promise<Map<string, TeamRow>> {
  const list = [...new Set([...ids].filter(Boolean))];
  if (list.length === 0) return new Map();
  const rows = await db.run(cds.ql.SELECT.from(TEAMS).where({ ID: { in: list } }));
  return new Map(rows.map((r: any) => [r.ID, nullable(r)]));
}

export async function membershipsOf(db: DbLike, email: string): Promise<MembershipRow[]> {
  const rows = await db.run(cds.ql.SELECT.from(MEMBERS).where({ email }).orderBy('createdAt', 'ID'));
  return rows.map(membership);
}
export async function membersOf(db: DbLike, teamId: string): Promise<MembershipRow[]> {
  const rows = await db.run(cds.ql.SELECT.from(MEMBERS).where({ team_ID: teamId }).orderBy('email'));
  return rows.map(membership);
}
export async function membershipOf(db: DbLike, teamId: string, email: string): Promise<MembershipRow | null> {
  const row = await db.run(cds.ql.SELECT.one.from(MEMBERS).where({ team_ID: teamId, email }));
  return row ? membership(row) : null;
}
export async function memberEmails(db: DbLike, teamId: string): Promise<string[]> {
  return (await membersOf(db, teamId)).map((m) => m.email);
}
export async function memberEmailsOfTeams(db: DbLike, teamIds: string[]): Promise<string[]> {
  if (teamIds.length === 0) return [];
  const rows = await db.run(cds.ql.SELECT.from(MEMBERS).columns('email').where({ team_ID: { in: teamIds } }));
  return [...new Set<string>(rows.map((r: any) => r.email as string))].sort();
}

/** A user's teams, oldest membership first, each with its row. */
export async function teamsOf(db: DbLike, email: string): Promise<Array<{ membership: MembershipRow; team: TeamRow }>> {
  const memberships = await membershipsOf(db, email);
  const teams = await getTeamsByIds(db, memberships.map((m) => m.team_ID));
  return memberships.filter((m) => teams.has(m.team_ID)).map((m) => ({ membership: m, team: teams.get(m.team_ID)! }));
}
export async function teamIdsOf(db: DbLike, email: string): Promise<string[]> {
  return (await membershipsOf(db, email)).map((m) => m.team_ID);
}
export async function primaryTeamOf(db: DbLike, email: string): Promise<TeamRow | null> {
  const primary = (await membershipsOf(db, email)).find((m) => m.isPrimary);
  return primary ? getTeam(db, primary.team_ID) : null;
}
export async function isTeamAdmin(db: DbLike, email: string, teamId: string): Promise<boolean> {
  const m = await membershipOf(db, teamId, email);
  return !!m && m.role === 'admin';
}
export async function adminTeamIdsOf(db: DbLike, email: string): Promise<string[]> {
  return (await membershipsOf(db, email)).filter((m) => m.role === 'admin').map((m) => m.team_ID);
}

/** The credential row a team question is about: which table, its owner e-mail and its own team. */
export async function credentialRow(db: DbLike, cred: CredentialRef): Promise<{ table: string; ID: string; email: string; team_ID: string | null } | null> {
  const table = 'apiKeyId' in cred ? KEYS : AWS;
  const ID = 'apiKeyId' in cred ? cred.apiKeyId : cred.awsCredentialId;
  const row = await db.run(cds.ql.SELECT.one.from(table).columns('ID', 'email', 'team_ID').where({ ID }));
  return row ? { table, ID: row.ID, email: row.email, team_ID: row.team_ID ?? null } : null;
}

/** Spec §4: the credential's own team, else the owner's primary team, else null. */
export async function requestTeamFor(db: DbLike, cred: CredentialRef): Promise<TeamRef | null> {
  const row = await credentialRow(db, cred);
  if (!row) return null;
  if (row.team_ID) {
    const own = await getTeam(db, row.team_ID);
    if (own) return { teamId: own.ID, name: own.name };
  }
  if (!row.email) return null;
  const primary = await primaryTeamOf(db, row.email);
  return primary ? { teamId: primary.ID, name: primary.name } : null;
}

/** Spec §4: per field the team's own value ('team'), else its pool profile ('profile'), else unlimited. No platform default for pools. */
export function poolLimits(team: Partial<Record<LimitField, any>> | null, profile: ProfileRow | null): { limits: Limits; limitSource: PoolLimitSource } {
  const limits: any = {}; const limitSource: any = {};
  const own = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
  for (const f of LIMIT_FIELDS) {
    const t = own(team?.[f]); const p = own(profile?.[f]);
    if (t !== null && Number.isFinite(t)) { limits[f] = t; limitSource[f] = 'team'; }
    else if (p !== null && Number.isFinite(p)) { limits[f] = p; limitSource[f] = 'profile'; }
    else { limits[f] = null; limitSource[f] = 'unlimited'; }
  }
  return { limits, limitSource };
}

/** Spec §4: the lowest non-null value per field among the member profiles of the user's teams, with the team's name; null when no team carries one. */
export async function memberProfileLimits(db: DbLike, email: string): Promise<TeamMemberLimits | null> {
  const withProfile = (await teamsOf(db, email)).filter((t) => t.team.memberQuotaProfile_ID);
  if (withProfile.length === 0) return null;
  const profiles = await getProfilesByIds(db, withProfile.map((t) => t.team.memberQuotaProfile_ID as string));
  const limits: Partial<Limits> = {}; const teamByField: Partial<Record<LimitField, string>> = {};
  for (const f of LIMIT_FIELDS) {
    for (const { team } of withProfile) {
      const v = profiles.get(team.memberQuotaProfile_ID as string)?.[f];
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const current = limits[f];
      if (current === undefined || current === null || n < current) { limits[f] = n; teamByField[f] = team.name; }
    }
    if (limits[f] === undefined) limits[f] = null;
  }
  return { limits, teamByField };
}

export async function teamsUsingProfile(db: DbLike, profileId: string): Promise<TeamRow[]> {
  const rows = await db.run(cds.ql.SELECT.from(TEAMS).where({ quotaProfile_ID: profileId }).or({ memberQuotaProfile_ID: profileId }).orderBy('name'));
  return rows.map(nullable);
}
export async function teamsUsingCatalog(db: DbLike, catalogId: string): Promise<TeamRow[]> {
  return (await db.run(cds.ql.SELECT.from(TEAMS).where({ entitlementCatalog_ID: catalogId }).orderBy('name'))).map(nullable);
}
export async function teamsUsingPolicy(db: DbLike, policyId: string): Promise<TeamRow[]> {
  return (await db.run(cds.ql.SELECT.from(TEAMS).where({ toolPolicy_ID: policyId }).orderBy('name'))).map(nullable);
}

export interface TeamBlock { teamId: string; teamName: string; limits: Limits; }
/** The `team` block of a validation response: the pool limits (spec §5). */
export async function wireTeamBlock(db: DbLike, team: TeamRef): Promise<TeamBlock> {
  const row = await getTeam(db, team.teamId);
  const profile = row?.quotaProfile_ID ? (await getProfilesByIds(db, [row.quotaProfile_ID])).get(row.quotaProfile_ID) ?? null : null;
  return { teamId: team.teamId, teamName: row?.name ?? team.name, limits: poolLimits(row, profile).limits };
}

/** e-mail → primary team id for a batch of owners (one query); the oldest primary wins, as in primaryTeamOf. */
export async function primaryTeamIdsFor(db: DbLike, emails: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set([...emails].filter(Boolean))];
  if (list.length === 0) return new Map();
  const rows = await db.run(cds.ql.SELECT.from(MEMBERS).columns('email', 'team_ID').where({ email: { in: list }, isPrimary: true }).orderBy('createdAt', 'ID'));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.email)) out.set(r.email, r.team_ID);
  return out;
}

/** The request team of a page of credentials in two queries: the own team, else the owner's primary (spec §4). */
export async function credentialTeamsFor(db: DbLike, rows: Array<{ ID: string; email: string | null; team_ID: string | null }>): Promise<Map<string, { teamId: string; name: string; followsPrimary: boolean }>> {
  const out = new Map<string, { teamId: string; name: string; followsPrimary: boolean }>();
  const primaries = await primaryTeamIdsFor(db, rows.filter((r) => !r.team_ID && r.email).map((r) => r.email as string));
  const teamOf = (r: { email: string | null; team_ID: string | null }) => r.team_ID ?? (r.email ? primaries.get(r.email) : undefined);
  const teams = await getTeamsByIds(db, rows.map(teamOf).filter((id): id is string => !!id));
  for (const r of rows) {
    const team = teams.get(teamOf(r) ?? '');
    if (team) out.set(r.ID, { teamId: team.ID, name: team.name, followsPrimary: !r.team_ID });
  }
  return out;
}
