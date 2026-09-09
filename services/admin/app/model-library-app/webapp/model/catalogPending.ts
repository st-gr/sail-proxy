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
}
export type PendingMark = 'add' | 'remove' | null;

export function emptyPending(): PendingChanges {
  return { addMembers: [], removeMembers: [], exclude: [], include: [], assign: {} };
}

export function pendingCount(p: PendingChanges): number {
  return p.addMembers.length + p.removeMembers.length + p.exclude.length + p.include.length + Object.keys(p.assign).length;
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

export interface MemberRow { modelId: string; displayName?: string | null; absent?: boolean; [k: string]: any; }
/** The members table: the server's rows marked 'remove' where queued, the queued additions appended and marked 'add'. */
export function mergeMembers<T extends MemberRow>(snapshot: T[], p: PendingChanges): Array<T & { pending: PendingMark }> {
  const removing = ids(p.removeMembers);
  const rows: Array<T & { pending: PendingMark }> = snapshot.map(r => ({ ...r, pending: removing.has(r.modelId) ? 'remove' as const : null }));
  for (const m of p.addMembers) rows.push({ modelId: m.modelId, displayName: m.displayName ?? m.modelId, absent: false, pending: 'add' } as T & { pending: PendingMark });
  return rows;
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

export function pendingSummary(p: PendingChanges): string {
  const n = pendingCount(p);
  return n === 0 ? '' : n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
}

export interface PendingInvokers {
  addModels(modelIds: string[]): Promise<{ added?: number; prunedFromChildren?: number } | undefined>;
  removeModels(modelIds: string[]): Promise<{ removed?: number; prunedFromChildren?: number } | undefined>;
  excludeModels(rows: PendingModel[]): Promise<{ excluded?: number; prunedFromChildren?: number } | undefined>;
  includeModels(modelIds: string[]): Promise<{ included?: number } | undefined>;
  assignCatalog(email: string, catalogId: string): Promise<{ prunedFromChildren?: number } | undefined>;
  unassignCatalog(email: string): Promise<unknown>;
}
export interface ApplyResults { added: number; removed: number; excluded: number; included: number; assigned: number; unassigned: number; prunedFromChildren: number; }
export interface ApplyOutcome { remaining: PendingChanges; failed: { step: string; message: string }[]; results: ApplyResults; }

const message = (e: any) => (e && typeof e.message === 'string' ? e.message : String(e));

/**
 * Save: removals, then additions, then inclusions, then exclusions — one action call per set —
 * then the assignments one user at a time (assignCatalog prunes the user's own catalogs server-
 * side, so those calls must not overlap). A set whose call fails stays pending, with the message;
 * the other steps still run, so what could be saved is.
 */
export async function applyPending(p: PendingChanges, invoke: PendingInvokers): Promise<ApplyOutcome> {
  const remaining = emptyPending();
  const failed: ApplyOutcome['failed'] = [];
  const results: ApplyResults = { added: 0, removed: 0, excluded: 0, included: 0, assigned: 0, unassigned: 0, prunedFromChildren: 0 };
  const pruned = (r: any) => { results.prunedFromChildren += Number(r?.prunedFromChildren) || 0; };

  if (p.removeMembers.length) {
    try { const r = await invoke.removeModels(p.removeMembers); results.removed += Number(r?.removed) || 0; pruned(r); }
    catch (e) { remaining.removeMembers = [...p.removeMembers]; failed.push({ step: 'remove models', message: message(e) }); }
  }
  if (p.addMembers.length) {
    try { const r = await invoke.addModels(p.addMembers.map(m => m.modelId)); results.added += Number(r?.added) || 0; pruned(r); }
    catch (e) { remaining.addMembers = [...p.addMembers]; failed.push({ step: 'add models', message: message(e) }); }
  }
  if (p.include.length) {
    try { const r = await invoke.includeModels(p.include); results.included += Number(r?.included) || 0; }
    catch (e) { remaining.include = [...p.include]; failed.push({ step: 'include models', message: message(e) }); }
  }
  if (p.exclude.length) {
    try { const r = await invoke.excludeModels(p.exclude); results.excluded += Number(r?.excluded) || 0; pruned(r); }
    catch (e) { remaining.exclude = [...p.exclude]; failed.push({ step: 'exclude models', message: message(e) }); }
  }
  for (const [email, target] of Object.entries(p.assign)) {
    try {
      if (target === null) { await invoke.unassignCatalog(email); results.unassigned += 1; }
      else { const r = await invoke.assignCatalog(email, target); results.assigned += 1; pruned(r); }
    } catch (e) {
      remaining.assign[email] = target;
      failed.push({ step: target === null ? `unassign ${email}` : `assign ${email}`, message: message(e) });
    }
  }
  return { remaining, failed, results };
}

/** The toast after Save, from what the server reported. */
export function saveSummary(r: ApplyResults): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.excluded) parts.push(`${r.excluded} excluded`);
  if (r.included) parts.push(`${r.included} included again`);
  if (r.assigned) parts.push(`${r.assigned} user(s) assigned`);
  if (r.unassigned) parts.push(`${r.unassigned} user(s) unassigned`);
  const base = parts.length ? `Saved: ${parts.join(', ')}` : 'Saved';
  return r.prunedFromChildren ? `${base}; ${r.prunedFromChildren} pruned from child catalogs` : base;
}
