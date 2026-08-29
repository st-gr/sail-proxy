#!/usr/bin/env node
const assert = require('assert'); const path = require('path'); const os = require('os'); const fs = require('fs');
const cw = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'config-writer.js'));
let f = 0; function check(n, fn){ try{ fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }

check('spliceTomlSections appends a new section, leaves others byte-stable', () => {
  const src = 'model = "x"\n\n[existing]\nfoo = "bar"\n';
  const out = cw.spliceTomlSections(src, { 'model_providers.sail-proxy': 'name = "sail-proxy"\nbase_url = "u"\n' });
  assert.ok(out.includes('model = "x"'));            // untouched
  assert.ok(out.includes('[existing]\nfoo = "bar"'));// untouched
  assert.ok(out.includes('[model_providers.sail-proxy]\nname = "sail-proxy"\nbase_url = "u"'));
});
check('spliceTomlSections REPLACES an existing owned section, not others', () => {
  const src = '[model_providers.sail-proxy]\nold = "1"\n\n[keepme]\nk = "v"\n';
  const out = cw.spliceTomlSections(src, { 'model_providers.sail-proxy': 'name = "new"\n' });
  assert.ok(!out.includes('old = "1"'));
  assert.ok(out.includes('name = "new"'));
  assert.ok(out.includes('[keepme]\nk = "v"'));      // untouched
});
check('setJsonPath sets a dotted path, preserves siblings', () => {
  const src = '{\n  "provider": { "other": { "x": 1 } }\n}';
  const out = cw.setJsonPath(src, 'provider.sail-proxy', '{"npm":"@ai-sdk/openai-compatible"}');
  const o = JSON.parse(out);
  assert.deepStrictEqual(o.provider.other, { x: 1 });
  assert.deepStrictEqual(o.provider['sail-proxy'], { npm: '@ai-sdk/openai-compatible' });
});
check('spliceTomlSections does not touch a same-length near-miss section name', () => {
  const src = '[model_providersXsail-proxy]\nsecret = "keep"\n\n[model_providers.sail-proxy]\nold = "1"\n';
  const out = cw.spliceTomlSections(src, { 'model_providers.sail-proxy': 'name = "new"\n' });
  assert.ok(out.includes('[model_providersXsail-proxy]\nsecret = "keep"'), 'near-miss section must survive byte-for-byte');
  assert.ok(!out.includes('old = "1"'));
  assert.ok(out.includes('[model_providers.sail-proxy]\nname = "new"'));
});
check('spliceTomlSections leaves an unrelated multi-blank-line run untouched', () => {
  const src = '[a]\nx = 1\n\n\n\n[b]\ny = 2\n\n[c]\nz = 3\n';
  const out = cw.spliceTomlSections(src, { c: 'z = 99\n' });
  assert.ok(out.includes('[a]\nx = 1\n\n\n\n[b]\ny = 2\n'), 'unrelated blank run must not be collapsed');
  assert.ok(out.includes('[c]\nz = 99\n'));
  assert.ok(!out.includes('z = 3'));
});
check('applyEdit throws a file-scoped error on malformed JSON', () => {
  const tmpFile = path.join(os.tmpdir(), 'sail-proxy-test-malformed-' + Date.now() + '.json');
  fs.writeFileSync(tmpFile, '{ not valid json');
  try {
    let threw = false;
    try {
      cw.applyEdit({ file: tmpFile, format: 'json', blocks: { 'provider.sail-proxy': '{}' } });
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes(tmpFile), 'error message should include file path: ' + e.message);
    }
    assert.ok(threw, 'applyEdit should have thrown');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
process.exit(f ? 1 : 0);
