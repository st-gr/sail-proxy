#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-launch-dryrun-'));
process.env.SAIL_PROXY_CONFIG_DIR = tmp;
process.env.HOME = tmp;
const { setEndpoint } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'endpoints.js'));
const { runLauncher } = require(path.resolve(__dirname, '..', 'dist', 'commands', 'launch.js'));
let f = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ f++; console.error('not ok - '+name+'\n  '+e.message); } }

(async () => {
  setEndpoint({ target: 'local', builtin: true });
  const code = await runLauncher('codex', ['hi'], { dryRun: true, noWebSearch: true });
  check('dry-run returns exit code 0', () => {
    assert.strictEqual(code, 0);
  });
  check('dry-run wrote no config.toml (binary-free, config-free preview)', () => {
    assert.strictEqual(fs.existsSync(path.join(tmp, '.codex', 'config.toml')), false);
  });
  process.exit(f ? 1 : 0);
})();
