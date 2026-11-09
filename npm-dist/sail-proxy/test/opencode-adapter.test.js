#!/usr/bin/env node
const assert = require('assert'); const path = require('path');
const { opencodeAdapter } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'opencode.js'));
let f = 0; function check(n, fn){ try{ fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }
(async () => {
  const plan = await opencodeAdapter.plan({ rootUrl: 'http://127.0.0.1:3000', apiKey: 'sk-x', webSearch: false, dryRun: true }, ['run', 'hi']);
  const edit = plan.fileEdits[0];
  check('opencode writes a namespaced json provider block', () => {
    assert.strictEqual(edit.format, 'json');
    assert.ok(edit.file.endsWith(path.join('opencode', 'opencode.json')));
    const v = JSON.parse(edit.blocks['provider.sail-proxy']);
    assert.strictEqual(v.npm, '@ai-sdk/openai');
    assert.strictEqual(v.options.baseURL, 'http://127.0.0.1:3000/openai/v1');
    assert.strictEqual(v.options.apiKey, 'sk-x');
  });
  check('opencode note mentions the Responses API', () => assert.ok(plan.notes.some(n => /responses api/i.test(n))));
  check('opencode plan.argv passes through unchanged', () => assert.deepStrictEqual(plan.argv, ['run', 'hi']));
  process.exit(f ? 1 : 0);
})();
