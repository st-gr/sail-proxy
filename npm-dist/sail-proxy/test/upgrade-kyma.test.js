// `sail-proxy upgrade kyma` / `restore kyma` against a fake cluster (test/helpers/fake-kyma.js):
// no kubectl, docker or registry is reached. The installation is made the way a real one is: the
// release kit's setup-kyma.js renders 0.11.0 and its deploy-kyma.js applies it to the fake.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync, spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const NS = 'sail-proxy-test';
const PASSPHRASE = 'correct horse battery staple';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-kyma-test-'));

// setup-docker.js (spawned by the render) asks `docker` about volumes: never the real one
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'docker.cmd'), '@exit /b 1\r\n');
process.env.PATH = bin + path.delimiter + process.env.PATH;
// Setup reads a service key from the shell (the maintainer's CI shell has one): the installation is built without it.
delete process.env.SAP_AI_CORE_SERVICE_KEY;

if (!process.env.UPGRADE_KYMA_CHILD) {
  execFileSync('node', [path.join(pkgRoot, 'scripts', 'copy-release-kit.js')], { stdio: 'ignore' });
}

const { FakeKyma } = require('./helpers/fake-kyma');
const { runUpgrade, exitCodeOf } = require('../dist/upgrade/kyma');
const { runRestore } = require('../dist/upgrade/kymaRestore');
const { commandAdapter, spawnKubectl } = require('../dist/upgrade/kubectl');
const { restoreObjects } = require('../dist/upgrade/kymaCluster');
const { Writable, Readable } = require('stream');
const { materializeKit } = require('../dist/upgrade/kit');
const { loadKitScripts } = require('../dist/upgrade/kymaRender');
const { openBundle, writeBundle } = require('../dist/upgrade/bundle');
const { onlyNewPromptFn } = require(path.join(repoRoot, 'docker', 'setup-flow', 'onlyNew.js'));
const { REVIEW, WRITE } = require(path.join(repoRoot, 'docker', 'setup-flow', 'session.js'));

function captureConsole(lines) {
  const saved = ['log', 'warn', 'error', 'info'].map((m) => [m, console[m]]);
  for (const [m] of saved) console[m] = (...a) => lines.push(a.map(String).join(' '));
  return () => { for (const [m, f] of saved) console[m] = f; };
}

/** A 0.11.0 installation: rendered by the kit's setup (scripted answers) and deployed to the fake. */
async function buildInstallation() {
  const fake = new FakeKyma(NS);
  fake.objects.delete(fake.key('namespace', null, NS)); // a first install: deploy creates it
  const kit = await materializeKit();
  const out = fs.mkdtempSync(path.join(scratch, 'render-'));
  const lines = [];
  const restore = captureConsole(lines);
  try {
    const { KymaSetup, PromptSession, deployKyma } = loadKitScripts(kit.root);
    const setup = new KymaSetup({ outputRoot: out, namespace: NS });
    setup._k8sApiClusterIp = '10.0.0.1';
    setup.runKubectl = (a) => fake.read(a);
    setup.selectImageVersion = async () => ({ tag: '0.11.0', useDigests: false, imageDigests: {}, published: true });
    const given = {
      confirmNewNamespace: true, deploymentType: 'internal', autoDeploy: false,
      configMethod: 'manual', SAP_AI_CORE_URL: 'https://api.ai.install-region-1.example.com', AUTH_URL: 'https://install.authentication.example.com/oauth/token',
      CLIENT_ID: 'install-client-id', CLIENT_SECRET: 'install-client-secret-81d2', SAP_AI_REGION: 'install-region-1', SAP_AI_RESOURCE_GROUP: 'default',
    };
    const promptFn = async (q) => {
      if (q.id === REVIEW) return WRITE;
      if (q.id in given) return given[q.id];
      if (q.type === 'list') return q.default !== undefined ? q.default : (q.choices[0].value ?? q.choices[0]);
      if (q.type === 'confirm') return q.default !== false;
      if (q.type === 'password') return '';
      return q.default !== undefined ? q.default : '';
    };
    const session = new PromptSession({ promptFn });
    const answers = await session.run((s) => setup.collectAnswers(s));
    await setup.applyAnswers({ ...answers, autoDeploy: null });
    await deployKyma.deployToKyma({
      kymaDir: out, argv: ['--namespace', NS], strict: true,
      kubectl: commandAdapter((a, o) => fake.run(a, o)), kubectlRead: (a) => fake.read(a),
    });
  } catch (error) {
    restore();
    console.error(lines.slice(-30).join('\n'));
    throw error;
  } finally {
    restore();
    await kit.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
  fake.calls = [];
  fake.db = 'CREATE TABLE public.sap_llm_gateway_admin_apikeys (\n    id text\n);\nrows of 0.11.0';
  return fake;
}

const tempLeftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => /^sail-proxy-(kit|render)-/.test(f)).sort();

async function upgrade(fake, o = {}) {
  const backupDir = o.backupDir || fs.mkdtempSync(path.join(scratch, 'backups-'));
  const asked = [];
  const lines = [];
  const before = tempLeftovers();
  const restore = o.quiet === false ? () => {} : captureConsole(lines);
  let result;
  try {
    result = await runUpgrade({
      namespace: NS,
      packageVersion: '0.12.0',
      backupDir,
      yes: true,
      prompt: async (q) => {
        asked.push(q.id || q.name);
        if (o.answers && (q.id || q.name) in o.answers) return o.answers[q.id || q.name];
        throw new Error(`unexpected question ${q.id || q.name}: ${q.message}`);
      },
      kubectl: (a, opt) => fake.run(a, opt),
      kubectlRead: (a) => fake.read(a),
      lookupDigest: async () => `sha256:${'a'.repeat(64)}`,
      statfs: async () => 10 * 1024 ** 3,
      signals: o.signals || new EventEmitter(),
      ...(o.env === null ? {} : { env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASSPHRASE, ...(o.env || {}) } }),
      exit: (code) => { throw new Error(`exit ${code}`); },
      pollMs: 1,
      healthTimeoutSeconds: 2,
      log: (m) => lines.push(m),
      ...(o.ctx || {}),
    });
  } finally {
    restore();
  }
  const out = lines.join('\n');
  assert.deepStrictEqual(tempLeftovers(), before, 'the kit copy and the render are removed');
  assert.deepStrictEqual(fs.readdirSync(backupDir).filter((f) => f.startsWith('.')), [], 'the work dir is removed');
  return { result, code: exitCodeOf(result), asked, out, backupDir, backups: fs.readdirSync(backupDir) };
}

const image = (fake, name) => fake.get('deployment', NS, name).spec.template.spec.containers[0].image;
const replicas = (fake) => ({ gateway: fake.get('deployment', NS, 'gateway').spec.replicas, admin: fake.get('deployment', NS, 'admin').spec.replicas });
/** Each phase line is followed by its duration (and only heartbeats in between). */
function assertPhases(text, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\']/g, '\\$&');
    assert.match(text, new RegExp(`^${esc}\\.\\.\\.\\n(?: {2}still .*\\n)* {2}done in \\d+ s$`, 'm'), `phase "${label}" with its duration`);
  }
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- onlyNewPromptFn -------------------------------------------------------------------------
test('onlyNewPromptFn answers what is current and forwards only the rest', async () => {
  const forwarded = [];
  const real = async (q) => { forwarded.push(q.id); return `asked:${q.id}`; };
  const fn = onlyNewPromptFn(real, { provider: 'okta', OKTA_SSO_URL: 'https://sso.example.test', imagePullSecrets: false, GITHUB_CLIENT_SECRET: 'x', dockerPassword: 'y', LDAP_HOST: 'bad host' });
  assert.strictEqual(await fn({ id: REVIEW, type: 'list', choices: [] }), WRITE);
  assert.strictEqual(await fn({ id: 'key-regeneration', type: 'list', choices: [{ value: 'keep' }, { value: 'regenerate' }] }), 'keep');
  assert.strictEqual(await fn({ id: 'confirmGenerateInExistingNamespace', type: 'confirm', default: true }), false);
  assert.strictEqual(await fn({ id: 'autoDeploy', type: 'confirm', default: true }), false);
  assert.strictEqual(await fn({ id: 'provider', type: 'list', choices: [{ value: 'local' }, { value: 'okta' }] }), 'okta');
  assert.strictEqual(await fn({ id: 'OKTA_SSO_URL', type: 'input' }), 'https://sso.example.test');
  assert.strictEqual(await fn({ id: 'imagePullSecrets', type: 'confirm', default: true }), false);
  assert.strictEqual(await fn({ id: 'GITHUB_CLIENT_SECRET', type: 'list', choices: [{ value: 'keep' }, { value: 'new' }] }), 'keep');
  assert.strictEqual(await fn({ id: 'dockerPassword', type: 'password' }), '');
  assert.strictEqual(await fn({ id: 'LDAP_HOST', type: 'input', validate: (v) => (/\s/.test(v) ? 'no spaces' : true) }), 'asked:LDAP_HOST');
  assert.strictEqual(await fn({ id: 'OKTA_METADATA_URL', type: 'input' }), 'asked:OKTA_METADATA_URL');
  assert.strictEqual(await fn({ id: 'OKTA_SAML_CA_DATA', type: 'list', choices: [{ value: 'auto-fetch-from-metadata' }, { value: 'manual' }] }), 'asked:OKTA_SAML_CA_DATA');
  assert.strictEqual(await fn({ id: 'provider#2', type: 'list', choices: ['local'] }), 'asked:provider#2', 'a value that is no choice is asked');
  assert.deepStrictEqual(forwarded, ['LDAP_HOST', 'OKTA_METADATA_URL', 'OKTA_SAML_CA_DATA', 'provider#2']);
});

// ---- the happy path --------------------------------------------------------------------------
test('happy path: steps in order, nothing asked, new version healthy, record written last', async (base) => {
  const fake = base.clone();
  const { code, result, asked, out, backups } = await upgrade(fake);
  assert.strictEqual(code, 0, out.slice(-2000));
  assert.deepStrictEqual(asked, [], 'an installation with a record is asked nothing');
  assert.doesNotMatch(out, /^\s*Output: /m, 'the temporary render folder is no place the admin can use');
  assert.doesNotMatch(out, /Generated files:|Manual steps|deploy-kyma\.js|docker-compose/, 'the upgrade deploys the render itself: no setup or Docker instructions for files that are gone');
  assert.match(out, /Kubernetes namespace: sail-proxy-test/);
  const steps = [...out.matchAll(/=== Step: (\w+) ===/g)].map((m) => m[1]);
  assert.deepStrictEqual(steps, ['read', 'ask', 'preflight', 'outage', 'backup', 'apply', 'migrate', 'health', 'record']);
  for (const name of ['gateway', 'admin', 'nginx']) assert.match(image(fake, name), /sail-proxy-\w+:0\.12\.0$/);
  assert.deepStrictEqual(replicas(fake), replicas(base));
  assert.match(fake.db, /admin schema of 0\.12\.0/);
  const record = fake.get('configmap', NS, 'sail-proxy-install');
  assert.strictEqual(JSON.parse(`"${record.data.version}"`), '0.12.0');
  assert.strictEqual(record.data.recordedBy, 'upgrade');
  const calls = fake.calls.map((a) => a.join(' '));
  const recordAt = calls.findIndex((c) => /^apply -f .*install-record\.yaml$/.test(c));
  assert.ok(recordAt > 0 && recordAt === calls.length - 1, 'the record is the last command');
  assert.ok(calls.findIndex((c) => c.startsWith('exec deploy/gateway')) < recordAt, 'after the health check');
  const migrateAdmin = calls.findIndex((c) => c.includes('sail-proxy/migration-job=admin'));
  const adminUp = calls.findIndex((c, i) => i > migrateAdmin && c === `scale deployment admin -n ${NS} --replicas=1`);
  const migrateFiles = calls.findIndex((c) => c.includes('sail-proxy/migration-job=file-search'));
  const gatewayUp = calls.findIndex((c, i) => i > migrateFiles && c === `scale deployment gateway -n ${NS} --replicas=1`);
  assert.ok(migrateAdmin > 0 && migrateAdmin < adminUp && adminUp < migrateFiles && migrateFiles < gatewayUp, 'admin migration, admin up, file_search migration, gateway up');
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(result.backup, path.join(path.dirname(result.backup), backups[0]));
  const work = fs.mkdtempSync(path.join(scratch, 'open-'));
  const bundle = await openBundle(result.backup, PASSPHRASE, work);
  assert.ok(bundle.manifest.entries.some((e) => e.name === 'database.sql.gz'));
  assert.ok(bundle.manifest.entries.some((e) => e.name === `previous/${NS}/Secret-admin-env.json`));
  assert.deepStrictEqual([bundle.manifest.fromVersion, bundle.manifest.toVersion], ['0.11.0', '0.12.0']);
  const manifestText = JSON.stringify(bundle.manifest);
  for (const secret of base.secretValues()) assert.ok(!manifestText.includes(secret), `no secret value in the manifest: ${secret}`);
});

// ---- refusals before the outage --------------------------------------------------------------
const refusals = [
  ['target not newer', (f) => ({ ctx: { packageVersion: '0.11.0' } }), /not newer/],
  ['source 0.10.0', (f) => { f.get('configmap', NS, 'sail-proxy-install').data.version = '0.10.0'; return {}; }, /starts from 0\.11\.0/],
  ['storage layout change', () => ({ ctx: { policy: { storageLayoutChange: true } } }), /layout of file storage/],
  ['postgres image differs', (f) => { f.get('statefulset', NS, 'postgres').spec.template.spec.containers[0].image = 'postgres:17'; return {}; }, /Postgres image/],
  ['rebuild running', (f) => { f.rebuildRunning = true; return {}; }, /rebuild-index Job is running/],
  ['can-i no', (f) => { f.denied.add('delete secrets'); return {}; }, /may not do everything.*delete secrets/],
  ['image missing', () => ({ ctx: { lookupDigest: async () => { throw new Error('404 Not Found'); } } }), /cannot be found/],
  ['too little disk', () => ({ ctx: { statfs: async () => 50 * 1024 * 1024 } }), /Not enough free space/],
  ['dry run fails', (f) => { f.failDryRun = 'admin.yaml'; return {}; }, /rejected the new manifests in a dry run/],
];
for (const [name, arrange, message] of refusals) {
  test(`refused before the outage: ${name} (nothing changed, exit 1)`, async (base) => {
    const fake = base.clone();
    const options = arrange(fake);
    const before = fake.state();
    const { code, out, backups, result } = await upgrade(fake, options);
    assert.strictEqual(code, 1, out.slice(-1500));
    assert.match(result.error, message);
    assert.strictEqual(fake.state(), before, 'the cluster is unchanged');
    assert.ok(!fake.calls.some((a) => a[0] === 'scale' || (a[0] === 'apply' && !a.includes('--dry-run=server'))), 'nothing scaled or applied');
    assert.deepStrictEqual(backups, []);
  });
}

// ---- failures after the outage roll back -----------------------------------------------------
for (const step of ['apply', 'migrate', 'health']) {
  test(`SAIL_PROXY_UPGRADE_FAIL_AT=${step}: rolled back to the previous version and database (exit 2)`, async (base) => {
    const fake = base.clone();
    const before = fake.state();
    // the new version adds an object of its own; the rollback must remove it
    fake.onApply = (obj) => {
      if (obj.kind === 'Deployment' && obj.metadata.name === 'gateway' && /0\.12\.0/.test(JSON.stringify(obj))) {
        fake.add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'added-by-0-12', namespace: NS, labels: { 'app.kubernetes.io/part-of': 'sail-proxy' } }, data: {} });
      }
    };
    const { code, out, backups, result } = await upgrade(fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: step } });
    assert.strictEqual(code, 2, out.slice(-2000));
    assert.strictEqual(result.failedAt, step);
    assert.strictEqual(fake.db, base.db, 'the pre-upgrade database');
    assert.match(image(fake, 'gateway'), /:0\.11\.0$/);
    assert.ok(!fake.get('configmap', NS, 'added-by-0-12'), 'the new object is gone');
    assert.ok(!fake.get('job', NS, 'sail-proxy-migrate-admin'), 'the migration jobs are gone');
    assert.strictEqual(fake.state(), before, 'every object as before the upgrade');
    assert.ok(fake.calls.some((a) => a[0] === 'exec' && a[1] === 'deploy/gateway'), 'the old version was health-checked');
    assert.strictEqual(backups.length, 1, 'the backup stays');
    assert.match(out, /Rolled back/);
    assertPhases(out, ['Stopping the new components', "Re-applying the previous version's objects", 'Restoring the database from the backup', 'Starting the previous version', 'Waiting for the previous version to report healthy']);
    assert.ok(fake.replaced.length > 0 && fake.replaced.every((r) => !r.startsWith('force ')), `replaced in place, never deleted and recreated: ${fake.replaced.filter((r) => r.startsWith('force '))}`);
    assert.ok(fake.replaced.includes('PeerAuthentication/default'), 'a custom resource was replaced at its resourceVersion');
    assert.match(fake.restorePrefixes[0], /DROP %s IF EXISTS %I\.%I CASCADE/);
    assert.match(fake.restorePrefixes[0], /WHERE n\.nspname IN \('public'\)/, 'every relation of the dump\'s schemas is dropped first');
  });
}

test('a rollback whose restore fails: exit 3, the restore command is named, the backup kept', async (base) => {
  const fake = base.clone();
  fake.failRestore = true;
  const { code, out, backups, result } = await upgrade(fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'migrate' } });
  assert.strictEqual(code, 3, out.slice(-1500));
  assert.strictEqual(backups.length, 1);
  assert.ok(out.includes(`sail-proxy restore kyma --namespace ${NS} --input "${result.backup}"`), out.slice(-800));
  assert.ok(out.includes(`The backup "${result.backup}" was kept.`) && !out.includes('Every file was kept'), out.slice(-800));
  assert.match(out, /THE ROLLBACK FAILED/);
});

test('SIGINT during backup: no backup file, old components resumed, a second SIGINT is ignored (exit 2)', async (base) => {
  const fake = base.clone();
  const signals = new EventEmitter();
  let interrupted = false;
  let second = false;
  fake.beforeCommand = async (args) => {
    if (!interrupted && args.join(' ').includes('pg_dump')) { interrupted = true; signals.emit('SIGINT', 'SIGINT'); }
    if (interrupted && !second && args[0] === 'scale' && args.includes('--replicas=1')) { second = true; signals.emit('SIGINT', 'SIGINT'); }
  };
  const { code, out, backups } = await upgrade(fake, { signals });
  assert.strictEqual(code, 2, out.slice(-1500));
  assert.deepStrictEqual(backups, []);
  assert.deepStrictEqual(replicas(fake), replicas(base));
  assert.match(out, /interrupted by SIGINT/);
  assert.match(out, /rollback in progress/);
  assert.match(out, /Rolled back/);
});

test('SIGINT while the bundle is written: the finished file is removed too, old components resumed (exit 2)', async (base) => {
  const fake = base.clone();
  const signals = new EventEmitter();
  const { writeBundle: realWrite } = require('../dist/upgrade/bundle');
  const writeBundle = async (...args) => { signals.emit('SIGINT', 'SIGINT'); return realWrite(...args); };
  const { code, out, backups } = await upgrade(fake, { signals, ctx: { writeBundle } });
  assert.strictEqual(code, 2, out.slice(-1500));
  assert.deepStrictEqual(backups, []);
  assert.deepStrictEqual(replicas(fake), replicas(base));
  assert.match(fake.calls.map((a) => a.join(' ')).join('\n'), /exec deploy\/gateway/, 'the old version is health-checked');
});

test('disk full (ENOSPC) while the bundle is written: like SIGINT, no partial file (exit 2)', async (base) => {
  const fake = base.clone();
  const writeBundle = async (file) => {
    fs.writeFileSync(`${file}.partial`, 'x');
    fs.rmSync(`${file}.partial`);
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
  };
  const { code, out, backups } = await upgrade(fake, { ctx: { writeBundle } });
  assert.strictEqual(code, 2, out.slice(-1500));
  assert.deepStrictEqual(backups, []);
  assert.deepStrictEqual(replicas(fake), replicas(base));
  assert.match(out, /disk is full/);
});

test('kubectl Unauthorized mid-run: says to log in again and names the restore command (exit 3)', async (base) => {
  const fake = base.clone();
  fake.beforeCommand = async (args) => {
    if (args.includes('sail-proxy/migration-job=admin')) fake.unauthorized = true;
  };
  const { code, out, result } = await upgrade(fake);
  assert.strictEqual(code, 3, out.slice(-1500));
  assert.match(out, /log in again/);
  assert.ok(out.includes(`sail-proxy restore kyma --namespace ${NS} --input "${result.backup}"`));
});

test('Okta installation: exactly OKTA_METADATA_URL and OKTA_SAML_CA_DATA are asked', async (base) => {
  const fake = base.clone();
  const record = fake.get('configmap', NS, 'sail-proxy-install');
  const answers = JSON.parse(record.data.answers);
  Object.assign(answers, { provider: 'okta', OKTA_SSO_URL: 'https://okta.example.test/app/sso/saml', OKTA_ADMIN_GROUP: 'gw-admins', OKTA_USER_GROUP: 'gw-users', LOGOUT_REDIRECT_URL: 'auto-shell' });
  record.data.answers = JSON.stringify(answers);
  const adminEnv = fake.get('secret', NS, 'admin-env');
  adminEnv.data.IDENTITY_PROVIDER = Buffer.from('okta').toString('base64');
  const { code, asked, out } = await upgrade(fake, {
    answers: { OKTA_METADATA_URL: 'https://okta.example.test/app/metadata', OKTA_SAML_CA_DATA: 'auto-fetch-from-metadata' },
    ctx: { adjustSetup: (setup) => { setup.fetchSamlCertificateFromMetadata = async () => ({ certificate: 'MIIBfakecertificate', ssoUrl: 'https://okta.example.test/app/sso/saml' }); } },
  });
  assert.deepStrictEqual(asked, ['OKTA_METADATA_URL', 'OKTA_SAML_CA_DATA']);
  assert.strictEqual(code, 0, out.slice(-1500));
});

test('first upgrade (no install record): the logout redirect is read from admin-env, not asked', async (base) => {
  const fake = base.clone();
  fake.objects.delete(fake.key('configmap', NS, 'sail-proxy-install'));
  const { code, asked, out } = await upgrade(fake);
  assert.strictEqual(code, 0, out.slice(-1500));
  assert.deepStrictEqual(asked, [], 'setup always renders <base>/admin/app/shell/, which is the auto-shell answer');
});

test('a SAP_AI_CORE_SERVICE_KEY in the shell neither replaces the installation\'s SAP credentials nor is printed', async (base) => {
  const fake = base.clone();
  const sapKeys = ['SAP_AI_CORE_URL', 'AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'SAP_AI_REGION', 'SAP_AI_RESOURCE_GROUP'];
  const sap = (f) => Object.fromEntries(sapKeys.map((k) => [k, f.get('secret', NS, 'gateway-env').data[k]]));
  const before = sap(fake);
  process.env.SAP_AI_CORE_SERVICE_KEY = JSON.stringify({
    clientid: 'shell-client-id', clientsecret: 'shell-client-secret-4f7a9c', url: 'https://shell.authentication.example.com',
    serviceurls: { AI_API_URL: 'https://api.ai.shell-region-9.example.com' },
  });
  let run;
  try { run = await upgrade(fake); } finally { delete process.env.SAP_AI_CORE_SERVICE_KEY; }
  assert.strictEqual(run.code, 0, run.out.slice(-1500));
  assert.deepStrictEqual(sap(fake), before, 'the gateway keeps the SAP credentials it had');
  assert.ok(!/shell-client-secret|shell-region-9|shell-client-id/.test(run.out), 'nothing of the shell key is printed');
});

test('a temporary render keeps the setup-docker child quiet, but shows its output when it fails', async () => {
  const kit = await materializeKit();
  try {
    const { KymaSetup } = loadKitScripts(kit.root);
    const script = path.join(scratch, 'fake-setup-docker.js');
    const written = [];
    const saved = process.stderr.write;
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    let codes;
    try {
      fs.writeFileSync(script, "console.log('docker-compose build'); process.exit(Number(process.argv[3] === '\"fail\"' ? 3 : 0));\n");
      const setup = new KymaSetup({ outputRoot: fs.mkdtempSync(path.join(scratch, 'q-')), namespace: NS, outputIsTemporary: true });
      codes = [await setup.spawnDockerSetup(script, 'ok'), written.join('')];
      codes.push(await setup.spawnDockerSetup(script, 'fail'), written.join(''));
    } finally { process.stderr.write = saved; }
    assert.deepStrictEqual([codes[0], codes[1]], [0, ''], 'a successful child prints nothing');
    assert.strictEqual(codes[2], 3);
    assert.match(codes[3], /docker-compose build/, 'a failing child\'s output is shown');
  } finally { await kit.cleanup(); }
});

// ---- fix round 1 ------------------------------------------------------------------------------
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
/** A destination that takes `limit` bytes into `target`, then fails like a full disk. */
function fullDisk(target, limit) {
  let seen = 0;
  return new Writable({
    write(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > limit) { target.destroy(); done(enospc()); return; }
      target.write(chunk, done);
    },
    final(done) { target.end(done); },
  });
}

test('spawnKubectl: a failing stdout destination (ENOSPC) kills the child and rejects with that error, no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const run = spawnKubectl(process.execPath);
    const sink = fullDisk(new Writable({ write(_c, _e, d) { d(); } }), 64 * 1024);
    const error = await run(['-e', 'setInterval(() => process.stdout.write(Buffer.alloc(65536)), 1)'], { stdout: sink }).catch((e) => e);
    assert.strictEqual(error.code, 'ENOSPC');
    const input = new Readable({ read() { this.destroy(Object.assign(new Error('EIO: read failed'), { code: 'EIO' })); } });
    const inputError = await run(['-e', 'process.stdin.resume()'], { input }).catch((e) => e);
    assert.strictEqual(inputError.code, 'EIO', 'an input stream error rejects too');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('spawnKubectl: children are detached and hidden on every platform and never get the backup passphrase', async () => {
  const seen = [];
  const fakeSpawn = (cmd, args, options) => { seen.push(options); const { spawn } = require('child_process'); return spawn(process.execPath, ['-e', ''], { ...options, stdio: options.stdio }); };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const p of ['win32', 'linux', 'darwin']) {
    Object.defineProperty(process, 'platform', { value: p });
    try {
      await spawnKubectl('kubectl', fakeSpawn)(['version']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  }
  assert.deepStrictEqual(seen.map((o) => [o.detached, o.windowsHide]), [[true, true], [true, true], [true, true]], 'win32 included');
  process.env.SAIL_PROXY_BACKUP_PASSPHRASE = PASSPHRASE;
  try {
    const { stdout } = await spawnKubectl(process.execPath)(['-e', 'process.stdout.write(String(process.env.SAIL_PROXY_BACKUP_PASSPHRASE))']);
    assert.strictEqual(stdout, 'undefined');
  } finally {
    delete process.env.SAIL_PROXY_BACKUP_PASSPHRASE;
  }
});

test('disk full while the dump streams to this machine: rollback runs, exit 2, no partial file', async (base) => {
  const fake = base.clone();
  const real = spawnKubectl(process.execPath);
  const kubectl = async (args, opt = {}) => {
    if (args[0] === 'exec' && args.includes('cat') && opt.stdout) {
      await fake.run(['get', 'namespace', NS, '-o', 'name']); // recorded like any call
      return real(['-e', 'setInterval(() => process.stdout.write(Buffer.alloc(65536)), 1)'], { ...opt, stdout: fullDisk(opt.stdout, 256 * 1024) });
    }
    return fake.run(args, opt);
  };
  const { code, out, backups, result } = await upgrade(fake, { ctx: { kubectl } });
  assert.strictEqual(code, 2, out.slice(-1500));
  assert.strictEqual(result.failedAt, 'backup');
  assert.match(out, /disk is full/);
  assert.deepStrictEqual(backups, []);
  assert.deepStrictEqual(replicas(fake), replicas(base));
  assert.strictEqual(fake.podFiles.size, 0, 'the pod-side dump is removed');
});

test('an aborted dump stops and removes the pod-side work (through the unguarded kubectl)', async (base) => {
  const fake = base.clone();
  const signals = new EventEmitter();
  fake.beforeCommand = async (args) => { if (args.includes('cat') && fake.podFiles.size > 0) signals.emit('SIGINT', 'SIGINT'); };
  const { code, out } = await upgrade(fake, { signals });
  assert.strictEqual(code, 2, out.slice(-1500));
  assert.ok(fake.calls.some((a) => /^kill \$\(cat \S+\.pid/.test(a[a.length - 1] || '')), 'the pod-side pg_dump/gzip is killed');
  assert.strictEqual(fake.podFiles.size, 0, 'no dump left in the pod');
});

test('a rollback that fails before anything was applied says the database is untouched and how to start the old version', async (base) => {
  const fake = base.clone();
  const signals = new EventEmitter();
  let interrupted = false;
  fake.beforeCommand = async (args) => {
    if (!interrupted && args.join(' ').includes('pg_dump')) { interrupted = true; signals.emit('SIGINT', 'SIGINT'); }
    if (interrupted && args[0] === 'scale' && args.includes('--replicas=1')) throw Object.assign(new Error('kubectl failed'), { stderr: 'Error from server (InternalError): etcd timeout\n' });
  };
  const { code, out } = await upgrade(fake, { signals });
  assert.strictEqual(code, 3, out.slice(-1500));
  assert.match(out, /database is untouched/);
  assert.ok(out.includes(`kubectl scale deployment admin -n ${NS} --replicas=1`) && out.includes(`kubectl scale deployment gateway -n ${NS} --replicas=1`), out.slice(-600));
  assert.doesNotMatch(out, /may be partly upgraded/);
});

test('can-i asks subresources with --subresource and checks watch', async (base) => {
  const fake = base.clone();
  await upgrade(fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'preflight' } });
  const canI = fake.calls.filter((a) => a[0] === 'auth').map((a) => a.join(' '));
  for (const expected of [
    `auth can-i create pods --subresource=exec -n ${NS}`,
    `auth can-i get pods --subresource=log -n ${NS}`,
    `auth can-i update deployments.apps --subresource=scale -n ${NS}`,
    `auth can-i patch deployments.apps --subresource=scale -n ${NS}`,
    `auth can-i watch deployments.apps -n ${NS}`, `auth can-i watch statefulsets.apps -n ${NS}`, `auth can-i watch jobs.batch -n ${NS}`,
    'auth can-i delete clusterroles.rbac.authorization.k8s.io', 'auth can-i update envoyfilters.networking.istio.io -n istio-system',
  ]) assert.ok(canI.includes(expected), `asked: ${expected}`);
  assert.ok(!canI.some((c) => /\/(exec|log|scale)/.test(c)), 'no resource/subresource argument');
});

test('the images keep the installation\'s registry and organization (a private org); test-mode flags set all three', async (base) => {
  const fake = base.clone();
  const record = fake.get('configmap', NS, 'sail-proxy-install');
  record.data.answers = JSON.stringify({ ...JSON.parse(record.data.answers), organization: 'st-gr-private' });
  for (const name of ['gateway', 'admin', 'nginx']) {
    const c = fake.get('deployment', NS, name).spec.template.spec.containers[0];
    c.image = c.image.replace('/st-gr/', '/st-gr-private/');
  }
  const looked = [];
  const lookupDigest = async (config, img, tag) => { looked.push(`${config.registry}/${config.organization}/${img}:${tag}`); return `sha256:${'b'.repeat(64)}`; };
  const kept = await upgrade(fake, { ctx: { lookupDigest } });
  assert.strictEqual(kept.code, 0, kept.out.slice(-1500));
  for (const name of ['gateway', 'admin', 'nginx']) assert.strictEqual(image(fake, name), `ghcr.io/st-gr-private/sail-proxy-${name}:0.12.0`);
  assert.ok(looked.includes('ghcr.io/st-gr-private/sail-proxy-gateway:0.12.0'));

  const flagged = base.clone();
  const test = await upgrade(flagged, { ctx: { testImages: { registry: 'registry.example.test', organization: 'rc-images', tag: 'rc-1a2b3c4d' } } });
  assert.strictEqual(test.code, 0, test.out.slice(-1500));
  for (const name of ['gateway', 'admin', 'nginx']) assert.strictEqual(image(flagged, name), `registry.example.test/rc-images/sail-proxy-${name}:rc-1a2b3c4d`);
});

test('SAIL_PROXY_BACKUP_PASSPHRASE is read once and reaches no child (the kit\'s setup-docker.js included)', async (base) => {
  const fake = base.clone();
  const atSpawn = [];
  process.env.SAIL_PROXY_BACKUP_PASSPHRASE = PASSPHRASE;
  try {
    const adjustSetup = (setup) => {
      const spawnDockerSetup = setup.spawnDockerSetup.bind(setup);
      setup.spawnDockerSetup = (...args) => { atSpawn.push(process.env.SAIL_PROXY_BACKUP_PASSPHRASE); return spawnDockerSetup(...args); };
    };
    const { code, out, result } = await upgrade(fake, { env: null, ctx: { adjustSetup } });
    assert.strictEqual(code, 0, out.slice(-1500));
    assert.deepStrictEqual(atSpawn, [undefined], 'setup-docker.js is spawned without it');
    const work = fs.mkdtempSync(path.join(scratch, 'open-env-'));
    await openBundle(result.backup, PASSPHRASE, work); // it still encrypted the backup
    assert.strictEqual(process.env.SAIL_PROXY_BACKUP_PASSPHRASE, PASSPHRASE, 'given back to the caller afterwards');
  } finally {
    delete process.env.SAIL_PROXY_BACKUP_PASSPHRASE;
  }
});

test('rollback: migration Jobs are deleted in the foreground and their pods gone before the database restore', async (base) => {
  const fake = base.clone();
  fake.jobPodPolls = 2;
  const { code, out } = await upgrade(fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'migrate' } });
  assert.strictEqual(code, 2, out.slice(-1500));
  const calls = fake.calls.map((a) => a.join(' '));
  const del = calls.findIndex((c) => c.startsWith('delete jobs.batch sail-proxy-migrate-admin sail-proxy-migrate-file-search') && c.includes('--cascade=foreground') && c.includes('--wait=true'));
  const polls = calls.map((c, i) => (c.includes('job-name in (sail-proxy-migrate-admin,sail-proxy-migrate-file-search)') ? i : -1)).filter((i) => i >= 0);
  const restore = calls.findIndex((c) => / gunzip \S+\.gz && /.test(` ${c.split(' -c ')[1] || ''}`) || /sh -c gunzip/.test(c));
  assert.ok(del > 0 && polls.length === 3 && polls[0] > del && polls[2] < restore, `delete ${del}, polls ${polls}, restore ${restore}`);
  assert.deepStrictEqual(calls.slice(del + 1, polls[2] + 1).filter((c, i) => !polls.includes(del + 1 + i)), [], 'nothing else runs until the pods are gone');
});

test('rollback: migration pods that do not go stop the rollback before the restore (exit 3, restore hint)', async (base) => {
  const fake = base.clone();
  fake.jobPodPolls = 1e9;
  const { code, out, result } = await upgrade(fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'migrate' }, ctx: { jobStopTimeoutSeconds: 0 } });
  assert.strictEqual(code, 3, out.slice(-1500));
  assert.match(out, /Migration pods are still running/);
  assert.ok(!fake.calls.some((a) => /gunzip/.test(a.join(' '))), 'the database was not restored');
  assert.ok(out.includes(`sail-proxy restore kyma --namespace ${NS} --input "${result.backup}"`));
});

// restoreObjects branches, against a scripted kubectl
async function restoreWith(script, obj) {
  const calls = [];
  const kubectl = async (args) => {
    const file = args[args.indexOf('-f') + 1];
    const sent = JSON.parse(fs.readFileSync(file, 'utf8'));
    calls.push({ args: args.filter((a) => a !== file), rv: sent.metadata.resourceVersion });
    return script(args, sent);
  };
  const dir = fs.mkdtempSync(path.join(scratch, 'restore-objects-'));
  const error = await restoreObjects(kubectl, [obj], dir).then(() => null, (e) => e);
  return { calls, error };
}
const cr = { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy', metadata: { name: 'p', namespace: NS, resourceVersion: '7' }, spec: {} };
const err = (stderr) => Object.assign(new Error('kubectl failed'), { stderr });

test('restoreObjects: an absent object is created; a live one replaced at the live resourceVersion', async () => {
  const absent = await restoreWith((a) => { if (a[0] === 'get') throw err('Error from server (NotFound): authorizationpolicies "p" not found\n'); return { stdout: '' }; }, cr);
  assert.strictEqual(absent.error, null);
  assert.deepStrictEqual(absent.calls.map((c) => c.args.join(' ')), ['get -f -o json', 'create -f']);
  assert.strictEqual(absent.calls[1].rv, undefined, 'created without a stale resourceVersion');
  const live = await restoreWith((a) => (a[0] === 'get' ? { stdout: JSON.stringify({ ...cr, metadata: { ...cr.metadata, resourceVersion: '42' } }) } : { stdout: '' }), cr);
  assert.deepStrictEqual(live.calls.map((c) => c.args.join(' ')), ['get -f -o json', 'replace -f']);
  assert.strictEqual(live.calls[1].rv, '42');
});

test('restoreObjects: the restored last-applied annotation is the snapshot\'s, never one with a resourceVersion', async () => {
  // 2026-11-08 rehearsal: `kubectl replace` rewrites an existing last-applied annotation from the file
  // it sends, which carries the live resourceVersion; the next `kubectl apply` then patched
  // resourceVersion away and the server refused the PeerAuthentication ("must be specified for an update").
  const LAST = 'kubectl.kubernetes.io/last-applied-configuration';
  const applied = { apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication', metadata: { annotations: {}, name: 'default', namespace: NS }, spec: { mtls: { mode: 'PERMISSIVE' } } };
  const obj = { ...cr, kind: 'PeerAuthentication', metadata: { name: 'default', namespace: NS, resourceVersion: '7', annotations: { [LAST]: JSON.stringify(applied) } } };
  const sentFiles = [];
  const result = await restoreWith((a, sent) => {
    sentFiles.push({ args: a.filter((x) => !x.endsWith('.json')).join(' '), sent });
    return a[0] === 'get' ? { stdout: JSON.stringify({ ...obj, metadata: { ...obj.metadata, resourceVersion: '42' } }) } : { stdout: '' };
  }, obj);
  assert.strictEqual(result.error, null);
  const last = sentFiles[sentFiles.length - 1];
  assert.strictEqual(last.args, 'apply set-last-applied -f');
  assert.deepStrictEqual(last.sent, applied, 'the annotation is set back to the snapshot\'s value');
  assert.strictEqual(last.sent.metadata.resourceVersion, undefined);
  // an object without the annotation gets none
  const plain = await restoreWith((a) => (a[0] === 'get' ? { stdout: JSON.stringify({ ...cr, metadata: { ...cr.metadata, resourceVersion: '42' } }) } : { stdout: '' }), cr);
  assert.ok(!plain.calls.some((c) => c.args.join(' ').includes('set-last-applied')));
});

test('restoreObjects: --force only for an Invalid/immutable error; any other error stops it', async () => {
  const getLive = { stdout: JSON.stringify({ ...cr, metadata: { ...cr.metadata, resourceVersion: '42' } }) };
  const immutable = await restoreWith((a) => {
    if (a[0] === 'get') return getLive;
    if (a[0] === 'replace' && !a.includes('--force')) throw err('The Deployment "p" is invalid: spec.selector: Invalid value: field is immutable\n');
    return { stdout: '' };
  }, cr);
  assert.strictEqual(immutable.error, null);
  assert.deepStrictEqual(immutable.calls.map((c) => c.args.join(' ')), ['get -f -o json', 'replace -f', 'replace --force -f']);
  for (const stderr of ['error: You must be logged in to the server (Unauthorized)\n', 'Error from server (Conflict): the object has been modified\n']) {
    const other = await restoreWith((a) => { if (a[0] === 'get') return getLive; throw err(stderr); }, cr);
    assert.ok(other.error && other.error.stderr === stderr, 'the error propagates');
    assert.ok(!other.calls.some((c) => c.args.includes('--force')), 'never deleted and recreated');
  }
  const getFails = await restoreWith(() => { throw err('error: You must be logged in to the server (Unauthorized)\n'); }, cr);
  assert.ok(getFails.error, 'an unreadable live object stops it');
  assert.ok(!getFails.calls.some((c) => c.args[0] === 'create'));
});

// ---- fix round 2 ------------------------------------------------------------------------------
test('preflight needs room for three dump copies plus 100 MB (dump, bundle, rollback restore input)', async (base) => {
  const { backupSpaceNeeded } = require('../dist/upgrade/kymaChecks');
  const MiB = 1024 * 1024;
  assert.strictEqual(backupSpaceNeeded(0), 100 * MiB);
  assert.strictEqual(backupSpaceNeeded(5e9), 3 * 5e9 + 100 * MiB);
  // the fake database is 1 MiB: 103 MiB needed; 102.5 MiB was enough under the old 2x rule
  const short = await upgrade(base.clone(), { ctx: { statfs: async () => 102.5 * MiB } });
  assert.strictEqual(short.code, 1);
  assert.match(short.result.error, /Not enough free space .*: 103 MB needed \(3 × the 1 MB database/);
  const enough = await upgrade(base.clone(), { ctx: { statfs: async () => 103 * MiB }, env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'preflight' } });
  assert.strictEqual(enough.result.failedAt, 'preflight');
  assert.match(enough.result.error, /failure injected at step preflight/, 'the disk check passed');
});

test('restoreObjects: a Conflict is retried at the re-read resourceVersion; five Conflicts give up', async () => {
  let rv = 40;
  let conflicts = 1;
  const once = await restoreWith((a) => {
    if (a[0] === 'get') return { stdout: JSON.stringify({ ...cr, metadata: { ...cr.metadata, resourceVersion: String(++rv) } }) };
    if (a[0] === 'replace' && conflicts-- > 0) throw err('Error from server (Conflict): Operation cannot be fulfilled: the object has been modified\n');
    return { stdout: '' };
  }, cr);
  assert.strictEqual(once.error, null);
  assert.deepStrictEqual(once.calls.map((c) => `${c.args.join(' ')}@${c.rv}`), ['get -f -o json@undefined', 'replace -f@41', 'get -f -o json@41', 'replace -f@42']);
  const always = await restoreWith((a) => {
    if (a[0] === 'get') return { stdout: JSON.stringify({ ...cr, metadata: { ...cr.metadata, resourceVersion: String(++rv) } }) };
    throw err('Error from server (Conflict): the object has been modified\n');
  }, cr);
  assert.ok(always.error && /Conflict/.test(always.error.stderr), 'the fifth Conflict propagates');
  assert.strictEqual(always.calls.filter((c) => c.args[0] === 'replace').length, 5);
  assert.ok(!always.calls.some((c) => c.args.includes('--force')));
});

// ---- restore ---------------------------------------------------------------------------------
test('restore kyma --manifests puts the previous version and database back; a wrong passphrase applies nothing', async (base) => {
  const fake = base.clone();
  const { code, result } = await upgrade(fake);
  assert.strictEqual(code, 0);
  fake.add({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'made-after-the-backup', namespace: NS, labels: { 'app.kubernetes.io/part-of': 'sail-proxy' } }, data: {} });
  const lines = [];
  const restoreConsole = captureConsole(lines);
  try {
    const upgraded = fake.state();
    const wrong = await runRestore({
      namespace: NS, input: result.backup, manifests: true, yes: true, prompt: async () => { throw new Error('no prompt'); },
      kubectl: (a, o) => fake.run(a, o), env: { SAIL_PROXY_BACKUP_PASSPHRASE: 'not the passphrase at all' }, pollMs: 1, healthTimeoutSeconds: 2, log: (m) => lines.push(m),
    });
    assert.strictEqual(wrong.ok, false);
    assert.match(wrong.error, /wrong passphrase or damaged file/);
    assert.strictEqual(fake.state(), upgraded, 'nothing applied');
    const ok = await runRestore({
      namespace: NS, input: result.backup, manifests: true, yes: true, prompt: async () => { throw new Error('no prompt'); },
      kubectl: (a, o) => fake.run(a, o), env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASSPHRASE }, pollMs: 1, healthTimeoutSeconds: 2, log: (m) => lines.push(m),
    });
    assert.strictEqual(ok.ok, true, lines.slice(-10).join('\n'));
    assertPhases(lines.join('\n'), ['Stopping the gateway and admin', "Re-applying the previous version's objects", 'Restoring the database from the backup', 'Starting the previous version', 'Waiting for the previous version to report healthy']);
  } finally {
    restoreConsole();
  }
  assert.strictEqual(fake.db, base.db);
  assert.match(image(fake, 'gateway'), /:0\.11\.0$/);
  assert.ok(!fake.get('configmap', NS, 'made-after-the-backup'), 'restore --manifests removes objects the backup lacks');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(result.backup)).filter((f) => f.startsWith('.')), []);
});

/** The backup with extra entries added (the writer re-seals it; a plaintext bundle could be edited the same way). */
async function withExtraEntries(backup, extra) {
  const work = fs.mkdtempSync(path.join(scratch, 'repack-'));
  const bundle = await openBundle(backup, PASSPHRASE, work);
  const { entries, ...manifest } = bundle.manifest;
  const added = Object.entries(extra).map(([name, obj]) => {
    const f = path.join(work, `extra-${name.replace(/\W/g, '_')}`);
    fs.writeFileSync(f, JSON.stringify(obj));
    return { name, source: f };
  });
  async function* list() { for (const e of entries) yield { name: e.name, source: bundle.path(e.name) }; yield* added; }
  const out = path.join(work, 'edited.spbk');
  await writeBundle(out, PASSPHRASE, manifest, list());
  return out;
}

test('restore kyma --manifests refuses objects the upgrade never snapshots, before anything is applied', async (base) => {
  const fake = base.clone();
  const { code, result } = await upgrade(fake);
  assert.strictEqual(code, 0);
  const foreign = [
    ['previous/_cluster/ClusterRoleBinding-evil.json', { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'evil' }, subjects: [], roleRef: { kind: 'ClusterRole', name: 'cluster-admin', apiGroup: 'rbac.authorization.k8s.io' } }],
    ['previous/_cluster/ClusterRole-other-dex.json', { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'other-dex' }, rules: [] }],
    ['previous/_cluster/Namespace-x.json', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'x' } }],
    ['previous/istio-system/EnvoyFilter-foreign.json', { apiVersion: 'networking.istio.io/v1alpha3', kind: 'EnvoyFilter', metadata: { name: 'foreign', namespace: 'istio-system', labels: { 'sail-proxy/namespace': 'someone-else' } } }],
    ['previous/istio-system/Deployment-x.json', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'x', namespace: 'istio-system' } }],
  ];
  const lines = [];
  for (const [name, obj] of foreign) {
    const edited = await withExtraEntries(result.backup, { [name]: obj });
    const before = fake.state();
    const r = await runRestore({
      namespace: NS, input: edited, manifests: true, yes: true, prompt: async () => { throw new Error('no prompt'); },
      kubectl: (a, o) => fake.run(a, o), env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASSPHRASE }, pollMs: 1, healthTimeoutSeconds: 2, log: (m) => lines.push(m),
    });
    assert.strictEqual(r.ok, false, name);
    assert.ok(r.error.includes(`${obj.kind}/${obj.metadata.name}`) && /nothing was changed/.test(r.error), r.error);
    assert.strictEqual(fake.state(), before, `${name}: nothing applied`);
  }
});

test('restore kyma: Ctrl-C once changes start is reported and the restore runs to completion', async (base) => {
  const fake = base.clone();
  const { result } = await upgrade(fake);
  const signals = new EventEmitter();
  fake.beforeCommand = async (args) => { if (args.join(' ').includes('gunzip')) signals.emit('SIGINT', 'SIGINT'); };
  const lines = [];
  const r = await runRestore({
    namespace: NS, input: result.backup, manifests: true, yes: true, prompt: async () => { throw new Error('no prompt'); }, signals,
    kubectl: (a, o) => fake.run(a, o), env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASSPHRASE }, pollMs: 1, healthTimeoutSeconds: 2, log: (m) => lines.push(m),
  });
  assert.strictEqual(r.ok, true, lines.join('\n'));
  assert.match(lines.join('\n'), /SIGINT received: the restore is restoring the database.*runs to completion/);
  for (const n of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.strictEqual(signals.listenerCount(n), 0, `${n} listener removed`);
});

test('the version guard orders pre-releases numerically (rc.10 is newer than rc.2)', () => {
  const { checkVersions } = require('../dist/upgrade/kymaChecks');
  const policy = { minUpgradeFrom: '0.11.0' };
  assert.doesNotThrow(() => checkVersions('0.12.0-rc.2', '0.12.0-rc.10', policy, false));
  assert.throws(() => checkVersions('0.12.0-rc.10', '0.12.0-rc.2', policy, false), /not newer/);
});

test('hand-restore commands quote paths for copy-paste', () => {
  const { quotePath } = require('../dist/upgrade/steps');
  if (process.platform === 'win32') return assert.strictEqual(quotePath('C:\\a b'), '"C:\\a b"');
  assert.strictEqual(quotePath('/tmp/my "x" $HOME `id`/b.spbk'), '"/tmp/my \\"x\\" \\$HOME \\`id\\`/b.spbk"');
});

// ---- no secret value reaches the output (child process: setup-docker.js output included) -----
test('no secret value of the installation appears in stdout/stderr (success and rollback)', async (base) => {
  const state = path.join(scratch, 'child-state.json');
  fs.writeFileSync(state, JSON.stringify([...base.objects]));
  const child = spawnSync('node', [__filename], {
    env: { ...process.env, UPGRADE_KYMA_CHILD: state }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${child.stdout}\n${child.stderr}`;
  assert.strictEqual(child.status, 0, output.slice(-2000));
  assert.match(output, /CHILD-RESULTS 0 2/);
  assert.doesNotMatch(output, /docker-compose (build|up)|Test users:/, 'the setup-docker child\'s Docker instructions are not part of an upgrade');
  const secrets = base.secretValues();
  const value = (secret, key) => Buffer.from(base.get('secret', NS, secret).data[key], 'base64').toString('utf8');
  for (const [secret, key] of [['admin-env', 'VALIDATION_TOKEN_SECRET'], ['admin-env', 'AWS_SECRET_ENCRYPTION_KEY'],
    ['postgres-env', 'POSTGRES_PASSWORD'], ['oauth2-proxy-secrets', 'cookie-secret'], ['oauth2-proxy-secrets', 'client-secret']]) {
    assert.ok(secrets.includes(value(secret, key)), `the check covers ${secret}/${key}`);
  }
  for (const secret of secrets) assert.ok(!output.includes(secret), `a secret value reached the output: ${secret} near: ${output.slice(Math.max(0, output.indexOf(secret) - 200), output.indexOf(secret) + 50)}`);
});

async function child() {
  const objects = JSON.parse(fs.readFileSync(process.env.UPGRADE_KYMA_CHILD, 'utf8'));
  const make = () => { const f = new FakeKyma(NS); f.objects = new Map(objects); return f; };
  const ok = await upgrade(make(), { quiet: false });
  const failed = await upgrade(make(), { quiet: false, env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'health' } });
  // the run's own messages too
  console.log(ok.out);
  console.log(failed.out);
  console.log(`CHILD-RESULTS ${ok.code} ${failed.code}`);
}

async function main() {
  if (process.env.UPGRADE_KYMA_CHILD) return child();
  const only = process.env.TEST_ONLY;
  const base = await buildInstallation();
  let failed = 0;
  for (const [name, fn] of tests) {
    if (only && !name.includes(only)) continue;
    try {
      await fn(base);
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.log(`not ok - ${name}\n${error.stack}`);
    }
  }
  return failed;
}

main().then((failed) => {
  fs.rmSync(scratch, { recursive: true, force: true });
  if (failed) { console.log(`# ${failed} failed`); process.exit(1); }
  process.exit(0);
}, (error) => {
  console.error(error);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
