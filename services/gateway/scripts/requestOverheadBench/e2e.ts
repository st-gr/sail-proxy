import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import * as dotenv from 'dotenv';
import { measure, UPSTREAM_DELAY_MS } from './load';

const GATEWAY_DIR = path.resolve(__dirname, '..', '..');
const CLI_DIST = path.resolve(GATEWAY_DIR, '..', '..', 'npm-dist', 'sail-proxy', 'dist');
const MODEL = 'gpt-bench';
const OUTPUT_TAIL = 8000; // only the tail of the child's output is ever read (on a failure); keeping all of it would add noise to the timing

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

// The fake SAP AI Core: token, foundation-model list, one running deployment of an OpenAI-family
// model, and its chat completion, answered after a fixed UPSTREAM_DELAY_MS.
function startFakeSap(): Promise<http.Server> {
  const json = (res: http.ServerResponse, body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('/oauth/token')) return json(res, { access_token: 'bench-token', expires_in: 3600 });
      if (url.includes('/lm/scenarios/foundation-models/models')) {
        return json(res, { count: 1, resources: [{ model: MODEL, provider: 'openai', displayName: MODEL, executableId: 'azure-openai', allowedScenarios: [{ scenarioId: 'foundation-models', executableId: 'azure-openai' }], versions: [{ name: 'latest', isLatest: true, capabilities: ['text-generation', 'chat'], streamingSupported: true }] }] });
      }
      if (url.includes('/lm/deployments')) {
        const base = `http://${req.headers.host}/sap/v2/inference/deployments/bench1`;
        return json(res, { count: 1, resources: [{ id: 'bench1', scenarioId: 'foundation-models', status: 'RUNNING', deploymentUrl: base, configurationId: 'c1', configurationName: 'bench', details: { resources: { backendDetails: { model: { name: MODEL, version: 'latest' } } } } }] });
      }
      if (url.includes('/chat/completions')) {
        return void setTimeout(() => json(res, { id: 'chatcmpl-bench', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), UPSTREAM_DELAY_MS);
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A standalone gateway as a child process, started from source (ts-node) so that the code under
// measurement is the working tree, not a stale build. Its settings are those of `sail-proxy run`.
async function startGateway(tmp: string, sapPort: number, port: number): Promise<{ child: ChildProcess; log: () => string }> {
  const { buildGatewayEnv } = require(path.join(CLI_DIST, 'utils', 'gateway-env.js')); // eslint-disable-line @typescript-eslint/no-var-requires
  const template = JSON.parse(fs.readFileSync(path.join(CLI_DIST, 'templates', 'api_config.template.json'), 'utf8'));
  template.api_config.platform = { ...template.api_config.platform, logging: { ...template.api_config.platform?.logging, log_folder_path: path.join(tmp, 'logs') } };
  const configFile = path.join(tmp, 'api_config.json');
  fs.writeFileSync(configFile, JSON.stringify(template));
  const settings = {
    PORT: String(port), GATEWAY_STANDALONE: 'true', LOG_LEVEL: 'INFO',
    SAP_AI_CORE_URL: `http://127.0.0.1:${sapPort}/sap`, AUTH_URL: `http://127.0.0.1:${sapPort}/sap/oauth/token`,
    CLIENT_ID: 'bench-client', CLIENT_SECRET: 'bench-secret', SAP_AI_RESOURCE_GROUP: 'default', SAP_AI_REGION: 'bench',
    SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES: 'true', // the CLI's .env template sets it; deployed models need it
    RATE_LIMIT_RPM: '10000000', // the standalone gateway limits a key to 100 requests a minute by default
    VALIDATION_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'), METADATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  };
  const env = buildGatewayEnv({ PATH: process.env.PATH, HOME: tmp }, settings, configFile);
  // The plugins are loaded as .ts from source only when NODE_ENV is not production (the CLI runs compiled .js).
  env.NODE_ENV = 'development';
  // The CLI's gateway reads no services/gateway/.env, but this child runs in that folder and dotenv fills in
  // every name it holds that is unset (a developer's .env made the bench's key hit 100 requests a minute).
  // Set them empty: dotenv leaves a name alone once it exists.
  const ownEnv = path.join(GATEWAY_DIR, '.env');
  if (fs.existsSync(ownEnv)) {
    for (const name of Object.keys(dotenv.parse(fs.readFileSync(ownEnv)))) if (!(name in env)) env[name] = '';
  }
  let output = '';
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'src/index.ts'], { cwd: GATEWAY_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (c) => { output = (output + c).slice(-OUTPUT_TAIL); });
  child.stderr?.on('data', (c) => { output = (output + c).slice(-OUTPUT_TAIL); });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the gateway exited before /health answered:\n${output.slice(-3000)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok) return { child, log: () => output }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the gateway did not answer /health within 120 s:\n${output.slice(-3000)}`);
}

function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM'); // by the PID of this very child
  });
}

export async function runE2eMode(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-overhead-bench-'));
  let sap: http.Server | undefined;
  let child: ChildProcess | undefined;
  try {
    sap = await startFakeSap();
    const sapPort = (sap.address() as net.AddressInfo).port;
    const port = await freePort();
    let log = () => '';
    ({ child, log } = await startGateway(tmp, sapPort, port));
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(`${base}/api/admin/api-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ createdBy: 'request-overhead-bench', email: '' }) });
    const apiKey = (await created.json() as { apiKey?: string }).apiKey;
    if (!created.ok || !apiKey) throw new Error(`could not create an API key: ${created.status}`);
    const body = JSON.stringify({ model: `${MODEL}--deployed`, messages: [{ role: 'user', content: 'hi' }] });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    await measure('e2e', async () => {
      const r = await fetch(`${base}/openai/v1/chat/completions`, { method: 'POST', headers, body });
      const text = await r.text();
      if (r.status !== 200) throw new Error(`chat completion answered ${r.status}: ${text.slice(0, 300)}\n${log().slice(-3000)}`);
    });
  } finally {
    await stop(child);
    await new Promise((resolve) => (sap ? sap.close(resolve) : resolve(undefined)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
