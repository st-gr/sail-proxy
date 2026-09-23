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

async function seedLibrary(client, defaultId) {
  const { names, users } = fixtures;
  // Local runs against a throwaway admin have no gateway: UI_JOURNEYS_SKIP_LIBRARY_REFRESH keeps
  // the snapshot the scratch database already holds (see chapter 9). The pipeline never sets it.
  if (process.env.UI_JOURNEYS_SKIP_LIBRARY_REFRESH) {
    console.log('[ui-journeys] UI_JOURNEYS_SKIP_LIBRARY_REFRESH is set - using the existing library snapshot');
  } else {
    const refreshed = await client.post('/refreshModelLibrary', {});
    if (!refreshed || refreshed.models < 3) {
      throw new Error(`refreshModelLibrary returned ${JSON.stringify(refreshed)} — the Phase 5 gateway must list at least three models`);
    }
  }
  // Same set the grid shows in its default state: LibraryModels reads always drop absent rows
  // (admin-service-library.ts) and the grid's untouched filter is accessType eq 'foundation'
  // ("Show Deployments" is off by default).
  const foundationFilter = encodeURIComponent("accessType eq 'foundation'");
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
  if (inThisRun('shell', 'users-app', 'api-keys-app')) created.quota = await seedQuotas(client, created.apiKeys);
  if (inThisRun('security-notifications-app')) created.securityEvent = await seedSecurityEvent(client, created.apiKeys);
  if (inThisRun('model-library-app')) {
    const defaultId = await purgeLibrary(client);
    await purgeProfiles(client);
    created.library = await seedLibrary(client, defaultId);
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
