import {
  emptyPending, pendingCount, stageAdd, stageRemove, stageExclude, stageInclude, stageAssign,
  mergeMembers, mergeExclusions, mergeUsers, pendingSummary, applyPending, saveSummary, PendingChanges,
  EXCLUDED_REASON, exclusionReason, stageTeamAssign, mergeTeams, TeamRow
} from '../webapp/model/catalogPending';

const m = (modelId: string, displayName = modelId) => ({ modelId, displayName });

describe('staging members', () => {
  it('adds new ids, skips ids the catalog holds or that are already queued', () => {
    const p = stageAdd(emptyPending(), [m('a'), m('b'), m('a')], ['b']);
    expect(p.addMembers).toEqual([m('a')]);
    expect(pendingCount(p)).toBe(1);
  });
  it('removing a queued addition forgets it; removing a held model queues it once', () => {
    let p = stageAdd(emptyPending(), [m('a')], []);
    p = stageRemove(p, ['a', 'b', 'b', 'zzz'], ['b']);
    expect(p).toMatchObject({ addMembers: [], removeMembers: ['b'] });
    expect(pendingCount(p)).toBe(1);
  });
  it('adding a model queued for removal un-removes it instead of queuing an add', () => {
    let p = stageRemove(emptyPending(), ['b'], ['b']);
    p = stageAdd(p, [m('b')], ['b']);
    expect(p).toEqual(emptyPending());
  });
  it('never mutates the input', () => {
    const before = emptyPending();
    stageAdd(before, [m('a')], []);
    stageRemove(before, ['a'], ['a']);
    expect(before).toEqual(emptyPending());
  });
});

describe('staging exclusions', () => {
  it('mirrors the member symmetry against the exclusion list, keeping the reason', () => {
    let p = stageExclude(emptyPending(), [{ modelId: 'x', displayName: 'X', reason: 'r' }, m('held')], ['held']);
    expect(p.exclude).toEqual([{ modelId: 'x', displayName: 'X', reason: 'r' }]);
    p = stageInclude(p, ['x', 'held', 'held'], ['held']);
    expect(p).toMatchObject({ exclude: [], include: ['held'] });
    p = stageExclude(p, [m('held')], ['held']);
    expect(p).toEqual(emptyPending());
  });
});

describe('staging assignments', () => {
  it('queues assign and unassign per user, and a target equal to the stored value is a no-op', () => {
    let p = stageAssign(emptyPending(), 'a@x', 'cat-1', null);
    p = stageAssign(p, 'b@x', null, 'cat-9');
    expect(p.assign).toEqual({ 'a@x': 'cat-1', 'b@x': null });
    p = stageAssign(p, 'a@x', null, null);      // back to what the server holds
    expect(p.assign).toEqual({ 'b@x': null });
    p = stageAssign(p, 'b@x', 'cat-9', 'cat-9');
    expect(p).toEqual(emptyPending());
  });
});

describe('merging for the tables', () => {
  const p: PendingChanges = { addMembers: [m('new', 'New')], removeMembers: ['gone'], exclude: [{ modelId: 'ex', reason: 'r' }], include: ['back'], assign: { 'u@x': 'cat-1', 'v@x': null } };
  it('members: held rows marked remove where queued, queued additions appended as present', () => {
    const rows = mergeMembers([{ modelId: 'gone', displayName: 'Gone', absent: true }, { modelId: 'kept', displayName: 'Kept', absent: false }], p);
    expect(rows).toEqual([
      { modelId: 'gone', displayName: 'Gone', absent: true, pending: 'remove' },
      { modelId: 'kept', displayName: 'Kept', absent: false, pending: null },
      { modelId: 'new', displayName: 'New', absent: false, pending: 'add' }
    ]);
  });
  it('exclusions: queued inclusions marked remove, queued exclusions appended', () => {
    expect(mergeExclusions([{ modelId: 'back', reason: 'old' }], p)).toEqual([
      { modelId: 'back', reason: 'old', pending: 'remove' },
      { modelId: 'ex', reason: 'r', pending: 'add' }
    ]);
  });
  it('users: a queued assignment overrides the stored catalog and is flagged', () => {
    const rows = mergeUsers([
      { email: 'u@x', catalogId: null, catalogName: null },
      { email: 'v@x', catalogId: 'cat-9', catalogName: 'Nine' },
      { email: 'w@x', catalogId: 'cat-9', catalogName: 'Nine' }
    ], p, { ID: 'cat-1', name: 'One' });
    expect(rows.map(r => [r.email, r.effectiveCatalogId, r.effectiveCatalogName, r.pending])).toEqual([
      ['u@x', 'cat-1', 'One', true],
      ['v@x', null, null, true],
      ['w@x', 'cat-9', 'Nine', false]
    ]);
  });
  it('the footer text counts every staged change', () => {
    expect(pendingSummary(emptyPending())).toBe('');
    expect(pendingSummary(stageAdd(emptyPending(), [m('a')], []))).toBe('1 unsaved change');
    expect(pendingSummary(p)).toBe('6 unsaved changes');
  });
});

describe('applyPending', () => {
  const p: PendingChanges = { addMembers: [m('a'), m('b')], removeMembers: ['r'], exclude: [{ modelId: 'x', reason: 'why' }], include: ['i'], assign: { 'u@x': 'cat-1', 'v@x': null } };
  const recorder = (fail: Partial<Record<string, boolean>> = {}) => {
    const calls: string[] = [];
    const step = (name: string, result: any) => async (...args: any[]) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      if (fail[name]) throw new Error(`${name} refused`);
      return result;
    };
    return { calls, invoke: {
      addModels: step('addModels', { added: 2, prunedFromChildren: 1 }),
      removeModels: step('removeModels', { removed: 1 }),
      excludeModels: step('excludeModels', { excluded: 1, prunedFromChildren: 2 }),
      includeModels: step('includeModels', { included: 1 }),
      assignCatalog: step('assignCatalog', { prunedFromChildren: 3 }),
      unassignCatalog: step('unassignCatalog', undefined)
    } };
  };
  it('one call per set, removals before additions, inclusions before exclusions, then the users in order', async () => {
    const { calls, invoke } = recorder();
    const out = await applyPending(p, invoke);
    expect(calls).toEqual([
      'removeModels:[["r"]]', 'addModels:[["a","b"]]', 'includeModels:[["i"]]',
      'excludeModels:[[{"modelId":"x","reason":"why"}]]', 'assignCatalog:["u@x","cat-1"]', 'unassignCatalog:["v@x"]'
    ]);
    expect(out.remaining).toEqual(emptyPending());
    expect(out.failed).toEqual([]);
    expect(out.results).toEqual({ added: 2, removed: 1, excluded: 1, included: 1, assigned: 1, unassigned: 1, teamsAssigned: 0, teamsUnassigned: 0, prunedFromChildren: 6 });
    expect(saveSummary(out.results)).toBe('Saved: 2 added, 1 removed, 1 excluded, 1 included again, 1 user(s) assigned, 1 user(s) unassigned; 6 pruned from child catalogs');
  });
  it('a failed set stays pending with its message; the other sets and users still go through', async () => {
    const { calls, invoke } = recorder({ addModels: true, unassignCatalog: true });
    const out = await applyPending(p, invoke);
    expect(calls).toHaveLength(6);
    expect(out.remaining).toEqual({ ...emptyPending(), addMembers: [m('a'), m('b')], assign: { 'v@x': null } });
    expect(out.failed).toEqual([{ step: 'add models', message: 'addModels refused' }, { step: 'unassign v@x', message: 'unassignCatalog refused' }]);
    expect(out.results).toMatchObject({ added: 0, removed: 1, assigned: 1, unassigned: 0 });
  });
  it('assignments run strictly one after another', async () => {
    let inFlight = 0; let overlap = false;
    const slow = async () => { inFlight++; if (inFlight > 1) overlap = true; await new Promise(r => setTimeout(r, 5)); inFlight--; return {}; };
    const invoke = { ...recorder().invoke, assignCatalog: slow, unassignCatalog: slow };
    await applyPending({ ...emptyPending(), assign: { 'a@x': 'c', 'b@x': null, 'c@x': 'c' } }, invoke);
    expect(overlap).toBe(false);
  });
  it('nothing staged means no calls and the plain "Saved"', async () => {
    const { calls, invoke } = recorder();
    const out = await applyPending(emptyPending(), invoke);
    expect(calls).toEqual([]);
    expect(saveSummary(out.results)).toBe('Saved');
  });
  // A quota profile stages assignments and nothing else: the controller hands over the profile
  // actions as assignCatalog/unassignCatalog and lets the four model invokers throw, so a step
  // that ever reached them would fail loudly rather than call a catalog action on a profile.
  it('an assign map alone calls only the two assignment steps, in order', async () => {
    const calls: string[] = [];
    const refuse = async () => { throw new Error('cannot be staged for a quota profile'); };
    // what the controller passes in profile mode: assignQuotaProfile/unassignQuotaProfile, which
    // answer with the Users row (no prunedFromChildren), and four model steps that must never run
    const profileInvokers = {
      addModels: refuse, removeModels: refuse, excludeModels: refuse, includeModels: refuse,
      assignCatalog: async (...args: any[]) => { calls.push(`assignCatalog:${JSON.stringify(args)}`); return { email: args[0] } as any; },
      unassignCatalog: async (...args: any[]) => { calls.push(`unassignCatalog:${JSON.stringify(args)}`); return { email: args[0] } as any; }
    };
    const out = await applyPending({ ...emptyPending(), assign: { 'u@x': 'profile-1', 'v@x': null } }, profileInvokers);
    expect(calls).toEqual(['assignCatalog:["u@x","profile-1"]', 'unassignCatalog:["v@x"]']);
    expect(out.remaining).toEqual(emptyPending());
    expect(out.failed).toEqual([]);
    expect(out.results).toEqual({ added: 0, removed: 0, excluded: 0, included: 0, assigned: 1, unassigned: 1, teamsAssigned: 0, teamsUnassigned: 0, prunedFromChildren: 0 });
    expect(saveSummary(out.results)).toBe('Saved: 1 user(s) assigned, 1 user(s) unassigned');
  });
});

describe('the cockpit language', () => {
  // The German bundle as the controller's translator would resolve it.
  const de = Object.fromEntries(require('fs').readFileSync(require('path').join(__dirname, '../webapp/i18n/i18n_de.properties'), 'utf8')
    .split('\n').filter((l: string) => /^[A-Za-z]/.test(l)).map((l: string) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const t = (key: string, args?: (string | number)[]) => String(de[key] ?? key).replace(/\{(\d+)\}/g, (_m, i) => String(args?.[Number(i)] ?? ''));
  it('words the pending line, the save toast and the failed steps through the translator', async () => {
    expect(pendingSummary(stageAdd(emptyPending(), [m('a')], []), t)).toBe('1 nicht gespeicherte Änderung');
    expect(saveSummary({ added: 2, removed: 0, excluded: 0, included: 0, assigned: 1, unassigned: 0, prunedFromChildren: 3 }, t))
      .toBe('Gespeichert: 2 hinzugefügt, 1 Benutzer zugeordnet; 3 aus untergeordneten Katalogen entfernt');
    expect(saveSummary({ added: 0, removed: 0, excluded: 0, included: 0, assigned: 0, unassigned: 0, prunedFromChildren: 0 }, t)).toBe('Gespeichert');
    const fail = () => Promise.reject(new Error('nein'));
    const out = await applyPending({ ...emptyPending(), addMembers: [m('a')], assign: { 'v@x': null } },
      { addModels: fail, removeModels: fail, excludeModels: fail, includeModels: fail, assignCatalog: fail, unassignCatalog: fail }, t);
    expect(out.failed.map((f) => f.step)).toEqual(['Modelle hinzufügen', 'Zuordnung von v@x aufheben']);
  });
});

describe('exclusion reason', () => {
  it('stores the English sentinel unchanged (it is data)', () => {
    expect(EXCLUDED_REASON).toBe('Excluded in the Model Library');
  });
  it('shows the bundle text for the sentinel, English before the bundle has loaded', () => {
    expect(exclusionReason(EXCLUDED_REASON, 'In der Modellbibliothek ausgeschlossen')).toBe('In der Modellbibliothek ausgeschlossen');
    expect(exclusionReason(EXCLUDED_REASON)).toBe('Excluded in the Model Library');
    expect(exclusionReason(EXCLUDED_REASON, null)).toBe('Excluded in the Model Library');
  });
  it('passes any other reason through as stored', () => {
    expect(exclusionReason('licence review', 'In der Modellbibliothek ausgeschlossen')).toBe('licence review');
    expect(exclusionReason(null, 'x')).toBe('');
    expect(exclusionReason(undefined)).toBe('');
  });
});

describe('team assignments (teams polish)', () => {
  const alpha = { teamId: 't-a', name: 'Alpha' };
  const beta = { teamId: 't-b', name: 'Beta' };
  const rows: TeamRow[] = [
    { ID: 't-a', name: 'Alpha', catalogId: null, catalogName: null, poolProfileId: 'p-1', poolProfileName: 'Light', memberProfileId: null, memberProfileName: null },
    { ID: 't-b', name: 'Beta', catalogId: 'c-1', catalogName: 'Engineering', poolProfileId: null, poolProfileName: null, memberProfileId: 'p-1', memberProfileName: 'Light' }
  ];
  it('stages per team and slot; staging the stored value again cancels it; counts towards the pending line', () => {
    let p = stageTeamAssign(emptyPending(), alpha, 'catalog', 'c-1', null);
    p = stageTeamAssign(p, beta, 'member', null, 'p-1');
    p = stageTeamAssign(p, alpha, 'pool', 'p-1', 'p-1');
    expect(pendingCount(p)).toBe(2);
    expect(Object.values(p.teams ?? {})).toEqual([{ ...alpha, slot: 'catalog', target: 'c-1' }, { ...beta, slot: 'member', target: null }]);
    expect(stageTeamAssign(p, alpha, 'catalog', null, null).teams).toEqual({ 't-b|member': { ...beta, slot: 'member', target: null } });
  });
  it('the teams table shows each slot with its staged value and says which are unsaved', () => {
    let p = stageTeamAssign(emptyPending(), alpha, 'member', 'p-2', null);
    p = stageTeamAssign(p, beta, 'catalog', null, 'c-1');
    const merged = mergeTeams(rows, p, { ID: 'p-2', name: 'Heavy' });
    expect(merged[0]).toMatchObject({ memberProfileId: 'p-2', memberProfileName: 'Heavy', pendingMember: true, poolProfileName: 'Light', pendingPool: false, pending: true });
    expect(merged[1]).toMatchObject({ catalogId: null, catalogName: null, pendingCatalog: true, memberProfileName: 'Light', pending: true });
  });
  it('Save writes the teams after the users, one at a time, and keeps a refused one staged', async () => {
    const calls: string[] = [];
    const ok = async () => ({});
    const invoke = {
      addModels: ok, removeModels: ok, excludeModels: ok, includeModels: ok,
      assignCatalog: async (e: string) => { calls.push(`user:${e}`); return {}; }, unassignCatalog: ok,
      assignTeam: async (teamId: string, slot: string, target: string | null) => {
        calls.push(`team:${teamId}:${slot}:${target}`);
        if (teamId === 't-b') throw new Error('refused');
        return {};
      }
    };
    let p = stageAssign(emptyPending(), 'u@x', 'c-1', null);
    p = stageTeamAssign(p, alpha, 'pool', 'p-2', 'p-1');
    p = stageTeamAssign(p, beta, 'catalog', null, 'c-1');
    const out = await applyPending(p, invoke);
    expect(calls).toEqual(['user:u@x', 'team:t-a:pool:p-2', 'team:t-b:catalog:null']);
    expect(out.remaining.teams).toEqual({ 't-b|catalog': { ...beta, slot: 'catalog', target: null } });
    expect(out.failed).toEqual([{ step: 'unassign team Beta', message: 'refused' }]);
    expect(saveSummary(out.results)).toBe('Saved: 1 user(s) assigned, 1 team(s) assigned');
    expect(saveSummary({ ...out.results, assigned: 0, teamsAssigned: 0, teamsUnassigned: 2 })).toBe('Saved: 2 team(s) unassigned');
  });
});
