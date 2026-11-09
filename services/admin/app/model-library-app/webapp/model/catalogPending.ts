/**
 * The unsaved list changes of one entitlement catalog (spec: catalogs save explicitly). Members,
 * exclusions and assignments are written through bound and unbound actions — the entities are
 * read-only over OData — so, unlike the header's deferred update group, nothing in the OData model
 * can hold them back until Save. This module does: the pending sets, how a click changes them
 * (staging the opposite of a pending change cancels it; a change the server already holds is a
 * no-op), how the tables show them, and the order Save writes them in. Pure, no UI5 imports —
 * unit-tested with jest like headerDirty.ts.
 */
export interface PendingModel { modelId: string; displayName?: string | null; reason?: string | null; }
export interface PendingChanges {
  addMembers: PendingModel[];
  removeMembers: string[];
  exclude: PendingModel[];
  include: string[];
  /** e-mail → this catalog's ID (assign) or null (unassign: back to the default catalog) */
  assign: Record<string, string | null>;
  /** `<teamId>|<slot>` → the team's staged catalog or profile for that slot (null = none). Optional
   *  so a set built without teams still reads as one; emptyPending() always carries it. */
  teams?: Record<string, TeamAssignment>;
}
/** Which association of a team an assignment writes: its catalog, its pool profile or its member profile. */
export type TeamSlot = 'catalog' | 'pool' | 'member';
export interface TeamAssignment { teamId: string; name: string; slot: TeamSlot; target: string | null; }
export type PendingMark = 'add' | 'remove' | null;

/**
 * Resolves an i18n key with optional {0} arguments — the controller injects the resource bundle;
 * jest passes none and gets the English defaults below, so the module keeps no UI5 imports.
 */
export type Translator = (key: string, args?: (string | number)[]) => string;
/** English defaults: each value is byte-identical to the literal it replaced, so the pure tests hold. */
const EN_TEXTS: Record<string, string> = {
  pendingOne: '1 unsaved change', pendingMany: '{0} unsaved changes',
  stepRemoveModels: 'remove models', stepAddModels: 'add models', stepIncludeModels: 'include models', stepExcludeModels: 'exclude models',
  stepAssign: 'assign {0}', stepUnassign: 'unassign {0}',
  savedAdded: '{0} added', savedRemoved: '{0} removed', savedExcluded: '{0} excluded', savedIncluded: '{0} included again',
  savedAssigned: '{0} user(s) assigned', savedUnassigned: '{0} user(s) unassigned',
  stepAssignTeam: 'assign team {0}', stepUnassignTeam: 'unassign team {0}',
  savedTeamsAssigned: '{0} team(s) assigned', savedTeamsUnassigned: '{0} team(s) unassigned',
  saved: 'Saved', savedParts: 'Saved: {0}', savedPruned: '{0}; {1} pruned from child catalogs',
  excludedInModelLibrary: 'Excluded in the Model Library'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

export function emptyPending(): PendingChanges {
  return { addMembers: [], removeMembers: [], exclude: [], include: [], assign: {}, teams: {} };
}

export function pendingCount(p: PendingChanges): number {
  return p.addMembers.length + p.removeMembers.length + p.exclude.length + p.include.length + Object.keys(p.assign).length + Object.keys(p.teams ?? {}).length;
}

const ids = (v: Iterable<string>) => new Set(v);
const without = (list: string[], id: string) => list.filter(x => x !== id);
const withoutModel = (list: PendingModel[], id: string) => list.filter(x => x.modelId !== id);

/**
 * Add `rows` to the catalog: a row queued for removal is un-removed instead, one the catalog
 * already holds (or that is already queued) is dropped.
 */
export function stageAdd(p: PendingChanges, rows: PendingModel[], currentMemberIds: Iterable<string>): PendingChanges {
  const current = ids(currentMemberIds);
  let next = { ...p, addMembers: [...p.addMembers], removeMembers: [...p.removeMembers] };
  for (const row of rows) {
    if (next.removeMembers.includes(row.modelId)) { next.removeMembers = without(next.removeMembers, row.modelId); continue; }
    if (current.has(row.modelId) || next.addMembers.some(m => m.modelId === row.modelId)) continue;
    next.addMembers.push({ modelId: row.modelId, displayName: row.displayName ?? row.modelId });
  }
  return next;
}

/** Remove `modelIds`: one only queued for adding is simply forgotten, one the catalog holds is queued. */
export function stageRemove(p: PendingChanges, modelIds: string[], currentMemberIds: Iterable<string>): PendingChanges {
  const current = ids(currentMemberIds);
  let next = { ...p, addMembers: [...p.addMembers], removeMembers: [...p.removeMembers] };
  for (const id of modelIds) {
    if (next.addMembers.some(m => m.modelId === id)) { next.addMembers = withoutModel(next.addMembers, id); continue; }
    if (current.has(id) && !next.removeMembers.includes(id)) next.removeMembers.push(id);
  }
  return next;
}

/** Exclude `rows` from the default catalog — the same symmetry as stageAdd against the exclusion list. */
export function stageExclude(p: PendingChanges, rows: PendingModel[], currentExcludedIds: Iterable<string>): PendingChanges {
  const current = ids(currentExcludedIds);
  let next = { ...p, exclude: [...p.exclude], include: [...p.include] };
  for (const row of rows) {
    if (next.include.includes(row.modelId)) { next.include = without(next.include, row.modelId); continue; }
    if (current.has(row.modelId) || next.exclude.some(m => m.modelId === row.modelId)) continue;
    next.exclude.push({ modelId: row.modelId, displayName: row.displayName ?? row.modelId, reason: row.reason ?? null });
  }
  return next;
}

/** Include `modelIds` again — the same symmetry as stageRemove against the exclusion list. */
export function stageInclude(p: PendingChanges, modelIds: string[], currentExcludedIds: Iterable<string>): PendingChanges {
  const current = ids(currentExcludedIds);
  let next = { ...p, exclude: [...p.exclude], include: [...p.include] };
  for (const id of modelIds) {
    if (next.exclude.some(m => m.modelId === id)) { next.exclude = withoutModel(next.exclude, id); continue; }
    if (current.has(id) && !next.include.includes(id)) next.include.push(id);
  }
  return next;
}

/** Assign (`target` = a catalog ID) or unassign (`target` = null) a user; the server's own value makes it a no-op. */
export function stageAssign(p: PendingChanges, email: string, target: string | null, currentCatalogId: string | null | undefined): PendingChanges {
  const assign = { ...p.assign };
  if ((currentCatalogId ?? null) === target) delete assign[email]; else assign[email] = target;
  return { ...p, assign };
}

/** Assign (`target` = a catalog or profile ID) or unassign (null) one slot of a team; the server's own value makes it a no-op. */
export function stageTeamAssign(p: PendingChanges, team: { teamId: string; name: string }, slot: TeamSlot, target: string | null, current: string | null | undefined): PendingChanges {
  const teams = { ...(p.teams ?? {}) };
  const key = `${team.teamId}|${slot}`;
  if ((current ?? null) === target) delete teams[key]; else teams[key] = { teamId: team.teamId, name: team.name, slot, target };
  return { ...p, teams };
}

/** A team as the assignments tab lists it: its three slots as the server holds them. */
export interface TeamRow {
  ID: string; name: string;
  catalogId: string | null; catalogName: string | null;
  poolProfileId: string | null; poolProfileName: string | null;
  memberProfileId: string | null; memberProfileName: string | null;
}
export interface MergedTeamRow extends TeamRow { pendingCatalog: boolean; pendingPool: boolean; pendingMember: boolean; pending: boolean; }
const TEAM_SLOT_FIELDS: Record<TeamSlot, ['catalogId' | 'poolProfileId' | 'memberProfileId', 'catalogName' | 'poolProfileName' | 'memberProfileName', 'pendingCatalog' | 'pendingPool' | 'pendingMember']> = {
  catalog: ['catalogId', 'catalogName', 'pendingCatalog'], pool: ['poolProfileId', 'poolProfileName', 'pendingPool'], member: ['memberProfileId', 'memberProfileName', 'pendingMember']
};
/** The teams table: a staged slot overrides what the server holds (named after `thisItem` when it points there), and says so. */
export function mergeTeams(snapshot: TeamRow[], p: PendingChanges, thisItem: { ID: string; name: string }): MergedTeamRow[] {
  return snapshot.map(r => {
    const row: MergedTeamRow = { ...r, pendingCatalog: false, pendingPool: false, pendingMember: false, pending: false };
    for (const slot of Object.keys(TEAM_SLOT_FIELDS) as TeamSlot[]) {
      const staged = p.teams?.[`${r.ID}|${slot}`];
      if (!staged) continue;
      const [idField, nameField, flag] = TEAM_SLOT_FIELDS[slot];
      row[idField] = staged.target;
      row[nameField] = staged.target === null ? null : staged.target === thisItem.ID ? thisItem.name : r[nameField];
      row[flag] = true; row.pending = true;
    }
    return row;
  });
}

export interface MemberRow { modelId: string; displayName?: string | null; absent?: boolean; [k: string]: any; }
/** The members table: the server's rows marked 'remove' where queued, the queued additions appended and marked 'add'. */
export function mergeMembers<T extends MemberRow>(snapshot: T[], p: PendingChanges): Array<T & { pending: PendingMark }> {
  const removing = ids(p.removeMembers);
  const rows: Array<T & { pending: PendingMark }> = snapshot.map(r => ({ ...r, pending: removing.has(r.modelId) ? 'remove' as const : null }));
  for (const m of p.addMembers) rows.push({ modelId: m.modelId, displayName: m.displayName ?? m.modelId, absent: false, pending: 'add' } as T & { pending: PendingMark });
  return rows;
}

/**
 * The reason stored with an exclusion made on this screen. It is data, kept in English in every
 * language; the exclusions table shows it through exclusionReason().
 */
export const EXCLUDED_REASON = 'Excluded in the Model Library';

/**
 * The exclusions table's reason column: the stored sentinel reads in the cockpit language (the view
 * binds the bundle text as the second part, the bundle is async), any other reason shows as stored.
 */
export function exclusionReason(reason: string | null | undefined, sentinelText?: string | null): string {
  if (reason === EXCLUDED_REASON) return sentinelText || defaultTranslate('excludedInModelLibrary');
  return reason ?? '';
}

export interface ExclusionRow { modelId: string; reason?: string | null; [k: string]: any; }
/** The exclusions table: queued inclusions marked 'remove', queued exclusions appended and marked 'add'. */
export function mergeExclusions<T extends ExclusionRow>(snapshot: T[], p: PendingChanges): Array<T & { pending: PendingMark }> {
  const including = ids(p.include);
  const rows: Array<T & { pending: PendingMark }> = snapshot.map(r => ({ ...r, pending: including.has(r.modelId) ? 'remove' as const : null }));
  for (const m of p.exclude) rows.push({ modelId: m.modelId, reason: m.reason ?? null, pending: 'add' } as T & { pending: PendingMark });
  return rows;
}

export interface UserRow { email: string; catalogId?: string | null; catalogName?: string | null; [k: string]: any; }
export interface MergedUserRow extends UserRow { effectiveCatalogId: string | null; effectiveCatalogName: string | null; pending: boolean; }
/** The assignments table: a queued assignment overrides what the server holds, and says so. */
export function mergeUsers<T extends UserRow>(snapshot: T[], p: PendingChanges, thisCatalog: { ID: string; name: string }): Array<T & MergedUserRow> {
  return snapshot.map(r => {
    const queued = Object.prototype.hasOwnProperty.call(p.assign, r.email);
    const target = queued ? p.assign[r.email] : (r.catalogId ?? null);
    const name = queued ? (target === null ? null : (target === thisCatalog.ID ? thisCatalog.name : r.catalogName ?? null)) : (r.catalogName ?? null);
    return { ...r, effectiveCatalogId: target, effectiveCatalogName: name, pending: queued };
  });
}

export function pendingSummary(p: PendingChanges, t: Translator = defaultTranslate): string {
  const n = pendingCount(p);
  return n === 0 ? '' : n === 1 ? t('pendingOne') : t('pendingMany', [n]);
}

export interface PendingInvokers {
  addModels(modelIds: string[]): Promise<{ added?: number; prunedFromChildren?: number } | undefined>;
  removeModels(modelIds: string[]): Promise<{ removed?: number; prunedFromChildren?: number } | undefined>;
  excludeModels(rows: PendingModel[]): Promise<{ excluded?: number; prunedFromChildren?: number } | undefined>;
  includeModels(modelIds: string[]): Promise<{ included?: number } | undefined>;
  assignCatalog(email: string, catalogId: string): Promise<{ prunedFromChildren?: number } | undefined>;
  unassignCatalog(email: string): Promise<unknown>;
  /** One slot of a team: assignTeamCatalog or assignTeamQuotaProfile (null target = none). */
  assignTeam?(teamId: string, slot: TeamSlot, target: string | null): Promise<unknown>;
}
export interface ApplyResults {
  added: number; removed: number; excluded: number; included: number; assigned: number; unassigned: number;
  teamsAssigned?: number; teamsUnassigned?: number; prunedFromChildren: number;
}
export interface ApplyOutcome { remaining: PendingChanges; failed: { step: string; message: string }[]; results: ApplyResults; }

const message = (e: any) => (e && typeof e.message === 'string' ? e.message : String(e));

/**
 * Save: removals, then additions, then inclusions, then exclusions — one action call per set —
 * then the assignments one user at a time (assignCatalog prunes the user's own catalogs server-
 * side, so those calls must not overlap). A set whose call fails stays pending, with the message;
 * the other steps still run, so what could be saved is.
 */
export async function applyPending(p: PendingChanges, invoke: PendingInvokers, t: Translator = defaultTranslate): Promise<ApplyOutcome> {
  const remaining = emptyPending();
  const failed: ApplyOutcome['failed'] = [];
  const results: ApplyResults = { added: 0, removed: 0, excluded: 0, included: 0, assigned: 0, unassigned: 0, teamsAssigned: 0, teamsUnassigned: 0, prunedFromChildren: 0 };
  const pruned = (r: any) => { results.prunedFromChildren += Number(r?.prunedFromChildren) || 0; };

  if (p.removeMembers.length) {
    try { const r = await invoke.removeModels(p.removeMembers); results.removed += Number(r?.removed) || 0; pruned(r); }
    catch (e) { remaining.removeMembers = [...p.removeMembers]; failed.push({ step: t('stepRemoveModels'), message: message(e) }); }
  }
  if (p.addMembers.length) {
    try { const r = await invoke.addModels(p.addMembers.map(m => m.modelId)); results.added += Number(r?.added) || 0; pruned(r); }
    catch (e) { remaining.addMembers = [...p.addMembers]; failed.push({ step: t('stepAddModels'), message: message(e) }); }
  }
  if (p.include.length) {
    try { const r = await invoke.includeModels(p.include); results.included += Number(r?.included) || 0; }
    catch (e) { remaining.include = [...p.include]; failed.push({ step: t('stepIncludeModels'), message: message(e) }); }
  }
  if (p.exclude.length) {
    try { const r = await invoke.excludeModels(p.exclude); results.excluded += Number(r?.excluded) || 0; pruned(r); }
    catch (e) { remaining.exclude = [...p.exclude]; failed.push({ step: t('stepExcludeModels'), message: message(e) }); }
  }
  for (const [email, target] of Object.entries(p.assign)) {
    try {
      if (target === null) { await invoke.unassignCatalog(email); results.unassigned += 1; }
      else { const r = await invoke.assignCatalog(email, target); results.assigned += 1; pruned(r); }
    } catch (e) {
      remaining.assign[email] = target;
      failed.push({ step: target === null ? t('stepUnassign', [email]) : t('stepAssign', [email]), message: message(e) });
    }
  }
  // the teams last, one at a time like the users: each write invalidates and republishes the members
  for (const [key, a] of Object.entries(p.teams ?? {})) {
    try {
      if (!invoke.assignTeam) throw new Error('team assignments cannot be saved here');
      await invoke.assignTeam(a.teamId, a.slot, a.target);
      if (a.target === null) results.teamsUnassigned! += 1; else results.teamsAssigned! += 1;
    } catch (e) {
      remaining.teams![key] = a;
      failed.push({ step: t(a.target === null ? 'stepUnassignTeam' : 'stepAssignTeam', [a.name]), message: message(e) });
    }
  }
  return { remaining, failed, results };
}

/** The toast after Save, from what the server reported. */
export function saveSummary(r: ApplyResults, t: Translator = defaultTranslate): string {
  const parts: string[] = [];
  if (r.added) parts.push(t('savedAdded', [r.added]));
  if (r.removed) parts.push(t('savedRemoved', [r.removed]));
  if (r.excluded) parts.push(t('savedExcluded', [r.excluded]));
  if (r.included) parts.push(t('savedIncluded', [r.included]));
  if (r.assigned) parts.push(t('savedAssigned', [r.assigned]));
  if (r.unassigned) parts.push(t('savedUnassigned', [r.unassigned]));
  if (r.teamsAssigned) parts.push(t('savedTeamsAssigned', [r.teamsAssigned]));
  if (r.teamsUnassigned) parts.push(t('savedTeamsUnassigned', [r.teamsUnassigned]));
  const base = parts.length ? t('savedParts', [parts.join(', ')]) : t('saved');
  return r.prunedFromChildren ? t('savedPruned', [base, r.prunedFromChildren]) : base;
}
