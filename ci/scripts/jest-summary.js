#!/usr/bin/env node
/**
 * Turns a jest run's results (ci/scripts/jest-summary-reporter.js, the shape of jest's --json output) into the per-suite record CI keeps: which suites passed, failed or were
 * skipped entirely (every test pending, as a suite gated on Valkey, Postgres or a live service is when
 * its environment is missing), with counts. It keeps paths and counts only - no titles, messages or
 * failure output, which can quote request text or the SAP relay - and deletes the raw file.
 *
 * Usage: node ci/scripts/jest-summary.js <raw jest json> <label> <service dir> <summary json out>
 */
const fs = require('fs');
const path = require('path');

function suiteStatus(result, counts) {
  if (result.status === 'failed' || counts.failed > 0) return 'failed';
  if (counts.passed === 0 && counts.skipped > 0) return 'skipped';
  return 'passed';
}

function summarize(run, serviceDir) {
  const files = (run.testResults || []).map(result => {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const a of result.assertionResults || []) {
      if (a.status === 'passed') counts.passed++;
      else if (a.status === 'failed') counts.failed++;
      else counts.skipped++; // pending, skipped, todo, disabled
    }
    return { file: path.relative(serviceDir, result.name).split(path.sep).join('/'), status: suiteStatus(result, counts), ...counts };
  }).sort((a, b) => a.file.localeCompare(b.file));
  const count = status => files.filter(f => f.status === status).length;
  const sum = key => files.reduce((n, f) => n + f[key], 0);
  return {
    suites: { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), total: files.length },
    tests: { passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped'), total: sum('passed') + sum('failed') + sum('skipped') },
    files,
  };
}

function formatSummary(label, s) {
  const lines = [
    `${label}: ${s.suites.passed} suites passed, ${s.suites.failed} failed, ${s.suites.skipped} skipped of ${s.suites.total}; ` +
    `${s.tests.passed} tests passed, ${s.tests.failed} failed, ${s.tests.skipped} skipped`,
  ];
  for (const f of s.files.filter(f => f.status === 'skipped')) lines.push(`  skipped: ${f.file}`);
  for (const f of s.files.filter(f => f.status === 'failed')) lines.push(`  failed: ${f.file}`);
  return lines.join('\n');
}

if (require.main === module) {
  const [raw, label, serviceDir, out] = process.argv.slice(2);
  let run;
  try {
    run = JSON.parse(fs.readFileSync(raw, 'utf8'));
  } catch (error) {
    console.log(`${label}: no jest result (${error.code || error.message})`);
    process.exit(0);
  }
  const summary = summarize(run, path.resolve(serviceDir));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
  fs.rmSync(raw, { force: true });
  console.log(formatSummary(label, summary));
}

module.exports = { summarize, formatSummary };
