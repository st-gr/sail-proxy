#!/usr/bin/env node
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cat-'));
process.env.SAIL_PROXY_CONFIG_DIR = tmp;
const cat = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'codex-catalog.js'));
let f = 0; function check(n, fn){ try{ fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }

check('present catalog: copies + flips use_responses_lite on the target model', () => {
  const home = path.join(tmp, 'models_cache.json');
  fs.writeFileSync(home, JSON.stringify({ models: [
    { slug: 'gpt-5.6-sol', use_responses_lite: true, web_search_tool_type: 'text_and_image' },
    { slug: 'other', use_responses_lite: true } ] }));
  const r = cat.prepareCodexCatalog('gpt-5.6-sol', home);
  assert.ok(r.catalogPath, 'expected a catalogPath');
  const out = JSON.parse(fs.readFileSync(r.catalogPath, 'utf8'));
  const e = out.models.find(m => m.slug === 'gpt-5.6-sol');
  assert.strictEqual(e.use_responses_lite, false);
  assert.strictEqual(out.models.find(m => m.slug === 'other').use_responses_lite, true); // untouched
});
check('absent catalog: skipped with a seed hint, no throw', () => {
  const r = cat.prepareCodexCatalog('gpt-5.6-sol', path.join(tmp, 'nope.json'));
  assert.strictEqual(r.skipped, true);
  assert.match(r.note, /web_search/i);
});
check('null catalog: gracefully skips on null, no throw', () => {
  const home = path.join(tmp, 'null-catalog.json');
  fs.writeFileSync(home, 'null');
  const r = cat.prepareCodexCatalog('gpt-5.6-sol', home);
  assert.strictEqual(r.skipped, true);
  assert.match(r.note, /web_search/i);
});
check('non-object element in models: null-safe find, no throw', () => {
  const home = path.join(tmp, 'models-with-null.json');
  fs.writeFileSync(home, JSON.stringify({ models: [null, { slug: 'gpt-5.6-sol', use_responses_lite: true }] }));
  const r = cat.prepareCodexCatalog('gpt-5.6-sol', home);
  assert.ok(r.catalogPath, 'expected a catalogPath');
  const out = JSON.parse(fs.readFileSync(r.catalogPath, 'utf8'));
  const e = out.models.find(m => m && m.slug === 'gpt-5.6-sol');
  assert.strictEqual(e.use_responses_lite, false);
});
process.exit(f ? 1 : 0);
