#!/usr/bin/env node
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-launch-'));
process.env.SAIL_PROXY_CONFIG_DIR = tmp;
const { codexAdapter } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'codex.js'));
let f = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ f++; console.error('not ok - '+name+'\n  '+e.message); } }

function indexOfSeq(arr, seq) {
  for (let i = 0; i <= arr.length - seq.length; i++) {
    if (seq.every((v, j) => arr[i + j] === v)) return i;
  }
  return -1;
}

(async () => {
  const plan = await codexAdapter.plan({ rootUrl: 'http://127.0.0.1:3000', apiKey: 'sk-x', webSearch: false, dryRun: true }, ['do', 'it']);
  check('codex plan writes no file edits', () => {
    assert.deepStrictEqual(plan.fileEdits, []);
  });
  check('codex plan: bearer key exported under SAILPROXY_KEY', () => assert.strictEqual(plan.env.SAILPROXY_KEY, 'sk-x'));
  check('codex argv contains -c overrides for provider, base_url, env_key, model (in order)', () => {
    assert.ok(indexOfSeq(plan.argv, ['-c', 'model_provider=sail-proxy']) >= 0);
    assert.ok(indexOfSeq(plan.argv, ['-c', 'model_providers.sail-proxy.base_url="http://127.0.0.1:3000/openai/v1"']) >= 0);
    assert.ok(indexOfSeq(plan.argv, ['-c', 'model_providers.sail-proxy.env_key="SAILPROXY_KEY"']) >= 0);
    assert.ok(indexOfSeq(plan.argv, ['-c', 'model=gpt-5.6-sol']) >= 0);
  });
  check('codex argv: webSearch:false omits web_search and model_catalog_json', () => {
    assert.ok(!plan.argv.includes('web_search=live'));
    assert.ok(!plan.argv.some(a => /model_catalog_json/.test(a)));
  });
  check('codex argv ends with the passthrough args', () => {
    assert.deepStrictEqual(plan.argv.slice(-2), ['do', 'it']);
  });
  process.exit(f ? 1 : 0);
})();
