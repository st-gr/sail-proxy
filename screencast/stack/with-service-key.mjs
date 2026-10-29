// Runs a command with SAP_AI_CORE_SERVICE_KEY set from a gateway .env that holds working credentials,
// so docker/setup-docker.js --ci can render the demo stack without the key ever being typed or
// stored by this toolkit. Also writes redact.local.json (mode 600, gitignored): real value → mock value,
// plus the entries of redact.extra.local.json (gitignored) when it exists.
// Usage: SAIL_DOCS_CREDENTIALS_ENV=/path/to/gateway/.env node screencast/stack/with-service-key.mjs -- <command> [args…]
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['SAP_AI_CORE_URL', 'AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET'];

function envMap(text) {
  const m = {};
  for (const line of text.split('\n')) {
    const kv = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (kv) m[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return m;
}

export function serviceKeyFromEnv(text) {
  const env = envMap(text);
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(', ')} missing from the credentials env`);
  return JSON.stringify({
    serviceurls: { AI_API_URL: env.SAP_AI_CORE_URL },
    url: env.AUTH_URL.replace(/\/oauth\/token\/?$/, ''),
    clientid: env.CLIENT_ID,
    clientsecret: env.CLIENT_SECRET
  });
}

/** Real → mock. URLs and their scheme-less hosts get their own entries; empty values never become keys. */
export function redactionMapFromEnv(text) {
  const env = envMap(text);
  const authBase = env.AUTH_URL.replace(/\/oauth\/token\/?$/, '');
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  return withoutEmptyKeys({
    [env.SAP_AI_CORE_URL]: 'https://api.ai.example.sap/v2',
    [authBase]: 'https://auth.example.sap',
    [host(env.SAP_AI_CORE_URL)]: 'api.ai.example.sap',
    [host(authBase)]: 'auth.example.sap',
    [env.CLIENT_ID]: 'sb-demo-client',
    [env.CLIENT_SECRET]: 'demo-client-secret'
  });
}

function withoutEmptyKeys(map) {
  return Object.fromEntries(Object.entries(map).filter(([k]) => k));
}

/** Merges the entries of redact.extra.local.json (they win on conflict). A parse error never quotes the file. */
export function mergeExtra(map, extraText) {
  let extra;
  try { extra = JSON.parse(extraText); } catch { throw new Error('redact.extra.local.json is not valid JSON'); }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('redact.extra.local.json is not a JSON object');
  return withoutEmptyKeys({ ...map, ...extra });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sep = process.argv.indexOf('--');
  const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
  const envPath = process.env.SAIL_DOCS_CREDENTIALS_ENV;
  if (!envPath || !cmd.length) { console.error('usage: SAIL_DOCS_CREDENTIALS_ENV=<gateway .env> node with-service-key.mjs -- <command…>'); process.exit(2); }
  const text = readFileSync(envPath, 'utf8');
  // An invalid env stops here, before a map is written.
  const serviceKey = serviceKeyFromEnv(text);
  const here = dirname(fileURLToPath(import.meta.url));
  const mapPath = join(here, '..', 'redact.local.json');
  const extraPath = join(here, '..', 'redact.extra.local.json');
  let map = redactionMapFromEnv(text);
  if (existsSync(extraPath)) {
    try { map = mergeExtra(map, readFileSync(extraPath, 'utf8')); } catch (e) { console.error(e.message); process.exit(1); }
  }
  writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
  chmodSync(mapPath, 0o600);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, SAP_AI_CORE_SERVICE_KEY: serviceKey } });
  console.error(`redaction map written to ${mapPath} (${Object.keys(map).length} entries)`);
  process.exit(r.status ?? 1);
}
