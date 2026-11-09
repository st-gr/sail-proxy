// `sail-proxy upgrade docker` / `restore docker` against a fake Docker host (test/helpers/fake-docker.js):
// no docker, git, registry or network is reached. The installation is made the way a real one is:
// the release kit's setup-docker.js writes a 0.11.0 install directory (--ci answers, then registry
// images), which the fake reports as a running compose project.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const PASSPHRASE = 'correct horse battery staple';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-docker-test-'));

execFileSync('node', [path.join(pkgRoot, 'scripts', 'copy-release-kit.js')], { stdio: 'ignore' });

const { FakeDocker, envOf } = require('./helpers/fake-docker');
const { runDockerUpgrade } = require('../dist/upgrade/docker');
const { runDockerRestore } = require('../dist/upgrade/dockerRestore');
const { exitCodeOf } = require('../dist/upgrade/kyma');
const { findComposeProject, composeFiles, trackedChanges, nginxPort } = require('../dist/upgrade/dockerHost');
const { writeBundle } = require('../dist/upgrade/bundle');
const { spawnCommand } = require('../dist/upgrade/kubectl');
const { materializeKit } = require('../dist/upgrade/kit');
const { openBundle } = require('../dist/upgrade/bundle');

const INPUTS = ['docker/docker-compose.yml', 'docker/configs', 'services/gateway/.env.sample', 'services/admin/.env.sample',
  'services/ollama/.env.sample', 'services/gateway/api_config.json', 'services/admin/api_config.json'];
const KEYS = {
  'services/gateway/.env': ['VALIDATION_TOKEN_SECRET', 'METADATA_ENCRYPTION_KEY'],
  'services/admin/.env': ['VALIDATION_TOKEN_SECRET', 'METADATA_ENCRYPTION_KEY', 'AWS_SECRET_ENCRYPTION_KEY', 'SIEM_CREDENTIAL_KEY', 'CONNECTION_CREDENTIAL_KEY'],
  'docker/.env': ['POSTGRES_PASSWORD'],
  'docker/.env.auth': ['OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET'],
};

function captureConsole(lines) {
  const saved = ['log', 'warn', 'error', 'info'].map((m) => [m, console[m]]);
  for (const [m] of saved) console[m] = (...a) => lines.push(a.map(String).join(' '));
  return () => { for (const [m, f] of saved) console[m] = f; };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** rel path -> sha256 and mode of every file under dir (not .git). */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = `${sha(fs.readFileSync(full))} ${fs.statSync(full).mode & 0o777}`;
    }
  };
  walk(dir);
  return out;
}

/** A 0.11.0 install directory, written by the kit's setup-docker.js. */
async function buildInstallation() {
  const dir = path.join(scratch, 'base-install');
  for (const rel of INPUTS) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(path.join(repoRoot, rel), path.join(dir, rel), { recursive: true });
  }
  // the 0.11.0 release's own compose file, told apart from the kit's
  fs.appendFileSync(path.join(dir, 'docker', 'docker-compose.yml'), '\n# release 0.11.0\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sail-proxy', version: '0.11.0' }));
  fs.mkdirSync(path.join(dir, '.git'));
  const kit = await materializeKit();
  const lines = [];
  const restore = captureConsole(lines);
  const saved = { argv: process.argv, key: process.env.SAP_AI_CORE_SERVICE_KEY };
  try {
    process.env.SAP_AI_CORE_SERVICE_KEY = JSON.stringify({
      serviceurls: { AI_API_URL: 'https://api.ai.example.invalid' }, url: 'https://auth.example.invalid',
      clientid: 'test-client-id', clientsecret: 'test-client-secret',
    });
    process.argv = [saved.argv[0], 'setup-docker.js'];
    const DockerSetup = require(path.join(kit.root, 'docker', 'setup-docker.js'));
    process.argv = saved.argv;
    const setup = new DockerSetup({ ciMode: true, forceOverwrite: true });
    setup.dockerDir = path.join(dir, 'docker');
    setup.configsDir = path.join(dir, 'docker', 'configs');
    setup.projectRoot = dir;
    setup.checkExistingVolumes = () => [];
    setup.deleteVolumes = () => { throw new Error('volumes deleted'); };
    setup.detectArchitecture = () => ({ isAppleSilicon: false });
    await setup.applyAnswers(setup.unattendedAnswers());
    await setup.configureDockerImages('registry', 'ghcr.io', 'st-gr');
  } catch (error) {
    restore();
    console.error(lines.slice(-30).join('\n'));
    throw error;
  } finally {
    restore();
    process.argv = saved.argv;
    if (saved.key === undefined) delete process.env.SAP_AI_CORE_SERVICE_KEY;
    else process.env.SAP_AI_CORE_SERVICE_KEY = saved.key;
    await kit.cleanup();
  }
  return dir;
}

let counter = 0;
function cloneInstall(base) {
  const dir = path.join(scratch, `install-${++counter}`);
  fs.cpSync(base, dir, { recursive: true });
  return { dir, fake: new FakeDocker({ dir }) };
}

const tempLeftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => /^sail-proxy-(kit|render|local-config)-/.test(f)).sort();

async function upgrade(dir, fake, o = {}) {
  const backupDir = o.backupDir || fs.mkdtempSync(path.join(scratch, 'backups-'));
  const asked = [];
  const lines = [];
  const before = tempLeftovers();
  const restore = captureConsole(lines);
  let result;
  try {
    result = await runDockerUpgrade({
      dir,
      packageVersion: '0.12.0',
      backupDir,
      yes: true,
      prompt: async (q) => {
        asked.push(q.id || q.name);
        if (o.answers && (q.id || q.name) in o.answers) return o.answers[q.id || q.name];
        throw new Error(`unexpected question ${q.id || q.name}: ${q.message}`);
      },
      docker: (a, opt) => fake.run(a, opt),
      git: (a) => fake.git(a),
      httpGet: (url) => fake.http(url),
      statfs: async () => 10 * 1024 ** 3,
      signals: o.signals || new EventEmitter(),
      env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASSPHRASE, ...(o.env || {}) },
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
  assert.deepStrictEqual(tempLeftovers(), before, 'the kit copy and the file snapshot are removed');
  assert.deepStrictEqual(fs.readdirSync(backupDir).filter((f) => f.startsWith('.')), [], 'the work dir is removed');
  return { result, code: exitCodeOf(result), asked, out, backupDir, backups: fs.readdirSync(backupDir) };
}

const keyHashes = (dir) => Object.fromEntries(Object.entries(KEYS).flatMap(([file, keys]) => {
  const env = envOf(path.join(dir, file));
  return keys.map((k) => [`${file}:${k}`, env[k] ? sha(env[k]) : undefined]);
}));
const FORBIDDEN = (args) => args.some((a) => a === 'down' || a === '-v' || a === '--volumes' || a === 'volume' || a === 'prune');

/** Each phase line is followed by its duration (and only heartbeats in between). */
function assertPhases(text, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\']/g, '\\$&');
    assert.match(text, new RegExp(`^${esc}\\.\\.\\.\\n(?: {2}still .*\\n)* {2}done in \\d+ s$`, 'm'), `phase "${label}" with its duration`);
  }
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- shared spawn helper ---------------------------------------------------------------------
test('spawnCommand: errors name the binary; extra env reaches the child, the passphrase never', async () => {
  const run = spawnCommand(process.execPath);
  await assert.rejects(run(['-e', 'process.stderr.write("boom\\n"); process.exit(3)']), (e) => {
    assert.match(e.message, new RegExp(`^${path.basename(process.execPath).replace(/\.exe$/i, '')} -e failed: boom`), 'named without .exe, like kubectl on Windows');
    assert.strictEqual(e.exitCode, 3);
    return true;
  });
  process.env.SAIL_PROXY_BACKUP_PASSPHRASE = 'never-in-a-child';
  try {
    const { stdout } = await run(['-e', 'process.stdout.write(`${process.env.DOCKER_TAG}|${process.env.SAIL_PROXY_BACKUP_PASSPHRASE}`)'], { env: { DOCKER_TAG: '9.9.9' } });
    assert.strictEqual(stdout, '9.9.9|undefined');
  } finally {
    delete process.env.SAIL_PROXY_BACKUP_PASSPHRASE;
  }
});

// ---- install record (kit side) ---------------------------------------------------------------
test('setup-docker.js writes docker/.sail-proxy-install.json without secrets', async (base) => {
  const record = JSON.parse(fs.readFileSync(path.join(base, 'docker', '.sail-proxy-install.json'), 'utf8'));
  assert.strictEqual(record.version, '0.11.0');
  assert.strictEqual(record.recordedBy, 'setup');
  assert.strictEqual(record.answers.provider, 'local');
  const text = JSON.stringify(record);
  for (const [file, keys] of Object.entries(KEYS)) {
    const env = envOf(path.join(base, file));
    for (const k of keys) assert.ok(!text.includes(env[k]), `${k} is not in the record`);
  }
});

// ---- compose project discovery ---------------------------------------------------------------
test('findComposeProject: from the running postgres labels; none or several refuse; Windows paths compare by path', async () => {
  const rows = (list) => async () => ({ stdout: list.map(([p, d]) => `${p}\t${d}\n`).join(''), stderr: '' });
  assert.strictEqual(await findComposeProject(rows([['other', '/x/docker'], ['mine', '/srv/sail/docker']]), '/srv/sail/'), 'mine');
  await assert.rejects(findComposeProject(rows([['other', '/x/docker']]), '/srv/sail'), /No running sail-proxy installation/);
  await assert.rejects(findComposeProject(rows([['a', '/srv/sail/docker'], ['b', '/srv/sail/docker']]), '/srv/sail'), /several compose projects \(a, b\)/);
  const win = { pathApi: path.win32 };
  assert.strictEqual(await findComposeProject(rows([['winproj', 'C:\\Users\\Ops\\sail-proxy\\docker']]), 'c:/users/ops/sail-proxy/', win), 'winproj');
  assert.strictEqual(await findComposeProject(rows([['winproj', 'C:\\Users\\Ops\\sail-proxy\\docker']]), 'C:\\Users\\Ops\\sail-proxy', win), 'winproj');
});

test('composeFiles: the override file only when present', async (base) => {
  const { dir } = cloneInstall(base);
  assert.deepStrictEqual(composeFiles(dir), [path.join(dir, 'docker', 'docker-compose.yml')]);
  fs.writeFileSync(path.join(dir, 'docker', 'docker-compose.override.yml'), 'services:\n  ldap-server:\n    image: x\n');
  assert.deepStrictEqual(composeFiles(dir), [path.join(dir, 'docker', 'docker-compose.yml'), path.join(dir, 'docker', 'docker-compose.override.yml')]);
});

test('trackedChanges: a file the last upgrade wrote (same sha256 as recorded) is no local change', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'git-'));
  fs.mkdirSync(path.join(dir, 'docker'));
  fs.writeFileSync(path.join(dir, 'docker', 'docker-compose.yml'), 'compose of 0.12.0');
  fs.writeFileSync(path.join(dir, 'README.md'), 'edited');
  const git = async () => ({ stdout: ' M docker/docker-compose.yml\0 M README.md\0', stderr: '' });
  assert.deepStrictEqual(await trackedChanges(git, dir, {}), ['docker/docker-compose.yml', 'README.md']);
  assert.deepStrictEqual(await trackedChanges(git, dir, { 'docker/docker-compose.yml': sha('compose of 0.12.0') }), ['README.md']);
  assert.deepStrictEqual(await trackedChanges(git, dir, { 'docker/docker-compose.yml': sha('other') }), ['docker/docker-compose.yml', 'README.md']);
});

// ---- the happy path --------------------------------------------------------------------------
test('an override file of the admin\'s (no build) survives the upgrade unchanged', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const override = path.join(dir, 'docker', 'docker-compose.override.yml');
  const text = 'services:\n  valkey:\n    ports: !override\n      - "127.0.0.1:16379:6379"\n';
  fs.writeFileSync(override, text);
  const { code, out } = await upgrade(dir, fake);
  assert.strictEqual(code, 0, out.slice(-3000));
  assert.ok(fs.existsSync(override), 'setup removes only an override it wrote itself');
  assert.strictEqual(fs.readFileSync(override, 'utf8'), text);
});

test('a failed command is named by its error line, not by a progress line before it', () => {
  const { KubectlError } = require('../dist/upgrade/kubectl');
  const stderr = ' dex Pulling \n Container sprehearsal-valkey-1  Starting\nError response from daemon: Bind for 127.0.0.1:6379 failed: port is already allocated\n';
  assert.strictEqual(new KubectlError(['compose', 'up'], 1, '', stderr, 'docker').message,
    'docker compose failed: Error response from daemon: Bind for 127.0.0.1:6379 failed: port is already allocated');
  assert.strictEqual(new KubectlError(['get'], 1, '', 'Error from server (NotFound): x\nmore\n').message, 'kubectl get failed: Error from server (NotFound): x');
  assert.strictEqual(new KubectlError(['get'], 1, '', 'boom\nsecond\n').message, 'kubectl get failed: boom', 'no error-like line: the first line');
  assert.strictEqual(new KubectlError(['get'], 7, '', '').message, 'kubectl get failed: exit code 7');
});

test('happy path: new DOCKER_TAG and record, keys kept, steps in order, no down/-v/volume/prune', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const keysBefore = keyHashes(dir);
  const { code, result, asked, out, backups } = await upgrade(dir, fake);
  assert.strictEqual(code, 0, out.slice(-3000));
  assert.deepStrictEqual(asked, []);
  assert.deepStrictEqual([...out.matchAll(/=== Step: (\w+) ===/g)].map((m) => m[1]),
    ['read', 'ask', 'preflight', 'outage', 'backup', 'apply', 'migrate', 'health', 'record']);
  for (const file of ['.env', '.env.docker']) {
    const env = envOf(path.join(dir, 'docker', file));
    assert.deepStrictEqual([env.DOCKER_REGISTRY, env.DOCKER_ORGANIZATION, env.DOCKER_TAG], ['ghcr.io', 'st-gr', '0.12.0'], file);
  }
  assert.deepStrictEqual(keyHashes(dir), keysBefore, 'every generated key kept (sha256)');
  assert.deepStrictEqual(Object.keys(keysBefore).filter((k) => !keysBefore[k]), [], "the fixture holds every key");
  assert.strictEqual(fs.readFileSync(path.join(dir, 'docker', 'docker-compose.yml'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8'), 'the release\'s compose file');
  for (const s of ['gateway', 'admin', 'nginx']) assert.strictEqual(fake.get(s).image, `ghcr.io/st-gr/sail-proxy-${s}:0.12.0`);
  assert.strictEqual(fake.db, 'rows of 0.11.0 +admin-schema +file-search');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'docker', '.sail-proxy-install.json'), 'utf8'));
  assert.deepStrictEqual([record.version, record.recordedBy], ['0.12.0', 'upgrade']);
  assert.strictEqual(record.files['docker/docker-compose.yml'], sha(fs.readFileSync(path.join(dir, 'docker', 'docker-compose.yml'))));
  assert.ok(!fake.calls.some((c) => FORBIDDEN(c.args)), 'never down, -v, volume or prune');
  const calls = fake.composeCalls();
  const at = (re, from = 0) => calls.findIndex((c, i) => i >= from && re.test(c));
  const stop = at(/^stop nginx gateway admin$/);
  const dump = at(/^exec -T postgres .*pg_dump/);
  const pull = at(/^pull gateway admin nginx$/, dump);
  const runAdmin = at(/^run --rm -T --no-deps admin sh -c .*cds-deploy --profile pg/);
  const upAdmin = at(/^up -d --no-deps admin$/);
  const runMigrate = at(/^run --rm -T --no-deps -e FILE_SEARCH_MIGRATE_NEVER_BLOCK=false gateway-migrate$/);
  // every long-running service that ran before comes to the new definition; postgres never
  const upRest = at(/^up -d --no-deps gateway nginx dex oauth2-proxy valkey$/);
  assert.ok(!calls.some((c) => /^(up|run) /.test(c) && / postgres( |$)/.test(c)), 'postgres is never in an up/run');
  assert.ok(stop >= 0 && stop < dump && dump < pull && pull < runAdmin && runAdmin < upAdmin && upAdmin < runMigrate && runMigrate < upRest, calls.join('\n'));
  // preflight pulled the target images before anything stopped, with the target coordinates
  const prePull = fake.calls.find((c) => c.args.includes('pull'));
  assert.deepStrictEqual(prePull.env, { DOCKER_REGISTRY: 'ghcr.io', DOCKER_ORGANIZATION: 'st-gr', DOCKER_TAG: '0.12.0' });
  assert.ok(fake.calls.indexOf(prePull) < fake.calls.findIndex((c) => c.args.includes('stop')));
  for (const c of fake.calls.filter((x) => x.args[0] === 'compose')) {
    assert.deepStrictEqual(c.args.slice(0, 7), ['compose', '-p', 'sailtest', '--project-directory', path.join(dir, 'docker'), '-f', c.args[6]]);
  }
  assert.strictEqual(backups.length, 1);
  const work = fs.mkdtempSync(path.join(scratch, 'open-'));
  const bundle = await openBundle(result.backup, PASSPHRASE, work);
  assert.strictEqual(bundle.manifest.kind, 'docker');
  assert.deepStrictEqual([bundle.manifest.fromVersion, bundle.manifest.toVersion], ['0.11.0', '0.12.0']);
  const names = bundle.manifest.entries.map((e) => e.name);
  for (const n of ['database.sql.gz', 'files.json', 'files/docker/.env', 'files/services/admin/.env', 'files/docker/docker-compose.yml']) assert.ok(names.includes(n), n);
  const text = JSON.stringify(bundle.manifest);
  for (const [file, keys] of Object.entries(KEYS)) for (const k of keys) assert.ok(!text.includes(envOf(path.join(dir, file))[k]), k);
});

test('an install without a record: the version comes from the running gateway image', async (base) => {
  const { dir, fake } = cloneInstall(base);
  fs.rmSync(path.join(dir, 'docker', '.sail-proxy-install.json'));
  const { code, out } = await upgrade(dir, fake);
  assert.strictEqual(code, 0, out.slice(-2000));
  assert.match(out, /Installed: 0\.11\.0/);
});

test('a second upgrade is not refused for the files the first one wrote', async (base) => {
  const { dir, fake } = cloneInstall(base);
  assert.strictEqual((await upgrade(dir, fake)).code, 0);
  fake.gitStatus = ' M docker/docker-compose.yml\0 M services/admin/.env.sample\0';
  const { code, out } = await upgrade(dir, fake, { ctx: { packageVersion: '0.13.0' } });
  assert.strictEqual(code, 0, out.slice(-2000));
});

test('test mode: --registry/--organization/--tag set all three image coordinates', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const { code, out } = await upgrade(dir, fake, { ctx: { testImages: { registry: 'registry.example.test', organization: 'rc-images', tag: 'rc-1a2b3c4d' } } });
  assert.strictEqual(code, 0, out.slice(-2000));
  const env = envOf(path.join(dir, 'docker', '.env'));
  assert.deepStrictEqual([env.DOCKER_REGISTRY, env.DOCKER_ORGANIZATION, env.DOCKER_TAG], ['registry.example.test', 'rc-images', 'rc-1a2b3c4d']);
  assert.strictEqual(fake.get('gateway').image, 'registry.example.test/rc-images/sail-proxy-gateway:rc-1a2b3c4d');
});

// ---- refusals before the outage --------------------------------------------------------------
const refusals = [
  ['an override that builds locally', ({ dir }) => fs.writeFileSync(path.join(dir, 'docker', 'docker-compose.override.yml'), 'services:\n  gateway:\n    build:\n      context: ..\n'), /built locally/],
  ['an override with pull_policy: build', ({ dir }) => fs.writeFileSync(path.join(dir, 'docker', 'docker-compose.override.yml'), 'services:\n  gateway:\n    pull_policy: build\n'), /built locally/],
  ['local changes to tracked files', ({ fake }) => { fake.gitStatus = ' M services/gateway/src/server.ts\0'; }, /local changes to tracked files.*services\/gateway\/src\/server\.ts/],
  ['no running project', ({ fake }) => { fake.get('postgres').state = 'exited'; }, /No running sail-proxy installation/],
  ['two running projects', ({ fake, dir }) => { fake.otherProjects.push({ project: 'second', workingDir: path.join(dir, 'docker') }); }, /several compose projects/],
  ['target not newer', () => ({ ctx: { packageVersion: '0.11.0' } }), /not newer/],
  ['postgres image differs', ({ fake }) => { fake.get('postgres').image = 'postgres:17'; }, /Postgres image/],
  ['image missing', ({ fake }) => { fake.missingTags.push('0.12.0'); }, /cannot be pulled/],
  ['too little disk', () => ({ ctx: { statfs: async () => 50 * 1024 * 1024 } }), /Not enough free space/],
];
for (const [name, arrange, message] of refusals) {
  test(`refused before the outage: ${name} (no file changed, exit 1)`, async (base) => {
    const c = cloneInstall(base);
    const options = arrange(c) || {};
    const before = tree(c.dir);
    const { code, out, backups, result } = await upgrade(c.dir, c.fake, options);
    assert.strictEqual(code, 1, out.slice(-1500));
    assert.match(result.error, message);
    assert.deepStrictEqual(tree(c.dir), before, 'no file changed');
    assert.ok(!c.fake.composeCalls().some((x) => /^(stop|start|up|run) |^exec .*(pg_dump|single-transaction)/.test(x)), 'nothing stopped, started, dumped or restored');
    assert.deepStrictEqual(backups, []);
  });
}

// ---- failures after the outage roll back -----------------------------------------------------
for (const step of ['apply', 'migrate', 'health', 'record']) {
  test(`SAIL_PROXY_UPGRADE_FAIL_AT=${step}: every file byte-identical, database restored, old version up (exit 2)`, async (base) => {
    const { dir, fake } = cloneInstall(base);
    const before = tree(dir);
    const db = fake.db;
    const { code, out, backups, result } = await upgrade(dir, fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: step } });
    assert.strictEqual(code, 2, out.slice(-3000));
    assert.strictEqual(result.failedAt, step);
    assert.deepStrictEqual(tree(dir), before, 'every file as before (new files removed)');
    assert.strictEqual(fake.db, db, 'the pre-upgrade database');
    const input = fake.restoreInputs[0];
    assert.match(input, /DROP %s IF EXISTS %I\.%I CASCADE/);
    assert.match(input, /WHERE n\.nspname IN \('public'\)/, 'every relation of the dump\'s schemas is dropped first');
    assert.ok(!/^DROP EXTENSION/m.test(input), 'the dump\'s DROP EXTENSION is left out');
    for (const s of ['gateway', 'admin', 'nginx']) {
      assert.strictEqual(fake.get(s).image, `ghcr.io/st-gr/sail-proxy-${s}:0.11.0`);
      assert.strictEqual(fake.get(s).state, 'running');
    }
    assert.ok(!fake.calls.some((c) => FORBIDDEN(c.args)));
    if (step !== 'apply') {
      const ups = fake.composeCalls().filter((c) => /^up /.test(c));
      assert.strictEqual(ups[ups.length - 1], 'up -d --no-deps admin gateway nginx dex oauth2-proxy valkey', 'the rollback brings every service back');
    }
    assert.strictEqual(backups.length, 1, 'the backup stays');
    assert.match(out, /Rolled back/);
    if (step !== 'apply') assertPhases(out, ['Stopping the new components', 'Putting the previous files back', 'Restoring the database from the backup', 'Starting the previous version', 'Waiting for the previous version to report healthy']);
  });
}

test('a rollback whose restore fails: exit 3, the restore command is named, the backup kept', async (base) => {
  const { dir, fake } = cloneInstall(base);
  fake.failOn = (args) => (args.join(' ').includes('--single-transaction') ? Object.assign(new Error('psql'), { stderr: 'ERROR: boom' }) : undefined);
  const { code, out, backups, result } = await upgrade(dir, fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'migrate' } });
  assert.strictEqual(code, 3, out.slice(-1500));
  assert.strictEqual(backups.length, 1);
  assert.ok(out.includes(`sail-proxy restore docker --dir "${dir}" --input "${result.backup}"`), out.slice(-800));
  assert.ok(out.includes(`The backup "${result.backup}" was kept.`) && !out.includes('Every file was kept'), out.slice(-800));
  assert.match(out, /THE ROLLBACK FAILED/);
});

test('a failing gateway-migrate counts: rolled back (exit 2)', async (base) => {
  const { dir, fake } = cloneInstall(base);
  fake.failOn = (args) => (args.includes('gateway-migrate') ? Object.assign(new Error('run'), { stderr: 'migration failed', exitCode: 1 }) : undefined);
  const { code, result } = await upgrade(dir, fake);
  assert.strictEqual(code, 2);
  assert.strictEqual(result.failedAt, 'migrate');
});

test('SIGINT during backup: files untouched, no backup file, services started again, a second SIGINT is ignored (exit 2)', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const before = tree(dir);
  const signals = new EventEmitter();
  let first = false;
  let second = false;
  fake.beforeCommand = async (args) => {
    const line = args.join(' ');
    if (!first && line.includes('pg_dump')) { first = true; signals.emit('SIGINT', 'SIGINT'); }
    if (first && !second && / start /.test(` ${line} `)) { second = true; signals.emit('SIGINT', 'SIGINT'); }
  };
  const { code, out, backups } = await upgrade(dir, fake, { signals });
  assert.strictEqual(code, 2, out.slice(-2000));
  assert.match(out, /interrupted by SIGINT/);
  assert.match(out, /rollback in progress/);
  assert.ok(second, 'the services were started again');
  assert.deepStrictEqual(backups, []);
  assert.deepStrictEqual(tree(dir), before);
  for (const s of ['gateway', 'admin', 'nginx']) assert.strictEqual(fake.get(s).state, 'running');
  assert.strictEqual(fake.restoreInputs.length, 0, 'the database was only read');
});

test('disk full while the dump is written: no partial backup, services started again (exit 2)', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const writeBundle = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  const { code, out, backups } = await upgrade(dir, fake, { ctx: { writeBundle } });
  assert.strictEqual(code, 2);
  assert.match(out, /disk is full/);
  assert.deepStrictEqual(backups, []);
  for (const s of ['gateway', 'admin', 'nginx']) assert.strictEqual(fake.get(s).state, 'running');
});

test('a shell-exported DOCKER_TAG does not win: apply runs the target, the rollback the previous images; running profile services follow', async (base) => {
  const saved = process.env.DOCKER_TAG;
  process.env.DOCKER_TAG = 'evil';
  try {
    const ok = cloneInstall(base);
    ok.fake.containers.push({ id: 'c99', service: 'ollama', image: 'ghcr.io/st-gr/sail-proxy-ollama:0.11.0', state: 'running', project: 'sailtest', oneoff: 'False' });
    const r1 = await upgrade(ok.dir, ok.fake);
    assert.strictEqual(r1.code, 0, r1.out.slice(-2000));
    for (const s of ['gateway', 'admin', 'nginx']) assert.strictEqual(ok.fake.get(s).image, `ghcr.io/st-gr/sail-proxy-${s}:0.12.0`);
    assert.ok(ok.fake.composeCalls().includes('up -d --no-deps gateway nginx dex oauth2-proxy ollama valkey'), ok.fake.composeCalls().join('\n'));
    for (const c of ok.fake.calls.filter((x) => x.args[0] === 'compose')) assert.ok(c.unsetEnv.includes('DOCKER_TAG'), c.args.join(' '));
    const bad = cloneInstall(base);
    const r2 = await upgrade(bad.dir, bad.fake, { env: { SAIL_PROXY_UPGRADE_FAIL_AT: 'migrate' } });
    assert.strictEqual(r2.code, 2, r2.out.slice(-2000));
    for (const s of ['gateway', 'admin', 'nginx']) assert.strictEqual(bad.fake.get(s).image, `ghcr.io/st-gr/sail-proxy-${s}:0.11.0`);
  } finally {
    if (saved === undefined) delete process.env.DOCKER_TAG;
    else process.env.DOCKER_TAG = saved;
  }
});

test('nginxPort: docker/.env value, quoted or with a comment; default 8080', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'port-'));
  fs.mkdirSync(path.join(dir, 'docker'));
  assert.strictEqual(nginxPort(dir), '8080');
  for (const [line, port] of [['NGINX_PORT=8081', '8081'], ['NGINX_PORT="8443" # tls', '8443'], ["NGINX_PORT='9000'", '9000'], ['  NGINX_PORT = 7000  ', '7000']]) {
    fs.writeFileSync(path.join(dir, 'docker', '.env'), `DOCKER_TAG=1\n${line}\n`);
    assert.strictEqual(nginxPort(dir), port, line);
  }
});

// ---- restore docker --------------------------------------------------------------------------
test('restore docker: a wrong passphrase changes nothing; the right one brings the files and database back', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const before = tree(dir);
  const db = fake.db;
  const { result } = await upgrade(dir, fake);
  assert.ok(result.ok);
  const after = tree(dir);
  const lines = [];
  const run = (passphrase) => runDockerRestore({
    dir, input: result.backup, yes: true, prompt: async () => { throw new Error('asked'); },
    docker: (a, o) => fake.run(a, o), httpGet: (u) => fake.http(u), env: { SAIL_PROXY_BACKUP_PASSPHRASE: passphrase },
    log: (m) => lines.push(m), pollMs: 1, healthTimeoutSeconds: 2,
  });
  const wrong = await run('a wrong passphrase!!');
  assert.strictEqual(wrong.ok, false);
  assert.match(wrong.error, /wrong passphrase or damaged file/);
  assert.deepStrictEqual(tree(dir), after);
  assert.strictEqual(fake.restoreInputs.length, 0);
  const right = await run(PASSPHRASE);
  assert.strictEqual(right.ok, true, lines.join('\n').slice(-1500));
  assertPhases(lines.join('\n'), ['Stopping the gateway, admin and nginx', 'Putting the previous files back', 'Restoring the database from the backup', 'Starting the previous version', 'Waiting for the previous version to report healthy']);
  assert.deepStrictEqual(tree(dir), before);
  assert.strictEqual(fake.db, db);
  for (const s of ['gateway', 'admin', 'nginx']) assert.strictEqual(fake.get(s).image, `ghcr.io/st-gr/sail-proxy-${s}:0.11.0`);
});

test('restore docker: a backup whose file list leaves the install directory is refused before anything changes', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const before = tree(dir);
  for (const rel of ['../outside.txt', '/etc/passwd', 'docker\\..\\..\\x', 'docker/../../x', 'C:/x']) {
    const work = fs.mkdtempSync(path.join(scratch, 'evil-'));
    const put = (name, text) => { const f = path.join(work, name.replace(/\//g, '_')); fs.writeFileSync(f, text); return { name, source: f }; };
    // (the bundle writer refuses such an entry name; an edited files.json is what can name one)
    const entries = [put('files.json', JSON.stringify([{ rel: 'docker/.env', existed: false }, { rel, existed: false }])),
      put('previous/state.json', '{}'), put('database.sql.gz', 'x')];
    const file = path.join(work, 'evil.spbk');
    async function* list() { yield* entries; }
    await writeBundle(file, null, { format: 1, kind: 'docker', fromVersion: '0.11.0', toVersion: '0.12.0', createdAt: new Date().toISOString() }, list());
    const result = await runDockerRestore({ dir, input: file, yes: true, prompt: async () => true, docker: (a, o) => fake.run(a, o), httpGet: (u) => fake.http(u), log: () => {}, pollMs: 1, healthTimeoutSeconds: 2 });
    assert.strictEqual(result.ok, false, rel);
    assert.match(result.error, /not a file of the install directory/, rel);
  }
  assert.deepStrictEqual(tree(dir), before);
  assert.ok(!fake.composeCalls().some((c) => /^(stop|up|exec) /.test(c)), 'nothing stopped or restored');
});

test('restore docker: Ctrl-C during the database restore is reported and the restore runs to completion', async (base) => {
  const { dir, fake } = cloneInstall(base);
  const { result } = await upgrade(dir, fake);
  const signals = new EventEmitter();
  fake.beforeCommand = async (args) => { if (args.join(' ').includes('--single-transaction')) signals.emit('SIGINT', 'SIGINT'); };
  const lines = [];
  const r = await runDockerRestore({
    dir, input: result.backup, yes: true, prompt: async () => true, signals,
    docker: (a, o) => fake.run(a, o), httpGet: (u) => fake.http(u), env: { SAIL_PROXY_BACKUP_PASSPHRASE: PASSPHRASE },
    log: (m) => lines.push(m), pollMs: 1, healthTimeoutSeconds: 2,
  });
  assert.strictEqual(r.ok, true, lines.join('\n'));
  assert.match(lines.join('\n'), /SIGINT received: the restore is restoring the database.*runs to completion/);
  assert.strictEqual(signals.listenerCount('SIGINT'), 0, 'listeners removed');
});

async function main() {
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
