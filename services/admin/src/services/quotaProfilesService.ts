/**
 * Quota profiles: a named set of the seven limits an administrator assigns per user (spec
 * 2026-09-08). A profile sits between the user's own values and the platform defaults in
 * effectiveLimits (user > profile > platform > unlimited); a null field says nothing, so the
 * platform default still applies. Reads only here — the three starters are seeded once, at
 * startup, into an empty table.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
import { LimitField } from './quotaLimits';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

export const PROFILES = 'sap.llm.gateway.admin.QuotaProfiles';
// Mirrors usersService.USERS: usersService reads a profile for the wire block, so importing it
// back here would make the two modules a require cycle.
const USERS = 'sap.llm.gateway.admin.Users';
export type ProfileRow = { ID: string; name: string; description: string | null } & Record<LimitField, number | null>;
type DbLike = { run(q: any): Promise<any> };

/** Starting points derived from a real deployment's usage (spec §1); fresh tokens, spend in the billing currency. */
export const STARTER_PROFILES: ReadonlyArray<Omit<ProfileRow, 'ID'>> = [
  { name: 'Light', description: 'Occasional use — chat and short tasks', requestsPerMinute: 30, tokensPerDay: 500000, tokensPerWeek: 2000000, tokensPerMonth: 5000000, spendPerDay: 25, spendPerWeek: 75, spendPerMonth: 150 },
  { name: 'Standard', description: 'Daily use — assistants and coding agents', requestsPerMinute: 60, tokensPerDay: 5000000, tokensPerWeek: 20000000, tokensPerMonth: 60000000, spendPerDay: 250, spendPerWeek: 1000, spendPerMonth: 3000 },
  { name: 'Power', description: 'Heavy use — agents with large contexts and batch jobs', requestsPerMinute: 200, tokensPerDay: 25000000, tokensPerWeek: 100000000, tokensPerMonth: 300000000, spendPerDay: 1500, spendPerWeek: 6000, spendPerMonth: 12000 }
];

/** Seed the starters into an EMPTY table; returns the rows inserted (0 when any profile exists). */
export async function ensureStarterProfiles(db: DbLike): Promise<number> {
  const { SELECT, INSERT } = cds.ql;
  const [{ n }] = await db.run(SELECT.from(PROFILES).columns('count(*) as n'));
  if (Number(n) > 0) return 0;
  await db.run(INSERT.into(PROFILES).entries(STARTER_PROFILES.map((p) => ({ ID: uuidv4(), ...p }))));
  logger.info('QuotaProfiles', `Seeded ${STARTER_PROFILES.length} starter profiles`);
  return STARTER_PROFILES.length;
}

export async function getProfile(db: DbLike, id: string): Promise<ProfileRow | null> {
  const rows = await db.run(cds.ql.SELECT.from(PROFILES).where({ ID: id }));
  return rows[0] ?? null;
}

export async function getProfilesByIds(db: DbLike, ids: Iterable<string>): Promise<Map<string, ProfileRow>> {
  const list = [...new Set([...ids].filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await db.run(cds.ql.SELECT.from(PROFILES).where({ ID: { in: list } }));
  return new Map(rows.map((r: ProfileRow) => [r.ID, r]));
}

/** The e-mails of the users assigned to one profile, in e-mail order. */
export async function assignedEmails(db: DbLike, profileId: string): Promise<string[]> {
  const rows = await db.run(cds.ql.SELECT.from(USERS).columns('email').where({ quotaProfile_ID: profileId }).orderBy('email'));
  return rows.map((r: any) => r.email);
}
