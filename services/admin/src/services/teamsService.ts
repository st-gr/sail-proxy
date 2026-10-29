// services/admin/src/services/teamsService.ts
/**
 * Team writes (spec 2026-10-14 §3 invariants): memberships with the primary flag, credential team
 * binding, deletion guards. Pure data rules; the OData handlers (admin-service-teams.ts) map them
 * to HTTP, audit, invalidate and republish. Call within a request handler (ambient transaction).
 */
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
import { touch, isServiceKeyEmail } from './usersService';
import { validateConstraints } from './quotaLimits';
import {
  TEAMS, MEMBERS, KEYS, AWS, ROLES, DbLike, TeamRole, TeamRow, MembershipRow, CredentialRef,
  getTeam, membershipsOf, membershipOf, memberEmails, credentialRow
} from './teamLookups';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export class TeamError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'TeamError'; }
}

/** Errors for a create or update payload against the stored row (null on create). */
export function validateTeamWrite(data: Record<string, any>, current: TeamRow | null): string[] {
  const errors: string[] = [];
  if (typeof data.name === 'string') data.name = data.name.trim();
  if (current === null && !data.name) errors.push('name is required');
  if (current !== null && 'name' in data && !data.name) errors.push('name is required');
  errors.push(...validateConstraints(data, current));
  return errors;
}

async function requireTeam(db: DbLike, teamId: string): Promise<TeamRow> {
  const team = await getTeam(db, teamId);
  if (!team) throw new TeamError(404, 'team_not_found', `Team ${teamId} not found`);
  return team;
}

export async function addMember(db: DbLike, teamId: string, email: string, role: TeamRole): Promise<MembershipRow> {
  if (!ROLES.includes(role)) throw new TeamError(400, 'bad_role', `role must be one of ${ROLES.join(', ')}`);
  if (!email || isServiceKeyEmail(email)) throw new TeamError(400, 'not_a_user', `${email} is a platform service credential, not a user`);
  await requireTeam(db, teamId);
  if (await membershipOf(db, teamId, email)) throw new TeamError(409, 'already_member', `${email} is already a member of this team`);
  await touch(db, email);
  const first = (await membershipsOf(db, email)).length === 0;
  const now = new Date().toISOString();
  const row = { ID: uuidv4(), team_ID: teamId, email, role, isPrimary: first, createdAt: now, modifiedAt: now };
  await db.run(cds.ql.INSERT.into(MEMBERS).entries(row));
  logger.info('Teams', `${email} joined team ${teamId} as ${role}${first ? ' (primary)' : ''}`);
  return { ...row, createdAt: now };
}

/** Clears the credentials of `email` that name `teamId`; returns how many. The membership is gone, so they follow the primary again. */
export async function clearCredentialTeam(db: DbLike, email: string, teamId: string): Promise<number> {
  let n = 0;
  for (const table of [KEYS, AWS]) {
    const rows = await db.run(cds.ql.SELECT.from(table).columns('ID').where({ email, team_ID: teamId }));
    if (rows.length === 0) continue;
    await db.run(cds.ql.UPDATE(table).set({ team_ID: null }).where({ email, team_ID: teamId }));
    n += rows.length;
  }
  return n;
}

export async function removeMember(db: DbLike, teamId: string, email: string): Promise<{ promotedPrimary: string | null }> {
  const m = await membershipOf(db, teamId, email);
  if (!m) throw new TeamError(404, 'not_member', `${email} is not a member of this team`);
  await db.run(cds.ql.DELETE.from(MEMBERS).where({ ID: m.ID }));
  await clearCredentialTeam(db, email, teamId);
  let promotedPrimary: string | null = null;
  if (m.isPrimary) {
    const rest = await membershipsOf(db, email);
    if (rest.length > 0) {
      await db.run(cds.ql.UPDATE(MEMBERS).set({ isPrimary: true }).where({ ID: rest[0].ID }));
      promotedPrimary = rest[0].team_ID;
    }
  }
  return { promotedPrimary };
}

export async function setMemberRole(db: DbLike, teamId: string, email: string, role: TeamRole): Promise<MembershipRow> {
  if (!ROLES.includes(role)) throw new TeamError(400, 'bad_role', `role must be one of ${ROLES.join(', ')}`);
  const m = await membershipOf(db, teamId, email);
  if (!m) throw new TeamError(404, 'not_member', `${email} is not a member of this team`);
  await db.run(cds.ql.UPDATE(MEMBERS).set({ role, modifiedAt: new Date().toISOString() }).where({ ID: m.ID }));
  return { ...m, role };
}

export async function setPrimary(db: DbLike, teamId: string, email: string): Promise<void> {
  const m = await membershipOf(db, teamId, email);
  if (!m) throw new TeamError(404, 'not_member', `${email} is not a member of this team`);
  await db.run(cds.ql.UPDATE(MEMBERS).set({ isPrimary: false }).where({ email }));
  await db.run(cds.ql.UPDATE(MEMBERS).set({ isPrimary: true }).where({ ID: m.ID }));
}

/** Binds a credential to one of its owner's teams, or clears it (null = follow the primary). */
export async function setCredentialTeam(db: DbLike, cred: CredentialRef, teamId: string | null): Promise<{ email: string }> {
  const row = await credentialRow(db, cred);
  if (!row) throw new TeamError(404, 'credential_not_found', 'credential not found');
  if (teamId) {
    await requireTeam(db, teamId);
    if (!(await membershipOf(db, teamId, row.email))) throw new TeamError(400, 'not_a_member', `${row.email} is not a member of team ${teamId}`);
  }
  await db.run(cds.ql.UPDATE(row.table).set({ team_ID: teamId, modifiedAt: new Date().toISOString() }).where({ ID: row.ID }));
  return { email: row.email };
}

export async function assertDeletable(db: DbLike, team: TeamRow): Promise<void> {
  const members = await memberEmails(db, team.ID);
  if (members.length > 0) throw new TeamError(409, 'has_members', `Team ${team.name} still has ${members.length} member(s): ${members.slice(0, 10).join(', ')}`);
}

/** Deletes an empty team. Defensive: clears any credential still naming it (none should) before the row goes. */
export async function deleteTeam(db: DbLike, teamId: string): Promise<void> {
  const team = await requireTeam(db, teamId);
  await assertDeletable(db, team);
  for (const table of [KEYS, AWS]) await db.run(cds.ql.UPDATE(table).set({ team_ID: null }).where({ team_ID: teamId }));
  await db.run(cds.ql.DELETE.from(TEAMS).where({ ID: teamId }));
}

/** Everyone whose cached validation must be refreshed when this team changes: its members. */
export async function affectedEmails(db: DbLike, teamId: string): Promise<string[]> {
  return memberEmails(db, teamId);
}
