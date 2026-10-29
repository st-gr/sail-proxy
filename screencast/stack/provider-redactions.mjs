// Adds the external providers' real values (Azure OpenAI, AWS Bedrock, Anthropic, OpenAI) to
// redact.extra.local.json (gitignored, mode 600) as real → mock pairs, so with-service-key.mjs merges them
// into redact.local.json. Reads the connection env files the setup scripts use; prints only mock values.
// Usage: node screencast/stack/provider-redactions.mjs            merge the pairs (idempotent)
//        node screencast/stack/provider-redactions.mjs --check <file>   exit 1 if <file> holds a real value
// Paths: SAIL_DOCS_AZURE_ENV, SAIL_DOCS_AWS_ENV, SAIL_DOCS_ANTHROPIC_ENV, SAIL_DOCS_OPENAI_ENV, SAIL_DOCS_REDACT_EXTRA;
// SAIL_DOCS_SAP_KEYS: comma-separated SAP AI Core service key files, the installation's tenant first (a, b, …).
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MASK = '••••••••';
const SECRETS = ['AZURE_OPENAI_API_KEY', 'AZURE_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

export function parseEnv(text) {
  const m = {};
  for (const line of text.split('\n')) {
    const kv = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (kv) m[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return m;
}

/** Real → mock for the provider keys present in env. AWS_REGION and BEDROCK_MODEL_ID are public and stay. */
export function providerMap(env) {
  const pairs = [];
  if (env.AZURE_OPENAI_ENDPOINT) {
    let host = '';
    try { host = new URL(env.AZURE_OPENAI_ENDPOINT).host; } catch { host = env.AZURE_OPENAI_ENDPOINT.replace(/^[a-z]+:\/\//i, '').split('/')[0]; }
    if (host) {
      pairs.push([host, 'demo-resource.openai.azure.com']);
      // The resource name (first host label) can hold a person's name, so it is masked wherever it appears.
      pairs.push([host.split('.')[0], 'demo-resource']);
    }
  }
  pairs.push([env.AZURE_OPENAI_DEPLOYMENT, 'gpt-demo']);
  pairs.push([env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT, 'embed-demo']);
  pairs.push([env.AZURE_TENANT_ID, '00000000-0000-0000-0000-000000000000']);
  pairs.push([env.AZURE_CLIENT_ID, '00000000-0000-0000-0000-000000000001']);
  pairs.push([env.AWS_ACCESS_KEY_ID, 'DEMO-ACCESS-KEY-ID']);
  for (const k of SECRETS) pairs.push([env[k], MASK]);
  return Object.fromEntries(pairs.filter(([real, mock]) => real && real !== mock));
}

/**
 * Real → mock for SAP AI Core service keys, tenant a, b, … in order. The cockpit shows a tenant as
 * `<subdomain>.<landscape>`, so the subdomain is masked wherever it appears; the regional AI API host is public.
 */
export function serviceKeyMap(keys) {
  const pairs = [];
  keys.forEach((k, i) => {
    const t = `demo-tenant-${String.fromCharCode(97 + i)}`;
    let host = '';
    try { host = new URL(k.url).host; } catch { /* no auth URL */ }
    const sub = host.split('.')[0] || k.identityzone;
    if (host) pairs.push([host, host.replace(sub, t)]);
    pairs.push([sub, t], [k.identityzone, t]);
    pairs.push([k.clientid, `sb-${t}-client`], [k.clientsecret, MASK], [k.appname, `${t}-app`]);
    pairs.push([k.identityzoneid, `00000000-0000-0000-0000-0000000000${String.fromCharCode(97 + i)}0`]);
  });
  return Object.fromEntries(pairs.filter(([real, mock]) => real && real !== mock));
}

/** Adds the pairs whose real value is not yet a key; existing entries stay as they are. Returns the added mocks. */
export function mergeInto(existing, map) {
  const out = { ...existing };
  const added = [];
  for (const [real, mock] of Object.entries(map)) if (!(real in out)) { out[real] = mock; added.push(mock); }
  return { merged: out, added };
}

/** Mock values whose real value occurs in text (case-insensitive), with the first line it occurs on. */
export function realValueHits(text, map) {
  const lower = text.toLowerCase().split('\n');
  const hits = [];
  for (const [real, mock] of Object.entries(map)) {
    const i = lower.findIndex((l) => l.includes(real.toLowerCase()));
    if (real && i >= 0) hits.push({ mock, line: i + 1 });
  }
  return hits;
}

export function defaultPaths(env = process.env, home = homedir()) {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    files: [
      env.SAIL_DOCS_AZURE_ENV || join(home, 'Documents/repos/azure-connection.env'),
      env.SAIL_DOCS_AWS_ENV || join(home, 'Documents/repos/aws-connection.env'),
      env.SAIL_DOCS_ANTHROPIC_ENV || join(home, 'Documents/repos/anthropic-connection.env'),
      env.SAIL_DOCS_OPENAI_ENV || join(home, '.config/ter-demo/openai.env')
    ],
    extra: env.SAIL_DOCS_REDACT_EXTRA || join(here, '..', 'redact.extra.local.json'),
    sapKeys: (env.SAIL_DOCS_SAP_KEYS || '').split(',').map((f) => f.trim()).filter(Boolean)
  };
}

/** Reads the env files that exist (notes name the missing ones) plus OPENAI_API_KEY from the environment. */
export function readProviderEnv(files, processEnv = process.env) {
  const env = {};
  const notes = [];
  for (const f of files) {
    if (!existsSync(f)) { notes.push(`skipped: ${f} not found`); continue; }
    Object.assign(env, parseEnv(readFileSync(f, 'utf8')));
  }
  if (processEnv.OPENAI_API_KEY) env.OPENAI_API_KEY = processEnv.OPENAI_API_KEY;
  return { env, notes };
}

function readExtra(path) {
  if (!existsSync(path)) return {};
  let extra;
  try { extra = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('redact.extra.local.json is not valid JSON'); }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('redact.extra.local.json is not a JSON object');
  return extra;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, extra: extraPath, sapKeys } = defaultPaths();
  const { env, notes } = readProviderEnv(files);
  for (const n of notes) console.error(n);
  const keys = sapKeys.filter((f) => existsSync(f) || (console.error(`skipped: ${f} not found`), false)).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const map = { ...providerMap(env), ...serviceKeyMap(keys) };
  const ci = process.argv.indexOf('--check');
  if (ci >= 0) {
    const file = process.argv[ci + 1];
    if (!file || !existsSync(file)) { console.error('usage: provider-redactions.mjs --check <text file>'); process.exit(2); }
    const hits = realValueHits(readFileSync(file, 'utf8'), map);
    for (const h of hits) console.error(`${file}:${h.line}: real value that should show "${h.mock}"`);
    if (hits.length) process.exit(1);
    console.log(`no provider value in ${file} (${Object.keys(map).length} values checked)`);
    process.exit(0);
  }
  let existing;
  try { existing = readExtra(extraPath); } catch (e) { console.error(e.message); process.exit(1); }
  const { merged, added } = mergeInto(existing, map);
  if (added.length || !existsSync(extraPath)) writeFileSync(extraPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  chmodSync(extraPath, 0o600);
  console.log(added.length ? `added ${added.length} entr${added.length === 1 ? 'y' : 'ies'} to ${extraPath}: ${added.join(', ')}` : `nothing to add to ${extraPath}`);
  console.log(`${Object.keys(map).length - added.length} already present; re-run with-service-key.mjs to refresh redact.local.json`);
}
