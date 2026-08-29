#!/usr/bin/env node
const assert = require('assert'); const path = require('path');
const { claudeAdapter } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'claude.js'));
let f = 0; function check(n, fn){ try{ fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }
(async () => {
  const plan = await claudeAdapter.plan({ rootUrl: 'https://gw', apiKey: 'sk-tok', webSearch: false, dryRun: true }, ['-p', 'x']);
  check('claude writes no files', () => assert.deepStrictEqual(plan.fileEdits, []));
  check('claude env: base url is the root, bearer token, telemetry off', () => {
    assert.strictEqual(plan.env.ANTHROPIC_BASE_URL, 'https://gw');
    assert.strictEqual(plan.env.ANTHROPIC_AUTH_TOKEN, 'sk-tok');
    assert.strictEqual(plan.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  });
  check('claude plan.argv passes through unchanged', () => assert.deepStrictEqual(plan.argv, ['-p', 'x']));
  process.exit(f ? 1 : 0);
})();
