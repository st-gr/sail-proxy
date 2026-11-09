#!/usr/bin/env node
// `sail-proxy connection` end to end: the built CLI writes connections.json in a temp config dir, the
// standalone gateway serves the connection's model from a loopback fake OpenAI server, the secret
// stays an env reference and never shows in the file, the CLI output or the gateway log.
// Prerequisites: `npm run build:local`, and a gateway build that has the connections file backend:
// `npm run bundle` (bundled/ wins when present, as in `sail-proxy run`), else services/gateway's
// `pnpm run build`. Everything binds 127.0.0.1 on ports picked by the OS.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const net = require('net'); const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { buildGatewayEnv } = require(path.resolve(__dirname, '..', 'dist', 'utils', 'gateway-env.js'));
const { getGatewayPath, getGatewayCwd } = require(path.resolve(__dirname, '..', 'dist', 'utils', 'paths.js'));

const CLI = path.resolve(__dirname, '..', 'bin', 'sail-proxy');
const FAKE_KEY = `fk-${crypto.randomBytes(12).toString('hex')}`;
const INLINE_SECRET = `sk-inline-${crypto.randomBytes(12).toString('hex')}`;
const TTY_SECRET = `sk-tty-${crypto.randomBytes(12).toString('hex')}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-conn-e2e-'));
const home = path.join(tmp, 'home'); const cfg = path.join(tmp, 'cfg');
fs.mkdirSync(home); fs.mkdirSync(cfg);
const connectionsFile = path.join(cfg, 'connections.json');
const transcript = []; // every CLI stdout/stderr and the gateway log, scanned for the secrets at the end
let f = 0;
async function check(name, fn) { try { await fn(); console.log('ok - ' + name); } catch (e) { f++; console.error('not ok - ' + name + '\n  ' + e.message); } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// The fake OpenAI upstream: /v1/models, /v1/chat/completions (JSON or SSE); /sap/* is the SAP AI
// Core stand-in and refuses everything, so the SAP side fails fast and never reaches the internet.
const seen = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/sap')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-x', object: 'model' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}');
      const base = { id: 'chatcmpl-fake', created: 1, model: parsed.model };
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello from fake' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hello from fake' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } }));
    }
    res.writeHead(404); res.end();
  });
});

const cliEnv = () => ({ PATH: process.env.PATH, HOME: home, SAIL_PROXY_CONFIG_DIR: cfg, NO_COLOR: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });
function cli(args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: cliEnv(), timeout: 30000 }, (err, stdout, stderr) => {
      transcript.push(stdout, stderr);
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}
const show = (r) => `exit ${r.code}\n  stdout: ${r.stdout}\n  stderr: ${r.stderr}`;

// The CLI on a pseudo-terminal (Python's pty module, which takes a piped stdin on macOS and Linux),
// answering a prompt once it shows: input sent earlier would be echoed before the prompt hides it.
// null where python3 is missing, and on Windows (Python's pty needs termios, which Windows lacks).
function cliOnTty(args, answer, promptPattern) {
  if (process.platform === 'win32') return Promise.resolve(null);
  const cmd = ['python3', ['-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)', process.execPath, CLI, ...args]];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd[1], { env: { ...cliEnv(), TERM: 'xterm' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let answered = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const onData = (c) => {
      out += c;
      if (!answered && promptPattern.test(out)) { answered = true; child.stdin.write(`${answer}\r`); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); transcript.push(out); child.stdin.destroy(); resolve({ code: code ?? 1, stdout: out, stderr: '' }); });
  });
}

let gateway = null; let gatewayLog = '';
async function startGateway(port, fakePort) {
  const settings = {
    PORT: String(port), GATEWAY_STANDALONE: 'true', LOG_LEVEL: 'DEBUG',
    SAP_AI_CORE_URL: `http://127.0.0.1:${fakePort}/sap`, AUTH_URL: `http://127.0.0.1:${fakePort}/sap/oauth/token`,
    CLIENT_ID: 'e2e-client', CLIENT_SECRET: 'e2e-client-secret', SAP_AI_RESOURCE_GROUP: 'default', SAP_AI_REGION: 'e2e',
    VALIDATION_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'), METADATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  };
  fs.writeFileSync(path.join(cfg, '.env'), Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  // FAKE_KEY comes from the shell, as a user would export it; the .env holds no secret of the file.
  const env = buildGatewayEnv({ ...cliEnv(), FAKE_KEY }, settings, path.join(cfg, 'api_config.json'));
  gatewayLog = '';
  gateway = spawn(process.execPath, [getGatewayPath()], { cwd: getGatewayCwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  gateway.stdout.on('data', (c) => { gatewayLog += c; }); gateway.stderr.on('data', (c) => { gatewayLog += c; });
  let exited = null; gateway.on('exit', (code) => { exited = code; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (exited !== null) throw Object.assign(new Error(`the gateway exited (${exited}) before /health answered:\n${gatewayLog.slice(-3000)}`), { portTaken: gatewayLog.includes('EADDRINUSE') });
    try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the gateway did not answer /health within 60 s:\n${gatewayLog.slice(-3000)}`);
}
function stopGateway() {
  // Ended by a signal counts as stopped: on Windows kill() ends the process at once (exitCode stays
  // null, signalCode is set), and waiting for an exit that already happened hung the run.
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => gateway.kill('SIGKILL'), 5000);
    gateway.on('exit', () => { clearTimeout(kill); resolve(); });
    gateway.kill('SIGTERM');
  });
}

async function main() {
  if (!fs.existsSync(getGatewayPath())) throw new Error(`${getGatewayPath()} is missing; run "npm run bundle" (or build services/gateway) first`);
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = fake.address().port;
  let port = await freePort();
  fs.copyFileSync(path.resolve(__dirname, '..', 'dist', 'templates', 'api_config.template.json'), path.join(cfg, 'api_config.json'));
  fs.writeFileSync(path.join(cfg, '.env'), `PORT=${port}\nGATEWAY_STANDALONE=true\n`);
  const chat = (key, model, stream) => fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

  await check('connection add with --secret-env stores an env reference (no server running)', async () => {
    const r = await cli(['connection', 'add', 'fake', '--type', 'openai', '--base-url', `http://127.0.0.1:${fakePort}/v1`, '--secret-env', 'FAKE_KEY']);
    assert.strictEqual(r.code, 0, show(r));
    const conn = JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections[0];
    assert.deepStrictEqual(conn, { name: 'fake', type: 'openai', active: true, settings: { baseUrl: `http://127.0.0.1:${fakePort}/v1` }, secret: { env: 'FAKE_KEY' } });
    // FAKE_KEY is in neither the CLI's env nor the config dir's .env: the user is told to set it.
    assert.match(r.stdout, /FAKE_KEY is not set/, show(r));
  });
  await check('--secret-env naming a variable of the config dir .env prints no hint', async () => {
    fs.appendFileSync(path.join(cfg, '.env'), 'DOTENV_KEY=from-dotenv\n');
    const r = await cli(['connection', 'add', 'dotenv', '--type', 'openai', '--secret-env', 'DOTENV_KEY']);
    assert.strictEqual(r.code, 0, show(r));
    assert.ok(!/is not set/.test(r.stdout + r.stderr), show(r));
    assert.strictEqual((await cli(['connection', 'remove', 'dotenv'])).code, 0);
  });
  await check('a per-type rule is refused by flag before any secret is read (azure-openai needs --endpoint)', async () => {
    const r = await cli(['connection', 'add', 'az', '--type', 'azure-openai', '--secret-env', 'AZ_KEY']);
    assert.notStrictEqual(r.code, 0, show(r));
    assert.match(r.stderr, /--endpoint/);
    assert.ok(!JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections.some((c) => c.name === 'az'));
  });
  await check('a base URL over plain http to a remote host is refused, without echoing it', async () => {
    const r = await cli(['connection', 'add', 'plain', '--type', 'openai', '--base-url', 'http://api.example.com/v1', '--secret-env', 'PLAIN_KEY']);
    assert.notStrictEqual(r.code, 0, show(r));
    assert.match(r.stderr, /--base-url .*https/);
    assert.ok(!(r.stdout + r.stderr).includes('api.example.com'), show(r));
  });
  await check('connection model add prints the model id to use', async () => {
    const r = await cli(['connection', 'model', 'add', 'fake', 'gpt-x']);
    assert.strictEqual(r.code, 0, show(r));
    assert.match(r.stdout, /gpt-x--fake/);
  });
  await check('model add stores --family, --display-name and --capabilities', async () => {
    const r = await cli(['connection', 'model', 'add', 'fake', 'gpt-v', '--family', 'claude', '--display-name', 'GPT V', '--capabilities', 'chat, streaming']);
    assert.strictEqual(r.code, 0, show(r));
    const m = JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections[0].models.find((x) => x.upstreamModel === 'gpt-v');
    assert.deepStrictEqual(m, { upstreamModel: 'gpt-v', family: 'claude', displayName: 'GPT V', capabilities: ['chat', 'streaming'] });
  });
  await check('model remove withdraws the model; an unknown one exits 1', async () => {
    let r = await cli(['connection', 'model', 'remove', 'fake', 'gpt-v']);
    assert.strictEqual(r.code, 0, show(r));
    assert.ok(!JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections[0].models.some((x) => x.upstreamModel === 'gpt-v'));
    r = await cli(['connection', 'model', 'remove', 'fake', 'gpt-v']);
    assert.strictEqual(r.code, 1, show(r));
    assert.match(r.stderr, /Unknown model "gpt-v"/);
  });
  await check('remove of an unknown connection exits 1', async () => {
    const r = await cli(['connection', 'remove', 'nope']);
    assert.strictEqual(r.code, 1, show(r));
    assert.match(r.stderr, /Unknown connection "nope"/);
  });
  if (process.platform !== 'win32') await check('connections.json is 0600', () => assert.strictEqual(fs.statSync(connectionsFile).mode & 0o777, 0o600));
  await check('connections.json holds no secret value', () => assert.ok(!fs.readFileSync(connectionsFile, 'utf8').includes(FAKE_KEY)));
  await check('a flag of another type is refused by name, before any secret is read', async () => {
    const r = await cli(['connection', 'add', 'wrong', '--type', 'openai', '--region', 'us-east-1']);
    assert.notStrictEqual(r.code, 0, show(r));
    assert.match(r.stderr, /--region/);
  });
  await check('a key pasted as --secret-env is refused, not written and not echoed', async () => {
    const before = fs.readFileSync(connectionsFile, 'utf8');
    const r = await cli(['connection', 'add', 'pasted', '--type', 'openai', '--secret-env', 'sk-not-a-name']);
    assert.notStrictEqual(r.code, 0, show(r));
    assert.strictEqual(fs.readFileSync(connectionsFile, 'utf8'), before);
    assert.ok(!(r.stdout + r.stderr).includes('sk-not-a-name'), show(r));
    assert.match(r.stderr, /--secret-env must name an environment variable/);
  });
  await check('an inline secret is read from stdin when not a TTY, stored, and never printed', async () => {
    const r = await cli(['connection', 'add', 'other', '--type', 'anthropic', '--inactive'], `${INLINE_SECRET}\n`);
    assert.strictEqual(r.code, 0, show(r));
    const conn = JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections.find((c) => c.name === 'other');
    assert.strictEqual(conn.secret, INLINE_SECRET);
    assert.strictEqual(conn.active, false);
    assert.match(r.stderr, /Reading the secret from standard input/, show(r));
  });
  await check('on a terminal the secret is read by a hidden prompt, stored, and never shown', async () => {
    const r = await cliOnTty(['connection', 'add', 'tty', '--type', 'openai', '--inactive'], TTY_SECRET, /Secret for tty/);
    if (r === null) return console.log('# skipped: no pseudo-terminal here (python3 missing, or Windows)');
    assert.strictEqual(r.code, 0, show(r));
    const conn = JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections.find((c) => c.name === 'tty');
    assert.strictEqual(conn && conn.secret, TTY_SECRET);
    assert.ok(!r.stdout.includes(TTY_SECRET), 'the secret was shown on the terminal');
    assert.strictEqual((await cli(['connection', 'remove', 'tty'])).code, 0);
  });
  await check('connection add without --secret-env and an empty stdin is refused', async () => {
    const r = await cli(['connection', 'add', 'empty', '--type', 'openai']);
    assert.notStrictEqual(r.code, 0, show(r));
    assert.ok(!JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections.some((c) => c.name === 'empty'));
  });
  await check('connection list shows name, type, state, secret kind and model ids, never a value', async () => {
    const r = await cli(['connection', 'list']);
    assert.strictEqual(r.code, 0, show(r));
    for (const s of ['fake', 'openai', 'env:FAKE_KEY', 'gpt-x--fake', 'other', 'anthropic', 'stored', 'inactive']) assert.ok(r.stdout.includes(s), `missing ${s}:\n${r.stdout}`);
  });
  await check('connection remove other', async () => { const r = await cli(['connection', 'remove', 'other']); assert.strictEqual(r.code, 0, show(r)); });
  await check('a second connection keeps the model list non-empty after fake goes', async () => {
    let r = await cli(['connection', 'add', 'keep', '--type', 'openai', '--base-url', `http://127.0.0.1:${fakePort}/v1`, '--secret-env', 'FAKE_KEY']);
    assert.strictEqual(r.code, 0, show(r));
    r = await cli(['connection', 'model', 'add', 'keep', 'gpt-y', '--capabilities', 'chat,streaming']);
    assert.strictEqual(r.code, 0, show(r));
  });

  try {
    // freePort only proposes a port; another process can take it before the gateway binds: try another.
    for (let attempt = 1; ; attempt++) {
      try { await startGateway(port, fakePort); break; } catch (e) {
        if (!e.portTaken || attempt === 3) throw e;
        port = await freePort();
      }
    }
    const created = await fetch(`http://127.0.0.1:${port}/api/admin/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ createdBy: 'connection-e2e', email: '' }),
    });
    assert.ok(created.ok, `api key create: ${created.status}`);
    const apiKey = (await created.json()).apiKey;
    assert.ok(apiKey, 'no api key returned');

    await check('GET /v1/models lists gpt-x--fake', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      assert.strictEqual(r.status, 200);
      assert.ok((await r.json()).data.some((m) => m.id === 'gpt-x--fake'));
    });
    await check('a chat completion is answered by the fake with the upstream model and the env secret', async () => {
      const before = seen.length;
      const r = await chat(apiKey, 'gpt-x--fake', false);
      const text = await r.text();
      assert.strictEqual(r.status, 200, text);
      assert.strictEqual(JSON.parse(text).choices[0].message.content, 'hello from fake');
      const call = seen.slice(before).find((s) => s.url === '/v1/chat/completions');
      assert.ok(call, 'the fake saw no chat request');
      assert.strictEqual(JSON.parse(call.body).model, 'gpt-x');
      assert.strictEqual(call.auth, `Bearer ${FAKE_KEY}`);
    });
    await check('a streamed chat completion is answered by the fake', async () => {
      const before = seen.length;
      const r = await chat(apiKey, 'gpt-x--fake', true);
      const text = await r.text();
      assert.strictEqual(r.status, 200, text);
      assert.match(text, /hello from fake/);
      const call = seen.slice(before).find((s) => s.url === '/v1/chat/completions');
      assert.ok(call && JSON.parse(call.body).stream === true && JSON.parse(call.body).model === 'gpt-x', 'the fake saw no streamed request for gpt-x');
      assert.strictEqual(call.auth, `Bearer ${FAKE_KEY}`);
    });
    await check('connection test fake prints ok', async () => {
      const r = await cli(['connection', 'test', 'fake']);
      assert.strictEqual(r.code, 0, show(r));
      assert.match(r.stdout, /\bok\b/i);
    });
    await check('connection models fake lists the upstream models', async () => {
      const r = await cli(['connection', 'models', 'fake']);
      assert.strictEqual(r.code, 0, show(r));
      assert.match(r.stdout, /gpt-x/);
    });
    await check('connection test of an unknown connection exits 1', async () => {
      const r = await cli(['connection', 'test', 'nope']);
      assert.strictEqual(r.code, 1, show(r));
    });
    await check('model remove takes the model off the running gateway', async () => {
      let r = await cli(['connection', 'model', 'add', 'keep', 'gpt-w']);
      assert.strictEqual(r.code, 0, show(r));
      r = await cli(['connection', 'model', 'remove', 'keep', 'gpt-w']);
      assert.strictEqual(r.code, 0, show(r));
      assert.match(r.stdout, /Gateway reloaded/);
      const ids = (await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } })).json()).data.map((m) => m.id);
      assert.ok(ids.includes('gpt-y--keep') && !ids.includes('gpt-w--keep'), `listed: ${ids.join(', ')}`);
    });
    await check('after connection remove the id is gone, its chat fails and the fake sees nothing', async () => {
      const r = await cli(['connection', 'remove', 'fake']);
      assert.strictEqual(r.code, 0, show(r));
      assert.match(r.stdout, /Gateway reloaded: 1 connection/);
      assert.match(r.stdout, /Model ids withdrawn:\s+gpt-x--fake/);
      const list = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      assert.strictEqual(list.status, 200);
      const ids = (await list.json()).data.map((m) => m.id);
      assert.ok(ids.includes('gpt-y--keep') && !ids.includes('gpt-x--fake'), `listed: ${ids.join(', ')}`);
      const before = seen.length;
      const c = await chat(apiKey, 'gpt-x--fake', false);
      await c.text();
      assert.ok(c.status >= 400, `chat answered ${c.status}`);
      assert.strictEqual(seen.length, before, 'the fake received a request');
    });
  } finally {
    await stopGateway();
  }
  await check('connection test with the gateway down says so and exits 1', async () => {
    const r = await cli(['connection', 'test', 'fake']);
    assert.strictEqual(r.code, 1, show(r));
    assert.match(r.stderr + r.stdout, /not running/);
  });
  await check('a gateway that answers but refuses the reload is reported', async () => {
    const stub = http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 403, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await new Promise((r) => stub.listen(port, '127.0.0.1', r));
    try {
      const r = await cli(['connection', 'model', 'add', 'keep', 'gpt-z']);
      assert.strictEqual(r.code, 0, show(r));
      assert.match(r.stdout, /Gateway did not reload \(status 403\)/);
    } finally { await new Promise((r) => stub.close(r)); }
  });
  await check('a gateway that drops the reload request is reported, and the change stays', async () => {
    const stub = http.createServer((req, res) => { if (req.url === '/health') { res.writeHead(200); res.end('{}'); } else req.socket.destroy(); });
    await new Promise((r) => stub.listen(port, '127.0.0.1', r));
    try {
      const r = await cli(['connection', 'model', 'add', 'keep', 'gpt-u']);
      assert.strictEqual(r.code, 0, show(r));
      assert.match(r.stdout, /Gateway did not reload \(no answer\)/);
      assert.ok(JSON.parse(fs.readFileSync(connectionsFile, 'utf8')).connections.find((c) => c.name === 'keep').models.some((m) => m.upstreamModel === 'gpt-u'));
    } finally { await new Promise((r) => stub.close(r)); }
  });
  await check('a hand-broken entry is reported by its path, not as a flag of the new connection', async () => {
    const good = fs.readFileSync(connectionsFile, 'utf8');
    const doc = JSON.parse(good);
    doc.connections.push({ name: 'hand', type: 'bedrock', secret: 'k' }); // no region
    fs.writeFileSync(connectionsFile, JSON.stringify(doc));
    try {
      const r = await cli(['connection', 'add', 'next', '--type', 'openai', '--secret-env', 'NEXT_KEY']);
      assert.notStrictEqual(r.code, 0, show(r));
      assert.match(r.stderr, new RegExp(`connections\\[${doc.connections.length - 1}\\]\\.settings\\.region`), show(r));
      assert.ok(!r.stderr.includes('--region'), show(r));
    } finally { fs.writeFileSync(connectionsFile, good, { mode: 0o600 }); }
  });
  await check('no secret value in the CLI output or the gateway log', () => {
    const all = transcript.join('\n') + gatewayLog;
    assert.ok(!all.includes(FAKE_KEY), 'FAKE_KEY value leaked');
    assert.ok(!all.includes(INLINE_SECRET), 'inline secret leaked');
    assert.ok(!all.includes(TTY_SECRET), 'prompted secret leaked');
  });
}

main()
  .catch((e) => { f++; console.error('not ok - ' + e.message); })
  .finally(async () => {
    await stopGateway();
    fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(f ? 1 : 0);
  });
