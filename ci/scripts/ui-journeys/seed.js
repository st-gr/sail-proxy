#!/usr/bin/env node
'use strict';

// Purge + seed the UI-journey fixtures over OData as the dev admin user.
//   ADMIN_SERVICE_URL=http://localhost:4014 node ci/scripts/ui-journeys/seed.js
// Safety: refuses any target whose whoami is not the dev-mode admin test user. It then
// deletes EVERY draft, API key, AWS credential, non-default tool policy and non-default model
// catalog — in the
// pipeline this runs after the last phase that reads the CI database (Phase 6.5);
// standalone it must only ever see a throwaway admin (see run.js).

const fs = require('fs');
const path = require('path');
const { createClient } = require('./odata');
const fixtures = require('./fixtures');
const roles = require('./roles');

const REPORT_DIR = path.resolve(__dirname, '../../reports/ui-journeys');
const SETS = ['ApiKeys', 'AwsCredentials', 'ToolPolicies'];

// run.js's UI_JOURNEYS_APPS filter has to reach the seed as well: a fixture whose journeys are
// not in this run is not seeded. The model-library fixtures cannot even be seeded without a
// gateway (refreshModelLibrary fails on a standalone throwaway admin); the quota and
// security-event fixtures would only be cost the run never reads back.
function inThisRun(...apps) {
  const filter = process.env.UI_JOURNEYS_APPS;
  if (!filter) return true;
  const wanted = filter.split(',').map((name) => name.trim());
  return apps.some((app) => wanted.includes(app));
}

// run.js seeds before every role × app run and names the app here; unset when seed.js runs alone.
const SEEDING_FOR = process.env.UI_JOURNEYS_SEED_APP || null;

async function guard(client) {
  const who = await client.post('/whoami');
  const ok = who && who.deployTarget === 'development' && who.isAdmin === true && who.user === fixtures.users.admin;
  if (!ok) {
    throw new Error(`refusing to seed: whoami returned ${JSON.stringify(who)} — expected the dev-mode admin test user`);
  }
}

/**
 * Refuses a target that holds credentials belonging to a real person.
 *
 * The port guard above is not enough: a throwaway admin that lost the race for its port (EADDRINUSE)
 * still logs its own scratch database and still answers `whoami` as the dev admin, while a stray
 * admin on that same port serves the maintainer's development database. Two runs deleted the dev
 * API keys exactly that way. An API key or AWS credential whose owner is neither a mocked fixture
 * user nor a platform service key means the target is somebody's real database, so nothing is
 * purged. The pipeline restores its database afterwards and opts out with UI_JOURNEYS_IN_PIPELINE.
 */
const FIXTURE_EMAILS = new Set(Object.values(fixtures.users));

async function refuseForeignCredentials(client) {
  if (process.env.UI_JOURNEYS_IN_PIPELINE === '1') return;
  const foreign = [];
  for (const set of ['ApiKeys', 'AwsCredentials']) {
    const page = await client.get(`/${set}?$select=ID,name,email&$top=100&$filter=${encodeURIComponent('IsActiveEntity eq true')}`);
    for (const row of page.value) {
      const email = String(row.email || '');
      if (email.endsWith('.service.key') || FIXTURE_EMAILS.has(email)) continue;
      if (String(row.name || '').startsWith(fixtures.prefix)) continue;
      foreign.push(`${set}: ${row.name} (${email})`);
    }
  }
  if (foreign.length > 0) {
    throw new Error('refusing to seed: this admin serves a database with credentials that are not journey fixtures —\n  '
      + foreign.join('\n  ')
      + '\nStart the throwaway admin on a free port and check that IT owns the port (lsof -ti:<port>) before seeding.');
  }
}

async function purge(client) {
  let deleted = 0;
  for (const set of SETS) {
    // Drafts first: an open draft blocks deleting its active row.
    for (const active of [false, true]) {
      for (;;) {
        // Platform service keys (email *.service.key, e.g. the admin's own gateway key) are not
        // fixtures: deleting them would break the admin's calls to the gateway while its cached
        // key is still in memory (refreshModelLibrary -> 401). The default tool policy cannot be
        // deleted (assertDeletable rejects it) and must survive every run.
        const keep = set === 'ApiKeys' ? " and not endswith(email,'.service.key')"
          : set === 'ToolPolicies' ? ' and isDefault eq false'
          : '';
        const filter = encodeURIComponent(`IsActiveEntity eq ${active}${keep}`);
        const page = await client.get(`/${set}?$select=ID&$filter=${filter}&$top=50`);
        if (page.value.length === 0) break;
        for (const row of page.value) {
          await client.del(`/${set}(ID=${row.ID},IsActiveEntity=${active})`);
          deleted += 1;
        }
      }
    }
  }
  return deleted;
}

async function createApiKey(client, name, email) {
  const created = await client.post('/createApiKey', { name, email });
  return created.id;
}

// Only an admin may set the flag, and only through the draft flow (lean draft: a
// direct PATCH on the active entity is answered with 501).
async function setNeverExpires(client, id) {
  await client.post(`/ApiKeys(ID=${id},IsActiveEntity=true)/AdminService.draftEdit`, { PreserveChanges: true });
  await client.patch(`/ApiKeys(ID=${id},IsActiveEntity=false)`, { neverExpires: true });
  await client.post(`/ApiKeys(ID=${id},IsActiveEntity=false)/AdminService.draftActivate`);
}

async function createAwsCredential(client, name, email) {
  const created = await client.post('/createAwsCredentials', {
    userId: email, email, name, description: 'UI journey fixture', permissions: []
  });
  return { id: created.id, accessKeyId: created.accessKeyId };
}

async function seed(client) {
  const { names, users } = fixtures;
  const apiKeys = {};
  apiKeys[names.userActiveKey] = await createApiKey(client, names.userActiveKey, users.user);
  apiKeys[names.userNeverExpiresKey] = await createApiKey(client, names.userNeverExpiresKey, users.user);
  await setNeverExpires(client, apiKeys[names.userNeverExpiresKey]);
  apiKeys[names.adminKey] = await createApiKey(client, names.adminKey, users.admin);
  apiKeys[names.otherUserKey] = await createApiKey(client, names.otherUserKey, users.other);
  const awsCredentials = {};
  awsCredentials[names.userAwsCredential] = await createAwsCredential(client, names.userAwsCredential, users.user);
  awsCredentials[names.otherUserAwsCredential] = await createAwsCredential(client, names.otherUserAwsCredential, users.other);
  return { apiKeys, awsCredentials };
}

// ---- Cockpit preferences --------------------------------------------------------------------
// The shell Settings journey changes the signed-in role's theme and language and puts them back;
// a run that fails half-way would leave them changed for the next one. Every role starts from the
// defaults: Light and the browser language ('' — the same as never chosen). updateUserPreference
// acts on the caller only, so it is called as each role; getCurrentUserPreferences creates the row.
async function resetCockpitPreferences(adminUrl) {
  for (const role of Object.values(roles)) {
    const client = createClient(adminUrl, role.credentials);
    await client.post('/getCurrentUserPreferences');
    await client.post('/updateUserPreference', { key: 'theme', value: 'sap_horizon' });
    await client.post('/updateUserPreference', { key: 'language', value: '' });
  }
}

// ---- Users & quotas fixtures --------------------------------------------------------------
// Users rows exist as soon as a key was created for the e-mail (usersService.touch). Reset the
// user's state from a previous run, then set the minimal constraints and post synthetic usage.
async function seedQuotas(client, apiKeys) {
  const { names, users, quota } = fixtures;
  // reactivate() (userLifecycleService.ts) is idempotent: an already-active user is a 200 with
  // body {"status":"active",...}, not a rejection - confirmed live (curl) against a fresh row.
  // This only rejects when the admin still reports the user active despite the non-2xx (kept for
  // safety against a future response-shape change); any other failure - e.g. the 404 "User <email>
  // not found" a still-missing row would return - must stop the seed, not be swallowed.
  await client.post('/reactivateUser', { email: users.user }).catch((error) => {
    if (!/"status":\s*"active"/.test(error.message)) throw error;
  });
  await client.post('/setUserConstraints', { email: users.user, constraints: {
    requestsPerMinute: null, spendPerDay: quota.spendPerDay, spendPerWeek: null, spendPerMonth: null,
    tokensPerDay: quota.tokensPerDay, tokensPerWeek: null, tokensPerMonth: null } });
  await client.post('/setUserConstraints', { email: users.other, constraints: {
    requestsPerMinute: null, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null } });
  await client.post('/resetUserQuotas', { emails: [users.user, users.other] });
  // usage rows dated now: two requests of seededTokens/2 tokens each, priced by the model-cost service.
  // usageEventProcessor stores validFrom as new Date(event.timestamp * 1000) - the events array
  // takes Unix epoch SECONDS, not the milliseconds Date.now() returns. The window query is
  // validFrom >= quotaResetAt (millisecond precision): flooring to the current second can land
  // just *before* the resetUserQuotas watermark and get excluded, so start two seconds ahead.
  const nowSeconds = Math.floor(Date.now() / 1000) + 2;
  const events = [];
  for (let i = 0; i < quota.seededRequests; i += 1) {
    events.push({ requestId: `${names.userActiveKey}-${nowSeconds}-${i}`, timestamp: nowSeconds - i, authType: 'api_key', credentialId: apiKeys[names.userActiveKey],
      provider: 'anthropic', model: 'anthropic--claude-4.5-haiku', inputTokens: quota.seededTokens / quota.seededRequests, outputTokens: 0,
      responseTime: 100, statusCode: 200 });
  }
  await client.post('/processUsageEvents', { events });
  // Quota profile: the seeded Standard profile (services/admin startup) assigned to the fixture
  // user, so the object page's Entitlement section has a profile to show.
  const profiles = await client.get(`/QuotaProfiles?$select=ID,requestsPerMinute,tokensPerDay,spendPerDay&$filter=${encodeURIComponent(`name eq '${quota.profileName}'`)}&$top=1`);
  const profile = profiles.value[0];
  if (!profile) throw new Error(`no QuotaProfiles row named '${quota.profileName}' — the admin has never run its quota-profile seed`);
  const assigned = await client.post('/assignQuotaProfile', { email: users.user, profileId: profile.ID });
  // The user's active key carries a per-credential limit of its own, so the credential journeys
  // can check that "Set Rate Limits" opens with the current value beside the owner's limit.
  await client.post(`/ApiKeys(ID=${apiKeys[names.userActiveKey]},IsActiveEntity=true)/AdminService.setRateLimits`, { requestsPerMinute: quota.keyRequestsPerMinute });
  // The profile's figures and the billing currency ride along so the object-page journeys can
  // derive the "Default" and "Owner's Limit" lines they expect instead of pinning the starter's numbers.
  return {
    user: users.user, other: users.other, tokens: quota.seededTokens, tokensPerDay: quota.tokensPerDay,
    profileName: quota.profileName, profileRequestsPerMinute: profile.requestsPerMinute, profileTokensPerDay: profile.tokensPerDay, profileSpendPerDay: profile.spendPerDay,
    currency: assigned.sapCostCurrency, keyRequestsPerMinute: quota.keyRequestsPerMinute
  };
}

// The grounding journeys ingest and search as the user on purpose, and a cockpit search is checked
// against the searcher's quota. Their real usage (chunk contexts plus embeddings, ~800 tokens a run)
// on top of the quota fixture's 400 passes its tokensPerDay as soon as the admin's next 30 s usage
// batch lands, so whether a search was refused depended on timing. Before grounding-app the user
// is active, has no constraints of its own and starts the day at zero.
async function liftQuotas(client) {
  const { users } = fixtures;
  await client.post('/reactivateUser', { email: users.user }).catch((error) => {
    if (!/"status":\s*"active"/.test(error.message)) throw error;
  });
  await client.post('/setUserConstraints', { email: users.user, constraints: {
    requestsPerMinute: null, spendPerDay: null, spendPerWeek: null, spendPerMonth: null, tokensPerDay: null, tokensPerWeek: null, tokensPerMonth: null } });
  await client.post('/resetUserQuotas', { emails: [users.user] });
}

// ---- Security Notifications fixture -------------------------------------------------------
async function seedSecurityEvent(client, apiKeys) {
  const { names, securityEvent } = fixtures;
  // the seed deleted every key and notification of a previous run is left where it is (deleting
  // a notification is age-gated server-side, spec §6): every run's fixture shares the same
  // clientIP, so the list can carry several of them by the time this app's journey runs. The
  // object page journey navigates straight to this run's own row by ID rather than filtering the
  // list down to one, which the shared IP cannot guarantee.
  const requestId = `${securityEvent.requestId} ${Date.now()}`;
  const key = await client.get(`/ApiKeys(ID=${apiKeys[names.userActiveKey]},IsActiveEntity=true)?$select=key`);
  await client.post('/logSecurityEvent', { credentialId: key.key, authType: 'api_key', eventType: 'failed_auth', severity: 'high',
    description: 'UI journey fixture', clientIP: securityEvent.clientIP, userAgent: securityEvent.userAgent, endpoint: securityEvent.endpoint,
    requestId, actionTaken: 'blocked' });
  const created = await client.get(`/MySecurityNotifications?$select=ID&$filter=${encodeURIComponent(`requestId eq '${requestId}'`)}&$top=1`);
  const id = created.value[0] && created.value[0].ID;
  if (!id) throw new Error(`logSecurityEvent did not create a MySecurityNotifications row for requestId ${requestId}`);
  return { requestId, clientIP: securityEvent.clientIP, id };
}

// ---- Model Library fixtures ----------------------------------------------------------------
// The snapshot itself comes from the gateway (Phase 5 runs it): refreshModelLibrary is a
// read-only list call, no tokens are spent. Catalog state is reset to "default only" before
// seeding.

async function purgeLibrary(client) {
  // assignments first (a deletion below would 409 on an assigned catalog)
  const users = await client.get('/libraryUsers()');
  for (const u of users.value || []) if (u.catalogId) await client.post('/unassignCatalog', { email: u.email });
  // children before parents, never the default
  for (const pass of ['parent_ID ne null', 'parent_ID eq null']) {
    const filter = encodeURIComponent(`isDefault eq false and ${pass}`);
    const page = await client.get(`/ModelCatalogs?$select=ID,isDefault&$filter=${filter}&$top=200`);
    for (const row of page.value) await client.del(`/ModelCatalogs(${row.ID})`);
  }
  const def = (await client.get(`/ModelCatalogs?$select=ID&$filter=${encodeURIComponent('isDefault eq true')}`)).value[0];
  if (!def) throw new Error('no default catalog — the admin has never run its model-library migration');
  const excl = await client.get(`/ModelCatalogExclusions?$select=modelId&$filter=${encodeURIComponent(`catalog_ID eq ${def.ID}`)}&$top=500`);
  if (excl.value.length) await client.post(`/ModelCatalogs(${def.ID})/AdminService.includeModels`, { modelIds: excl.value.map((e) => e.modelId) });
  return def.ID;
}

// Quota profiles live beside the catalogs in the same app, and ProfilesJourney creates its own.
// Only rows named with the fixture prefix are dropped: the three starters are the product's, and
// seedQuotas may have just assigned one of them to the fixture user.
async function purgeProfiles(client) {
  const filter = encodeURIComponent(`startswith(name,'${fixtures.prefix}')`);
  const page = await client.get(`/QuotaProfiles?$select=ID,name&$filter=${filter}&$top=200`);
  if (page.value.length === 0) return 0;
  const ids = new Set(page.value.map((row) => row.ID));
  // assignments first: deleting a profile somebody still carries is answered with a 409
  const users = await client.get('/quotaProfileUsers()');
  for (const u of users.value || []) {
    if (u.profileId && ids.has(u.profileId)) await client.post('/unassignQuotaProfile', { email: u.email });
  }
  for (const row of page.value) await client.del(`/QuotaProfiles(${row.ID})`);
  return page.value.length;
}

// Runs fn up to `attempts` times, `delayMs` apart, and rethrows the last error. Only for the
// steps that depend on something outside the runner; everything else fails on the first error.
async function withRetries(what, attempts, delayMs, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      console.warn(`[ui-journeys] ${what} attempt ${attempt}/${attempts} failed: ${error.message} - retrying in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function seedLibrary(client, defaultId) {
  const { names, users } = fixtures;
  // Local runs against a throwaway admin have no gateway: UI_JOURNEYS_SKIP_LIBRARY_REFRESH keeps
  // the snapshot the scratch database already holds (see chapter 9). The pipeline never sets it.
  if (process.env.UI_JOURNEYS_SKIP_LIBRARY_REFRESH) {
    console.log('[ui-journeys] UI_JOURNEYS_SKIP_LIBRARY_REFRESH is set - using the existing library snapshot');
  } else {
    // The refresh makes the Phase 5 gateway pull its live model list from SAP AI Core. That is the
    // one step of the seed with an upstream outside the runner, so one failed attempt gets two
    // more (private CI 2026-09-30: a 500 on the first attempt failed the whole run).
    const refreshed = await withRetries('refreshModelLibrary', 3, 15000, () => client.post('/refreshModelLibrary', {}));
    if (!refreshed || refreshed.models < 3) {
      throw new Error(`refreshModelLibrary returned ${JSON.stringify(refreshed)} — the Phase 5 gateway must list at least three models`);
    }
  }
  // Same set the grid shows in its default state: LibraryModels reads always drop absent rows
  // (admin-service-library.ts) and the grid's untouched filter is foundation or external
  // ("Show Deployments" is off by default; an external row is a published Connection model).
  const foundationFilter = encodeURIComponent("(accessType eq 'foundation' or accessType eq 'external')");
  const foundation = (await client.get(
    `/LibraryModels?$select=modelId,provisioning&$filter=${foundationFilter}&$orderby=provisioning,modelId&$top=500`)).value;
  if (foundation.length < 3) throw new Error(`only ${foundation.length} foundation models in the snapshot — the journeys need three`);
  // The two members must differ in `provisioning`, otherwise FilterJourney's "SAP Hosted"
  // tick cannot narrow the user's two-model grid.
  const hosted = foundation.filter((m) => m.provisioning === 'hosted');
  const others = foundation.filter((m) => m.provisioning !== 'hosted');
  const memberIds = hosted.length && others.length
    ? [hosted[0].modelId, others[0].modelId]
    : foundation.slice(0, 2).map((m) => m.modelId);
  if (!hosted.length || !others.length) {
    console.warn('[ui-journeys] every foundation model has the same provisioning —' +
      ' FilterJourney cannot narrow the grid for the user role');
  }
  const excludedId = foundation.map((m) => m.modelId).find((id) => !memberIds.includes(id));
  const created = await client.post('/ModelCatalogs', { name: names.teamCatalog, description: 'UI journey fixture' });
  await client.post(`/ModelCatalogs(${created.ID})/AdminService.addModels`, { modelIds: memberIds });
  await client.post('/assignCatalog', { email: users.user, catalogId: created.ID });
  await client.post(`/ModelCatalogs(${defaultId})/AdminService.excludeModels`, { modelIds: [excludedId], reason: names.exclusionReason });
  const all = (await client.get(`/LibraryModels?$filter=${foundationFilter}&$count=true&$top=0`))['@odata.count'];
  // `all` is the admin's count (every non-absent foundation model); the user's expected count
  // is memberIds.length, because the user is assigned the team catalog.
  return { teamCatalogId: created.ID, memberIds, excludedId, allIds: all };
}

// The shared fixture's one file and the passage the user role's Test Retrieval journey asks for.
const SHARED_FILE_CONTENT = 'Staff handbook. The cafeteria on the fourth floor serves lentil soup every Thursday from noon until two.';

/**
 * Grounding fixtures, through the admin's own /api/grounding as each role's user: the gateway
 * scopes files and stores by owner, so the admin user cannot create another user's store.
 * Purges what earlier runs left (by the fixture prefixes), then creates one store per role, and
 * for the admin two more: an empty one the admin journey shares and unshares, and one with one
 * ingested file, shared with all users.
 * Needs the Phase 5 gateway with a file_search database; says so clearly when it is missing.
 */
async function seedGrounding(adminUrl) {
  let sharedOwner = null;
  for (const role of Object.keys(roles)) {
    const authorization = 'Basic ' + Buffer.from(roles[role].credentials).toString('base64');
    const call = async (method, path, body) => {
      const multipart = body instanceof FormData;
      const response = await fetch(`${adminUrl}/api/grounding${path}`, {
        method,
        headers: { Authorization: authorization, Accept: 'application/json', ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: multipart ? body : body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} /api/grounding${path} as ${role} -> ${response.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    };

    const status = await call('GET', '/status');
    if (!status.available) {
      throw new Error(`grounding fixtures need file_search, but the gateway reports "${status.reason}". ` +
        'The pipeline gives its Phase 5 gateway a database (ci/scripts/file-search-test-db.js); ' +
        'for a standalone run restrict it with UI_JOURNEYS_APPS so grounding-app is not included.');
    }

    // All pages are read first and only then is anything deleted: the gateway resolves `after` by
    // looking that row up, so a cursor pointing at a row just deleted would end the paging early.
    const purgeAll = async (listPath, matches, deletePath, beforeDelete) => {
      const doomed = [];
      let after;
      for (;;) {
        const page = await call('GET', `${listPath}?limit=100&order=desc${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        doomed.push(...page.data.filter(matches));
        if (!page.has_more || page.data.length === 0) break;
        after = page.data[page.data.length - 1].id;
      }
      for (const item of doomed) {
        if (beforeDelete) await beforeDelete(item);
        await call('DELETE', deletePath(item));
      }
    };
    // The list also holds stores other users share (owned:false): the role can neither unshare nor
    // delete those, and their owner's own purge removes them. A shared store of the role's own is
    // unshared first, so no other role lists a store that is being deleted.
    const ownFixtureStore = (store) => store.owned !== false && String(store.name || '').startsWith(fixtures.prefix);
    await purgeAll('/stores', ownFixtureStore, (store) => `/stores/${encodeURIComponent(store.id)}`,
      (store) => store.is_shared ? call('POST', `/admin/stores/${encodeURIComponent(store.id)}/unshare`) : null);
    await purgeAll('/files', (file) => String(file.filename || '').startsWith('ui-fixture-'),
      (file) => `/files/${encodeURIComponent(file.id)}?detach=true`);
    await call('POST', '/stores', { name: fixtures.names.groundingStore });
    if (roles[role].isAdmin) {
      await call('POST', '/stores', { name: fixtures.names.groundingShareStore });
      sharedOwner = await seedSharedStore(call);
    }
  }
  return {
    storeName: fixtures.names.groundingStore, fileName: fixtures.names.groundingFile,
    sharedStoreName: fixtures.names.groundingSharedStore, sharedFileName: fixtures.names.groundingSharedFile,
    sharedOwner: sharedOwner, shareStoreName: fixtures.names.groundingShareStore
  };
}

/** The admin's shared fixture: a store with one file, ingested before the journeys search it, then shared. Answers its owner. */
async function seedSharedStore(call) {
  const store = await call('POST', '/stores', { name: fixtures.names.groundingSharedStore });
  const form = new FormData();
  form.append('purpose', 'assistants');
  form.append('file', new Blob([SHARED_FILE_CONTENT], { type: 'text/plain' }), fixtures.names.groundingSharedFile);
  const file = await call('POST', '/files', form);
  await call('POST', `/stores/${encodeURIComponent(store.id)}/files`, { file_id: file.id });
  // Ingestion is a real embedding call (the Files journey waits up to 120 s for the same).
  const deadline = Date.now() + 120000;
  for (;;) {
    const attached = await call('GET', `/stores/${encodeURIComponent(store.id)}/files/${encodeURIComponent(file.id)}`);
    if (attached.status === 'completed') break;
    if (attached.status !== 'in_progress' || Date.now() > deadline) {
      throw new Error(`the shared fixture file did not complete ingestion (status ${attached.status}` +
        `${attached.last_error ? `: ${attached.last_error.message}` : ''})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const sharedStore = await call('POST', `/admin/stores/${encodeURIComponent(store.id)}/share`);
  return sharedStore.owner_email;
}

// ---- Teams fixtures ---------------------------------------------------------------------------
async function purgeTeams(client) {
  const filter = encodeURIComponent(`IsActiveEntity eq true and startswith(name,'${fixtures.prefix}')`);
  const page = await client.get(`/Teams?$select=ID&$filter=${filter}&$top=50`);
  for (const row of page.value) {
    const members = await client.get(`/TeamMembers?$select=email&$filter=${encodeURIComponent(`team_ID eq ${row.ID}`)}&$top=100`);
    for (const m of members.value) await client.post(`/Teams(ID=${row.ID},IsActiveEntity=true)/AdminService.removeMember`, { email: m.email });
    await client.del(`/Teams(ID=${row.ID},IsActiveEntity=true)`);
  }
  const drafts = await client.get(`/Teams?$select=ID&$filter=${encodeURIComponent(`IsActiveEntity eq false and startswith(name,'${fixtures.prefix}')`)}&$top=50`);
  for (const row of drafts.value) await client.del(`/Teams(ID=${row.ID},IsActiveEntity=false)`);
}
async function seedTeam(client, { pool = true } = {}) {
  const { names, users, team } = fixtures;
  const draft = await client.post('/Teams', { name: names.team, description: 'journey fixture', ...(pool ? { tokensPerDay: team.tokensPerDay } : {}) });
  const active = await client.post(`/Teams(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`, {});
  const add = (email, role) => client.post(`/Teams(ID=${active.ID},IsActiveEntity=true)/AdminService.addMember`, { email, role });
  await add(users.admin, 'admin');
  await add(team.leadEmail, 'admin');
  await add(team.memberEmail, 'member');
  return { id: active.ID, name: names.team, tokensPerDay: pool ? team.tokensPerDay : null, memberEmail: team.memberEmail, leadEmail: team.leadEmail };
}

// ---- Connections fixtures ---------------------------------------------------------------------
async function purgeConnections(client) {
  for (const active of [true, false]) {
    const filter = encodeURIComponent(`IsActiveEntity eq ${active} and startswith(title,'${fixtures.prefix}')`);
    const page = await client.get(`/ProviderConnections?$select=ID,providerType,isActive&$filter=${filter}&$top=50`);
    for (const row of page.value) {
      // An active SAP AI Core connection cannot be deleted (409 connection_active): one a manual run left active goes inactive first
      if (active && row.providerType === 'sap-ai-core' && row.isActive) await client.post(`/ProviderConnections(ID=${row.ID},IsActiveEntity=true)/AdminService.deactivate`, {});
      await client.del(`/ProviderConnections(ID=${row.ID},IsActiveEntity=${active})`);
    }
  }
}
async function seedConnection(client) {
  const { names, connection } = fixtures;
  const draft = await client.post('/ProviderConnections', { name: connection.name, title: names.connection, providerType: connection.providerType });
  const active = await client.post(`/ProviderConnections(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`, {});
  await client.post(`/ProviderConnections(ID=${active.ID},IsActiveEntity=true)/AdminService.addModel`, { upstreamModel: connection.model });
  return { id: active.ID, name: connection.name, title: names.connection, providerType: connection.providerType, providerTypeText: connection.providerTypeText, model: connection.model };
}
// The SAP AI Core connection: created through the draft, its invented service key stored; never tested or activated.
async function seedSapConnection(client) {
  const { names, sapConnection: sap } = fixtures;
  const draft = await client.post('/ProviderConnections', { name: sap.name, title: names.sapConnection, providerType: sap.providerType, productive: sap.productive });
  const active = await client.post(`/ProviderConnections(ID=${draft.ID},IsActiveEntity=false)/AdminService.draftActivate`, {});
  await client.post(`/ProviderConnections(ID=${active.ID},IsActiveEntity=true)/AdminService.setCredential`, { secret: JSON.stringify(sap.serviceKey) });
  return {
    id: active.ID, name: sap.name, title: names.sapConnection, providerType: sap.providerType, providerTypeText: sap.providerTypeText,
    endpoint: sap.serviceKey.serviceurls.AI_API_URL, region: sap.region, resourceGroup: sap.resourceGroup, productive: sap.productive
  };
}

async function main() {
  const adminUrl = process.env.ADMIN_SERVICE_URL;
  if (!adminUrl) throw new Error('ADMIN_SERVICE_URL is not set');
  // The whoami guard below cannot tell the CI admin from the maintainer's dev admin: both are
  // dev-mode. Port 4004 is therefore refused unless the pipeline explicitly opts in.
  if (new URL(adminUrl).port === '4004' && process.env.UI_JOURNEYS_IN_PIPELINE !== '1') {
    throw new Error(`refusing ${adminUrl}: port 4004 is the maintainer's development admin;` +
      ' the CI pipeline sets UI_JOURNEYS_IN_PIPELINE=1 for its own admin on that port');
  }
  const client = createClient(adminUrl, roles.admin.credentials);
  await guard(client);
  await refuseForeignCredentials(client);
  const deleted = await purge(client);
  const created = await seed(client);
  await resetCockpitPreferences(adminUrl);
  if (SEEDING_FOR === 'grounding-app') await liftQuotas(client);
  else if (inThisRun('shell', 'users-app', 'api-keys-app')) created.quota = await seedQuotas(client, created.apiKeys);
  // Every app that shows a team gets the fixture team. A grounding-app run gets it without the pool
  // limit: user@test.com's primary team would otherwise cap the grounding journeys' real requests.
  await purgeTeams(client);
  if (inThisRun('shell', 'teams-app', 'api-keys-app', 'aws-credentials-app', 'users-app', 'tool-policies-app', 'model-library-app', 'grounding-app')) {
    created.team = await seedTeam(client, { pool: SEEDING_FOR !== 'grounding-app' });
  }
  await purgeConnections(client);
  if (inThisRun('connections-app')) {
    created.connection = await seedConnection(client);
    created.sapConnection = await seedSapConnection(client);
  }
  if (inThisRun('security-notifications-app')) created.securityEvent = await seedSecurityEvent(client, created.apiKeys);
  if (inThisRun('model-library-app')) {
    const defaultId = await purgeLibrary(client);
    await purgeProfiles(client);
    created.library = await seedLibrary(client, defaultId);
  }
  if (inThisRun('grounding-app')) {
    try {
      created.grounding = await seedGrounding(adminUrl);
    } catch (error) {
      // A run of grounding-app alone has nothing else to protect, so it fails here as before. In a
      // wider run the other apps' journeys go on and grounding-app fails at its bootstrap test.
      const groundingOnly = (process.env.UI_JOURNEYS_APPS || '').split(',').map((name) => name.trim()).join() === 'grounding-app';
      if (groundingOnly) throw error;
      console.warn(`[ui-journeys] grounding fixtures skipped: ${error.message}`);
    }
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'fixtures.json'),
    JSON.stringify({ seededAt: new Date().toISOString(), adminUrl, ...created }, null, 2));
  console.log(`[ui-journeys] purged ${deleted} rows, seeded ${Object.keys(created.apiKeys).length} API keys` +
    ` and ${Object.keys(created.awsCredentials).length} AWS credentials at ${adminUrl}` +
    (created.library
      ? `, plus the model library (${created.library.allIds} models, ${created.library.memberIds.length} in ${fixtures.names.teamCatalog})`
      : ' (model library skipped: UI_JOURNEYS_APPS excludes model-library-app)'));
}

main().catch((error) => {
  console.error(`[ui-journeys] seed failed: ${error.message}`);
  process.exit(1);
});
