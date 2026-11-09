#!/usr/bin/env node
const assert = require('assert'); const path = require('path'); const os = require('os');
const { geminiAdapter, hasModelFlag } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'gemini.js'));
let f = 0; function check(n, fn){ try{ fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }
(async () => {
  const ctx = { rootUrl: 'https://gw', apiKey: 'sk-tok', webSearch: false, dryRun: true };
  const plan = await geminiAdapter.plan(ctx, ['-p', 'x']);
  check('gemini env: base url is the /google prefix, key under GEMINI_API_KEY', () => {
    assert.strictEqual(plan.env.GOOGLE_GEMINI_BASE_URL, 'https://gw/google');
    assert.strictEqual(plan.env.GEMINI_API_KEY, 'sk-tok');
  });
  check('gemini writes exactly the auth-type setting into ~/.gemini/settings.json', () => {
    assert.strictEqual(plan.fileEdits.length, 1);
    assert.strictEqual(plan.fileEdits[0].file, path.join(os.homedir(), '.gemini', 'settings.json'));
    assert.strictEqual(plan.fileEdits[0].format, 'json');
    assert.deepStrictEqual(plan.fileEdits[0].blocks, { 'security.auth.selectedType': '"gemini-api-key"' });
  });
  check('gemini argv: default model prepended, passthrough kept in order', () =>
    assert.deepStrictEqual(plan.argv, ['-m', 'gemini-3.5-flash', '-p', 'x']));
  check('gemini argv: a caller-chosen model is left alone', async () => {
    for (const args of [['-m', 'anthropic--claude-4.5-haiku', '-p', 'x'], ['--model', 'gemini-2.5-pro'], ['--model=gemini-2.5-pro']]) {
      assert.strictEqual(hasModelFlag(args), true);
    }
    assert.strictEqual(hasModelFlag(['-p', 'x']), false);
  });
  const chosen = await geminiAdapter.plan(ctx, ['-m', 'anthropic--claude-4.5-haiku', '-p', 'x']);
  check('gemini argv with -m passes through unchanged', () =>
    assert.deepStrictEqual(chosen.argv, ['-m', 'anthropic--claude-4.5-haiku', '-p', 'x']));
  check('gemini notes mention the auth setting and the trust flag', () => {
    assert.ok(plan.notes.some(n => n.includes('settings.json')));
    assert.ok(plan.notes.some(n => n.includes('--skip-trust')));
  });
  process.exit(f ? 1 : 0);
})();
