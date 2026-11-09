import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMap, overlaySource, API_KEY, redactionMisses, pageText } from './redact.mjs';
import { scan } from '../check.js';

test('applyMap replaces every occurrence, longest key first', () => {
  const map = { 'https://api.ai.prod.eu-central-1.ml.hana.ondemand.com': 'https://api.ai.example.sap/v2', 'eu-central-1': 'example-region' };
  assert.equal(applyMap('url https://api.ai.prod.eu-central-1.ml.hana.ondemand.com/v2 region eu-central-1', map), 'url https://api.ai.example.sap/v2/v2 region example-region');
});

test('generic patterns: kyma hosts and non-loopback IPs', () => {
  assert.equal(applyMap('at abc.c-1234.kyma.ondemand.com from 10.1.2.3 and 127.0.0.1', {}), 'at sail.example.com from 203.0.113.7 and 127.0.0.1');
});

test('overlaySource embeds the map and is valid JavaScript', () => {
  const src = overlaySource({ 'secret-x': 'demo-x' });
  assert.match(src, /MutationObserver/); assert.match(src, /"secret-x"/);
  new Function(src.replace(/^\(\(\) => \{/, '').replace(/\}\)\(\);\s*$/, ''));
});

test('deployment ids become stable demo-deployment-<n> placeholders, 16-digit numbers stay', () => {
  assert.equal(applyMap('a1b2c3d4e5f60718 then 0f1e2d3c4b5a6978 then a1b2c3d4e5f60718', {}), 'demo-deployment-1 then demo-deployment-2 then demo-deployment-1');
  assert.equal(applyMap('card 4111111111111111', {}), 'card 4111111111111111');
});

// The join keeps the commit guard's access-key pattern out of the source.
const ACCESS_KEY_ID = 'AKIA' + 'TESTKEY000000001';

test('AWS-shaped access key ids become DEMO-ACCESS-KEY-ID', () => {
  assert.equal(applyMap(`key ${ACCESS_KEY_ID}`, {}), 'key DEMO-ACCESS-KEY-ID');
});

test('the overlay applies both rules to the DOM and keeps deployment numbering across calls', () => {
  const text = (v) => ({ nodeType: 3, nodeValue: v });
  const first = text(`dep a1b2c3d4e5f60718 key ${ACCESS_KEY_ID} card 4111111111111111`);
  const body = { nodeType: 1, tagName: 'BODY', hasAttribute: () => false, childNodes: [first] };
  let observer;
  const run = new Function('window', 'document', 'MutationObserver', overlaySource({}));
  run({}, { body }, class { constructor(cb) { observer = cb; } observe() {} });
  assert.equal(first.nodeValue, 'dep demo-deployment-1 key DEMO-ACCESS-KEY-ID card 4111111111111111');
  const later = text('0f1e2d3c4b5a6978 and a1b2c3d4e5f60718');
  observer([{ type: 'childList', addedNodes: [later] }]);
  assert.equal(later.nodeValue, 'demo-deployment-2 and demo-deployment-1');
});

test('SAP auth hosts become auth.example.sap; the docs placeholder stays', () => {
  assert.equal(applyMap('token at https://sub-x1.authentication.eu10.hana.ondemand.com/oauth/token', {}), 'token at https://auth.example.sap/oauth/token');
  assert.equal(applyMap('<subdomain>.authentication.<region>.hana.ondemand.com', {}), '<subdomain>.authentication.<region>.hana.ondemand.com');
  const node = { nodeType: 3, nodeValue: 'host sub-x1.authentication.eu10.hana.ondemand.com' };
  const run = new Function('window', 'document', 'MutationObserver', overlaySource({}));
  run({}, { body: { nodeType: 1, tagName: 'BODY', hasAttribute: () => false, childNodes: [node] } }, class { observe() {} });
  assert.equal(node.nodeValue, 'host auth.example.sap');
});

test('empty map keys are skipped by applyMap and the overlay', () => {
  const map = { '': 'x', real: 'mock' };
  assert.equal(applyMap('a real text', map), 'a mock text');
  const node = { nodeType: 3, nodeValue: 'a real text' };
  const run = new Function('window', 'document', 'MutationObserver', overlaySource(map));
  run({}, { body: { nodeType: 1, tagName: 'BODY', hasAttribute: () => false, childNodes: [node] } }, class { observe() {} });
  assert.equal(node.nodeValue, 'a mock text');
});

// Built at run time so the gate's own patterns find no literal in this file.
const KEY = 'sk-' + 'live' + '0123456789abcdefghijklmn';
const AKID = 'AKIA' + 'TESTKEY000000001';
const DEP = 'a1b2c3d4' + 'e5f60718';

test('applyMap replaces any key value with the demo key, and leaves the demo key alone', () => {
  assert.equal(applyMap(`Authorization: Bearer ${KEY}`, {}), 'Authorization: Bearer sk-demo-00000000000000000000');
  assert.equal(applyMap('sk-demo-your-key and sk-demo-00000000000000000000', {}), 'sk-demo-your-key and sk-demo-00000000000000000000');
  assert.equal(API_KEY[1], 'sk-demo-00000000000000000000');
});

test('the overlay source carries the key rule', () => {
  assert.ok(overlaySource({}).includes("'sk-demo-00000000000000000000'"));
});

test('redactionMisses names map entries by their mock and flags keys, access-key and deployment ids', () => {
  assert.deepEqual(redactionMisses('shows real-value', { 'real-value': 'demo-value' }), ['map entry shown as "demo-value"']);
  assert.deepEqual(redactionMisses(`key ${KEY}`, {}), ['api key']);
  assert.deepEqual(redactionMisses(`id ${AKID}`, {}), ['access key id']);
  assert.deepEqual(redactionMisses(`deployment ${DEP}`, {}), ['deployment id']);
  assert.deepEqual(redactionMisses('card 4111111111111111, demo-deployment-1, DEMO-ACCESS-KEY-ID, sk-demo-00000000000000000000', {}), []);
  assert.ok(!redactionMisses(`key ${KEY}`, {}).join().includes(KEY));
});

test('pageText reads the body text, input values and title attributes', () => {
  const doc = {
    body: { innerText: 'visible' },
    querySelectorAll: (sel) => (sel === 'input, textarea' ? [{ value: 'typed' }, { value: '' }] : sel === '[title]' ? [{ getAttribute: () => 'tooltip' }] : [])
  };
  assert.equal(pageText(doc), 'visible\ntyped\ntooltip');
});

test('redactionMisses flags a SAP auth host and a non-example e-mail, and passes example domains', () => {
  assert.deepEqual(redactionMisses('at ' + ['acme', 'authentication', 'eu10', 'hana', 'ondemand', 'com'].join('.'), {}), ['SAP auth host']);
  assert.deepEqual(redactionMisses('mail ' + 'jo.doe' + '@' + 'corp.io', {}), ['non-example email']);
  assert.deepEqual(redactionMisses('mail mara.lindqvist@example.com', {}), []);
});

test('the secret gate and the recorder share one e-mail rule and one label', () => {
  const foreign = 'mail ' + 'jo.doe' + '@' + 'corp.io';
  const hits = scan(['f'], { readFile: () => foreign }).map((h) => h.pattern);
  assert.deepEqual(hits, redactionMisses(foreign, {}));
  assert.deepEqual(scan(['f'], { readFile: () => 'mail a@test.com' }), []);
});

test('the placeholder cluster c-abc123 stays as it is; a real cluster host is still replaced and reported', () => {
  const fake = 'https://sail-proxy-test.c-abc123.kyma.ondemand.com';
  assert.equal(applyMap(fake, {}), fake);
  assert.deepEqual(redactionMisses(fake, {}), []);
  assert.equal(applyMap('https://sail-proxy-test.c-0123abc.kyma.ondemand.com/admin', {}), 'https://sail.example.com/admin');
  assert.deepEqual(redactionMisses('host: x.c-0123abc.kyma.ondemand.com', {}), ['cluster host']);
});

// Invented: 32 lower-case hex characters, the shape of a classic Azure OpenAI key.
const AZURE_KEY = '0123456789abcdef'.repeat(2).split('').reverse().join('');

test('32-hex Azure keys are masked; 32 digits, upper-case hex and longer hex runs stay', () => {
  assert.equal(applyMap(`api-key: ${AZURE_KEY}`, {}), 'api-key: ••••••••');
  assert.equal(applyMap('n 12345678901234567890123456789012', {}), 'n 12345678901234567890123456789012');
  assert.equal(applyMap(`u ${AZURE_KEY.toUpperCase()}`, {}), `u ${AZURE_KEY.toUpperCase()}`);
  assert.equal(applyMap(`sha ${AZURE_KEY}abcdef01`, {}), `sha ${AZURE_KEY}abcdef01`);
  assert.deepEqual(redactionMisses(`k ${AZURE_KEY}`, {}), ['azure key']);
});

test('the overlay masks 32-hex Azure keys too', () => {
  const t = { nodeType: 3, nodeValue: `key ${AZURE_KEY}` };
  const body = { nodeType: 1, tagName: 'BODY', hasAttribute: () => false, childNodes: [t] };
  new Function('window', 'document', 'MutationObserver', overlaySource({}))({}, { body }, class { observe() {} });
  assert.equal(t.nodeValue, 'key ••••••••');
});

test('the overlay sweeps input values a script set after the node was added (no mutation fires for them)', () => {
  const input = { nodeType: 1, tagName: 'INPUT', hasAttribute: () => false, childNodes: [], value: '' };
  const body = { nodeType: 1, tagName: 'BODY', hasAttribute: () => false, childNodes: [input] };
  let sweep;
  const run = new Function('window', 'document', 'MutationObserver', overlaySource({ 'tenant-real': 'demo-tenant-b' }));
  run({ setInterval: (fn) => { sweep = fn; } }, { body, querySelectorAll: () => [input] }, class { observe() {} });
  input.value = 'tenant-real.us10'; // as a UI5 Select writes its key into its hidden input
  sweep();
  assert.equal(input.value, 'demo-tenant-b.us10');
});
