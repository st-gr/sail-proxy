#!/usr/bin/env node
/**
 * Dependency gate, two passes. The full `pnpm audit --json` blocks on high/critical advisories;
 * `pnpm audit --prod --json` - the dependencies that ship, which pnpm tells apart across the
 * workspace where GitHub's Dependabot cannot (it scopes pnpm-lock v9 workspace members as runtime) -
 * also blocks on moderate ones. Either pass blocks only on advisories not on the reviewed allowlist
 * (ci/audit-allowlist.json), and both block on expired or incomplete allowlist entries and on audit
 * output that cannot be read. pnpm audit exits 1 whenever it finds anything, so its exit code is
 * ignored and only the JSON decides - reading the exit code is what made the old check pass for a
 * year while findings accumulated (see audit-gate.test.js).
 *
 * Usage: node ci/audit-gate.js    (exit 0 = pass, 1 = blocked)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BLOCKING = ['critical', 'high'];
const PROD_BLOCKING = ['critical', 'high', 'moderate'];
const ALLOWLIST_PATH = path.join(__dirname, 'audit-allowlist.json');

function evaluateAudit(auditJson, allowlist, today, blockingSeverities = BLOCKING) {
  const result = { ok: false, blocking: [], allowed: [], expired: [], invalid: [], counts: { critical: 0, high: 0, moderate: 0, low: 0 } };
  if (!auditJson || typeof auditJson !== 'object' || !auditJson.advisories || typeof auditJson.advisories !== 'object') {
    result.error = 'pnpm audit produced no advisories object - the audit did not run';
    return result;
  }
  const entries = new Map();
  for (const entry of allowlist || []) {
    if (!entry || !entry.id || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy || '')) result.invalid.push(entry);
    else entries.set(entry.id, entry);
  }
  for (const a of Object.values(auditJson.advisories)) {
    if (a.severity in result.counts) result.counts[a.severity]++;
    if (!blockingSeverities.includes(a.severity)) continue;
    const item = { id: a.github_advisory_id, severity: a.severity, package: a.module_name, title: a.title };
    const entry = entries.get(item.id);
    if (!entry) result.blocking.push(item);
    else if (entry.reviewBy < today) result.expired.push({ ...item, reviewBy: entry.reviewBy });
    else result.allowed.push({ ...item, reason: entry.reason, reviewBy: entry.reviewBy });
  }
  result.ok = result.blocking.length === 0 && result.expired.length === 0 && result.invalid.length === 0;
  return result;
}

function runPass(label, args, blockingSeverities, allowlist, today) {
  const run = spawnSync('pnpm', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let auditJson = null;
  try { auditJson = JSON.parse(run.stdout); } catch { /* evaluateAudit reports it */ }
  const r = evaluateAudit(auditJson, allowlist, today, blockingSeverities);
  const c = r.counts;
  console.log(`${label}: ${c.critical} critical, ${c.high} high, ${c.moderate} moderate, ${c.low} low (blocking: ${blockingSeverities.join('/')})`);
  r.allowed.forEach(a => console.log(`  allowed  ${a.severity} ${a.package} ${a.id} (until ${a.reviewBy}): ${a.reason}`));
  if (r.error) console.error(`  BLOCKED  ${r.error}${run.stderr ? `\n${run.stderr.trim().slice(0, 500)}` : ''}`);
  r.blocking.forEach(b => console.error(`  BLOCKED  ${b.severity} ${b.package} ${b.id}: ${b.title}`));
  r.expired.forEach(e => console.error(`  BLOCKED  allowlist entry ${e.id} (${e.package}) expired ${e.reviewBy} - re-review it`));
  r.invalid.forEach(e => console.error(`  BLOCKED  allowlist entry needs id, reason and reviewBy (YYYY-MM-DD): ${JSON.stringify(e)}`));
  return r.ok;
}

function main() {
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const all = runPass('Dependency audit (all)', ['audit', '--json'], BLOCKING, allowlist, today);
  const prod = runPass('Dependency audit (production)', ['audit', '--prod', '--json'], PROD_BLOCKING, allowlist, today);
  const ok = all && prod;
  console.log(ok ? 'Dependency gate: PASSED' : 'Dependency gate: FAILED');
  return ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { evaluateAudit, BLOCKING, PROD_BLOCKING };
