#!/usr/bin/env node
// `sail-proxy file-search rebuild-index` runs the bundled gateway's migration CLI (the file_search index rebuild)
// with the user's arguments, from the gateway's cwd and with the gateway's environment (the user's .env).
// Prerequisites: `npm run build:local` (and `npm run bundle` for the bundle check).
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const { rebuildIndexInvocation } = require(path.resolve(__dirname, '..', 'dist', 'commands', 'fileSearch.js'));
const { getGatewayCwd } = require(path.resolve(__dirname, '..', 'dist', 'utils', 'paths.js'));
let f = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ f++; console.error('not ok - '+name+'\n  '+e.message); } }

check('runs migrateCli.js rebuild-index with the arguments as given', () => {
  const run = rebuildIndexInvocation(['--dry-run', '--ef-construction', '100'], { PATH: '/usr/bin' }, {});
  assert.strictEqual(run.command, process.execPath);
  assert.ok(run.args[0].endsWith(path.join('src', 'fileSearch', 'migrateCli.js')), run.args[0]);
  assert.deepStrictEqual(run.args.slice(1), ['rebuild-index', '--dry-run', '--ef-construction', '100']);
  assert.strictEqual(run.cwd, getGatewayCwd());
});
check("takes the database credentials from the user's .env, like the gateway", () => {
  const run = rebuildIndexInvocation([], { PATH: '/usr/bin' }, { FILE_SEARCH_DATABASE_URL: 'postgresql://u:p@h/db' });
  assert.strictEqual(run.env.FILE_SEARCH_DATABASE_URL, 'postgresql://u:p@h/db');
  assert.strictEqual(run.env.PATH, '/usr/bin');
});
const bundled = path.resolve(__dirname, '..', 'bundled', 'gateway');
if (fs.existsSync(bundled)) {
  check('the bundle carries the migration CLI and the command resolves to it', () => {
    const run = rebuildIndexInvocation([], {}, {});
    assert.strictEqual(run.args[0], path.join(bundled, 'services', 'gateway', 'src', 'fileSearch', 'migrateCli.js'));
    assert.ok(fs.existsSync(run.args[0]));
  });
}
process.exit(f ? 1 : 0);
