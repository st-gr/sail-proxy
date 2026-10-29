import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, loadMap } from './check.js';

// The join keeps the commit guard's access-key pattern out of the source.
const ACCESS_KEY_ID = 'AKIA' + 'TESTKEY000000001';

test('reports real values, key patterns, foreign emails, hosts and IPs with file and line', () => {
  const files = { 'a.md': 'ok line\nkey sk-ant-abc\nmail someone@corp-mail.io\nmocked admin@test.com and a@example.org\n', 'b.cast': 'host x.c-9f.kyma.ondemand.com\nip 10.0.0.5\nip 203.0.113.7\n' + ACCESS_KEY_ID + '\nfield "clientsecret": "<your secret>"\nclientsecret=ab12cd34ef56gh78ij90kl' };
  const hits = scan(Object.keys(files), { map: { 'real-secret': 'x' }, readFile: (f) => files[f] });
  const lines = hits.map((h) => `${h.file}:${h.line}:${h.pattern}`);
  assert.ok(lines.includes('a.md:2:anthropic key')); assert.ok(lines.includes('a.md:3:non-example email'));
  assert.ok(!lines.some((l) => l.startsWith('a.md:4')), 'test.com and example.org are allowed documentation domains');
  assert.ok(lines.includes('b.cast:1:kyma host')); assert.ok(lines.includes('b.cast:2:ip address')); assert.ok(lines.includes('b.cast:4:aws access key id'));
  assert.ok(!lines.some((l) => l.startsWith('b.cast:3')), '203.0.113.7 is the documentation range');
  assert.ok(!lines.some((l) => l.startsWith('b.cast:5')), 'the field name with a placeholder is not a secret');
  assert.ok(lines.includes('b.cast:6:client secret value'));
});

test('a real value from the map is a hit even inside a longer token', () => {
  const hits = scan(['c.md'], { map: { 'sb-abc!b123|aicore!b45': 'sb-demo' }, readFile: () => 'id=sb-abc!b123|aicore!b45;' });
  assert.equal(hits[0].pattern, 'redaction map value');
});

test('the unspecified address 0.0.0.0 is not an ip hit, a private address is', () => {
  const lines = { ok: 'bind 0.0.0.0', bad: 'bind 10.0.0.5' };
  const hits = scan(Object.keys(lines), { readFile: (f) => lines[f] });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.pattern}`), ['bad:ip address']);
});

test('placeholder client secrets are not hits, a random value is', () => {
  const src = { ph: '"clientsecret": "your-client-secret"', env: 'clientsecret=${CLIENT_SECRET_VALUE_X}', ex: 'clientsecret: Example-secret-value-1', code: 'clientsecret: env.CLIENT_SECRET', proc: 'clientsecret: process.env.CLIENT_SECRET', rnd: '"clientsecret": "Zq8Lm3Xv9Tb2Kd7Pw4Rn6A"' };
  const hits = scan(Object.keys(src), { readFile: (f) => src[f] });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.pattern}`), ['rnd:client secret value']);
});

test('a malformed map throws without echoing its content', () => {
  assert.throws(() => loadMap('{"real-value-xyz": '), (e) => e.message === 'redact.local.json is not valid JSON' && !e.message.includes('real-value-xyz'));
  assert.deepEqual(loadMap('{"a":"b"}'), { a: 'b' });
});

test('a SAP deployment id is a hit; a 16-digit number and the documented example are not', () => {
  const src = { dep: 'deployment a1b2c3d4e5f60718', num: 'card 4111111111111111', doc: '"key": "sk-1234567890abcdef"' };
  const hits = scan(Object.keys(src), { readFile: (f) => src[f] });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.pattern}`), ['dep:sap deployment id']);
});

test('a SAP auth host is a hit; the documented placeholder is not', () => {
  const src = { real: 'AUTH_URL=https://sub-x1.authentication.eu10.hana.ondemand.com/oauth/token', doc: 'https://<subdomain>.authentication.<region>.hana.ondemand.com' };
  const hits = scan(Object.keys(src), { readFile: (f) => src[f] });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.pattern}`), ['real:sap auth host']);
});

test('a key value is a hit; the demo key and the documented example are not', () => {
  const live = 'sk-' + 'live' + '0123456789abcdefghijklmn';
  const src = { live: `Bearer ${live}`, demo: 'Bearer sk-demo-00000000000000000000', doc: 'sk-demo-your-key', ex: 'sk-1234567890abcdef' };
  const hits = scan(Object.keys(src), { readFile: (f) => src[f] });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.pattern}`), ['live:api key']);
});

test('the placeholder cluster host is not a finding; a real one is', () => {
  const files = { 'a.md': 'see https://sail-proxy-test.c-abc123.kyma.ondemand.com', 'b.md': 'see https://x.c-0123abc.kyma.ondemand.com' };
  const hits = scan(Object.keys(files), { readFile: (f) => files[f] });
  assert.deepEqual(hits.map((h) => `${h.file} ${h.pattern}`), ['b.md kyma host']);
});
