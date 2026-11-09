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

  const down = await plan('http://127.0.0.1:9');
  await check('an unreachable gateway still launches, without the note', () => assert.ok(!says(down)));
  process.exit(f ? 1 : 0);
})();
