#!/usr/bin/env node
/**
 * The Docker build decision (docker-build-decision.js) with a stubbed git. A local run compares
 * against the last local image build, so a multi-commit merge ending in a docs commit still
 * builds when an earlier commit changed an image-relevant file.
 */
const assert = require('assert');
const { decideDockerBuild } = require('./docker-build-decision');

const MARKER = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const quiet = { info() {}, warning() {}, error() {} };
const UNTRACKED = 'git ls-files --others --exclude-standard';

/** A fake promisified exec: `responses` maps a command to its stdout, or to an Error to reject with. */
function fakeExec(responses) {
  const calls = [];
  const exec = async (cmd) => {
    calls.push(cmd);
    // No untracked files unless a test says otherwise.
    if (!(cmd in responses) && cmd === UNTRACKED) return { stdout: '', stderr: '' };
    if (!(cmd in responses)) throw new Error(`unexpected command: ${cmd}`);
    const r = responses[cmd];
    if (r instanceof Error) throw r;
    return { stdout: r, stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

/** A local repo whose marker is MARKER (an ancestor of HEAD unless `ancestor` is false). */
function localRepo({ uncommitted = '', committed = '', ancestor = true, marker = MARKER } = {}) {
  return fakeExec({
    'git rev-parse --is-inside-work-tree': 'true\n',
    'git diff --name-only HEAD': uncommitted,
    [`git merge-base --is-ancestor ${marker} HEAD`]: ancestor ? '' : new Error('Command failed: exit 1'),
    [`git diff --name-only ${marker} HEAD`]: committed
  });
}

const decide = (exec, { env = {}, marker = `${MARKER}\n` } = {}) => decideDockerBuild({
  exec, env, logger: quiet,
  readMarker: async () => {
    if (marker instanceof Error) throw marker;
    return marker;
  }
});

const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}

(async () => {
  await check('local: only docs changed since the last local build skips, naming the base', async () => {
    const r = await decide(localRepo({ committed: 'docs/a.md\nREADME.md\n' }));
    assert.strictEqual(r.required, false);
    assert.match(r.reason, new RegExp(`since the last local image build ${MARKER.slice(0, 8)} \\(2 files checked\\)`));
  });

  await check('local: a gateway change in an earlier commit since the marker builds (the merge case)', async () => {
    const exec = localRepo({ committed: 'services/gateway/src/index.ts\ndocs/a.md\n' });
    const r = await decide(exec);
    assert.strictEqual(r.required, true);
    assert.deepStrictEqual(r.files, ['services/gateway/src/index.ts']);
    assert.ok(exec.calls.includes(`git diff --name-only ${MARKER} HEAD`));
    assert.ok(!exec.calls.some(c => c.includes('HEAD~1')), 'local mode must not diff HEAD~1');
  });

  await check('local: a missing marker builds (fail-safe) and says why', async () => {
    const r = await decide(localRepo({ committed: 'docs/a.md\n' }), { marker: enoent() });
    assert.strictEqual(r.required, true);
    assert.match(r.reason, /no local image build recorded.*fail-safe/);
  });

  await check('local: an unreadable or malformed marker builds (fail-safe)', async () => {
    assert.strictEqual((await decide(localRepo(), { marker: new Error('EACCES') })).required, true);
    assert.strictEqual((await decide(localRepo(), { marker: 'not-a-sha\n' })).required, true);
  });

  await check('local: a marker that is not an ancestor of HEAD builds (fail-safe)', async () => {
    const r = await decide(localRepo({ marker: OTHER, ancestor: false, committed: 'docs/a.md\n' }), { marker: OTHER });
    assert.strictEqual(r.required, true);
    assert.match(r.reason, /not an ancestor of HEAD.*fail-safe/);
  });

  await check('local: an uncommitted image-relevant change builds even with nothing committed since the marker', async () => {
    const r = await decide(localRepo({ uncommitted: 'services/admin/src/srv/x.ts\n' }));
    assert.strictEqual(r.required, true);
    assert.deepStrictEqual(r.files, ['services/admin/src/srv/x.ts']);
  });

  await check('local: nothing changed since the marker and a clean tree skips', async () => {
    const r = await decide(localRepo());
    assert.strictEqual(r.required, false);
    assert.match(r.reason, /No changes since the last local image build/);
  });

  await check('local: a clean start is reported, so the marker may be recorded after the build', async () => {
    assert.strictEqual((await decide(localRepo({ committed: 'services/gateway/src/index.ts\n' }))).cleanTree, true);
    assert.strictEqual((await decide(localRepo({ committed: 'docs/a.md\n' }), { marker: enoent() })).cleanTree, true);
  });

  await check('local: a start with uncommitted image edits builds but is not clean, so the marker stays put', async () => {
    // Recording HEAD here would let the next run skip once the edits are discarded, though
    // HEAD's own tree was never built.
    const r = await decide(localRepo({ uncommitted: 'services/gateway/src/index.ts\n' }));
    assert.strictEqual(r.required, true);
    assert.strictEqual(r.cleanTree, false);
    const missing = await decide(localRepo({ uncommitted: 'services/gateway/src/index.ts\n' }), { marker: enoent() });
    assert.strictEqual(missing.required, true);
    assert.strictEqual(missing.cleanTree, false);
  });

  await check('local: a failed uncommitted-change check is never reported clean', async () => {
    const exec = fakeExec({ 'git rev-parse --is-inside-work-tree': 'true\n', 'git diff --name-only HEAD': new Error('boom') });
    const r = await decide(exec);
    assert.strictEqual(r.required, true);
    assert.strictEqual(r.cleanTree, false);
  });

  await check('FORCE_DOCKER_BUILD builds without consulting git or the marker outside a local run', async () => {
    const exec = fakeExec({});
    const r = await decide(exec, { env: { FORCE_DOCKER_BUILD: '1', CI: 'true' }, marker: enoent() });
    assert.strictEqual(r.required, true);
    assert.deepStrictEqual(exec.calls, []);
  });

  await check('FORCE_DOCKER_BUILD locally still reports whether the tree was clean', async () => {
    const clean = await decide(fakeExec({ 'git diff --name-only HEAD': '' }), { env: { FORCE_DOCKER_BUILD: '1' } });
    assert.strictEqual(clean.required, true);
    assert.strictEqual(clean.cleanTree, true);
    const dirty = await decide(fakeExec({ 'git diff --name-only HEAD': 'libs/x.ts\n' }), { env: { FORCE_DOCKER_BUILD: 'true' } });
    assert.strictEqual(dirty.cleanTree, false);
  });

  await check('SKIP_DOCKER_BUILD skips without consulting git, also on GitHub Actions', async () => {
    const exec = fakeExec({});
    const r = await decide(exec, { env: { SKIP_DOCKER_BUILD: 'true', GITHUB_ACTIONS: 'true' }, marker: enoent() });
    assert.strictEqual(r.required, false);
    assert.match(r.reason, /SKIP_DOCKER_BUILD/);
    assert.deepStrictEqual(exec.calls, []);
    const one = await decide(fakeExec({}), { env: { SKIP_DOCKER_BUILD: '1', CI: 'true' }, marker: enoent() });
    assert.strictEqual(one.required, false);
  });

  await check('FORCE_DOCKER_BUILD wins over SKIP_DOCKER_BUILD', async () => {
    const r = await decide(fakeExec({}), { env: { FORCE_DOCKER_BUILD: '1', SKIP_DOCKER_BUILD: '1', CI: 'true' }, marker: enoent() });
    assert.strictEqual(r.required, true);
  });

  await check('local: a new untracked image file builds and the start is not clean', async () => {
    const r = await decide(fakeExec({
      'git rev-parse --is-inside-work-tree': 'true\n',
      'git diff --name-only HEAD': '',
      [UNTRACKED]: 'services/gateway/src/newModule.ts\n',
      [`git merge-base --is-ancestor ${MARKER} HEAD`]: '',
      [`git diff --name-only ${MARKER} HEAD`]: 'docs/a.md\n'
    }));
    assert.strictEqual(r.required, true);
    assert.strictEqual(r.cleanTree, false);
  });

  await check('local: an untracked or edited file outside the images skips and still counts as a clean start', async () => {
    const r = await decide(fakeExec({
      'git rev-parse --is-inside-work-tree': 'true\n',
      'git diff --name-only HEAD': 'docs/guide/introduction.md\n',
      [UNTRACKED]: 'notes/scratch.md\n',
      [`git merge-base --is-ancestor ${MARKER} HEAD`]: '',
      [`git diff --name-only ${MARKER} HEAD`]: ''
    }));
    assert.strictEqual(r.required, false);
    assert.strictEqual(r.cleanTree, true);
  });

  await check('generic CI=true still compares HEAD~1 and ignores the marker', async () => {
    const exec = fakeExec({ 'git rev-parse --is-inside-work-tree': 'true\n', 'git diff --name-only HEAD~1 HEAD': 'docs/a.md\n' });
    const r = await decide(exec, { env: { CI: 'true' }, marker: enoent() });
    assert.strictEqual(r.required, false);
    assert.strictEqual(r.reason, 'No Docker-related files changed (1 files checked)');
  });

  await check('GitHub Actions still compares the push before-commit', async () => {
    const exec = fakeExec({ 'git rev-parse --is-inside-work-tree': 'true\n', [`git diff --name-only ${OTHER}...HEAD`]: 'libs/x/index.ts\n' });
    const r = await decide(exec, { env: { GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_EVENT_BEFORE: OTHER }, marker: enoent() });
    assert.strictEqual(r.required, true);
  });

  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('docker-build-decision: all checks passed');
})();
