/**
 * Tool governance policies (spec 2026-09-16 §4/§5): the default policy, the effective block a
 * validation response carries for a user and for a key, write validation, assignments.
 * Pure data rules; the OData handlers in admin-service-tool-policies.ts map them to HTTP.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
const cds = require('@sap/cds');

const logger = getDefaultLogger();
export const POLICIES = 'sap.llm.gateway.admin.ToolPolicies';
export const ALLOWS = 'sap.llm.gateway.admin.ToolPolicyAllows';
export const DENIES = 'sap.llm.gateway.admin.ToolPolicyDenies';
export const SENSITIVE = 'sap.llm.gateway.admin.ToolPolicySensitive';
export const UNTRUSTED = 'sap.llm.gateway.admin.ToolPolicyUntrusted';
const USERS = 'sap.llm.gateway.admin.Users';
const API_KEYS = 'sap.llm.gateway.admin.ApiKeys';
export const DEFAULT_POLICY_NAME = 'Default';
export const MODES = ['monitor', 'strip', 'reject'] as const;
export type PolicyMode = typeof MODES[number];
/** `namespace:name`, optionally ending in one `*`; the same regex the gateway matcher documents. */
export const PATTERN_SYNTAX = /^(function|hosted|mcp):([^*\s]+\*?|\*)$/;

export interface Policy { ID: string; name: string; description?: string | null; isDefault: boolean; mode: PolicyMode; }
export interface ToolPolicyBlock { policyId: string; policyName: string; mode: PolicyMode; allow: string[]; deny: string[]; sensitive: string[]; untrusted: string[]; }

export async function ensureDefaultPolicy(db: any): Promise<Policy> {
  const { SELECT, INSERT } = cds.ql;
  const rows = await db.run(SELECT.from(POLICIES).where({ isDefault: true }));
  if (rows.length > 0) return rows[0];
  const row = { ID: uuidv4(), name: DEFAULT_POLICY_NAME, description: 'Applies to every user without an assigned policy', isDefault: true, mode: 'monitor' };
  await db.run(INSERT.into(POLICIES).entries([row]));
  logger.info('ToolPolicy', 'Default tool policy created');
  return row as Policy;
}

export async function getPolicy(db: any, id: string): Promise<Policy | null> {
  const rows = await db.run(cds.ql.SELECT.from(POLICIES).where({ ID: id }));
  return rows[0] ?? null;
}

async function patterns(db: any, entity: string, policyId: string): Promise<string[]> {
  const rows = await db.run(cds.ql.SELECT.from(entity).columns('pattern').where({ policy_ID: policyId }).orderBy('pattern'));
  return rows.map((r: any) => r.pattern);
}

export async function blockOf(db: any, policy: Policy): Promise<ToolPolicyBlock> {
  return {
    policyId: policy.ID, policyName: policy.name, mode: policy.mode,
    allow: await patterns(db, ALLOWS, policy.ID), deny: await patterns(db, DENIES, policy.ID),
    sensitive: await patterns(db, SENSITIVE, policy.ID), untrusted: await patterns(db, UNTRUSTED, policy.ID)
  };
}

/** The user's assigned policy, else the default (seeded on first use). */
export async function policyBlockFor(db: any, email: string): Promise<ToolPolicyBlock> {
  const { SELECT } = cds.ql;
  const user = (await db.run(SELECT.from(USERS).columns('toolPolicy_ID').where({ email })))[0];
  const assigned = user?.toolPolicy_ID ? await getPolicy(db, user.toolPolicy_ID) : null;
  return blockOf(db, assigned ?? (await ensureDefaultPolicy(db)));
}

/** The key's own policy, or null when the key names none. */
export async function keyPolicyBlockFor(db: any, keyId: string): Promise<ToolPolicyBlock | null> {
  const key = (await db.run(cds.ql.SELECT.from(API_KEYS).columns('toolPolicy_ID').where({ ID: keyId })))[0];
  if (!key?.toolPolicy_ID) return null;
  const policy = await getPolicy(db, key.toolPolicy_ID);
  return policy ? blockOf(db, policy) : null;
}

const PATTERN_HINT = 'must look like function:name, hosted:type[/name] or mcp:server[/tool], optionally ending in *';

/** Errors for a create or update payload (deep, with allows/denies) against the stored row (null on create). */
export function validatePolicyWrite(data: any, existing: { isDefault: boolean } | null): string[] {
  const errors: string[] = [];
  if (data.name !== undefined && !(typeof data.name === 'string' && data.name.trim().length > 0)) errors.push('name is required');
  if (data.mode !== undefined && !MODES.includes(data.mode)) errors.push('mode must be monitor, strip or reject');
  if (data.isDefault !== undefined && data.isDefault !== (existing?.isDefault ?? false)) errors.push('The default policy is fixed; assign users to another policy instead');
  for (const [list, label] of [[data.allows, 'allow'], [data.denies, 'deny'], [data.sensitive, 'sensitive'], [data.untrusted, 'untrusted source']] as const) {
    for (const e of Array.isArray(list) ? list : []) if (e?.pattern !== undefined && !PATTERN_SYNTAX.test(String(e.pattern))) errors.push(`${label} pattern "${e.pattern}" ${PATTERN_HINT}`);
  }
  return errors;
}

export function assertDeletable(policy: Policy): void {
  if (policy.isDefault) throw new Error('The default policy cannot be deleted');
}

export async function assignUser(db: any, email: string, policyId: string | null): Promise<void> {
  await db.run(cds.ql.UPDATE(USERS).set({ toolPolicy_ID: policyId, modifiedAt: new Date().toISOString() }).where({ email }));
}

export async function assignApiKey(db: any, keyId: string, policyId: string | null): Promise<void> {
  await db.run(cds.ql.UPDATE(API_KEYS).set({ toolPolicy_ID: policyId, modifiedAt: new Date().toISOString() }).where({ ID: keyId }));
}

/** Everyone whose cached validation must be refreshed when this policy changes: assigned users, plus owners of assigned keys. */
export async function affectedEmails(db: any, policyId: string): Promise<string[]> {
  const { SELECT } = cds.ql;
  const users = await db.run(SELECT.from(USERS).columns('email').where({ toolPolicy_ID: policyId }));
  const keys = await db.run(SELECT.from(API_KEYS).columns('email').where({ toolPolicy_ID: policyId }));
  return [...new Set([...users, ...keys].map((r: any) => r.email).filter(Boolean))].sort();
}

/** Deleting a policy sends its users and keys back to the default. */
export async function releaseAssignments(db: any, policyId: string): Promise<void> {
  await db.run(cds.ql.UPDATE(USERS).set({ toolPolicy_ID: null }).where({ toolPolicy_ID: policyId }));
  await db.run(cds.ql.UPDATE(API_KEYS).set({ toolPolicy_ID: null }).where({ toolPolicy_ID: policyId }));
}
