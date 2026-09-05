#!/usr/bin/env node
'use strict';

// Purge + seed the UI-journey fixtures over OData as the dev admin user.
//   ADMIN_SERVICE_URL=http://localhost:4014 node ci/scripts/ui-journeys/seed.js
// Safety: refuses any target whose whoami is not the dev-mode admin test user. It then
// deletes EVERY draft, API key and AWS credential — in the pipeline this runs after the
// last phase that reads the CI database (Phase 6.5); standalone it must only ever see a
// throwaway admin (see run.js).

const fs = require('fs');
const path = require('path');
const { createClient } = require('./odata');
const fixtures = require('./fixtures');
const roles = require('./roles');

const REPORT_DIR = path.resolve(__dirname, '../../reports/ui-journeys');
const SETS = ['ApiKeys', 'AwsCredentials'];

async function guard(client) {
  const who = await client.post('/whoami');
  const ok = who && who.deployTarget === 'development' && who.isAdmin === true && who.user === fixtures.users.admin;
  if (!ok) {
    throw new Error(`refusing to seed: whoami returned ${JSON.stringify(who)} — expected the dev-mode admin test user`);
  }
}

async function purge(client) {
  let deleted = 0;
  for (const set of SETS) {
    // Drafts first: an open draft blocks deleting its active row.
    for (const active of [false, true]) {
      for (;;) {
        const filter = encodeURIComponent(`IsActiveEntity eq ${active}`);
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
  const deleted = await purge(client);
  const created = await seed(client);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'fixtures.json'),
    JSON.stringify({ seededAt: new Date().toISOString(), adminUrl, ...created }, null, 2));
  console.log(`[ui-journeys] purged ${deleted} rows, seeded ${Object.keys(created.apiKeys).length} API keys` +
    ` and ${Object.keys(created.awsCredentials).length} AWS credentials at ${adminUrl}`);
}

main().catch((error) => {
  console.error(`[ui-journeys] seed failed: ${error.message}`);
  process.exit(1);
});
