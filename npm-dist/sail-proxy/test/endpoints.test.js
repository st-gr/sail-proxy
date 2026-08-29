#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
// Isolate the config dir so we never touch the real ~/.sail-proxy
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ep-'));
process.env.SAIL_PROXY_CONFIG_DIR = tmp;               // paths.ts honors this override (added in Step 3)
const ep = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'endpoints.js'));
let failures = 0;
function check(name, fn){ try { fn(); console.log('ok - '+name); } catch(e){ failures++; console.error('not ok - '+name+'\n  '+e.message); } }

check('parseSetArgs local', () => {
  assert.deepStrictEqual(ep.parseSetArgs('local', {}), { target: 'local', builtin: true });
});
check('parseSetArgs remote with key-env', () => {
  assert.deepStrictEqual(
    ep.parseSetArgs('https://gw.kyma.example', { keyEnv: 'SP_KYMA' }),
    { target: 'gw.kyma.example', rootUrl: 'https://gw.kyma.example', keyEnv: 'SP_KYMA' });
});
check('parseSetArgs remote requires exactly one key source', () => {
  assert.throws(() => ep.parseSetArgs('https://x', {}), /key/i);
  assert.throws(() => ep.parseSetArgs('https://x', { key: 'a', keyEnv: 'B' }), /one/i);
});
check('set then show round-trips', () => {
  const spec = { target: 'docker', rootUrl: 'http://localhost:8080', key: 'sk-stored' };
  ep.setEndpoint(spec);
  assert.deepStrictEqual(ep.showEndpoint(), spec);
});
check('resolveEndpoint remote via env', () => {
  ep.setEndpoint({ target: 'kyma', rootUrl: 'https://gw', keyEnv: 'SP_TEST_KEY' });
  process.env.SP_TEST_KEY = 'sk-from-env';
  const r = ep.resolveEndpoint();
  assert.strictEqual(r.rootUrl, 'https://gw');
  assert.strictEqual(r.isLocal, false);
  assert.strictEqual(r.resolveKey(), 'sk-from-env');
});
check('resolveEndpoint local: isLocal true, 127.0.0.1 root, creates a local key', () => {
  ep.setEndpoint({ target: 'local', builtin: true });
  const r = ep.resolveEndpoint();
  assert.strictEqual(r.isLocal, true);
  assert.match(r.rootUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(r.resolveKey().startsWith('sk-'));
});
check('resolveEndpoint remote missing env throws with fix hint', () => {
  ep.setEndpoint({ target: 'kyma', rootUrl: 'https://gw', keyEnv: 'SP_UNSET_KEY' });
  assert.throws(() => ep.resolveEndpoint().resolveKey(), /SP_UNSET_KEY/);
});
process.exit(failures ? 1 : 0);
