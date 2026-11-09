#!/usr/bin/env node
const assert = require('assert'); const path = require('path'); const http = require('http');
const { claudeAdapter, pickClaudeModels } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'claude.js'));
let f = 0;
async function check(n, fn){ try{ await fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }

// The ids /anthropic/v1/models returns for a tenant with Claude up to 4.8 Opus (2026-10-29).
const LISTED = ['anthropic--claude-4.5-haiku', 'anthropic--claude-4.5-sonnet', 'anthropic--claude-4.6-opus',
  'anthropic--claude-4.7-opus', 'anthropic--claude-4.6-sonnet', 'anthropic--claude-4.5-opus', 'anthropic--claude-4.8-opus',
  'anthropic--claude-4.8-opus--deployed', 'anthropic--claude-4.7-opus--deployed', 'anthropic--claude-4.5-haiku--deployed',
  'anthropic--claude-4-sonnet', 'anthropic--claude-4.10-sonnet-preview-x'];

// A gateway stand-in that answers /anthropic/v1/models with the given ids.
function fakeGateway(ids, status = 200) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: ids.map((id) => ({ type: 'model', id })) }));
    }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() }));
  });
}

(async () => {
  const dry = await claudeAdapter.plan({ rootUrl: 'https://gw', apiKey: 'sk-tok', webSearch: false, dryRun: true }, ['-p', 'x']);
  await check('claude writes no files', () => assert.deepStrictEqual(dry.fileEdits, []));
  await check('claude env: base url is the /anthropic route, bearer token, telemetry off', () => {
    assert.strictEqual(dry.env.ANTHROPIC_BASE_URL, 'https://gw/anthropic');
    assert.strictEqual(dry.env.ANTHROPIC_AUTH_TOKEN, 'sk-tok');
    assert.strictEqual(dry.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  });
  await check('claude plan.argv passes through unchanged', () => assert.deepStrictEqual(dry.argv, ['-p', 'x']));
  await check('a dry run stays offline and pins no model', () => {
    assert.strictEqual(dry.env.ANTHROPIC_MODEL, undefined);
    assert.ok(dry.notes.some((n) => /model/i.test(n)));
  });

  await check('picks the newest model per family, preferring the deployment twin', () => {
    assert.deepStrictEqual(pickClaudeModels(LISTED), {
      opus: 'anthropic--claude-4.8-opus--deployed',
      sonnet: 'anthropic--claude-4.6-sonnet',
      haiku: 'anthropic--claude-4.5-haiku--deployed',
    });
  });
  await check('versions compare numerically, not as text (4.10 > 4.8)', () => {
    assert.strictEqual(pickClaudeModels(['anthropic--claude-4.8-opus', 'anthropic--claude-4.10-opus']).opus, 'anthropic--claude-4.10-opus');
  });
  await check('a family the tenant lacks stays unset', () => {
    assert.deepStrictEqual(pickClaudeModels(['anthropic--claude-4.5-haiku']), { haiku: 'anthropic--claude-4.5-haiku' });
  });

  // Claude Code's own default (claude-opus-5-5 in 2.1.312) is unknown to SAP AI Core; without these
  // variables `sail-proxy claude` failed on its first prompt.
  const gw = await fakeGateway(LISTED);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
  try {
    const live = await claudeAdapter.plan({ rootUrl: gw.url, apiKey: 'sk-tok', webSearch: false, dryRun: false }, ['-p', 'x']);
    await check('a launch reads /anthropic/v1/models with the key', () => {
      assert.strictEqual(gw.seen[0].url, '/anthropic/v1/models');
      assert.strictEqual(gw.seen[0].auth, 'Bearer sk-tok');
    });
    await check('a launch pins the main model and the opus/sonnet/haiku defaults to tenant models', () => {
      assert.strictEqual(live.env.ANTHROPIC_MODEL, 'anthropic--claude-4.8-opus--deployed');
      assert.strictEqual(live.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'anthropic--claude-4.8-opus--deployed');
      assert.strictEqual(live.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'anthropic--claude-4.6-sonnet');
      assert.strictEqual(live.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'anthropic--claude-4.5-haiku--deployed');
      assert.strictEqual(live.env.ANTHROPIC_SMALL_FAST_MODEL, 'anthropic--claude-4.5-haiku--deployed');
    });
    const own = await claudeAdapter.plan({ rootUrl: gw.url, apiKey: 'sk-tok', webSearch: false, dryRun: false }, ['--model', 'claude-sonnet-4-5-20250929']);
    await check('the caller\'s --model wins over the pinned main model', () => {
      assert.strictEqual(own.env.ANTHROPIC_MODEL, undefined);
      assert.strictEqual(own.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'anthropic--claude-4.6-sonnet');
    });
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-haiku';
    const exported = await claudeAdapter.plan({ rootUrl: gw.url, apiKey: 'sk-tok', webSearch: false, dryRun: false }, []);
    await check('a variable the user exported is left alone', () => {
      assert.strictEqual(exported.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    });
  } finally {
    gw.close();
    process.env = saved;
  }

  const says = (p) => p.notes.some((n) => /orchestration/i.test(n));
  const bare = await fakeGateway(['anthropic--claude-4.8-opus', 'anthropic--claude-4.5-haiku']);
  const twin = await fakeGateway(LISTED);
  try {
    const noDeployment = await claudeAdapter.plan({ rootUrl: bare.url, apiKey: 'sk-tok', webSearch: false, dryRun: false }, []);
    await check('without a deployment the launch says it runs through orchestration', () => assert.ok(says(noDeployment)));
    const withDeployment = await claudeAdapter.plan({ rootUrl: twin.url, apiKey: 'sk-tok', webSearch: false, dryRun: false }, []);
    await check('with a deployment there is no note', () => assert.ok(!says(withDeployment)));
  } finally {
    bare.close();
    twin.close();
  }

  const down = await claudeAdapter.plan({ rootUrl: 'http://127.0.0.1:9', apiKey: 'sk-tok', webSearch: false, dryRun: false }, []);
  await check('an unreachable gateway still launches, pins nothing and says why', () => {
    assert.strictEqual(down.env.ANTHROPIC_MODEL, undefined);
    assert.ok(down.notes.some((n) => /--model/.test(n)));
  });
  process.exit(f ? 1 : 0);
})();
