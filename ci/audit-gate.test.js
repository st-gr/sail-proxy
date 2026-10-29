#!/usr/bin/env node
/**
 * The dependency gate. Until 2026-09 CI's audit reported the opposite of the truth: pnpm audit exits 1
 * exactly when it finds something, the scanner took that exit as "the audit could not run", and its
 * catch logged "No vulnerabilities found" - every green run since 2025-10 passed because there were
 * findings. The gate now reads pnpm's JSON and blocks on high/critical advisories that are not on the
 * reviewed allowlist, on expired allowlist entries, and on output it cannot read.
 */
const assert = require('assert');
const { evaluateAudit, PROD_BLOCKING } = require('./audit-gate');

let failed = 0;
function check(name, fn) { try { fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); } }

const adv = (id, severity, module_name) => ({ github_advisory_id: id, severity, module_name, title: `${module_name} issue`, findings: [{ version: '1.0.0' }] });
const audit = (...advisories) => ({ advisories: Object.fromEntries(advisories.map((a, i) => [String(i), a])) });
const today = '2026-09-24';

check('a high advisory that is not allowlisted blocks', () => {
  const r = evaluateAudit(audit(adv('GHSA-aaaa', 'high', 'pkg')), [], today);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.blocking.map(b => b.id), ['GHSA-aaaa']);
});
check('a critical advisory blocks', () => {
  assert.strictEqual(evaluateAudit(audit(adv('GHSA-cccc', 'critical', 'pkg')), [], today).ok, false);
});
check('moderate and low advisories are reported but do not block', () => {
  const r = evaluateAudit(audit(adv('GHSA-m', 'moderate', 'a'), adv('GHSA-l', 'low', 'b')), [], today);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.counts, { critical: 0, high: 0, moderate: 1, low: 1 });
});
check('an allowlisted high advisory passes while its entry is current', () => {
  const r = evaluateAudit(audit(adv('GHSA-aaaa', 'high', 'pkg')),
    [{ id: 'GHSA-aaaa', package: 'pkg', reason: 'dev-only, no fix', reviewBy: '2026-12-31' }], today);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.allowed.map(a => a.id), ['GHSA-aaaa']);
});
check('an expired allowlist entry blocks again', () => {
  const r = evaluateAudit(audit(adv('GHSA-aaaa', 'high', 'pkg')),
    [{ id: 'GHSA-aaaa', package: 'pkg', reason: 'x', reviewBy: '2026-09-01' }], today);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.expired.map(e => e.id), ['GHSA-aaaa']);
});
check('an allowlist entry without reason or review date is rejected', () => {
  const r = evaluateAudit(audit(adv('GHSA-aaaa', 'high', 'pkg')), [{ id: 'GHSA-aaaa' }], today);
  assert.strictEqual(r.ok, false);
});
check('output without an advisories object blocks instead of passing', () => {
  for (const bad of [null, {}, { error: 'ERR_PNPM_AUDIT_BAD_RESPONSE' }, 'not json']) {
    assert.strictEqual(evaluateAudit(bad, [], today).ok, false, JSON.stringify(bad));
  }
});
check('the production pass also blocks a moderate advisory that is not allowlisted', () => {
  const moderate = audit(adv('GHSA-mmmm', 'moderate', 'shipped'));
  assert.strictEqual(evaluateAudit(moderate, [], today).ok, true);
  const prod = evaluateAudit(moderate, [], today, PROD_BLOCKING);
  assert.strictEqual(prod.ok, false);
  assert.deepStrictEqual(prod.blocking.map(b => b.id), ['GHSA-mmmm']);
  const allowed = evaluateAudit(moderate, [{ id: 'GHSA-mmmm', package: 'shipped', reason: 'checked', reviewBy: '2026-12-31' }], today, PROD_BLOCKING);
  assert.strictEqual(allowed.ok, true);
});
check('a low advisory never blocks, not even in the production pass', () => {
  assert.strictEqual(evaluateAudit(audit(adv('GHSA-llll', 'low', 'x')), [], today, PROD_BLOCKING).ok, true);
});
check('an empty audit passes', () => {
  assert.strictEqual(evaluateAudit(audit(), [], today).ok, true);
});

process.exit(failed ? 1 : 0);
