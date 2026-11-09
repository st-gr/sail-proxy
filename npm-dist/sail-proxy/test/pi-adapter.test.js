#!/usr/bin/env node
const assert = require('assert'); const path = require('path'); const os = require('os'); const http = require('http');
const pi = require(path.resolve(__dirname, '..', 'dist', 'launcher', 'adapters', 'pi.js'));
const { piAdapter, toPiModels, hasModelFlag, defaultModelArg, FALLBACK_MODELS } = pi;
let f = 0; function check(n, fn){ try{ fn(); console.log('ok - '+n);}catch(e){f++;console.error('not ok - '+n+'\n  '+e.message);} }

const gatewayList = { object: 'list', data: [
  { id: 'anthropic--claude-4.5-haiku', displayName: 'Claude 4.5 Haiku', versions: [{ isLatest: true, contextLength: 200000, inputTypes: ['text', 'image'],
    capabilities: ['text-generation', 'image-recognition'], cost: [{ inputCost: '0.00079' }, { outputCost: '0.00367' }, { cacheReadInputCost: '0.00008' }, { cacheCreationInputCost: '0.00099' }] }] },
  { id: 'anthropic--claude-4.5-haiku--deployed', versions: [{ isLatest: true, contextLength: 200000, inputTypes: ['text'], capabilities: ['text-generation'] }] },
  { id: 'anthropic--claude-3-haiku--deployed', versions: [{ isLatest: true, contextLength: 200000, inputTypes: ['text'], capabilities: ['text-generation'] }] },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', versions: [{ isLatest: true, contextLength: 1050000, inputTypes: ['text', 'image'], capabilities: ['text-generation', 'image-recognition', 'reasoning'] }] },
  { id: 'gpt-5.6-sol--deployed', versions: [{ isLatest: true, contextLength: 1050000, inputTypes: ['text'], capabilities: ['text-generation'] }] },
  { id: 'gemini-3.5-flash', versions: [{ isLatest: false, contextLength: 1 }, { isLatest: true, contextLength: 1000000, inputTypes: ['text', 'image', 'audio', 'video'], capabilities: ['text-generation', 'reasoning'] }] },
  { id: 'mistralai--mistral-medium', versions: [{ isLatest: true, contextLength: 256000, inputTypes: ['text'], capabilities: ['text-generation'] }] },
  { id: 'text-embedding-3-small', versions: [{ isLatest: true, capabilities: ['embeddings'] }] },
  { id: 'cohere-reranker--deployed', versions: [] },
] };

(async () => {
  const models = toPiModels(gatewayList);
  check('toPiModels: chat models only, --deployed dropped when the base id exists, deployed-only kept', () => {
    assert.deepStrictEqual(models.map(m => m.id),
      ['anthropic--claude-4.5-haiku', 'anthropic--claude-3-haiku--deployed', 'gpt-5.6-sol', 'gemini-3.5-flash', 'mistralai--mistral-medium', 'cohere-reranker--deployed']);
  });
  check('toPiModels: metadata from the latest version, cost scaled to per-million, image input kept, audio dropped', () => {
    const haiku = models[0];
    assert.strictEqual(haiku.name, 'Claude 4.5 Haiku');
    assert.strictEqual(haiku.reasoning, false);
    assert.deepStrictEqual(haiku.input, ['text', 'image']);
    assert.strictEqual(haiku.contextWindow, 200000);
    assert.deepStrictEqual(haiku.cost, { input: 0.79, output: 3.67, cacheRead: 0.08, cacheWrite: 0.99 });
    const gemini = models.find(m => m.id === 'gemini-3.5-flash');
    assert.strictEqual(gemini.reasoning, true);
    assert.strictEqual(gemini.contextWindow, 1000000);
    assert.deepStrictEqual(gemini.input, ['text', 'image']);
    assert.strictEqual(gemini.cost, undefined);
    assert.strictEqual(models.find(m => m.id === 'cohere-reranker--deployed').contextWindow, 128000);
  });
  check('hasModelFlag: --model and --provider in both spellings', () => {
    for (const a of [['--model', 'x'], ['--model=x'], ['--provider', 'p'], ['--provider=p', '-p', 'hi']]) assert.strictEqual(hasModelFlag(a), true);
    assert.strictEqual(hasModelFlag(['-p', 'hi', '--thinking', 'high']), false);
  });
  check('defaultModelArg: gpt-5.6-sol when listed, else the first model, null for none', () => {
    assert.strictEqual(defaultModelArg(FALLBACK_MODELS), 'sail-proxy/gpt-5.6-sol');
    assert.strictEqual(defaultModelArg(models.filter(m => m.id !== 'gpt-5.6-sol')), 'sail-proxy/anthropic--claude-4.5-haiku');
    assert.strictEqual(defaultModelArg([]), null);
  });

  const dry = await piAdapter.plan({ rootUrl: 'https://gw', apiKey: 'sk-tok', webSearch: false, dryRun: true }, ['-p', 'hi']);
  check('dry run: one sail-proxy provider block on the Responses API in ~/.pi/agent/models.json, built-in models, no network', () => {
    assert.strictEqual(dry.fileEdits.length, 1);
    const edit = dry.fileEdits[0];
    assert.strictEqual(edit.file, path.join(os.homedir(), '.pi', 'agent', 'models.json'));
    assert.strictEqual(edit.format, 'json');
    assert.deepStrictEqual(Object.keys(edit.blocks), ['providers.sail-proxy']);
    const p = JSON.parse(edit.blocks['providers.sail-proxy']);
    assert.deepStrictEqual([p.baseUrl, p.api, p.apiKey], ['https://gw/openai/v1', 'openai-responses', 'SAILPROXY_KEY']);
    assert.deepStrictEqual(p.models.map(m => m.id), ['gpt-5.6-sol', 'anthropic--claude-4.5-sonnet', 'gemini-3.5-flash']);
    assert.ok(dry.notes.some(n => /dry run/i.test(n)));
  });
  check('plan: key exported under SAILPROXY_KEY, default model prepended, passthrough kept', () => {
    assert.strictEqual(dry.env.SAILPROXY_KEY, 'sk-tok');
    assert.deepStrictEqual(dry.argv, ['--model', 'sail-proxy/gpt-5.6-sol', '-p', 'hi']);
  });
  const chosen = await piAdapter.plan({ rootUrl: 'https://gw', apiKey: 'sk-tok', webSearch: false, dryRun: true }, ['--model', 'sail-proxy/anthropic--claude-4.5-sonnet', '-p', 'hi']);
  check('plan: a caller-chosen model is left alone', () => assert.deepStrictEqual(chosen.argv, ['--model', 'sail-proxy/anthropic--claude-4.5-sonnet', '-p', 'hi']));

  // Real launch: the gateway's list flows into the block (a stub gateway on a random port).
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(gatewayList)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const live = await piAdapter.plan({ rootUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-live', webSearch: false, dryRun: false }, []);
  srv.close();
  check('live plan: GET /v1/models with the bearer key, every chat model in the block, default model chosen', () => {
    assert.deepStrictEqual(seen, [{ url: '/v1/models', auth: 'Bearer sk-live' }]);
    const p = JSON.parse(live.fileEdits[0].blocks['providers.sail-proxy']);
    assert.deepStrictEqual(p.models.map(m => m.id), models.map(m => m.id));
    assert.deepStrictEqual(live.argv, ['--model', 'sail-proxy/gpt-5.6-sol']);
    assert.ok(!live.notes.some(n => /dry run|could not read/i.test(n)));
  });
  const down = await piAdapter.plan({ rootUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-live', webSearch: false, dryRun: false }, []);
  check('live plan with the gateway down: built-in models and a note', () => {
    const p = JSON.parse(down.fileEdits[0].blocks['providers.sail-proxy']);
    assert.deepStrictEqual(p.models.map(m => m.id), ['gpt-5.6-sol', 'anthropic--claude-4.5-sonnet', 'gemini-3.5-flash']);
    assert.ok(down.notes.some(n => /could not read the gateway's model list/i.test(n)));
  });
  process.exit(f ? 1 : 0);
})();
