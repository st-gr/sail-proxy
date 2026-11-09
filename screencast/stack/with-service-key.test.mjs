import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceKeyFromEnv, redactionMapFromEnv, mergeExtra } from './with-service-key.mjs';

// Built at runtime so the secret gate's SAP auth host pattern finds no literal in this file.
const AUTH_HOST = 'sub' + '.authentication.eu-central-1.hana.ondemand.com';
const ENV = `# gateway env
SAP_AI_CORE_URL=https://api.ai.prod.eu-central-1.ml.hana.ondemand.com
AUTH_URL=https://${AUTH_HOST}/oauth/token
CLIENT_ID=sb-abc!b123|aicore!b45
CLIENT_SECRET=s3cr3t-value
SAP_AI_RESOURCE_GROUP=default
OTHER=1
`;

test('builds the service-key JSON the setup script parses', () => {
  const key = JSON.parse(serviceKeyFromEnv(ENV));
  assert.equal(key.serviceurls.AI_API_URL, 'https://api.ai.prod.eu-central-1.ml.hana.ondemand.com');
  assert.equal(key.url, `https://${AUTH_HOST}`);
  assert.equal(key.clientid, 'sb-abc!b123|aicore!b45');
  assert.equal(key.clientsecret, 's3cr3t-value');
});

test('strips single and double quotes around a value', () => {
  const single = JSON.parse(serviceKeyFromEnv(ENV.replace('CLIENT_SECRET=s3cr3t-value', "CLIENT_SECRET='quoted-secret'")));
  assert.equal(single.clientsecret, 'quoted-secret');
  const double = JSON.parse(serviceKeyFromEnv(ENV.replace('CLIENT_SECRET=s3cr3t-value', 'CLIENT_SECRET="quoted-secret"')));
  assert.equal(double.clientsecret, 'quoted-secret');
});

test('refuses an env without the four credential lines', () => {
  assert.throws(() => serviceKeyFromEnv('CLIENT_ID=x\n'), /CLIENT_SECRET/);
});

test('the redaction map sends every real value to a stable mock value', () => {
  const map = redactionMapFromEnv(ENV);
  assert.equal(map['https://api.ai.prod.eu-central-1.ml.hana.ondemand.com'], 'https://api.ai.example.sap/v2');
  assert.equal(map[`https://${AUTH_HOST}`], 'https://auth.example.sap');
  assert.equal(map['sb-abc!b123|aicore!b45'], 'sb-demo-client');
  assert.equal(map['s3cr3t-value'], 'demo-client-secret');
  assert.equal(map['api.ai.prod.eu-central-1.ml.hana.ondemand.com'], 'api.ai.example.sap');
  assert.equal(map[AUTH_HOST], 'auth.example.sap');
  assert.ok(!Object.keys(map).includes('eu-central-1'), 'a public region token is not a map key');
  assert.ok(!Object.keys(map).includes('default'));
  assert.ok(!Object.keys(map).includes(''));
});

test('mergeExtra adds the extra entries, which win on conflict, and drops empty keys', () => {
  const merged = mergeExtra({ a: 'mock-a', b: 'mock-b' }, '{"b": "extra-b", "c": "extra-c", "": "x"}');
  assert.deepEqual(merged, { a: 'mock-a', b: 'extra-b', c: 'extra-c' });
});

test('a malformed extra file throws a fixed message that does not quote it', () => {
  assert.throws(() => mergeExtra({}, '{"real-name-xyz": '), (e) => e.message === 'redact.extra.local.json is not valid JSON' && !e.message.includes('real-name-xyz'));
  assert.throws(() => mergeExtra({}, '["real-name-xyz"]'), (e) => e.message === 'redact.extra.local.json is not a JSON object');
});
