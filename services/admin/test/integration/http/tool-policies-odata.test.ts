import path from 'path';
process.env.CDS_TYPESCRIPT = 'true';
const cds = require('@sap/cds');
cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: ':memory:' } };
cds.env.requires.auth = { kind: 'mocked', users: {
  'tp-admin@test.com': { id: 'tp-admin@test.com', roles: ['admin', 'user'] },
  'tp-user@test.com': { id: 'tp-user@test.com', roles: ['user'] } } };
const { GET, POST, PATCH, DELETE, axios } = cds.test(path.resolve(__dirname, '../../..'));
import * as users from '../../../src/services/usersService';
const ADMIN = { auth: { username: 'tp-admin@test.com', password: 'x' } };
const USER = { auth: { username: 'tp-user@test.com', password: 'x' } };
axios.defaults.validateStatus = () => true;

async function createPolicy(body: any) {
  // draft-enabled: create the draft, then activate
  const draft = await POST('/odata/v4/admin/ToolPolicies', body, ADMIN);
  expect(draft.status).toBe(201);
  const act = await POST(`/odata/v4/admin/ToolPolicies(ID=${draft.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
  expect(act.status).toBe(201);
  return act.data;
}

describe('ToolPolicies OData', () => {
  it('lists the seeded default policy for admins and hides the set from users', async () => {
    const list = await GET('/odata/v4/admin/ToolPolicies?$filter=isDefault eq true', ADMIN);
    expect(list.status).toBe(200);
    expect(list.data.value).toHaveLength(1);
    expect(list.data.value[0]).toMatchObject({ name: 'Default', mode: 'monitor' });
    expect((await GET('/odata/v4/admin/ToolPolicies', USER)).status).toBe(403);
  });

  it('creates a policy with entries and refuses bad patterns and modes', async () => {
    const p = await createPolicy({ name: 'Team', mode: 'strip', allows: [{ pattern: 'function:*' }], denies: [{ pattern: 'mcp:github/*' }] });
    expect(p.mode).toBe('strip');
    const allows = await GET(`/odata/v4/admin/ToolPolicies(ID=${p.ID},IsActiveEntity=true)/allows`, ADMIN);
    expect(allows.data.value.map((a: any) => a.pattern)).toEqual(['function:*']);
    const bad = await POST('/odata/v4/admin/ToolPolicies', { name: 'Bad', mode: 'block' }, ADMIN);
    const badActivate = bad.status === 201 ? await POST(`/odata/v4/admin/ToolPolicies(ID=${bad.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN) : bad;
    expect(badActivate.status).toBe(400);
    expect(JSON.stringify(badActivate.data)).toContain('mode must be monitor, strip or reject');
  });

  it('creates a policy with sensitive tools and untrusted sources, refuses a malformed untrusted pattern, and cascades their deletion', async () => {
    const p = await createPolicy({ name: 'Trust', mode: 'strip', sensitive: [{ pattern: 'function:shell' }], untrusted: [{ pattern: 'hosted:web_search' }] });
    const read = await GET(`/odata/v4/admin/ToolPolicies(ID=${p.ID},IsActiveEntity=true)?$expand=sensitive,untrusted`, ADMIN);
    expect(read.status).toBe(200);
    expect(read.data.sensitive.map((s: any) => s.pattern)).toEqual(['function:shell']);
    expect(read.data.untrusted.map((u: any) => u.pattern)).toEqual(['hosted:web_search']);

    const badUntrusted = await POST('/odata/v4/admin/ToolPolicies', { name: 'BadUntrusted', mode: 'monitor', untrusted: [{ pattern: 'mcp:browser/**' }] }, ADMIN);
    expect(badUntrusted.status).toBe(201);
    const badUntrustedActivate = await POST(`/odata/v4/admin/ToolPolicies(ID=${badUntrusted.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    expect(badUntrustedActivate.status).toBe(400);
    expect(JSON.stringify(badUntrustedActivate.data)).toContain('untrusted source pattern \\"mcp:browser/**\\"');

    expect((await DELETE(`/odata/v4/admin/ToolPolicies(ID=${p.ID},IsActiveEntity=true)`, ADMIN)).status).toBe(204);
    const sensitiveAfter = await GET(`/odata/v4/admin/ToolPolicySensitive?$filter=policy_ID eq ${p.ID}`, ADMIN);
    expect(sensitiveAfter.data.value).toEqual([]);
  });

  it('refuses an allow or deny pattern that does not match the namespace:name[*] syntax', async () => {
    const HINT = 'must look like function:name, hosted:type[/name] or mcp:server[/tool], optionally ending in *';
    const badAllow = await POST('/odata/v4/admin/ToolPolicies', { name: 'BadAllowPattern', mode: 'monitor', allows: [{ pattern: 'function:a*b' }] }, ADMIN);
    expect(badAllow.status).toBe(201);
    const badAllowActivate = await POST(`/odata/v4/admin/ToolPolicies(ID=${badAllow.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    expect(badAllowActivate.status).toBe(400);
    expect(JSON.stringify(badAllowActivate.data)).toContain(HINT);

    const badDeny = await POST('/odata/v4/admin/ToolPolicies', { name: 'BadDenyPattern', mode: 'monitor', denies: [{ pattern: 'function:' }] }, ADMIN);
    expect(badDeny.status).toBe(201);
    const badDenyActivate = await POST(`/odata/v4/admin/ToolPolicies(ID=${badDeny.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    expect(badDenyActivate.status).toBe(400);
    expect(JSON.stringify(badDenyActivate.data)).toContain(HINT);

    const good = await createPolicy({ name: 'GoodWildcardPattern', mode: 'monitor', allows: [{ pattern: 'function:*' }] });
    expect(good.mode).toBe('monitor');
  });

  // The Fiori list creates an allow/deny entry inline, against the DRAFT root's navigation — which
  // is why the two child projections cannot be @readonly (that answers the inline POST with 405).
  // A write addressed straight at an active child is refused by cds itself, and the child
  // handlers validate the pattern for anything that does reach them.
  it('creates an inline allow entry on the draft and refuses a direct write to the child set', async () => {
    const draft = await POST('/odata/v4/admin/ToolPolicies', { name: 'Inline', mode: 'monitor' }, ADMIN);
    expect(draft.status).toBe(201);
    const inline = await POST(`/odata/v4/admin/ToolPolicies(ID=${draft.data.ID},IsActiveEntity=false)/allows`, { pattern: 'function:inline_*' }, ADMIN);
    expect(inline.status).toBe(201);
    const act = await POST(`/odata/v4/admin/ToolPolicies(ID=${draft.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    expect(act.status).toBe(201);
    const allows = await GET(`/odata/v4/admin/ToolPolicies(ID=${draft.data.ID},IsActiveEntity=true)/allows`, ADMIN);
    expect(allows.data.value.map((a: any) => a.pattern)).toEqual(['function:inline_*']);
    // Addressing a child set directly is refused by the draft runtime itself, for an admin too:
    // a draft-enabled entity is only writable through its root.
    const direct = await POST('/odata/v4/admin/ToolPolicyAllows', { pattern: 'function:sneaky', policy_ID: draft.data.ID }, ADMIN);
    expect(direct.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(direct.data)).toContain('only be modified via its root entity');
    const directDeny = await POST('/odata/v4/admin/ToolPolicyDenies', { pattern: 'function:sneaky', policy_ID: draft.data.ID }, ADMIN);
    expect(directDeny.status).toBeGreaterThanOrEqual(400);
    expect((await POST('/odata/v4/admin/ToolPolicyAllows', { pattern: 'function:sneaky' }, USER)).status).toBe(403);
  });

  it('wires the bound assignUser/unassignUser/assignApiKey/unassignApiKey actions on ToolPolicies', async () => {
    const policy = await createPolicy({ name: 'Bound', mode: 'monitor' });
    await users.touch(cds.db, 'tp-bound-user@test.com', { roles: ['user'] });
    const policyPath = `/odata/v4/admin/ToolPolicies(ID=${policy.ID},IsActiveEntity=true)`;
    const userPath = "/odata/v4/admin/Users(email='tp-bound-user@test.com',IsActiveEntity=true)?$select=toolPolicy_ID";

    const assignUser = await POST(`${policyPath}/AdminService.assignUser`, { email: 'tp-bound-user@test.com' }, ADMIN);
    expect(assignUser.status).toBe(200);
    expect((await GET(userPath, ADMIN)).data.toolPolicy_ID).toBe(policy.ID);

    const unassignUser = await POST(`${policyPath}/AdminService.unassignUser`, { email: 'tp-bound-user@test.com' }, ADMIN);
    expect(unassignUser.status).toBe(200);
    expect((await GET(userPath, ADMIN)).data.toolPolicy_ID).toBeNull();

    expect((await POST(`${policyPath}/AdminService.assignUser`, { email: 'nobody-bound@test.com' }, ADMIN)).status).toBe(404);
    expect((await POST(`${policyPath}/AdminService.assignUser`, { email: 'tp-bound-user@test.com' }, USER)).status).toBe(403);

    const keyDraft = await POST('/odata/v4/admin/ApiKeys', { name: 'tp-bound-key', email: 'tp-bound-keyowner@test.com' }, ADMIN);
    expect(keyDraft.status).toBe(201);
    const keyActivate = await POST(`/odata/v4/admin/ApiKeys(ID=${keyDraft.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    expect(keyActivate.status).toBe(201);
    const keyId = keyDraft.data.ID;
    const keyPath = `/odata/v4/admin/ApiKeys(ID=${keyId},IsActiveEntity=true)?$select=toolPolicy_ID`;

    const assignApiKey = await POST(`${policyPath}/AdminService.assignApiKey`, { keyId }, ADMIN);
    expect(assignApiKey.status).toBe(200);
    expect((await GET(keyPath, ADMIN)).data.toolPolicy_ID).toBe(policy.ID);

    const unassignApiKey = await POST(`${policyPath}/AdminService.unassignApiKey`, { keyId }, ADMIN);
    expect(unassignApiKey.status).toBe(200);
    expect((await GET(keyPath, ADMIN)).data.toolPolicy_ID).toBeNull();

    expect((await POST(`${policyPath}/AdminService.assignApiKey`, { keyId: '00000000-0000-0000-0000-000000000000' }, ADMIN)).status).toBe(404);
  });

  it('assigns and unassigns a user and a key, invalidating nothing visibly but returning the rows', async () => {
    await users.touch(cds.db, 'tp-user@test.com', { roles: ['user'] });
    const team = (await GET("/odata/v4/admin/ToolPolicies?$filter=name eq 'Team'", ADMIN)).data.value[0];
    const a = await POST('/odata/v4/admin/assignToolPolicy', { email: 'tp-user@test.com', policyId: team.ID }, ADMIN);
    expect(a.status).toBe(200);
    expect(a.data.toolPolicy_ID).toBe(team.ID);
    const withCount = await GET(`/odata/v4/admin/ToolPolicies(ID=${team.ID},IsActiveEntity=true)?$select=assignedUsers`, ADMIN);
    expect(withCount.data.assignedUsers).toBe(1);
    const u = await POST('/odata/v4/admin/unassignToolPolicy', { email: 'tp-user@test.com' }, ADMIN);
    expect(u.data.toolPolicy_ID).toBeNull();
    expect((await POST('/odata/v4/admin/assignToolPolicy', { email: 'nobody@test.com', policyId: team.ID }, ADMIN)).status).toBe(404);
    expect((await POST('/odata/v4/admin/assignToolPolicy', { email: 'tp-user@test.com', policyId: team.ID }, USER)).status).toBe(403);
  });

  it('refuses to delete the default and releases assignments when deleting another policy', async () => {
    const def = (await GET('/odata/v4/admin/ToolPolicies?$filter=isDefault eq true', ADMIN)).data.value[0];
    expect((await DELETE(`/odata/v4/admin/ToolPolicies(ID=${def.ID},IsActiveEntity=true)`, ADMIN)).status).toBe(400);
    const team = (await GET("/odata/v4/admin/ToolPolicies?$filter=name eq 'Team'", ADMIN)).data.value[0];
    await POST('/odata/v4/admin/assignToolPolicy', { email: 'tp-user@test.com', policyId: team.ID }, ADMIN);
    // An API key assignment must be released too: nothing in the database enforces it (the policy
    // is reached through an unmanaged association, so there is no cascade), and a key left pointing
    // at a deleted policy would be governed by a policy nobody can see or edit.
    const keyDraft = await POST('/odata/v4/admin/ApiKeys', { name: 'tp-delete-key', email: 'tp-delete-keyowner@test.com' }, ADMIN);
    await POST(`/odata/v4/admin/ApiKeys(ID=${keyDraft.data.ID},IsActiveEntity=false)/AdminService.draftActivate`, {}, ADMIN);
    await POST(`/odata/v4/admin/ToolPolicies(ID=${team.ID},IsActiveEntity=true)/AdminService.assignApiKey`, { keyId: keyDraft.data.ID }, ADMIN);

    expect((await DELETE(`/odata/v4/admin/ToolPolicies(ID=${team.ID},IsActiveEntity=true)`, ADMIN)).status).toBe(204);

    const user = await GET("/odata/v4/admin/Users(email='tp-user@test.com',IsActiveEntity=true)?$select=toolPolicy_ID", ADMIN);
    expect(user.data.toolPolicy_ID).toBeNull();
    const key = await GET(`/odata/v4/admin/ApiKeys(ID=${keyDraft.data.ID},IsActiveEntity=true)?$select=toolPolicy_ID`, ADMIN);
    expect(key.data.toolPolicy_ID).toBeNull();
  });

  it('serves the inventory over a day range', async () => {
    const T = 'sap.llm.gateway.admin.ToolUsageDaily';
    const today = new Date().toISOString().slice(0, 10);
    await cds.db.run(cds.ql.INSERT.into(T).entries([
      { email: 'a@test.com', day: today, identity: 'function:x', facet: 'declared', requests: 3, allowed: 3, lastSeen: new Date().toISOString() },
      { email: 'b@test.com', day: today, identity: 'function:x', facet: 'declared', requests: 1, stripped: 1, lastSeen: new Date().toISOString() },
      { email: 'a@test.com', day: '2020-01-01', identity: 'function:old', facet: 'invoked', requests: 9, allowed: 9, lastSeen: '2020-01-01T00:00:00.000Z' }
    ]));
    await cds.db.run(cds.ql.INSERT.into('sap.llm.gateway.admin.ToolUsageAgentDaily').entries([
      { email: 'a@test.com', day: today, identity: 'function:x', facet: 'declared', agent: 'claude-cli', requests: 3, lastSeen: new Date().toISOString() },
      { email: 'b@test.com', day: today, identity: 'function:x', facet: 'declared', agent: 'codex', requests: 1, lastSeen: new Date().toISOString() },
      { email: 'a@test.com', day: '2020-01-01', identity: 'function:old', facet: 'invoked', agent: 'axios', requests: 9, lastSeen: '2020-01-01T00:00:00.000Z' }
    ]));
    const r = await GET('/odata/v4/admin/ToolInventory?$orderby=identity', ADMIN);
    expect(r.status).toBe(200);
    expect(r.data.value.map((v: any) => [v.identity, v.facet, v.users, v.requests, v.allowed, v.stripped])).toEqual([['function:x', 'declared', 2, 4, 3, 1]]);
    expect(r.data.value[0].lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // which client program asked for the tool, from the per-agent daily rows, inside the same day range
    expect(r.data.value[0].agents).toBe('claude-cli, codex');
    // The period is ONE filter with a range, which is the shape Fiori Elements sends for a
    // SingleRange date field and for every semantic operator ("Last 30 Days"); the ends may arrive
    // in either order, a single day pins both ends, and any other operator is a 400 rather than a
    // silently ignored filter that would hand back the default window.
    const range = await GET(`/odata/v4/admin/ToolInventory?$filter=day ge 2019-12-31 and day le ${today}`, ADMIN);
    expect(range.status).toBe(200);
    expect(range.data.value.map((v: any) => v.identity).sort()).toEqual(['function:old', 'function:x']);
    expect(range.data.value[0].day).toBe(today);
    const reversed = await GET(`/odata/v4/admin/ToolInventory?$filter=day le ${today} and day ge 2019-12-31`, ADMIN);
    expect(reversed.status).toBe(200);
    expect(reversed.data.value.map((v: any) => v.identity).sort()).toEqual(['function:old', 'function:x']);
    const oneDay = await GET('/odata/v4/admin/ToolInventory?$filter=day eq 2020-01-01', ADMIN);
    expect(oneDay.status).toBe(200);
    expect(oneDay.data.value.map((v: any) => v.identity)).toEqual(['function:old']);
    const bad = await GET('/odata/v4/admin/ToolInventory?$filter=day gt 2019-12-31', ADMIN);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.data)).toContain('day supports only eq, ge and le');
    expect((await GET('/odata/v4/admin/ToolInventory', USER)).status).toBe(403);
    // The filter bar renders the period as a date control and the facet as a dropdown only because
    // of these two annotations.
    const meta = await GET('/odata/v4/admin/$metadata', ADMIN);
    const inventory = /<Annotations Target="AdminService.EntityContainer\/ToolInventory">([\s\S]*?)<\/Annotations>/.exec(meta.data)?.[1] ?? '';
    expect(inventory).toMatch(/FilterExpressionRestrictions[\s\S]*?PropertyPath="day"[\s\S]*?AllowedExpressions" String="SingleRange"/);
    const facetBlock = /<Annotations Target="AdminService.ToolInventory\/facet">([\s\S]*?)<\/Annotations>/.exec(meta.data)?.[1] ?? '';
    expect(facetBlock).toContain('Common.ValueListWithFixedValues');
  });

  /**
   * Filtering the table was the reported gap: the filter bar had no Tool field, and anything but an
   * exact match - a "contains" from Adapt Filters, the search box - was silently dropped, so the
   * table answered with every row and read as a filter that does nothing.
   */
  it('filters the inventory by tool, facet, client program and the search field', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const names = async (query: string) => {
      const r = await GET(`/odata/v4/admin/ToolInventory?${query}`, ADMIN);
      expect(r.status).toBe(200);
      return r.data.value.map((v: any) => `${v.identity}|${v.facet}`).sort();
    };
    const all = `day%20ge%202019-12-31%20and%20day%20le%20${today}`;
    expect(await names(`$filter=${all}`)).toEqual(['function:old|invoked', 'function:x|declared']);
    // contains, startswith and endswith on the Tool column
    expect(await names(`$filter=${all}%20and%20contains(identity,'old')`)).toEqual(['function:old|invoked']);
    expect(await names(`$filter=${all}%20and%20startswith(identity,'function:x')`)).toEqual(['function:x|declared']);
    expect(await names(`$filter=${all}%20and%20endswith(identity,'old')`)).toEqual(['function:old|invoked']);
    // several values of one field are alternatives
    expect(await names(`$filter=${all}%20and%20(identity%20eq%20'function:old'%20or%20identity%20eq%20'function:x')`))
      .toEqual(['function:old|invoked', 'function:x|declared']);
    // the client program that asked for the tool, and the free-text search over both
    expect(await names(`$filter=${all}%20and%20agents%20eq%20'codex'`)).toEqual(['function:x|declared']);
    expect(await names(`$filter=${all}%20and%20agents%20eq%20'nobody'`)).toEqual([]);
    expect(await names(`$filter=${all}&$search=axios`)).toEqual(['function:old|invoked']);
    expect(await names(`$filter=${all}&$search=OLD`)).toEqual(['function:old|invoked']);
    // and a filter the page cannot honour is refused, never silently ignored
    const bad = await GET(`/odata/v4/admin/ToolInventory?$filter=${all}%20and%20users%20eq%201`, ADMIN);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.data)).toContain('users cannot be filtered');
  });

  it('narrows both value helps by what has been typed into the field', async () => {
    // mdc sends the partial entry as a contains filter; ignoring it left the dropdown showing every
    // recorded tool however much had been typed.
    const tools = await GET("/odata/v4/admin/ToolIdentities?$filter=contains(identity,'old')", ADMIN);
    expect(tools.status).toBe(200);
    expect(tools.data.value.map((v: any) => v.identity)).toEqual(['function:old']);
    const agents = await GET("/odata/v4/admin/ToolAgents?$filter=contains(agent,'cla')", ADMIN);
    expect(agents.status).toBe(200);
    expect(agents.data.value.map((v: any) => v.agent)).toEqual(['claude-cli']);
  });

  it('offers the recorded client programs as a value help for the Requested By filter', async () => {
    const list = await GET('/odata/v4/admin/ToolAgents', ADMIN);
    expect(list.status).toBe(200);
    expect(list.data.value.map((v: any) => [v.agent, v.tools, v.requests])).toEqual([
      ['axios', 1, 9], ['claude-cli', 1, 3], ['codex', 1, 1]
    ]);
    expect((await GET('/odata/v4/admin/ToolAgents', USER)).status).toBe(403);
  });

  it('offers the two facets as a fixed-value help for the inventory filter', async () => {
    const list = await GET('/odata/v4/admin/ToolFacets', ADMIN);
    expect(list.status).toBe(200);
    expect(list.data.value.map((v: any) => v.code)).toEqual(['declared', 'invoked', 'source']);
  });

  it('offers the recorded tool identities as a value help for policy patterns', async () => {
    const list = await GET('/odata/v4/admin/ToolIdentities?$orderby=identity', ADMIN);
    expect(list.status).toBe(200);
    expect(list.data.value.map((v: any) => [v.identity, v.users, v.requests])).toEqual([
      ['function:old', 1, 9], ['function:x', 2, 4]
    ]);
    expect(list.data.value[1].lastSeen).toMatch(/Z$/);
    expect((await GET('/odata/v4/admin/ToolIdentities', USER)).status).toBe(403);
  });

  /**
   * The object page shows the assigned users and the assigned API keys as tables over two
   * associations. Fiori Elements offers Create and Delete on such a table whenever the TARGET set
   * allows them - Users carries Capabilities.InsertRestrictions.Insertable: false and so stayed
   * quiet, while ApiKeys does not and produced a Create button that could only fail with "Active
   * entities cannot be modified via draft request". Assignment is not a creation: it runs through
   * the four bound actions, so both navigations are annotated non-insertable and non-deletable.
   */
  it('declares the assignment tables as neither insertable nor deletable through the policy', async () => {
    const meta = await GET('/odata/v4/admin/$metadata', ADMIN);
    expect(meta.status).toBe(200);
    // Capabilities annotations target the entity SET, not the entity type.
    const block = /<Annotations Target="AdminService.EntityContainer\/ToolPolicies">([\s\S]*?)<\/Annotations>/.exec(meta.data)?.[1] ?? '';
    expect(block).toContain('Capabilities.NavigationRestrictions');
    for (const nav of ['assignedUsersList', 'assignedKeys']) {
      // One restriction record reaches up to the next navigation property, or to the end.
      const restriction = new RegExp(`NavigationPropertyPath="${nav}"([\\s\\S]*?)(?=NavigationPropertyPath=|$)`).exec(block)?.[1] ?? '';
      expect(restriction).toMatch(/InsertRestrictions[\s\S]*?Insertable" Bool="false"/);
      expect(restriction).toMatch(/DeleteRestrictions[\s\S]*?Deletable" Bool="false"/);
    }
  });
});
