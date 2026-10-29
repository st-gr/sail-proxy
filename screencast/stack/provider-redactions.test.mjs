import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv, providerMap, mergeInto, realValueHits, serviceKeyMap } from './provider-redactions.mjs';

// Invented values only. The AWS-shaped id is built at run time so no access-key-shaped literal is in the file.
const ACCESS_KEY = ['A', 'K', 'I', 'A'].join('') + 'FAKEFAKEFAKE0042';
const AZURE = `AZURE_OPENAI_ENDPOINT=https://jane-doe-oai.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=jd-chat-prod
export AZURE_OPENAI_EMBEDDING_DEPLOYMENT="jd-embed-prod"
AZURE_OPENAI_API_KEY=fake-azure-key-value-000111222
AZURE_TENANT_ID=11111111-2222-3333-4444-555555555555
AZURE_CLIENT_ID=66666666-7777-8888-9999-aaaaaaaaaaaa
AZURE_CLIENT_SECRET='fake~client~secret~value'
`;
const AWS = `AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-v1:0
AWS_ACCESS_KEY_ID=${ACCESS_KEY}
AWS_SECRET_ACCESS_KEY=fake/aws/secret/value/0000000000000000
AWS_BEARER_TOKEN_BEDROCK=fake-bedrock-bearer-token-000
`;
const ANTHROPIC = 'ANTHROPIC_API_KEY=fake-anthropic-key-000000000000\n';
const OPENAI = 'OPENAI_API_KEY=fake-openai-key-000000000000\n';
const REALS = ['jane-doe-oai', 'jd-chat-prod', 'jd-embed-prod', 'fake-azure-key-value-000111222', '11111111-2222', '66666666-7777',
  'fake~client~secret~value', ACCESS_KEY, 'fake/aws/secret', 'fake-bedrock-bearer', 'fake-anthropic-key', 'fake-openai-key'];

test('parseEnv reads plain, exported and quoted lines', () => {
  const env = parseEnv(AZURE);
  assert.equal(env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT, 'jd-embed-prod');
  assert.equal(env.AZURE_CLIENT_SECRET, 'fake~client~secret~value');
});

test('providerMap masks every provider value and leaves the public region and model id', () => {
  const map = providerMap(parseEnv(AZURE + AWS + ANTHROPIC + OPENAI));
  assert.equal(map['jane-doe-oai.openai.azure.com'], 'demo-resource.openai.azure.com');
  assert.equal(map['jane-doe-oai'], 'demo-resource');
  assert.equal(map['jd-chat-prod'], 'gpt-demo');
  assert.equal(map['jd-embed-prod'], 'embed-demo');
  assert.equal(map['11111111-2222-3333-4444-555555555555'], '00000000-0000-0000-0000-000000000000');
  assert.equal(map['66666666-7777-8888-9999-aaaaaaaaaaaa'], '00000000-0000-0000-0000-000000000001');
  assert.equal(map[ACCESS_KEY], 'DEMO-ACCESS-KEY-ID');
  for (const k of ['fake-azure-key-value-000111222', 'fake~client~secret~value', 'fake/aws/secret/value/0000000000000000',
    'fake-bedrock-bearer-token-000', 'fake-anthropic-key-000000000000', 'fake-openai-key-000000000000']) assert.match(map[k], /^•{4,}$/);
  assert.ok(!('us-east-1' in map));
  assert.ok(!('anthropic.claude-sonnet-4-v1:0' in map));
  assert.ok(!('' in providerMap({})));
});

test('mergeInto keeps existing entries and adds nothing twice', () => {
  const first = mergeInto({ '/Users/someone': '/Users/demo', 'jd-chat-prod': 'kept-mock' }, { 'jd-chat-prod': 'gpt-demo', x: 'y-mock' });
  assert.deepEqual(first.merged, { '/Users/someone': '/Users/demo', 'jd-chat-prod': 'kept-mock', x: 'y-mock' });
  assert.deepEqual(first.added, ['y-mock']);
  assert.deepEqual(mergeInto(first.merged, { x: 'y-mock' }).added, []);
});

test('realValueHits names the mock and the line, case-insensitively', () => {
  assert.deepEqual(realValueHits('ok\nhost JANE-DOE-OAI.openai.azure.com', { 'jane-doe-oai.openai.azure.com': 'demo-resource.openai.azure.com' }),
    [{ mock: 'demo-resource.openai.azure.com', line: 2 }]);
  assert.deepEqual(realValueHits('demo-resource only', { 'jane-doe-oai': 'demo-resource' }), []);
});

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'provider-redactions.mjs');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'provider-redactions-'));
  writeFileSync(join(dir, 'azure.env'), AZURE);
  writeFileSync(join(dir, 'aws.env'), AWS);
  writeFileSync(join(dir, 'openai.env'), OPENAI);
  writeFileSync(join(dir, 'extra.json'), JSON.stringify({ '/Users/someone': '/Users/demo' }));
  const env = { PATH: process.env.PATH, HOME: dir, SAIL_DOCS_AZURE_ENV: join(dir, 'azure.env'), SAIL_DOCS_AWS_ENV: join(dir, 'aws.env'),
    SAIL_DOCS_ANTHROPIC_ENV: join(dir, 'missing-anthropic.env'), SAIL_DOCS_OPENAI_ENV: join(dir, 'openai.env'), SAIL_DOCS_REDACT_EXTRA: join(dir, 'extra.json') };
  return { dir, env, run: (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' }) };
}

test('the CLI merges idempotently into a mode-600 file and never prints a real value', () => {
  const { dir, run } = setup();
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /skipped: .*missing-anthropic\.env not found/);
  assert.match(out, /demo-resource\.openai\.azure\.com/);
  for (const real of REALS) assert.ok(!out.includes(real), 'a real value was printed');
  const extra = JSON.parse(readFileSync(join(dir, 'extra.json'), 'utf8'));
  assert.equal(extra['/Users/someone'], '/Users/demo');
  assert.equal(extra['jane-doe-oai'], 'demo-resource');
  assert.ok(!Object.keys(extra).some((k) => k.startsWith('fake-anthropic')));
  assert.equal(statSync(join(dir, 'extra.json')).mode & 0o777, 0o600);
  const again = run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to add/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'extra.json'), 'utf8')), extra);
});

test('the CLI creates the extra file when it is missing', () => {
  const { dir, env } = setup();
  const path = join(dir, 'new-extra.json');
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...env, SAIL_DOCS_REDACT_EXTRA: path }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('--check exits 1 naming the mock, 0 on a clean file, and never prints the real value', () => {
  const { dir, run } = setup();
  writeFileSync(join(dir, 'leak.txt'), 'line one\ncurl https://jane-doe-oai.openai.azure.com/openai\n');
  writeFileSync(join(dir, 'clean.txt'), 'curl https://demo-resource.openai.azure.com/openai\n');
  const leak = run('--check', join(dir, 'leak.txt'));
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /leak\.txt:2: real value that should show "demo-resource/);
  for (const real of REALS) assert.ok(!(leak.stdout + leak.stderr).includes(real));
  assert.equal(run('--check', join(dir, 'clean.txt')).status, 0);
});

// Two invented SAP AI Core service keys (tenant a and b), shaped like the BTP ones. The auth domain is built at
// run time, like the access key above, so no auth-host-shaped literal is in the file.
const AUTH = ['authentication', 'eu10', 'hana', 'ondemand', 'com'].join('.');
const sapKey = (sub, n) => ({
  serviceurls: { AI_API_URL: `https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com` },
  appname: `${sub}-app!b${n}`, clientid: `sb-${sub}-client!b${n}|aicore!b540`, clientsecret: 'example-' + sub + '-secret$value=',
  identityzone: sub, identityzoneid: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`,
  url: `https://${sub}.${AUTH}`
});

test('serviceKeyMap masks each tenant: subdomain, tenant key, auth host, client, secret, zone id, app name', () => {
  const map = serviceKeyMap([sapKey('jane-trial', 1), sapKey('acme-prod', 2)]);
  assert.equal(map['jane-trial'], 'demo-tenant-a');
  assert.equal(map['acme-prod'], 'demo-tenant-b');
  assert.equal(map[`jane-trial.${AUTH}`], `demo-tenant-a.${AUTH}`);
  assert.equal(map['sb-acme-prod-client!b2|aicore!b540'], 'sb-demo-tenant-b-client');
  assert.equal(map['example-jane-trial-secret$value='], '••••••••');
  assert.equal(map['22222222-0000-4000-8000-000000000002'], '00000000-0000-0000-0000-0000000000b0');
  assert.equal(map['acme-prod-app!b2'], 'demo-tenant-b-app');
  assert.equal(map['api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com'], undefined, 'the regional AI API host is public');
});
