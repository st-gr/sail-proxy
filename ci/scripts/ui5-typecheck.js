#!/usr/bin/env node
/**
 * Type-checks the cockpit's UI5 TypeScript apps (CI gate and dev tool).
 *
 *   node ci/scripts/ui5-typecheck.js [--verbose] [app ...]
 *
 * Without arguments it runs `tsc --noEmit -p <app>/tsconfig.json` for every services/admin/app/<app>
 * that has a tsconfig.json (the build itself transpiles with babel and never type-checks). It prints
 * the error count per app and exits 1 when
 *
 * - an app listed in ui5-typecheck.gated.json next to this file has any error (an app joins that list
 *   once it is clean and stays at 0 from then on), or
 * - any app reports TS2688: the UI5 types (@sapui5/types in services/admin devDependencies) are not
 *   installed, and tsc then stops before it checks a single file, or
 * - tsc fails without reporting an error (it did not run), or a gated app does not exist.
 *
 * --verbose prints every error, not only those of failing apps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_DIR = path.join(REPO_ROOT, 'services', 'admin');
const APP_ROOT = path.join(ADMIN_DIR, 'app');
const DEFAULT_GATED = path.join(__dirname, 'ui5-typecheck.gated.json');
/** Reported when the type library a tsconfig names under "types" is not installed. */
const MISSING_TYPES = 'TS2688';

/** The errors in `tsc --pretty false` output: "file(line,col): error TSnnnn: …" or a global "error TSnnnn: …". */
function parseTscOutput(output) {
  const errors = [];
  for (const line of String(output).split(/\r?\n/)) {
    const located = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (located) {
      errors.push({ file: located[1], line: Number(located[2]), code: located[4], message: located[5] });
      continue;
    }
    const global = /^error (TS\d+): (.*)$/.exec(line.trim());
    if (global) errors.push({ file: null, line: null, code: global[1], message: global[2] });
  }
  return errors;
}

/** "TS2339×3, TS2532×1": the codes of an app's errors, most frequent first. */
function codeSummary(errors) {
  const counts = new Map();
  for (const e of errors) counts.set(e.code, (counts.get(e.code) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code}×${n}`).join(', ');
}

/**
 * The verdict over all results ({ app, errors, status }). Returns { exitCode, failures }, one
 * failure ({ app, reason }) per reason.
 */
function decide(results, gated) {
  const failures = [];
  for (const app of gated) {
    if (!results.some((r) => r.app === app)) failures.push({ app, reason: 'gated but not found' });
  }
  for (const r of results) {
    if (r.errors.some((e) => e.code === MISSING_TYPES)) {
      failures.push({ app: r.app, reason: `${MISSING_TYPES} — the UI5 types are not installed (pnpm install)` });
    } else if (r.status !== 0 && r.errors.length === 0) {
      failures.push({ app: r.app, reason: `tsc exited ${r.status} without reporting an error` });
    } else if (gated.includes(r.app) && r.errors.length > 0) {
      failures.push({ app: r.app, reason: `${r.errors.length} error(s) in a gated app` });
    }
  }
  return { exitCode: failures.length ? 1 : 0, failures };
}

/** The UI5 apps: every directory under appRoot with a tsconfig.json. */
function discoverApps(appRoot = APP_ROOT) {
  return fs.readdirSync(appRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(appRoot, d.name, 'tsconfig.json')))
    .map((d) => d.name)
    .sort();
}

function loadGated(file = DEFAULT_GATED) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.apps)) throw new Error(`${file} needs an "apps" array`);
  return data.apps;
}

function typecheck(app, appRoot = APP_ROOT) {
  const tsc = require.resolve('typescript/bin/tsc', { paths: [ADMIN_DIR] });
  const cwd = path.join(appRoot, app);
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const status = run.status === null ? -1 : run.status;
  return { app, status, errors: parseTscOutput(output), output: run.error ? String(run.error) : output };
}

function main(argv, log = console.log) {
  const verbose = argv.includes('--verbose');
  const named = argv.filter((a) => !a.startsWith('--'));
  const gated = loadGated();
  const apps = named.length ? named : discoverApps();
  const results = apps.map((app) => typecheck(app));
  // Named apps narrow the run; a gated app left out of it is not "missing".
  const verdict = decide(results, named.length ? gated.filter((a) => apps.includes(a)) : gated);
  const width = Math.max(...apps.map((a) => a.length));
  for (const r of results) {
    const tag = gated.includes(r.app) ? 'gated' : '     ';
    const codes = r.errors.length ? `  ${codeSummary(r.errors)}` : '';
    log(`  ${r.app.padEnd(width)}  ${tag}  ${String(r.errors.length).padStart(4)}${codes}`);
  }
  const failing = new Set(verdict.failures.map((f) => f.app));
  for (const r of results) {
    if (!verbose && !failing.has(r.app)) continue;
    if (!r.errors.length && !failing.has(r.app)) continue;
    log(`\n${r.app}:`);
    log(r.errors.length ? r.errors.map((e) => `  ${e.file ? `${e.file}(${e.line}): ` : ''}${e.code} ${e.message}`).join('\n')
      : r.output.trim().split('\n').map((l) => `  ${l}`).join('\n'));
  }
  const total = results.reduce((n, r) => n + r.errors.length, 0);
  log(`\nui5-typecheck: ${total} error(s) in ${results.filter((r) => r.errors.length).length} of ${results.length} app(s); ` +
    `${gated.length} gated`);
  for (const f of verdict.failures) log(`FAIL ${f.app}: ${f.reason}`);
  return verdict.exitCode;
}

module.exports = { parseTscOutput, codeSummary, decide, discoverApps, loadGated, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
