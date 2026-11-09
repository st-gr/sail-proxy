#!/usr/bin/env node
/** The per-suite summary CI keeps of a jest run: which suites ran, which skipped, without any test output. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { summarize, formatSummary } = require('./jest-summary');

let failed = 0;
function check(name, fn) { try { fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); } }

const root = '/repo/services/gateway';
const suite = (rel, statuses, extra = {}) => ({
  name: `${root}/${rel}`,
  status: statuses.includes('failed') ? 'failed' : 'passed',
  message: 'expect(received).toBe(expected) https://relay.example.test/secret-key',
  assertionResults: statuses.map((status, i) => ({ status, title: `t${i}`, failureMessages: status === 'failed' ? ['boom https://relay.example.test/secret-key'] : [] })),
  ...extra,
});
const run = {
  numPassedTestSuites: 2, numFailedTestSuites: 1, numPendingTestSuites: 1, numTotalTestSuites: 4,
  numPassedTests: 4, numFailedTests: 1, numPendingTests: 3, numTodoTests: 0, numTotalTests: 8, success: false,
  testResults: [
    suite('test/a.test.ts', ['passed', 'passed', 'pending']),
    suite('test/integration/valkeyCache.test.ts', ['pending', 'pending']),
    suite('test/b.test.ts', ['passed', 'failed']),
    suite('test/c.test.ts', ['passed']),
  ],
};

check('counts suites as passed, failed and skipped (every test pending)', () => {
  const s = summarize(run, '/repo/services/gateway');
  assert.deepStrictEqual(s.suites, { passed: 2, failed: 1, skipped: 1, total: 4 });
  assert.deepStrictEqual(s.tests, { passed: 4, failed: 1, skipped: 3, total: 8 });
});

check('lists suites by path relative to the service, with their own counts', () => {
  const s = summarize(run, '/repo/services/gateway');
  assert.deepStrictEqual(s.files.find(f => f.file === 'test/integration/valkeyCache.test.ts'),
    { file: 'test/integration/valkeyCache.test.ts', status: 'skipped', passed: 0, failed: 0, skipped: 2 });
  assert.deepStrictEqual(s.files.find(f => f.file === 'test/b.test.ts'),
    { file: 'test/b.test.ts', status: 'failed', passed: 1, failed: 1, skipped: 0 });
});

check('carries no test titles, messages or failure output', () => {
  const text = JSON.stringify(summarize(run, '/repo/services/gateway'));
  assert.ok(!text.includes('relay.example.test'), text);
  assert.ok(!text.includes('expect(received)'), text);
  assert.ok(!/"t\d"/.test(text), text);
});

check('a suite that failed to run (no assertions, failed status) counts as failed', () => {
  const broken = { ...run, testResults: [{ name: `${root}/test/x.test.ts`, status: 'failed', message: 'TS2305', assertionResults: [] }] };
  assert.strictEqual(summarize(broken, '/repo/services/gateway').files[0].status, 'failed');
});

check('the text names every skipped suite', () => {
  const text = formatSummary('Gateway', summarize(run, '/repo/services/gateway'));
  assert.match(text, /Gateway: 2 suites passed, 1 failed, 1 skipped of 4; 4 tests passed, 1 failed, 3 skipped/);
  assert.match(text, /skipped: test\/integration\/valkeyCache\.test\.ts/);
});

check('the command line writes the summary file and prints the text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-summary-'));
  try {
    const raw = path.join(dir, 'raw.json');
    const out = path.join(dir, 'out', 'gateway.json');
    fs.writeFileSync(raw, JSON.stringify(run));
    const printed = execFileSync(process.execPath, [path.join(__dirname, 'jest-summary.js'), raw, 'Gateway', '/repo/services/gateway', out], { encoding: 'utf8' });
    assert.match(printed, /Gateway: 2 suites passed/);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).suites.skipped, 1);
    assert.ok(!fs.existsSync(raw), 'the raw jest output, which holds failure messages, is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('a missing raw file (jest never wrote it) is reported, not thrown', () => {
  const printed = execFileSync(process.execPath, [path.join(__dirname, 'jest-summary.js'), '/nonexistent/raw.json', 'Gateway', '/repo', '/nonexistent/out.json'], { encoding: 'utf8' });
  assert.match(printed, /Gateway: no jest result/);
});

check('the CI reporter writes the shape the summary reads, from jest\'s aggregated results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-reporter-'));
  const raw = path.join(dir, 'raw.json');
  const saved = process.env.JEST_SUMMARY_RAW;
  process.env.JEST_SUMMARY_RAW = raw;
  try {
    const Reporter = require('./jest-summary-reporter');
    new Reporter().onRunComplete(new Set(), {
      success: false,
      testResults: [
        { testFilePath: `${root}/test/a.test.ts`, numFailingTests: 0, testResults: [{ status: 'passed', title: 'x', failureMessages: [] }, { status: 'pending' }] },
        { testFilePath: `${root}/test/valkey.test.ts`, numFailingTests: 0, testResults: [{ status: 'pending' }] },
        { testFilePath: `${root}/test/broken.test.ts`, numFailingTests: 0, testExecError: { message: 'worker killed https://relay.example.test/k' }, testResults: [] },
      ],
    });
    const written = fs.readFileSync(raw, 'utf8');
    assert.ok(!written.includes('relay.example.test'), written);
    const s = summarize(JSON.parse(written), root);
    assert.deepStrictEqual(s.suites, { passed: 1, failed: 1, skipped: 1, total: 3 });
    assert.strictEqual(s.files.find(f => f.file === 'test/broken.test.ts').status, 'failed');
  } finally {
    if (saved === undefined) delete process.env.JEST_SUMMARY_RAW; else process.env.JEST_SUMMARY_RAW = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('the reporter writes nothing without JEST_SUMMARY_RAW', () => {
  const saved = process.env.JEST_SUMMARY_RAW;
  delete process.env.JEST_SUMMARY_RAW;
  try {
    const Reporter = require('./jest-summary-reporter');
    assert.doesNotThrow(() => new Reporter().onRunComplete(new Set(), { success: true, testResults: [] }));
  } finally {
    if (saved !== undefined) process.env.JEST_SUMMARY_RAW = saved;
  }
});

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
