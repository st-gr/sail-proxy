#!/usr/bin/env node
/**
 * Build progress (docker-build-progress.js): the milestones the CI prints while `docker compose build`
 * runs, read from BuildKit's plain progress output, and the streaming runner that keeps the full log
 * on disk. The sample lines are real ones from an admin image build (2026-11-06), shortened.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBuildProgress, formatDuration, labelOf, streamBuild } = require('./docker-build-progress');

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

/** A clock the test moves by hand, in seconds. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (seconds) => { t += seconds * 1000; } };
}

const quiet = { step() {}, info() {}, warning() {}, error() {} };

(async () => {
  await check('formats durations as s, m and h', () => {
    assert.strictEqual(formatDuration(45_000), '45s');
    assert.strictEqual(formatDuration(252_000), '4m12s');
    assert.strictEqual(formatDuration(3_720_000), '1h02m');
  });

  await check('a long step is a milestone when it is done, with its own stage, number and duration', () => {
    const c = clock();
    const p = createBuildProgress('admin', { now: c.now });
    assert.deepStrictEqual(p.feed('#73 [admin ui5 11/15] RUN --mount=type=cache,target=/root/.ui5/framework,sharing=locked     echo "=== Building UI5 Applications with framework cache ===" &&     for yaml in app/*/ui5.yaml; do'), []);
    c.advance(252);
    assert.deepStrictEqual(p.feed('#73 DONE 252.4s'), ['admin: ui5 11/15 Building UI5 Applications with framework cache done in 4m12s']);
  });

  await check('a step label skips the echo that writes a setting before the real command', () => {
    assert.strictEqual(labelOf('RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --no-frozen-lockfile'), 'pnpm install --no-frozen-lockfile');
    assert.strictEqual(labelOf('RUN pnpm build:gateway'), 'pnpm build:gateway');
    assert.strictEqual(labelOf('COPY docker/package.json ./package.json'), 'COPY docker/package.json ./package.json');
  });

  await check('reads the headers of a one-service build, which carry no service name (what Phase 7 runs)', () => {
    const c = clock();
    const p = createBuildProgress('gateway', { now: c.now });
    p.feed('#7 [build  2/12] RUN corepack enable && corepack prepare pnpm@10.12.4 --activate');
    p.feed('#8 [production  2/16] RUN corepack enable && corepack prepare pnpm@10.12.4 --activate');
    c.advance(30);
    assert.strictEqual(p.heartbeat(), 'gateway: build 2/12 corepack enable && corepack prepare pnpm@10.12.4 --activate still running, 30s (image 30s so far)');
    assert.deepStrictEqual(p.feed('#8 DONE 12.0s'), ['gateway: production 2/16 corepack enable && corepack prepare pnpm@10.12.4 --activate done in 12s']);
    assert.deepStrictEqual(p.feed('#1 [internal] load local bake definitions'), []);
  });

  await check('a quick or cached step stays quiet, and so do internal steps and output lines', () => {
    const p = createBuildProgress('admin', { now: clock().now });
    const lines = [
      '#3 [admin internal] load build definition from admin.Dockerfile',
      '#3 DONE 0.0s',
      '#23 [admin build  3/12] WORKDIR /app',
      '#23 DONE 0.1s',
      '#24 [admin build  4/12] COPY docker/package.json ./package.json',
      '#24 CACHED',
      '#22 0.512 Preparing pnpm@10.12.4 for immediate activation...'
    ];
    assert.deepStrictEqual(lines.flatMap((l) => p.feed(l)), []);
  });

  await check('names each UI5 app as its build starts, counting them', () => {
    const p = createBuildProgress('admin', { now: clock().now });
    p.feed('#73 [admin ui5 11/15] RUN echo "=== Building UI5 Applications with framework cache ==="');
    assert.deepStrictEqual(p.feed('#73 4.527 > admin.apikeysapp@1.0.0 build:docker /app/services/admin/app/api-keys-app'), ['admin: UI5 app 1: api-keys-app']);
    assert.deepStrictEqual(p.feed('#73 116.8 > admin.awscredentialsapp@1.0.0 build:docker /app/services/admin/app/aws-credentials-app'), ['admin: UI5 app 2: aws-credentials-app']);
  });

  await check('a failing step is reported with its error, whatever its duration', () => {
    const p = createBuildProgress('admin', { now: clock().now });
    p.feed('#73 [admin ui5 11/15] RUN echo "=== Building UI5 Applications with framework cache ==="');
    const out = p.feed('#73 ERROR: process "/bin/sh -c echo" did not complete successfully: exit code: 1');
    assert.strictEqual(out.length, 1);
    assert.match(out[0], /^admin: ui5 11\/15 Building UI5 Applications with framework cache FAILED: process/);
  });

  await check('a header BuildKit prints again does not restart the step', () => {
    const c = clock();
    const p = createBuildProgress('gateway', { now: c.now });
    p.feed('#40 [gateway build 8/10] RUN pnpm run build');
    c.advance(30);
    p.feed('#40 [gateway build 8/10] RUN pnpm run build');
    c.advance(5);
    assert.deepStrictEqual(p.feed('#40 DONE 35.0s'), ['gateway: build 8/10 pnpm run build done in 35s']);
  });

  await check('the heartbeat names the step that has run longest, and the time so far', () => {
    const c = clock();
    const p = createBuildProgress('admin', { now: c.now });
    assert.strictEqual(p.heartbeat(), 'admin: still building, 0s so far');
    p.feed('#73 [admin ui5 11/15] RUN echo "=== Building UI5 Applications with framework cache ==="');
    c.advance(60);
    p.feed('#80 [admin build 12/12] RUN pnpm run build');
    c.advance(312);
    assert.strictEqual(p.heartbeat(), 'admin: ui5 11/15 Building UI5 Applications with framework cache still running, 6m12s (image 6m12s so far)');
  });

  await check('a step BuildKit takes from the cache is finished, so the heartbeat never names it', () => {
    const c = clock();
    const p = createBuildProgress('gateway', { now: c.now });
    p.feed('#5 [build  1/12] FROM docker.io/library/node:24-alpine@sha256:a34ab6d7');
    p.feed('#5 CACHED');
    c.advance(40);
    assert.strictEqual(p.heartbeat(), 'gateway: still building, 40s so far');
  });

  await check('keeps the last lines for a failure report', () => {
    const p = createBuildProgress('nginx', { now: clock().now, tailLines: 3 });
    ['a', 'b', 'c', 'd'].forEach((l) => p.feed(l));
    assert.deepStrictEqual(p.tail(), ['b', 'c', 'd']);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-progress-'));
  try {
    await check('streamBuild writes every line to the log, prints the milestones and resolves on exit 0', async () => {
      const info = [];
      const logFile = path.join(dir, 'ok.log');
      const script = 'printf \'%s\\n\' "#9 [nginx base 2/3] RUN echo \\"=== Setting up ===\\"" "#9 12.0 working" "#9 DONE 12.0s"';
      await streamBuild(script, { service: 'nginx', logFile, logger: { ...quiet, info: (m) => info.push(m) }, env: process.env, heartbeatMs: 0 });
      assert.deepStrictEqual(info, ['nginx: base 2/3 Setting up done in 12s']);
      assert.strictEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 3);
    });

    await check('streamBuild rejects on a non-zero exit, after printing the last lines and the log path', async () => {
      const errors = [];
      const logFile = path.join(dir, 'fail.log');
      const script = 'echo "#1 [admin ui5 1/2] RUN false" 1>&2; echo "#1 ERROR: boom"; exit 3';
      await assert.rejects(
        streamBuild(script, { service: 'admin', logFile, logger: { ...quiet, error: (m) => errors.push(m) }, env: process.env, heartbeatMs: 0 }),
        (error) => /exit code 3/.test(error.message) && error.code === 3
      );
      const all = errors.join('\n');
      assert.match(all, /#1 ERROR: boom/);
      assert.match(all, new RegExp(logFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    await check('streamBuild reaches the command with the environment it is given', async () => {
      const logFile = path.join(dir, 'env.log');
      await streamBuild('echo "$BUILDKIT_PROGRESS-$DOCKER_TAG"', { service: 'x', logFile, logger: quiet, env: { ...process.env, BUILDKIT_PROGRESS: 'plain', DOCKER_TAG: 'ci-test' }, heartbeatMs: 0 });
      assert.strictEqual(fs.readFileSync(logFile, 'utf8').trim(), 'plain-ci-test');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('docker-build-progress: all checks passed');
})();
