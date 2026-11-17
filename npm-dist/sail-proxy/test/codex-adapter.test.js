#!/usr/bin/env node
const assert = require('assert'); const path = require('path'); const http = require('http');
const { codexAdapter } = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'codex.js'));
let f = 0;
async function check(n, fn){ try{ await fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }

function fakeGateway(ids) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() }));
  });
}
const plan = (rootUrl, dryRun = false) => codexAdapter.plan({ rootUrl, apiKey: 'sk-tok', webSearch: false, dryRun }, []);
const says = (p) => p.notes.some((n) => /orchestration/i.test(n));

(async () => {
  const bare = await fakeGateway(['gpt-5.6-sol', 'gpt-4.1-nano']);
  const noDeployment = await plan(bare.url);
  await check('without a deployment the launch says it runs through orchestration', () => assert.ok(says(noDeployment)));
  await check('the launch reads the model list with the key', () => {
    assert.strictEqual(bare.seen[0].url, '/openai/v1/models');
    assert.strictEqual(bare.seen[0].auth, 'Bearer sk-tok');
  });
  const dry = await plan(bare.url, true);
  await check('a dry run stays offline', () => {
    assert.strictEqual(bare.seen.length, 1);
    assert.ok(!says(dry));
  });
  bare.close();

  const deployed = await fakeGateway(['gpt-5.6-sol', 'gpt-5.6-sol--deployed']);
  const withDeployment = await plan(deployed.url);
  await check('with a deployment there is no note', () => assert.ok(!says(withDeployment)));
  deployed.close();

  // Codex signed in to ChatGPT brings its own app services, a web search among them, which the
  // model can call and which never pass the gateway (seen live 2026-11-12: codex_apps
  // search_service.web_run beside the gateway's web_search). Switching them off is the user's
  // choice (maintainer, 2026-11-12: opt-in for now): `sail-proxy codex -c features.apps=false`.
  const pairs = (argv) => argv.map((a, i) => (a === '-c' ? argv[i + 1] : null)).filter(Boolean);
  for (const webSearch of [false, true]) {
    const p = await codexAdapter.plan({ rootUrl: 'http://127.0.0.1:9', apiKey: 'sk-tok', webSearch, dryRun: true }, []);
    await check(`the launch does not decide about Codex's own app services (web search ${webSearch ? 'on' : 'off'})`,
      () => assert.ok(!pairs(p.argv).some((c) => c.startsWith('features.apps'))));
  }
  const optedOut = await codexAdapter.plan({ rootUrl: 'http://127.0.0.1:9', apiKey: 'sk-tok', webSearch: false, dryRun: true }, ['-c', 'features.apps=false', 'hi']);
  await check("the user's own -c features.apps=false reaches Codex, after the launcher's settings", () => {
    assert.deepStrictEqual(optedOut.argv.slice(-3), ['-c', 'features.apps=false', 'hi']);
  });

  const down = await plan('http://127.0.0.1:9');
  await check('an unreachable gateway still launches, without the note', () => assert.ok(!says(down)));
  process.exit(f ? 1 : 0);
})();
