/**
 * Tool policy handlers (spec 2026-09-16 §8), registered on AdminService from admin-service.ts
 * init(). Rules live in services/toolPolicyService.ts; this file maps requests to them, errors
 * to HTTP statuses, and every change to a credential-cache invalidation.
 */
import { getDefaultLogger } from '@libs/logger';
import * as tp from '../services/toolPolicyService';
import { parseInventoryQuery, matchesRow } from '../services/toolInventoryQuery';
import { invalidateForEmails } from '../services/credentialInvalidation';
import { TOOL_USAGE_DAILY, TOOL_USAGE_AGENT_DAILY } from '../services/toolUsageService';
const cds = require('@sap/cds');

const logger = getDefaultLogger();
const POLICIES = 'AdminService.ToolPolicies';
const USERS = 'sap.llm.gateway.admin.Users';
const API_KEYS = 'sap.llm.gateway.admin.ApiKeys';

function isAdmin(req: any): boolean { return typeof req.user?.is === 'function' && req.user.is('admin'); }

/**
 * An untyped aggregate timestamp as an ISO string in UTC. SQLite returns the stored ISO text, while
 * PostgreSQL returns a zone-less value ('2026-09-17T16:08:48' or '2026-09-17 16:08:48.123') that a
 * browser would read as local time. CAP stores timestamps in UTC, so a value without an offset is UTC.
 */
export function asUtcIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim().replace(' ', 'T');
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? String(value) : new Date(ms).toISOString();
}

export function registerToolPolicyHandlers(service: any): void {
  service.before('READ', ['ToolPolicies', 'ToolPolicyAllows', 'ToolPolicyDenies', 'ToolPolicySensitive', 'ToolPolicyUntrusted', 'ToolUsageDaily', 'ToolInventory', 'ToolIdentities', 'ToolAgents'], (req: any) => {
    if (!isAdmin(req)) req.reject(403, 'Administrators only');
  });

  service.on('READ', 'ToolPolicyModes', () => [
    { code: 'monitor', text: 'Monitor (record only)' },
    { code: 'strip', text: 'Strip (remove tools)' },
    { code: 'reject', text: 'Reject (refuse request)' }
  ]);

  // The inventory's facet filter has exactly two values, so it is a fixed-value list: without one,
  // Fiori Elements offers the generic conditions dialog and the administrator has to type 'declared'.
  service.on('READ', 'ToolFacets', () => [
    { code: 'declared', text: 'Declared (offered in the request)' },
    { code: 'invoked', text: 'Invoked (called by the model)' },
    { code: 'source', text: 'Source (its output was in the request)' }
  ]);

  // Value help behind the inventory's Requested By filter: the client programs that have been seen.
  service.on('READ', 'ToolAgents', async (req: any) => {
    const { filter } = parseInventoryQuery(req.query.SELECT?.where, req.query.SELECT?.search);
    const rows = await cds.run(cds.ql.SELECT.from(TOOL_USAGE_AGENT_DAILY)
      .columns('agent', 'count(distinct identity) as tools', 'sum(requests) as requests', 'max(lastSeen) as lastSeen')
      .groupBy('agent').orderBy('agent'));
    return rows
      .filter((r: any) => matchesRow(filter, { identity: '', facet: '', agents: [r.agent] }))
      .map((r: any) => ({ agent: r.agent, tools: Number(r.tools), requests: Number(r.requests), lastSeen: asUtcIso(r.lastSeen) }));   // `agents` predicates match the single agent
  });

  // assignedUsers virtual: one count query per page
  service.after('READ', 'ToolPolicies', async (rows: any, req: any) => {
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const ids = list.map((r) => r.ID).filter(Boolean);
    if (ids.length === 0) return;
    const counts = await cds.run(cds.ql.SELECT.from(USERS).columns('toolPolicy_ID', 'count(*) as n').where({ toolPolicy_ID: { in: ids } }).groupBy('toolPolicy_ID'));
    const by = new Map(counts.map((c: any) => [c.toolPolicy_ID, Number(c.n)]));
    for (const r of list) r.assignedUsers = by.get(r.ID) ?? 0;
  });

  // Writes reach the active entity on draft activation as CREATE / UPDATE with the deep payload.
  service.before(['CREATE', 'UPDATE'], 'ToolPolicies', async (req: any) => {
    if (!isAdmin(req)) { req.reject(403, 'Administrators only'); return; }
    const existing = req.event === 'UPDATE' && req.data.ID ? await tp.getPolicy(cds.db, req.data.ID) : null;
    const errors = tp.validatePolicyWrite(req.data, existing);
    if (errors.length) req.reject(400, errors.join('; '));
  });
  service.after(['CREATE', 'UPDATE'], 'ToolPolicies', async (row: any) => {
    if (!row?.ID) return;
    const emails = await tp.affectedEmails(cds.db, row.ID);
    const def = await tp.getPolicy(cds.db, row.ID);
    await invalidateForEmails(cds.db, def?.isDefault ? 'everyone' : emails, 'tool-policy');
  });

  // The two child sets have to stay writable for the Fiori list's inline creation (it POSTs onto
  // the DRAFT root's navigation, which lean-draft refuses with 405 once the active entity is
  // @readonly), so they carry the root's rules themselves instead: the same validatePolicyWrite
  // syntax check on the pattern, and the owning policy's credential-cache invalidation. Over
  // HTTP these never fire — a write addressed at a draft-enabled entity becomes a NEW/PATCH on
  // its draft and the runtime refuses it ("A draft-enabled entity can only be modified via its
  // root entity") — they guard a programmatic service-level write (srv.create/update/delete).
  for (const [entity, list] of [['ToolPolicyAllows', 'allows'], ['ToolPolicyDenies', 'denies'], ['ToolPolicySensitive', 'sensitive'], ['ToolPolicyUntrusted', 'untrusted']] as const) {
    service.before(['CREATE', 'UPDATE', 'DELETE'], entity, (req: any) => {
      if (!isAdmin(req)) { req.reject(403, 'Administrators only'); return; }
      if (req.event === 'DELETE' || req.data?.pattern === undefined) return;
      const errors = tp.validatePolicyWrite({ [list]: [{ pattern: req.data.pattern }] }, null);
      if (errors.length) req.reject(400, errors.join('; '));
    });
    service.after(['CREATE', 'UPDATE', 'DELETE'], entity, async (_: any, req: any) => {
      const policyId = req.data?.policy_ID;
      if (!policyId) return;
      const emails = await tp.affectedEmails(cds.db, policyId);
      if (emails.length) await invalidateForEmails(cds.db, emails, 'tool-policy');
    });
  }

  // Draft activation writes the deep payload (allows/denies included) against the service
  // projection; @cap-js/sqlite refuses a plain INSERT/UPDATE against that view ("cannot modify
  // ... because it is a view"), the same quirk the ApiKeys/AwsCredentials/SapCapacityUnitPrice
  // writers in admin-service.ts work around. Redirect to the base tables here too.
  async function replaceEntries(tx: any, table: string, policyId: string, rows: any[]): Promise<void> {
    await tx.run(cds.ql.DELETE.from(table).where({ policy_ID: policyId }));
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return;
    await tx.run(cds.ql.INSERT.into(table).entries(list.map((r: any) => ({ ID: r.ID ?? cds.utils.uuid(), policy_ID: policyId, pattern: r.pattern, note: r.note ?? null }))));
  }
  service.on('CREATE', 'ToolPolicies', async (req: any) => {
    const tx = cds.transaction(req);
    const { allows, denies, sensitive, untrusted, ...rest } = req.data ?? {};
    rest.ID ??= cds.utils.uuid();
    const now = new Date().toISOString();
    const user = req.user?.id || 'system';
    rest.createdAt = now; rest.createdBy = user; rest.modifiedAt = now; rest.modifiedBy = user;
    await tx.run(cds.ql.INSERT.into(tp.POLICIES).entries(rest));
    await replaceEntries(tx, tp.ALLOWS, rest.ID, allows);
    await replaceEntries(tx, tp.DENIES, rest.ID, denies);
    await replaceEntries(tx, tp.SENSITIVE, rest.ID, sensitive);
    await replaceEntries(tx, tp.UNTRUSTED, rest.ID, untrusted);
    return tx.run(cds.ql.SELECT.one.from(POLICIES).where({ ID: rest.ID }));
  });
  service.on('UPDATE', 'ToolPolicies', async (req: any) => {
    const tx = cds.transaction(req);
    const { ID, allows, denies, sensitive, untrusted, ...rest } = req.data ?? {};
    if (!ID) { req.reject(400, 'ID is required for UPDATE'); return; }
    delete (rest as any).createdAt; delete (rest as any).createdBy;
    rest.modifiedAt = new Date().toISOString(); rest.modifiedBy = req.user?.id || 'system';
    if (Object.keys(rest).length) await tx.run(cds.ql.UPDATE(tp.POLICIES).set(rest).where({ ID }));
    if (allows !== undefined) await replaceEntries(tx, tp.ALLOWS, ID, allows);
    if (denies !== undefined) await replaceEntries(tx, tp.DENIES, ID, denies);
    if (sensitive !== undefined) await replaceEntries(tx, tp.SENSITIVE, ID, sensitive);
    if (untrusted !== undefined) await replaceEntries(tx, tp.UNTRUSTED, ID, untrusted);
    return tx.run(cds.ql.SELECT.one.from(POLICIES).where({ ID }));
  });

  service.before('DELETE', 'ToolPolicies', async (req: any) => {
    if (!isAdmin(req)) { req.reject(403, 'Administrators only'); return; }
    const policy = await tp.getPolicy(cds.db, req.data.ID);
    if (!policy) return;
    try { tp.assertDeletable(policy); } catch (e: any) { req.reject(400, e.message); return; }
    (req as any)._affected = await tp.affectedEmails(cds.db, policy.ID);
    await tp.releaseAssignments(cds.db, policy.ID);
  });
  service.after('DELETE', 'ToolPolicies', async (_: any, req: any) => {
    const emails: string[] = (req as any)._affected ?? [];
    if (emails.length) await invalidateForEmails(cds.db, emails, 'tool-policy');
  });

  async function requirePolicy(req: any, id: string | null): Promise<boolean> {
    if (id === null || id === undefined) return true;
    if (!(await tp.getPolicy(cds.db, id))) { req.reject(404, `Tool policy ${id} not found`); return false; }
    return true;
  }
  async function setUserPolicy(req: any, email: string, policyId: string | null): Promise<any> {
    const user = (await cds.run(cds.ql.SELECT.from(USERS).where({ email })))[0];
    if (!user) { req.reject(404, `User ${email} not found`); return; }
    if (!(await requirePolicy(req, policyId))) return;
    await tp.assignUser(cds.db, email, policyId);
    await invalidateForEmails(cds.db, [email], 'tool-policy');
    logger.info('ToolPolicy', `${email} -> ${policyId ?? 'default'}`);
    return (await cds.run(cds.ql.SELECT.from(USERS).where({ email })))[0];
  }
  async function setKeyPolicy(req: any, keyId: string, policyId: string | null): Promise<any> {
    const key = (await cds.run(cds.ql.SELECT.from(API_KEYS).where({ ID: keyId })))[0];
    if (!key) { req.reject(404, `API key ${keyId} not found`); return; }
    if (!(await requirePolicy(req, policyId))) return;
    await tp.assignApiKey(cds.db, keyId, policyId);
    await invalidateForEmails(cds.db, [key.email], 'tool-policy');
    return (await cds.run(cds.ql.SELECT.from(API_KEYS).where({ ID: keyId })))[0];
  }

  service.on('assignToolPolicy', (req: any) => setUserPolicy(req, req.data.email, req.data.policyId));
  service.on('unassignToolPolicy', (req: any) => setUserPolicy(req, req.data.email, null));
  service.on('setApiKeyToolPolicy', (req: any) => setKeyPolicy(req, req.data.keyId, req.data.policyId ?? null));
  const boundId = (req: any) => req.params?.[0]?.ID ?? req.params?.[0];
  service.on('assignUser', POLICIES, async (req: any) => { await setUserPolicy(req, req.data.email, boundId(req)); return tp.getPolicy(cds.db, boundId(req)); });
  service.on('unassignUser', POLICIES, async (req: any) => { await setUserPolicy(req, req.data.email, null); return tp.getPolicy(cds.db, boundId(req)); });
  service.on('assignApiKey', POLICIES, async (req: any) => { await setKeyPolicy(req, req.data.keyId, boundId(req)); return tp.getPolicy(cds.db, boundId(req)); });
  service.on('unassignApiKey', POLICIES, async (req: any) => { await setKeyPolicy(req, req.data.keyId, null); return tp.getPolicy(cds.db, boundId(req)); });

  // Value help behind a policy's allow/deny pattern and the inventory's Tool filter: every tool
  // identity that was ever recorded, narrowed by whatever the field has been typed into so far.
  // A value help applies the filters it understands and ignores the rest: an extra suggestion is
  // harmless, while a 400 would break the dropdown the administrator is typing in.
  service.on('READ', 'ToolIdentities', async (req: any) => {
    const { filter } = parseInventoryQuery(req.query.SELECT?.where, req.query.SELECT?.search);
    const rows = await cds.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY)
      .columns('identity', 'count(distinct email) as users', 'sum(requests) as requests', 'max(lastSeen) as lastSeen')
      .groupBy('identity').orderBy('identity'));
    return rows
      .filter((r: any) => matchesRow(filter, { identity: r.identity, facet: '', agents: [] }))
      .map((r: any) => ({ identity: r.identity, users: Number(r.users), requests: Number(r.requests), lastSeen: asUtcIso(r.lastSeen) }));
  });

  // Inventory: group the daily aggregates over the requested day range (default: the last 30 days).
  service.on('READ', 'ToolInventory', async (req: any) => {
    const { filter, errors } = parseInventoryQuery(req.query.SELECT?.where, req.query.SELECT?.search);
    if (errors.length > 0) { req.reject(400, errors.join('; ')); return; }
    const { dayFrom, dayTo } = filter;
    const to = dayTo ?? new Date().toISOString().slice(0, 10);
    const from = dayFrom ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await cds.run(cds.ql.SELECT.from(TOOL_USAGE_DAILY)
      .columns('identity', 'facet', 'count(distinct email) as users', 'sum(requests) as requests', 'sum(allowed) as allowed', 'sum(monitored) as monitored',
        'sum(stripped) as stripped', 'sum(rejected) as rejected', 'sum(unlisted) as unlisted', 'sum(detected) as detected', 'sum(trustChained) as trustChained', 'max(lastSeen) as lastSeen')
      .where({ day: { '>=': from } }).and({ day: { '<=': to } }).groupBy('identity', 'facet'));
    // Which client programs asked for each tool in the same range (ToolUsageAgentDaily, one row per agent).
    const agentRows = await cds.run(cds.ql.SELECT.from(TOOL_USAGE_AGENT_DAILY).columns('identity', 'facet', 'agent')
      .where({ day: { '>=': from } }).and({ day: { '<=': to } }).groupBy('identity', 'facet', 'agent').orderBy('agent'));
    const agentsOf = new Map<string, string[]>();
    for (const a of agentRows) {
      const key = `${a.identity}|${a.facet}`;
      const list = agentsOf.get(key) ?? [];
      if (!list.includes(a.agent)) list.push(a.agent);
      agentsOf.set(key, list);
    }
    // Tool, facet, client program and the search term are matched here (the set is small: one row
    // per distinct tool and facet), then $orderby and $top/$skip are applied to what survives.
    let out = rows.map((r: any) => {
      const agents = (agentsOf.get(`${r.identity}|${r.facet}`) ?? []).sort();
      return { ...r, users: Number(r.users), requests: Number(r.requests), allowed: Number(r.allowed), monitored: Number(r.monitored),
        stripped: Number(r.stripped), rejected: Number(r.rejected), unlisted: Number(r.unlisted), detected: Number(r.detected), trustChained: Number(r.trustChained), lastSeen: asUtcIso(r.lastSeen),
        agentList: agents, agents: agents.join(', ') || null, day: to };
    }).filter((r: any) => matchesRow(filter, { identity: r.identity, facet: r.facet, agents: r.agentList }))
      .map(({ agentList, ...r }: any) => r);
    const orderBy = req.query.SELECT?.orderBy?.[0];
    if (orderBy?.ref?.[0]) { const k = orderBy.ref[0]; const dir = orderBy.sort === 'desc' ? -1 : 1; out.sort((a: any, b: any) => (a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0)); }
    const total = out.length;
    const skip = Number(req.query.SELECT?.limit?.offset?.val ?? 0);
    const top = Number(req.query.SELECT?.limit?.rows?.val ?? total);
    const page: any = out.slice(skip, skip + top);
    page.$count = total;
    return page;
  });
}
