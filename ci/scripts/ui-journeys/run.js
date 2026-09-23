#!/usr/bin/env node
'use strict';

// Runs the OPA5 UI journeys per role × app with ui5-test-runner against ADMIN_SERVICE_URL.
// ci/ci-pipeline.js (Phase 6.6) points it at the admin started in Phase 5; standalone use
// needs a throwaway admin (recipe below and in docs/developer/chapter-9-testing-strategy.md).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const fixtures = require('./fixtures');
const roles = require('./roles');

const ROOT = path.resolve(__dirname, '../../..');
const REPORT_ROOT = 'ci/reports/ui-journeys'; // relative to ROOT: the runner resolves --report-dir against cwd
const RUNNER = path.join(ROOT, 'node_modules/.bin/ui5-test-runner');
const TEST_PAGE = '/test/integration/opaTests.qunit.html';
// mount = cds-plugin-ui5 mount path (services/admin/package.json → cds-plugin-ui5.modules)
// minTests = the journeys the page must actually run; a page that silently ran fewer
// (a journey dropped from opaTests.qunit.js, a bootstrap that never started) is a failure.
const APPS = [
  { name: 'shell', mount: '/shell', minTests: 4 },
  { name: 'api-keys-app', mount: '/api-keys', minTests: 6 },
  { name: 'aws-credentials-app', mount: '/aws-credentials', minTests: 5 },
  { name: 'model-library-app', mount: '/model-library', minTests: 7 },
  { name: 'security-notifications-app', mount: '/security-notifications', minTests: 3 },
  { name: 'users-app', mount: '/users', minTests: 6, roles: ['admin'] },  // admin-only app (plan B ruling 1)
  { name: 'tool-policies-app', mount: '/tool-policies', minTests: 4, roles: ['admin'] }   // admin-only app (plan B ruling 1)
];

// UI_JOURNEYS_APPS=<name>[,<name>…] restricts a run to those apps. seed.js honours the same
// variable (its model-library fixtures need the gateway the pipeline starts in Phase 5).
function selectedApps() {
  const filter = process.env.UI_JOURNEYS_APPS;
  if (!filter) return APPS;
  const wanted = filter.split(',').map((name) => name.trim());
  return APPS.filter((app) => wanted.includes(app.name));
}

const SKIP_MESSAGE = `[ui-journeys] skipped: ADMIN_SERVICE_URL is not set.
The journeys purge and seed the database they run against — never point them at a dev DB.
Start a throwaway admin (schema in a scratch file, port 4014), then re-run:
  cd services/admin && npx cds deploy --to sqlite:/tmp/ui-journeys.db
  cd services/admin && CDS_CONFIG='{"requires":{"db":{"credentials":{"url":"/tmp/ui-journeys.db"}}}}' PORT=4014 pnpm run dev:ts:mock
  ADMIN_SERVICE_URL=http://localhost:4014 pnpm run ui:journeys
A throwaway admin has no gateway, so the model-library seed (refreshModelLibrary) fails there:
restrict a standalone run with UI_JOURNEYS_APPS=shell,api-keys-app,aws-credentials-app, or run
the full pipeline (pnpm run ci).`;

// The page gets the role entry minus the password, plus the email, the fixture names and —
// when the seed that just ran created them — the model-library fixture ids.
function encodeExpectations(role) {
  const { credentials, ...expect } = roles[role];
  expect.email = credentials.split(':')[0];
  expect.fixtures = { ...fixtures.names, users: { ...fixtures.users } };
  const seeded = path.join(ROOT, REPORT_ROOT, 'fixtures.json');
  if (fs.existsSync(seeded)) {
    const seededFixtures = JSON.parse(fs.readFileSync(seeded, 'utf8'));
    for (const block of ['library', 'quota', 'securityEvent']) if (seededFixtures[block]) expect.fixtures[block] = seededFixtures[block];
  }
  return Buffer.from(JSON.stringify(expect), 'utf8').toString('base64url');
}

function seed(adminUrl) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, ADMIN_SERVICE_URL: adminUrl }
  });
  if (result.status !== 0) throw new Error('seed.js failed (see the output above)');
}

function runOne(adminUrl, role, app) {
  const [username, password] = roles[role].credentials.split(':');
  const reportDir = `${REPORT_ROOT}/${app.name}-${role}`;
  fs.rmSync(path.join(ROOT, reportDir), { recursive: true, force: true });
  const url = `${adminUrl}${app.mount}${TEST_PAGE}?role=${role}&expect=${encodeExpectations(role)}`;
  const args = [
    '--url', url,
    '--report-dir', reportDir,
    '--ci', '--parallel', '1',
    // --no-screenshot: per-step screenshots stalled 1-3 min per page (BROWSER_SCREENSHOT_TIMEOUT); failures still get one
    '--no-screenshot',
    '--page-timeout', '600000',
    '--global-timeout', '900000',
    '--report-generator', '$/report.js', '$/junit-xml-report.js',
    // everything after "--" goes to the browser driver (puppeteer.js)
    // dev-only fixed credentials; they are visible in the process list of the CI runner, which is acceptable for these mocked users
    '--', '--basic-auth-username', username, '--basic-auth-password', password
  ];
  const result = spawnSync(RUNNER, args, { cwd: ROOT, stdio: 'inherit' });
  const junit = path.join(ROOT, reportDir, 'junit.xml');
  if (!fs.existsSync(junit)) {
    return { role, app: app.name, ok: false, detail: `${reportDir}/junit.xml missing` };
  }
  const xml = fs.readFileSync(junit, 'utf8');
  const tests = (xml.match(/<testcase/g) || []).length;
  const failures = (xml.match(/<failure/g) || []).length;
  const enough = tests >= app.minTests;
  const shortfall = enough ? '' : `, expected at least ${app.minTests}`;
  const detail = `${reportDir}/junit.xml (${tests} tests, ${failures} failures${shortfall})`;
  return { role, app: app.name, ok: result.status === 0 && enough && failures === 0, detail };
}

function main() {
  const adminUrl = process.env.ADMIN_SERVICE_URL;
  if (!adminUrl) {
    console.log(SKIP_MESSAGE);
    return 0;
  }
  if (!fs.existsSync(RUNNER)) {
    console.error(`[ui-journeys] ${RUNNER} is missing — run pnpm install`);
    return 1;
  }
  const results = [];
  const apps = selectedApps();
  if (apps.length === 0) {
    console.error(`[ui-journeys] UI_JOURNEYS_APPS=${process.env.UI_JOURNEYS_APPS} matches none of ` +
      APPS.map((app) => app.name).join(', '));
    return 1;
  }
  roleLoop:
  for (const role of Object.keys(roles)) {
    for (const app of apps) {
      if (app.roles && !app.roles.includes(role)) continue;
      console.log(`\n[ui-journeys] ${app.name} as ${role}`);
      try {
        seed(adminUrl); // fresh fixtures for every role × app run
      } catch (error) {
        // a failed seed means the admin is unusable: record it, stop, and still print the summary
        results.push({ role, app: app.name, ok: false, detail: `seed failed: ${error.message}` });
        break roleLoop;
      }
      results.push(runOne(adminUrl, role, app));
    }
  }
  console.log('\n[ui-journeys] summary');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.app.padEnd(22)} ${r.role.padEnd(6)} ${r.detail}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[ui-journeys] ${error.message}`);
  process.exit(1);
}
