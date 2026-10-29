// services/admin/src/srv/admin-service-teams.ts
/**
 * Teams handlers (spec 2026-10-14 §7), registered on AdminService from admin-service.ts init().
 * Rules live in teamLookups / teamsService / teamQuotaService; this file maps requests to them,
 * errors to HTTP statuses, and every change to audit + cache invalidation + republish (spec §5
 * matrix). Platform admins edit through the draft; team admins run the member actions; every
 * action re-checks the caller's role for that team. Reads and writes join the request's own
 * transaction through cds.run (never cds.tx(fn) in here: single SQLite connection).
 */
import { getDefaultLogger } from '@libs/logger';
import * as lookups from '../services/teamLookups';
import * as teams from '../services/teamsService';
import * as tq from '../services/teamQuotaService';
import * as quota from '../services/userQuotaService';
import { getProfilesByIds } from '../services/quotaProfilesService';
import { LIMIT_FIELDS, LimitField } from '../services/quotaLimits';
import { criticality } from '../services/quotaCriticality';
import { invalidateForEmails } from '../services/credentialInvalidation';
import { recordAuditEvent, AuditEventInput } from '../services/auditEventService';
import { clientContext } from '../utils/clientIp';
import { isAdminRole, getCatalog } from '../services/modelEntitlementService';
import { callGateway } from '../services/groundingGatewayClient';
import { getUser, USERS, isServiceKeyEmail } from '../services/usersService';
import { wantsIeee754 } from './admin-service-users';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const TEAMS = 'AdminService.Teams';
const DRAFT_TEAMS = 'AdminService.Teams.drafts';
const DRAFT_MEMBERS = 'AdminService.TeamMembers.drafts';
const WINDOWS = ['Day', 'Week', 'Month'] as const;
const LIMIT_SET = new Set<string>(LIMIT_FIELDS);
const ASSOCIATIONS = ['quotaProfile_ID', 'memberQuotaProfile_ID', 'entitlementCatalog_ID', 'toolPolicy_ID'] as const;
const EDITABLE = new Set<string>([...LIMIT_FIELDS, ...ASSOCIATIONS, 'name', 'description']);
const DRAFT_META = new Set(['ID', 'IsActiveEntity', 'HasActiveEntity', 'HasDraftEntity', 'DraftAdministrativeData_DraftUUID', 'DraftAdministrativeData', 'modifiedAt', 'modifiedBy', 'createdAt', 'createdBy', 'quotaResetAt']);
const VIRTUAL_FIELDS = new Set<string>([
  'canEdit', 'canManageMembers', 'canResetQuota', 'quotaProfileName', 'memberQuotaProfileName', 'sapCostCurrency', 'usedRequestsMinute', 'resetsAtDay', 'resetsAtWeek', 'resetsAtMonth', 'memberCount',
  ...WINDOWS.flatMap((w) => [`usedSpend${w}`, `usedTokens${w}`, `effectiveSpendPer${w}Currency`, `criticalitySpend${w}`, `criticalityTokens${w}`]),
  ...LIMIT_FIELDS.flatMap((f) => { const F = f[0].toUpperCase() + f.slice(1); return [`effective${F}`, `limitSource${F}`, `${f}DefaultText`]; })
]);

const roles = (req: any): string[] => { const r = req.user?.roles || req.user?.scope || []; return Array.isArray(r) ? r : Object.keys(r); };
const isAdmin = (req: any): boolean => isAdminRole(roles(req));
const actor = (req: any): string => req.user?.id || 'anonymous';
const keyId = (req: any): string => { const p = req.params?.[0]; return typeof p === 'object' && p !== null ? p.ID : p; };
const audit = (req: any, action: string, resourceId: string, details?: any): AuditEventInput => ({
  actorId: actor(req), actorType: isAdmin(req) ? 'admin_user' : 'user', action, resourceType: 'Team', resourceId,
  outcome: 'success', severity: 'medium', ...clientContext(req), ...(details ? { details: JSON.stringify(details) } : {})
});

/** TeamError codes that have a translated refusal in _i18n/messages*.properties ({0} = the member's e-mail). */
const TEAM_MESSAGES: Record<string, string> = { already_member: 'TEAM_ALREADY_MEMBER', not_member: 'TEAM_NOT_A_MEMBER', not_a_member: 'TEAM_CREDENTIAL_NOT_MEMBER' };
function fail(req: any, e: any): void {
  if (e instanceof teams.TeamError) {
    const key = TEAM_MESSAGES[e.code];
    req.reject(key ? { status: e.status, code: key, message: key, args: [req.data?.email ?? ''] } : { status: e.status, code: e.code, message: e.message });
    return;
  }
  logger.error('Teams', 'team operation failed', e instanceof Error ? e : new Error(String(e)));
  req.reject(500, 'TEAM_OPERATION_FAILED');
}

/**
 * What a team admin's query may look like (Rulings R8/R8b), deny by default. CAP 8.9.7 does not apply
 * @restrict to anything reached through a navigation - an $expand, a path in $select/$filter/$orderby
 * (`quotaProfile/tokensPerDay`), a lambda (`user/memberships/any(...)`, an `exists` in CQN) or an
 * $apply aggregate - so without this a team admin reads or probes QuotaProfiles, ToolPolicies,
 * ModelCatalogs, Users and other teams through Teams and TeamMembers. Allowed: the entity's own flat
 * columns in $select/$filter/$orderby (functions over them too, e.g. contains), $count, $top/$skip,
 * $search over the entity's own rows, and the expands below, each naming its columns explicitly.
 * Refused: any path or lambda; any aggregate column, groupby or having, and so every $apply
 * transformation that introduces one (a plain $apply=filter/top/search over the entity's own flat
 * columns lands in where/limit/search and is judged like $filter); '*' or an implicit column list in
 * an expand; inside an expand, a $filter/$orderby on any column outside its whitelist (a filter on a
 * to-one expand is an oracle on the target's hidden columns) and any $search/groupby/having; any
 * other column or navigation. The draft flags are allowed on every expand target: lean draft
 * itself adds IsActiveEntity to an expand of a draft-enabled entity (Users), and they carry no data.
 * The standard Fiori Elements draft list needs two more forms on Teams (Ruling R8c): the exact path
 * SiblingEntity/IsActiveEntity, and an expand of DraftAdministrativeData with any of its own columns
 * (draft metadata, no business data); any other SiblingEntity path stays refused.
 */
const DRAFT_FLAGS = ['IsActiveEntity', 'HasActiveEntity', 'HasDraftEntity'];
const NAMES = ['ID', 'name'];
const MEMBER_COLUMNS = ['ID', 'team_ID', 'email', 'role', 'isPrimary', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'];
const USER_COLUMNS = ['email', 'displayName', 'status', 'lastSeenAt'];
const EXPANDABLE: Record<string, Record<string, { columns: string[]; into: string | null }>> = {
  Teams: {
    quotaProfile: { columns: NAMES, into: null }, memberQuotaProfile: { columns: NAMES, into: null },
    toolPolicy: { columns: NAMES, into: null }, entitlementCatalog: { columns: NAMES, into: null },
    members: { columns: MEMBER_COLUMNS, into: 'TeamMembers' }
  },
  TeamMembers: { user: { columns: USER_COLUMNS, into: null } }
};
/** A one-segment ref to a plain element name (no path, no infix filter). */
const flatRef = (x: any): boolean => Array.isArray(x?.ref) && x.ref.length === 1 && typeof x.ref[0] === 'string';
/**
 * The draft paths the Fiori draft list needs on Teams (Ruling R8c): the sibling's draft flag, and a
 * column of the draft's administrative data - lean draft itself scopes its drafts query with
 * `DraftAdministrativeData/InProcessByUser = <caller>`, and that query passes through this check too.
 */
const siblingFlag = (x: any, entity: string | null): boolean =>
  entity === 'Teams' && Array.isArray(x?.ref) && x.ref.length === 2 && typeof x.ref[1] === 'string' &&
  ((x.ref[0] === 'SiblingEntity' && x.ref[1] === 'IsActiveEntity') || x.ref[0] === 'DraftAdministrativeData');
/** A where/orderBy/function-argument expression: values, flat refs, operators, functions and lists over those. */
function expressionAllowed(x: any, entity: string | null = null): boolean {
  if (x === undefined || x === null) return true;
  if (Array.isArray(x)) return x.every((y) => expressionAllowed(y, entity));
  if (typeof x === 'string') return x.toLowerCase() !== 'exists';
  if (typeof x !== 'object') return true;
  if ('ref' in x) return flatRef(x) || siblingFlag(x, entity);
  if ('val' in x) return true;
  if ('list' in x) return expressionAllowed(x.list, entity);
  if ('xpr' in x) return expressionAllowed(x.xpr, entity);
  if ('func' in x) return expressionAllowed(x.args, entity);
  return false;   // SELECT sub-queries and anything unknown
}
/** An expand of the draft's administrative data (Ruling R8c): its own columns only, including the
 *  InProcessByUser case expression lean draft rewrites the column into; no nested navigation. */
function draftAdminExpandAllowed(c: any): boolean {
  if (c.expand.length === 0 || !expressionAllowed(c.where) || !expressionAllowed(c.orderBy)) return false;
  return c.expand.every((e: any) => e !== '*' && !Array.isArray(e?.expand) && (flatRef(e) || ((('xpr' in (e || {})) || ('func' in (e || {}))) && expressionAllowed(e))));
}
/** The `count(1) as $count` CAP builds for /$count; any other aggregate comes from $apply. */
const isDollarCount = (c: any): boolean => c?.func === 'count' && c.as === '$count' && Array.isArray(c.args) && c.args.length === 1 && c.args[0]?.val === 1;
/** Every ref in an expression is one of `columns` (or a draft flag): what an expand's $filter/$orderby may name. */
function refsWithin(x: any, columns: string[]): boolean {
  if (Array.isArray(x)) return x.every((y) => refsWithin(y, columns));
  if (!x || typeof x !== 'object') return true;
  if ('ref' in x) return flatRef(x) && (columns.includes(x.ref[0]) || DRAFT_FLAGS.includes(x.ref[0]));
  return refsWithin(x.list, columns) && refsWithin(x.xpr, columns) && refsWithin(x.args, columns);
}
function expandAllowed(c: any, entity: string | null): boolean {
  if (entity === 'Teams' && flatRef(c) && c.ref[0] === 'DraftAdministrativeData') return draftAdminExpandAllowed(c);
  const rule = entity && flatRef(c) ? EXPANDABLE[entity]?.[c.ref[0]] : undefined;
  if (!rule || c.expand.length === 0) return false;
  if (c.search || c.groupBy?.length || c.having?.length) return false;
  if (!expressionAllowed(c.where) || !expressionAllowed(c.orderBy)) return false;
  if (!refsWithin(c.where, rule.columns) || !refsWithin(c.orderBy, rule.columns)) return false;
  for (const e of c.expand) {
    if (!flatRef(e)) return false;
    if (Array.isArray(e.expand)) { if (!expandAllowed(e, rule.into)) return false; continue; }
    if (!rule.columns.includes(e.ref[0]) && !DRAFT_FLAGS.includes(e.ref[0])) return false;
  }
  return true;
}
function queryAllowed(SELECT: any, entity: string): boolean {
  if (!SELECT) return true;
  if (SELECT.groupBy?.length || SELECT.having?.length) return false;
  if (SELECT.from && !Array.isArray(SELECT.from.ref)) return false;   // sub-query or join from a transformation
  for (const c of SELECT.columns || []) {
    if (c === '*') continue;
    if (Array.isArray(c?.expand)) { if (!expandAllowed(c, entity)) return false; continue; }
    if (flatRef(c) || siblingFlag(c, entity) || isDollarCount(c)) continue;
    return false;
  }
  return expressionAllowed(SELECT.where, entity) && expressionAllowed(SELECT.orderBy, entity);
}
/** The query lean draft stashed before cleansing (see realQuery() in admin-service-users.ts); the query itself otherwise. */
function originalQuery(query: any): any {
  const sym = Object.getOwnPropertySymbols(query || {}).find((s) => s.description === 'original');
  return (sym && query[sym]) || query;
}

/** Platform admin, or (level 'members') an admin of that team. Rejects 403 otherwise; returns whether to go on. */
export async function requireTeamAccess(req: any, teamId: string, level: 'edit' | 'members'): Promise<boolean> {
  if (isAdmin(req)) return true;
  if (level === 'members' && await lookups.isTeamAdmin(cds, actor(req), teamId)) return true;
  req.reject({ status: 403, code: 'TEAM_FORBIDDEN', message: 'TEAM_FORBIDDEN' });
  return false;
}

/** "25.00 USD (Light profile)" or "unlimited": what the pool uses while the team's own field is empty. */
function poolDefaultText(f: LimitField, profileName: string | null, profile: any, currency: string): string {
  const v = profile?.[f];
  if (v === null || v === undefined || v === '') return 'unlimited';
  const n = Number(v);
  const figure = f.startsWith('spend') ? `${n.toFixed(2)} ${currency}` : n.toLocaleString('en-US');
  return `${figure} (${profileName} profile)`;
}

function applyStatusVirtuals(row: any, s: tq.TeamQuotaStatus, profile: any): void {
  Object.assign(row, { usedRequestsMinute: s.used.minuteRequests, sapCostCurrency: s.sapCostCurrency, quotaProfileName: s.quotaProfileName, resetsAtDay: s.resetsAt.day, resetsAtWeek: s.resetsAt.week, resetsAtMonth: s.resetsAt.month });
  for (const w of WINDOWS) {
    const lw = w.toLowerCase() as 'day' | 'week' | 'month';
    row[`usedSpend${w}`] = s.used[lw].sapCost; row[`usedTokens${w}`] = s.used[lw].tokens;
  }
  for (const f of LIMIT_FIELDS) {
    const F = f[0].toUpperCase() + f.slice(1);
    row[`effective${F}`] = s.limits[f]; row[`limitSource${F}`] = s.limitSource[f];
    row[`${f}DefaultText`] = poolDefaultText(f, s.quotaProfileName, profile, s.sapCostCurrency);
  }
  for (const w of WINDOWS) {
    row[`effectiveSpendPer${w}Currency`] = row[`effectiveSpendPer${w}`] == null ? null : s.sapCostCurrency;
    row[`criticalitySpend${w}`] = criticality(row[`usedSpend${w}`], row[`effectiveSpendPer${w}`]);
    row[`criticalityTokens${w}`] = criticality(row[`usedTokens${w}`], row[`effectiveTokensPer${w}`]);
  }
}
function stringifyInt64Virtuals(row: any): void {
  for (const w of WINDOWS) for (const k of [`usedTokens${w}`, `effectiveTokensPer${w}`]) if (row[k] !== null && row[k] !== undefined) row[k] = String(row[k]);
}

/** Fills the virtuals of a page of Teams rows: one status fan-out, one profile read, one member count. */
async function fillVirtuals(rows: any[], req: any): Promise<void> {
  const list = rows.filter((r) => r?.ID);
  if (list.length === 0) return;
  const ids = list.map((r) => r.ID);
  const statuses = await tq.teamStatusMany(cds, ids, undefined, list);
  const profiles = await getProfilesByIds(cds, list.flatMap((r) => [r.quotaProfile_ID, r.memberQuotaProfile_ID]).filter(Boolean));
  const counts: any[] = await cds.run(cds.ql.SELECT.from(lookups.MEMBERS).columns('team_ID', 'count(*) as n').where({ team_ID: { in: ids } }).groupBy('team_ID'));
  const countById = new Map<string, number>(counts.map((c) => [c.team_ID, Number(c.n) || 0]));
  const admin = isAdmin(req);
  const adminTeams = admin ? null : new Set(await lookups.adminTeamIdsOf(cds, actor(req)));
  const ieee754 = wantsIeee754(req);
  // Reset Quota needs a saved team: a draft that was never activated has no row in the active table.
  const saved = admin ? new Set<string>((await cds.run(cds.ql.SELECT.from(TEAMS).columns('ID').where({ ID: { in: ids } }))).map((r: any) => r.ID)) : new Set<string>();
  for (const row of list) {
    row.memberCount = countById.get(row.ID) ?? 0;
    row.canEdit = admin;
    row.canManageMembers = admin || !!adminTeams?.has(row.ID);
    row.canResetQuota = admin && saved.has(row.ID);
    row.memberQuotaProfileName = row.memberQuotaProfile_ID ? profiles.get(row.memberQuotaProfile_ID)?.name ?? null : null;
    const s = statuses.get(row.ID);
    if (s) applyStatusVirtuals(row, s, row.quotaProfile_ID ? profiles.get(row.quotaProfile_ID) : null);
    if (s && ieee754) stringifyInt64Virtuals(row);
  }
}

/** One Teams row with its virtuals, for actions that `returns Teams` (never dispatched as a READ). */
export async function teamRowWithVirtuals(id: string, req: any): Promise<any> {
  const row = await cds.run(cds.ql.SELECT.one.from(TEAMS).where({ ID: id }));
  if (row) await fillVirtuals([row], req);
  return row;
}

/** Spec §5 matrix for a team edit: which members to invalidate and what to republish. */
async function afterTeamChange(req: any, teamId: string, changed: Record<string, any>): Promise<void> {
  const keys = Object.keys(changed);
  // the name travels in the members' team blocks and the team document, so a rename costs the same
  const invalidating = keys.some((k) => k === 'name' || LIMIT_SET.has(k) || (ASSOCIATIONS as readonly string[]).includes(k));
  await recordAuditEvent(audit(req, 'team.update', teamId, changed));
  if (!invalidating) return;
  const members = await lookups.memberEmails(cds, teamId);
  if (members.length) await invalidateForEmails(cds, members, 'team');
  await tq.publishTeam(cds, teamId);
  if ('memberQuotaProfile_ID' in changed && members.length) await quota.publishMany(cds, members);
}

/**
 * Members are a composition, so an open draft of the team holds its own copy of them, and that copy
 * is what the object page shows in edit mode. The member actions write the saved team, so the copy
 * is rebuilt from it; Save never writes members back (on UPDATE Teams takes EDITABLE fields only).
 */
async function syncDraftMembers(teamId: string): Promise<void> {
  const { SELECT, DELETE, INSERT } = cds.ql;
  const draft = await cds.run(SELECT.one.from(DRAFT_TEAMS).columns('DraftAdministrativeData_DraftUUID').where({ ID: teamId }));
  if (!draft) return;
  await cds.run(DELETE.from(DRAFT_MEMBERS).where({ team_ID: teamId }));
  const rows: any[] = await cds.run(SELECT.from(lookups.MEMBERS).where({ team_ID: teamId }));
  if (rows.length) {
    await cds.run(INSERT.into(DRAFT_MEMBERS).entries(rows.map((r) => ({
      ...r, IsActiveEntity: false, HasActiveEntity: true, HasDraftEntity: false, DraftAdministrativeData_DraftUUID: draft.DraftAdministrativeData_DraftUUID
    }))));
  }
}

/**
 * Entitlements & Quotas sets one association of a saved team (platform admin): the same side
 * effects as a draft save of that field. An open draft carries the association too and would write
 * its old value back on Save, so it takes the new value as well.
 */
async function assignTeamAssociation(req: any, teamId: string, column: typeof ASSOCIATIONS[number], value: string | null): Promise<any> {
  const team = await lookups.getTeam(cds, teamId);
  if (!team) { req.reject(404, `Team ${teamId} not found`); return; }
  const before = (team as any)[column] ?? null;
  await cds.run(cds.ql.UPDATE(lookups.TEAMS).set({ [column]: value, modifiedAt: new Date().toISOString(), modifiedBy: actor(req) }).where({ ID: teamId }));
  await cds.run(cds.ql.UPDATE(DRAFT_TEAMS).set({ [column]: value }).where({ ID: teamId }));
  if (before !== value) await afterTeamChange(req, teamId, { [column]: value });
  return teamRowWithVirtuals(teamId, req);
}
const PROFILE_SLOTS: Record<string, typeof ASSOCIATIONS[number]> = { pool: 'quotaProfile_ID', member: 'memberQuotaProfile_ID' };

export function registerTeamHandlers(service: any): void {
  // ---- SAP billing by team: both usage tables, per team and currency, folded in JS ----
  const NO_TEAM = '00000000-0000-0000-0000-000000000000';
  service.on('READ', 'TeamSapBillingStats', async (req: any) => {
    // `$filter=sapTenant eq '<zone>'` narrows both tables to that SAP tenant (SAP bills per subaccount).
    const where: any[] = req.query?.SELECT?.where ?? [];
    const at = where.findIndex((t) => t?.ref?.length === 1 && t.ref[0] === 'sapTenant');
    const tenant: string | null = at >= 0 && where[at + 1] === '=' && typeof where[at + 2]?.val === 'string' ? where[at + 2].val : null;
    const cols = ['team_ID as teamId', 'max(teamName) as teamName', 'sapCostCurrency', 'count(*) as totalRequests',
      'COALESCE(sum(genAiTokens), 0) as totalGenAiTokens', 'COALESCE(sum(capacityUnits), 0) as totalCapacityUnits', 'COALESCE(sum(sapCost), 0) as totalSapCost'];
    const read = (table: string) => cds.run(cds.ql.SELECT.from(table).columns(cols).where({ provider: { '!=': null }, sapCostCurrency: { '!=': null }, ...(tenant ? { sapTenant: tenant } : {}) }).groupBy('team_ID', 'sapCostCurrency'));
    const out = new Map<string, any>();
    for (const r of [...await read('sap.llm.gateway.admin.ApiKeyUsage'), ...await read('sap.llm.gateway.admin.AwsCredentialUsage')]) {
      const teamId = r.teamId ?? NO_TEAM;
      const key = `${teamId}|${r.sapCostCurrency}`;
      const row = out.get(key) ?? { teamId, sapCostCurrency: r.sapCostCurrency, teamName: r.teamId ? r.teamName ?? null : null, totalRequests: 0, totalGenAiTokens: 0, totalCapacityUnits: 0, totalSapCost: 0 };
      row.totalRequests += Number(r.totalRequests) || 0; row.totalGenAiTokens += Number(r.totalGenAiTokens) || 0;
      row.totalCapacityUnits += Number(r.totalCapacityUnits) || 0; row.totalSapCost += Number(r.totalSapCost) || 0;
      if (!row.teamName && r.teamName && r.teamId) row.teamName = r.teamName;
      out.set(key, row);
    }
    return [...out.values()].sort((a, b) => String(a.teamName ?? '~').localeCompare(String(b.teamName ?? '~')) || a.sapCostCurrency.localeCompare(b.sapCostCurrency));
  });

  // ---- what the caller may do on the Teams list (Fiori Elements Create/Delete) ----
  service.on('READ', 'TeamPermissions', (req: any) => {
    const hidden = !isAdmin(req);
    return { ID: 1, createHidden: hidden, deleteHidden: hidden };
  });

  // ---- row filter: a platform admin sees all; a team admin the teams they administer; others nothing ----
  service.before('READ', ['Teams', 'Teams.drafts', 'TeamMembers'], async (req: any) => {
    if (isAdmin(req)) return;
    const root = String(req.target?.name || '').endsWith('TeamMembers') ? 'TeamMembers' : 'Teams';
    if (![req.query, originalQuery(req.query)].every((q) => queryAllowed(q?.SELECT, root))) {
      req.reject({ status: 403, code: 'TEAM_FORBIDDEN', message: 'TEAM_FORBIDDEN' }); return;
    }
    const ids = await lookups.adminTeamIdsOf(cds, actor(req));
    const column = String(req.target?.name || '').endsWith('TeamMembers') ? 'team_ID' : 'ID';
    req.query.where({ [column]: { in: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] } });
  });

  // ---- validation on the draft and on activation ----
  service.before(['CREATE', 'UPDATE'], ['Teams', 'Teams.drafts'], async (req: any) => {
    if (!isAdmin(req)) { req.reject({ status: 403, code: 'TEAM_FORBIDDEN', message: 'TEAM_FORBIDDEN' }); return; }
    const id = req.data?.ID ?? (req.event === 'UPDATE' ? keyId(req) : undefined);
    const current = id ? await lookups.getTeam(cds, id) : null;
    // The Fiori create flow POSTs an empty draft and then PATCHes one field at a time, and a
    // never-activated team has no stored row: a draft write is weighed against `current ?? {}`, so
    // only an explicitly emptied name fails there (Ruling R2). The activation CREATE on the active
    // entity gets the whole draft row and still requires the name and the full window order.
    const onDraft = String(req.target?.name || '').endsWith('.drafts');
    const errors = teams.validateTeamWrite(req.data || {}, onDraft ? (current ?? {} as any) : req.event === 'CREATE' ? null : current);
    if (errors.includes('name is required')) { req.reject(400, 'TEAM_NAME_REQUIRED'); return; }
    if (errors.length) { req.reject(400, errors.join('; ')); return; }
    if (typeof req.data?.name === 'string' && req.data.name) {
      const clash = await lookups.getTeamByName(cds, req.data.name);
      if (clash && clash.ID !== id) { req.reject({ status: 400, code: 'TEAM_NAME_TAKEN', message: 'TEAM_NAME_TAKEN', args: [req.data.name] }); return; }
    }
    if (req.data?.entitlementCatalog_ID) {
      const catalog = await getCatalog(cds, req.data.entitlementCatalog_ID);
      if (!catalog) { req.reject(404, 'catalog not found'); return; }
      if (catalog.ownerEmail) { req.reject({ status: 400, code: 'not_assignable', message: 'only admin catalogs and the default can be assigned to a team' }); return; }
    }
  });
  service.before('UPDATE', 'Teams.drafts', async (req: any) => {
    const current = await lookups.getTeam(cds, req.data?.ID ?? keyId(req));
    for (const [k, v] of Object.entries(req.data || {})) {
      if (EDITABLE.has(k) || DRAFT_META.has(k) || VIRTUAL_FIELDS.has(k)) continue;
      const stored = (current as any)?.[k];
      const same = v === stored || (v == null && stored == null) || (v != null && stored != null && String(v) === String(stored));
      if (!same) { req.reject(400, `${k} is read-only`); return; }
    }
  });

  // CREATE reaches the active entity on draftActivate with the whole draft row: the projection is a
  // view (virtual columns), so the insert goes to the base table with the persisted columns only.
  service.on('CREATE', 'Teams', async (req: any) => {
    const now = new Date().toISOString();
    const data: any = { ID: req.data.ID ?? cds.utils.uuid(), createdAt: now, createdBy: actor(req), modifiedAt: now, modifiedBy: actor(req) };
    for (const k of EDITABLE) if (k in (req.data || {})) data[k] = req.data[k] === '' ? null : req.data[k];
    await cds.run(cds.ql.INSERT.into(lookups.TEAMS).entries(data));
    await recordAuditEvent(audit(req, 'team.create', data.ID, { name: data.name }));
    await tq.publishTeam(cds, data.ID);
    return teamRowWithVirtuals(data.ID, req);
  });
  service.on('UPDATE', 'Teams', async (req: any) => {
    const id = req.data?.ID ?? keyId(req);
    const current = await lookups.getTeam(cds, id);
    if (!current) { req.reject(404, `Team ${id} not found`); return; }
    const patch: any = {}; const changed: any = {};
    for (const k of EDITABLE) {
      if (!(k in (req.data || {}))) continue;
      const v = req.data[k] === '' ? null : req.data[k];
      patch[k] = v;
      const stored = (current as any)[k];
      if (!(v === stored || (v == null && stored == null) || (v != null && stored != null && String(v) === String(stored)))) changed[k] = v;
    }
    patch.modifiedAt = new Date().toISOString(); patch.modifiedBy = actor(req);
    await cds.run(cds.ql.UPDATE(lookups.TEAMS).set(patch).where({ ID: id }));
    await afterTeamChange(req, id, changed);
    return teamRowWithVirtuals(id, req);
  });
  service.after('READ', ['Teams', 'Teams.drafts'], async (rows: any, req: any) => {
    await fillVirtuals(Array.isArray(rows) ? rows : rows ? [rows] : [], req);
  });
  // The create response is the new draft's first read: without its virtuals the object page binds missing properties.
  service.after('NEW', 'Teams.drafts', async (row: any, req: any) => { await fillVirtuals(row ? [row] : [], req); });

  // ---- delete: only an empty team; its document and credential bindings go with it ----
  service.before('DELETE', 'Teams', async (req: any) => {
    const team = await lookups.getTeam(cds, keyId(req));
    if (!team) return;
    try { await teams.assertDeletable(cds, team); } catch (e) {
      if (!(e instanceof teams.TeamError && e.code === 'has_members')) { fail(req, e); return; }
      const members = await lookups.memberEmails(cds, team.ID);
      req.reject({ status: 409, code: 'TEAM_HAS_MEMBERS', message: 'TEAM_HAS_MEMBERS', args: [members.length, members.slice(0, 10).join(', ')] });
    }
  });
  service.on('DELETE', 'Teams', async (req: any, next: any) => {
    const id = keyId(req);
    for (const table of [lookups.KEYS, lookups.AWS]) await cds.run(cds.ql.UPDATE(table).set({ team_ID: null }).where({ team_ID: id }));
    const result = await next();
    // The team's vector-store shares go too (spec §8): after the commit and off the request, so the
    // gateway call never holds the admin's single SQLite connection. A failure leaves rows that no
    // member can match any more (a deleted team has no members); nothing retries.
    req.on('succeeded', () => {
      void callGateway({ email: actor(req), role: 'admin' }, 'delete', `/admin/teams/${id}/shares`).then((r) => {
        if (r.status >= 400) logger.warn('Teams', `store share cleanup for team ${id} answered ${r.status}`);
      });
    });
    await tq.unpublishTeam(id);
    await recordAuditEvent(audit(req, 'team.delete', id));
    return result;
  });

  // ---- membership actions (platform admin or team admin; every call re-checks) ----
  // The role check runs before the existence check, so a caller without access learns nothing about
  // which team IDs exist (403 either way); a platform admin gets the 404.
  const memberAction = (name: string, action: string, run: (teamId: string, req: any) => Promise<any>) =>
    service.on(name, TEAMS, async (req: any) => {
      const teamId = keyId(req);
      if (!(await requireTeamAccess(req, teamId, 'members'))) return;
      if (!(await lookups.getTeam(cds, teamId))) { req.reject(404, `Team ${teamId} not found`); return; }
      try {
        const details = await run(teamId, req);
        await syncDraftMembers(teamId);
        await recordAuditEvent(audit(req, action, teamId, details));
        return teamRowWithVirtuals(teamId, req);
      } catch (e) { return fail(req, e); }
    });
  /** A membership change: that member's cached validation and both documents (spec §5 matrix). */
  const afterMembership = async (teamId: string, email: string) => {
    await invalidateForEmails(cds, [email], 'team');
    await quota.publish(cds, email);
    await tq.publishTeam(cds, teamId);
  };
  memberAction('addMember', 'team.member_added', async (teamId, req) => {
    const { email, role } = req.data;
    // A team admin may add known users only; a platform admin any e-mail (the Users row is touched into existence).
    if (!isAdmin(req) && !(await getUser(cds, email))) throw new teams.TeamError(404, 'unknown_user', `${email} is not a known user`);
    const m = await teams.addMember(cds, teamId, email, role ?? 'member');
    await afterMembership(teamId, email);
    return { email, role: m.role, isPrimary: m.isPrimary };
  });
  memberAction('removeMember', 'team.member_removed', async (teamId, req) => {
    const { email } = req.data;
    const r = await teams.removeMember(cds, teamId, email);
    await afterMembership(teamId, email);
    return { email, promotedPrimary: r.promotedPrimary };
  });
  memberAction('setMemberRole', 'team.member_role_changed', async (teamId, req) => {
    const { email, role } = req.data;
    await teams.setMemberRole(cds, teamId, email, role);
    return { email, role };
  });
  memberAction('setPrimary', 'team.primary_changed', async (teamId, req) => {
    const { email } = req.data;
    await teams.setPrimary(cds, teamId, email);
    await afterMembership(teamId, email);
    return { email };
  });

  // ---- pool reset (platform admin) ----
  const reset = async (req: any, teamId: string) => {
    const team = await lookups.getTeam(cds, teamId);
    if (!team) return { teamId, ok: false, message: 'not found', quotaResetAt: null };
    const { quotaResetAt } = await tq.resetTeamQuota(cds, teamId);
    await recordAuditEvent(audit(req, 'team.quota_reset', teamId));
    return { teamId, ok: true, message: 'reset', quotaResetAt };
  };
  service.on('resetQuota', TEAMS, async (req: any) => { if (!isAdmin(req)) { req.reject(403, 'Administrators only'); return; } return reset(req, keyId(req)); });
  service.on('resetTeamQuotas', async (req: any) => {
    const out = [];
    for (const id of new Set<string>((req.data.teamIds || []).filter(Boolean))) out.push(await reset(req, id));
    return out;
  });

  // ---- Entitlements & Quotas: a team's catalog and profile slots (platform admin, @requires) ----
  service.on('assignTeamCatalog', async (req: any) => {
    const catalogId = req.data.catalogId || null;
    if (catalogId) {
      const catalog = await getCatalog(cds, catalogId);
      if (!catalog) { req.reject(404, 'catalog not found'); return; }
      if (catalog.ownerEmail) { req.reject({ status: 400, code: 'not_assignable', message: 'only admin catalogs and the default can be assigned to a team' }); return; }
    }
    return assignTeamAssociation(req, req.data.teamId, 'entitlementCatalog_ID', catalogId);
  });
  service.on('assignTeamQuotaProfile', async (req: any) => {
    const column = PROFILE_SLOTS[req.data.slot];
    if (!column) { req.reject(400, `slot must be 'pool' or 'member'`); return; }
    const profileId = req.data.profileId || null;
    if (profileId && !(await getProfilesByIds(cds, [profileId])).get(profileId)) { req.reject(404, 'quota profile not found'); return; }
    return assignTeamAssociation(req, req.data.teamId, column, profileId);
  });

  // ---- reads for everyone: my teams, candidates, status ----
  service.on('myTeams', async (req: any) => {
    const mine = await lookups.teamsOf(cds, actor(req));
    const statuses = await tq.teamStatusMany(cds, mine.map((m) => m.team.ID));
    return mine.map(({ membership, team }) => ({ teamId: team.ID, name: team.name, role: membership.role, isPrimary: membership.isPrimary, pool: statuses.get(team.ID) ?? null }));
  });
  service.on('teamQuotaStatus', async (req: any) => {
    const s = await tq.teamStatus(cds, req.data.teamId);
    if (!s) { req.reject(404, `Team ${req.data.teamId} not found`); return; }
    return s;
  });
  service.on('teamMemberCandidates', async (req: any) => {
    const teamId = req.data.teamId;
    if (!(await requireTeamAccess(req, teamId, 'members'))) return;
    const members = new Set(await lookups.memberEmails(cds, teamId));
    const rows: any[] = await cds.run(cds.ql.SELECT.from(USERS).columns('email', 'displayName', 'status').where({ status: 'active' }).orderBy('email'));
    return rows.filter((u) => !members.has(u.email) && !isServiceKeyEmail(u.email)).map((u) => ({ email: u.email, displayName: u.displayName ?? null, status: u.status }));
  });

  // ---- credential binding: owner or platform admin; must be one of the owner's teams ----
  const bind = (entity: 'ApiKeys' | 'AwsCredentials') => async (req: any) => {
    const id = entity === 'ApiKeys' ? req.data.keyId : req.data.credentialId;
    const cred: lookups.CredentialRef = entity === 'ApiKeys' ? { apiKeyId: id } : { awsCredentialId: id };
    const row = await lookups.credentialRow(cds, cred);
    if (!row) { req.reject(404, `${entity} ${id} not found`); return; }
    if (!isAdmin(req) && row.email !== actor(req)) { req.reject({ status: 403, code: 'TEAM_FORBIDDEN', message: 'TEAM_FORBIDDEN' }); return; }
    try {
      await teams.setCredentialTeam(cds, cred, req.data.teamId ?? null);
      await invalidateForEmails(cds, [row.email], 'team');
      await recordAuditEvent({ ...audit(req, 'credential.team_changed', id, { teamId: req.data.teamId ?? null }), resourceType: entity === 'ApiKeys' ? 'ApiKey' : 'AwsCredential' });
      // The row goes back without its secret: the key itself and the stored (encrypted) AWS secret.
      const out = await cds.run(cds.ql.SELECT.one.from(`AdminService.${entity}`).where({ ID: id }));
      if (out) { delete out.key; delete out.secretAccessKey; }
      return out;
    } catch (e) { return fail(req, e); }
  };
  service.on('setApiKeyTeam', bind('ApiKeys'));
  service.on('setAwsCredentialTeam', bind('AwsCredentials'));
}

/** After a credential insert: bind it to the requested team (one of the owner's) or reject 400. */
export async function bindCreatedCredential(req: any, cred: lookups.CredentialRef, teamId: string | null | undefined): Promise<boolean> {
  if (!teamId) return true;
  try { await teams.setCredentialTeam(cds, cred, teamId); return true; }
  catch (e) { fail(req, e); return false; }
}
