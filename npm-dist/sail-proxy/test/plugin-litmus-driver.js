// Child process of plugin-litmus.test.js. Runs one step against a copy of the bundled gateway and prints
// what happened, so a sync and the load after it are separate processes, as across a real restart. Not a
// test by itself. SAP is a local mock in this process, and any name lookup is refused and reported, so
// nothing here can reach a real service.
const dns = require('dns');
const http = require('http');
const net = require('net');
const path = require('path');

const { srcDir, op, sourceFolder, requests = {}, modules = [], settingsFor, messagesRequest } = JSON.parse(process.argv[2]);

const lookups = [];
const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (net.isIP(hostname)) return realLookup(hostname, options, callback); // the mock's own listen
  lookups.push(hostname);
  (callback || options)(new Error(`name lookup refused in the litmus: ${hostname}`));
};

const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const srcModule = (...parts) => require(path.join(srcDir, ...parts));

const MOCK_DEPLOYMENT = 'mock-sonar';
const MOCK_CLAUDE = 'mock-claude';
const MOCK_CLAUDE_MODEL = 'anthropic--claude-4-sonnet';
const calls = [];
const upstreamBodies = [];

function startSapMock() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url.split('?')[0]}`);
      const sent = Buffer.concat(chunks).toString('utf8');
      if (req.url.startsWith('/v2/inference/')) upstreamBodies.push(sent);
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/oauth/token') return json(200, { access_token: 'mock-token', expires_in: 3600 });
      if (req.url.startsWith('/v2/lm/scenarios/foundation-models/models')) {
        return json(200, {
          resources: [{
            model: MOCK_CLAUDE_MODEL,
            provider: 'Anthropic',
            executableId: 'aws-bedrock',
            allowedScenarios: [{ scenarioId: 'foundation-models', executableId: 'aws-bedrock' }],
            versions: [{ name: '1', isLatest: true }],
          }],
        });
      }
      if (req.url.startsWith('/v2/lm/deployments')) {
        const running = (id, name) => ({
          id,
          status: 'RUNNING',
          scenarioId: 'foundation-models',
          deploymentUrl: `${process.env.SAP_AI_CORE_URL}/v2/inference/deployments/${id}`,
          details: { resources: { backendDetails: { model: { name, version: '1' } } } },
        });
        return json(200, { resources: [running(MOCK_DEPLOYMENT, 'sonar-pro'), running(MOCK_CLAUDE, MOCK_CLAUDE_MODEL)] });
      }
      if (req.url === `/v2/inference/deployments/${MOCK_CLAUDE}/invoke`) {
        const asked = JSON.parse(sent);
        if (!asked.tools) { // no tool to call: answer with what arrived, so a placeholder comes back to be restored
          const last = asked.messages[asked.messages.length - 1].content;
          return json(200, {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: MOCK_CLAUDE_MODEL,
            content: [{ type: 'text', text: `You wrote: ${typeof last === 'string' ? last : last[0].text}` }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 2 },
          });
        }
        return json(200, {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: MOCK_CLAUDE_MODEL,
          content: [{ type: 'tool_use', id: 'toolu_mock', name: 'web_search', input: { query: 'what is new' } }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2 },
        });
      }
      if (req.url === `/v2/inference/deployments/${MOCK_DEPLOYMENT}/chat/completions`) {
        return json(200, {
          choices: [{ message: { content: 'Mock answer' } }],
          search_results: [{ title: 'Mock Result', url: 'https://example.invalid/mock', snippet: 'Mock snippet', date: 'January 2026' }],
        });
      }
      return json(404, { error: 'not mocked' });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      process.env.SAP_AI_CORE_URL = base;
      process.env.AUTH_URL = `${base}/oauth/token`;
      process.env.CLIENT_ID = 'mock-client';
      process.env.CLIENT_SECRET = 'mock-secret';
      resolve();
    });
  });
}

async function runHandler(loader, { rule, strategy, body, upstreamResponse }) {
  const found = loader.getRule(rule, strategy);
  if (!found) throw new Error(`${rule}/${strategy} is not registered`);
  const req = { body, headers: {} };
  const returned = await found.handler({ req, res: {}, utils: { logger: silent }, upstreamResponse });
  return { returned, body: req.body };
}

async function load() {
  await startSapMock();
  const loader = srcModule('services', 'pluginLoader.js');
  const configService = srcModule('services', 'configService.js');
  loader.loadAll();
  const handlers = {};
  for (const [name, request] of Object.entries(requests)) handlers[name] = await runHandler(loader, request);
  const resolved = {};
  for (const file of modules) resolved[file] = Object.keys(srcModule(file)).length > 0;
  const report = loader.getLoadReport();
  await srcModule('pluginInstall', 'reload.js').reloadPluginsInsideLock();
  const registry = srcModule('pluginSupport', 'hostedTool', 'registry.js');
  return {
    report,
    reloaded: loader.getLoadReport(),
    hostedTools: ['web_search', 'file_search'].filter(type => registry.descriptorForType(type)),
    handlers,
    calls,
    resolved,
    settings: settingsFor ? configService.getPluginSettings(settingsFor) : undefined,
  };
}

async function sync() {
  const { syncPlugins } = srcModule('pluginInstall', 'sync.js');
  const { createFolderSource } = srcModule('pluginInstall', 'folderSource.js');
  const { getGatewayVersion } = srcModule('pluginInstall', 'gatewayVersion.js');
  return syncPlugins(createFolderSource(sourceFolder), {
    pluginsDir: path.join(srcDir, 'plugins'),
    gatewayVersion: getGatewayVersion(),
    unpackAllowed: true,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const listening = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

/** One Messages request through the real gateway entry, listening on an OS-picked loopback port. */
async function request() {
  await startSapMock();
  const port = await freePort();
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES = 'true'; // keeps what marks the model as a deployment
  require(path.join(srcDir, 'index.js'));
  const deadline = Date.now() + 60_000;
  while (!(await listening(port))) {
    if (Date.now() > deadline) throw new Error('the gateway never listened');
    await new Promise(r => setTimeout(r, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/api/admin/api-keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ createdBy: 'plugin-litmus', email: '' }),
  });
  if (!created.ok) throw new Error(`api key create: ${created.status}`);
  const { apiKey } = await created.json();
  const response = await fetch(`${base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(messagesRequest),
  });
  return {
    status: response.status,
    body: await response.json(),
    calls,
    upstreamBodies,
    report: srcModule('services', 'pluginLoader.js').getLoadReport(),
  };
}

const OPS = { sync, load, request };
OPS[op]()
  .then(result => {
    process.stdout.write(`\nRESULT ${JSON.stringify({ ...result, lookups })}\n`);
    process.exit(0);
  })
  .catch(error => {
    process.stdout.write(`\nRESULT ${JSON.stringify({ driverError: String((error && error.stack) || error) })}\n`);
    process.exit(1);
  });
