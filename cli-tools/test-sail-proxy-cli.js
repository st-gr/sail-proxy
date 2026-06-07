#!/usr/bin/env node

/**
 * End-to-end test for the published @st-gr/sail-proxy CLI.
 *
 * Packs the npm tarball at npm-dist/sail-proxy/, installs it into a clean
 * tmpdir under an isolated $HOME, populates ~/.sail-proxy/.env from
 * SAP_AI_CORE_SERVICE_KEY (same env var the rest of CI uses), then exercises
 * the CLI surface that depends on the bundled gateway/ollama and the
 * @libs alias resolution: run, status, apikey CRUD, real inference call,
 * stop. Cleans up on success and failure alike.
 *
 * Run this AFTER service unit/integration tests pass and BEFORE the docker
 * build phase, so the tarball it tests reflects the same source CI already
 * validated.
 *
 * Exits non-zero on any failure. Designed to be invoked from
 * ci/ci-pipeline.js's Phase 6.5.
 */

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const NPM_DIST_DIR = path.join(REPO_ROOT, 'npm-dist', 'sail-proxy');
const PORT = '3088'; // non-default to avoid colliding with anything CI already started

// --- helpers ---------------------------------------------------------------

function log(msg) {
  console.log(`[sail-proxy-cli-test] ${msg}`);
}

function fail(msg, extra) {
  console.error(`[sail-proxy-cli-test] ❌ ${msg}`);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(
      `Command failed (${cmd} ${args.join(' ')}): exit ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  return result;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object in service-key payload');
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
    } else {
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        if (--depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  throw new Error('Unbalanced JSON in service-key payload');
}

// --- main flow -------------------------------------------------------------

const skJson = process.env.SAP_AI_CORE_SERVICE_KEY;
if (!skJson) {
  fail('SAP_AI_CORE_SERVICE_KEY env var is required (same one the rest of CI uses).');
  process.exit(1);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-proxy-ci-'));
const fakeHome = path.join(tmpRoot, 'home');
const installDir = path.join(tmpRoot, 'work');
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(installDir, { recursive: true });

let gatewayStarted = false;
let cliBin = null;

function cleanup() {
  try {
    if (gatewayStarted && cliBin) {
      run(cliBin, ['stop'], { env: { ...process.env, HOME: fakeHome }, allowFailure: true });
    }
  } catch {}
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  log('Bundling services into npm-dist/sail-proxy/bundled');
  // CI's Phase 3 ran `build:local` (clean+compile+copy-templates only) which
  // doesn't populate bundled/. Run the bundle steps explicitly so the tarball
  // ships gateway+ollama+@libs+service-key-parser the same way `npm publish`
  // would upload them. Reuses services/*/dist already built by Phase 3.
  run('npm', ['run', 'bundle'], { cwd: NPM_DIST_DIR, stdio: 'inherit' });

  log('Packing tarball from npm-dist/sail-proxy');
  // Rewrite workspace:* deps so the tarball is portable.
  require('./prepare-for-pack').main();
  let tarballName;
  try {
    // --ignore-scripts: skip prepublishOnly so we don't redo the bundle we
    // just performed above. This mirrors what `pnpm run publish:npm` would
    // upload.
    run('npm', ['pack', '--ignore-scripts'], { cwd: NPM_DIST_DIR });
    const dirEntries = fs.readdirSync(NPM_DIST_DIR);
    tarballName = dirEntries.find(f => f.endsWith('.tgz'));
    if (!tarballName) throw new Error('npm pack produced no .tgz');
  } finally {
    require('./restore-workspace-protocol').main();
  }
  const tarballPath = path.join(NPM_DIST_DIR, tarballName);
  log(`Tarball: ${tarballName}`);

  log('Installing tarball into clean tmpdir');
  fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'sail-proxy-ci-test', version: '0.0.0', private: true }, null, 2));
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath], { cwd: installDir });

  cliBin = path.join(installDir, 'node_modules', '.bin', 'sail-proxy');
  if (!fs.existsSync(cliBin)) throw new Error(`bin not at ${cliBin}`);

  log('Populating ~/.sail-proxy/.env from SAP_AI_CORE_SERVICE_KEY');
  const cliRoot = path.join(installDir, 'node_modules', '@st-gr', 'sail-proxy');
  const parser = require(path.join(cliRoot, 'node_modules', '@sap-llm-gateway', 'service-key-parser'));
  const cfg = parser.parseServiceKey(extractFirstJsonObject(skJson));
  cfg.PORT = PORT;
  const envBody = parser.formatAsEnvFile(cfg);
  const cfgDir = path.join(fakeHome, '.sail-proxy');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, '.env'), envBody);
  fs.copyFileSync(
    path.join(cliRoot, 'dist', 'templates', 'api_config.template.json'),
    path.join(cfgDir, 'api_config.json')
  );
  const ollamaTmpl = fs.readFileSync(
    path.join(cliRoot, 'dist', 'templates', 'ollama.env.template'), 'utf8'
  ).replace(/MAIN_PROXY_URL=http:\/\/localhost:\d+/, `MAIN_PROXY_URL=http://localhost:${PORT}`);
  fs.writeFileSync(path.join(cfgDir, 'ollama.env'), ollamaTmpl);

  const cliEnv = { ...process.env, HOME: fakeHome };

  log('sail-proxy --version');
  const ver = run(cliBin, ['--version'], { env: cliEnv });
  if (!ver.stdout.includes('0.9')) throw new Error(`Unexpected version output: ${ver.stdout}`);

  log('sail-proxy --help');
  run(cliBin, ['--help'], { env: cliEnv });

  log('sail-proxy status (before run — should report stopped)');
  const statusBefore = run(cliBin, ['status'], { env: cliEnv });
  if (!/Stopped/i.test(statusBefore.stdout)) {
    throw new Error(`Expected 'Stopped' in pre-run status, got: ${statusBefore.stdout}`);
  }

  log('sail-proxy run');
  run(cliBin, ['run'], { env: cliEnv });
  gatewayStarted = true;

  log('sail-proxy status (after run — should report running)');
  const statusAfter = run(cliBin, ['status'], { env: cliEnv });
  if (!/Running/i.test(statusAfter.stdout)) {
    throw new Error(`Expected 'Running' in post-run status, got: ${statusAfter.stdout}`);
  }

  log('sail-proxy apikey create');
  const created = run(cliBin, ['apikey', 'create', 'ci-smoke'], { env: cliEnv });
  const keyMatch = created.stdout.match(/sk-[a-f0-9]+/);
  if (!keyMatch) throw new Error(`No API key emitted: ${created.stdout}`);
  const apiKey = keyMatch[0];

  log('sail-proxy apikey list');
  const listed = run(cliBin, ['apikey', 'list'], { env: cliEnv });
  if (!listed.stdout.includes('ci-smoke')) {
    throw new Error(`apikey list missing the just-created key: ${listed.stdout}`);
  }

  log('Live inference smoke against /openai/v1/chat/completions');
  const curl = spawnSync('curl', [
    '-sS', '-w', '\nHTTP=%{http_code}', '-m', '60',
    '-X', 'POST', `http://localhost:${PORT}/openai/v1/chat/completions`,
    '-H', `Authorization: Bearer ${apiKey}`,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'reply with the word OK' }],
      max_tokens: 10,
    })
  ], { encoding: 'utf8' });
  if (curl.status !== 0) throw new Error(`curl failed: ${curl.stderr}`);
  const httpMatch = curl.stdout.match(/HTTP=(\d+)/);
  if (!httpMatch || httpMatch[1] !== '200') {
    throw new Error(`Inference call did not return 200: ${curl.stdout}`);
  }
  log('Inference returned 200 ✓');

  log('sail-proxy stop');
  run(cliBin, ['stop'], { env: cliEnv });
  gatewayStarted = false;

  log('✅ all gates passed');
} catch (err) {
  fail(err.message, err.stack);
}
