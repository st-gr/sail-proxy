#!/usr/bin/env node
/** The CI gateway's SAP settings when the run goes through the relay. */
const assert = require('assert');
const dotenv = require('dotenv');
const { sapRelayEnv, withRelayEnv } = require('./sap-relay-env');

let failed = 0;
function check(name, fn) { try { fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); } }

const base = 'https://relay.example.test/key123';
const expected = { SAP_AI_CORE_URL: base + '/api', AUTH_URL: base + '/auth/oauth/token', SAP_DEPLOYMENT_URL_BASE: base + '/api' };

check('unset, empty and blank give no settings', () => {
  for (const v of [undefined, '', '   ']) assert.deepStrictEqual(sapRelayEnv(v), {});
});
check('a base without a trailing slash derives the three settings', () => assert.deepStrictEqual(sapRelayEnv(base), expected));
check('trailing slashes are stripped', () => {
  assert.deepStrictEqual(sapRelayEnv(base + '/'), expected);
  assert.deepStrictEqual(sapRelayEnv(base + '//'), expected);
});
check('nothing is written to stdout or stderr', () => {
  const o = process.stdout.write, e = process.stderr.write; let seen = '';
  process.stdout.write = process.stderr.write = (s) => { seen += s; return true; };
  try { sapRelayEnv(base); } finally { process.stdout.write = o; process.stderr.write = e; }
  assert.strictEqual(seen, '');
});

const body = 'SAP_AI_CORE_URL=https://direct.example.test/api\nAUTH_URL=https://direct.example.test/oauth/token\nPORT=3088\n';
check('withRelayEnv: unset, empty and blank leave the env body identical', () => {
  for (const v of [undefined, '', '   ']) assert.strictEqual(withRelayEnv(body, v), body);
});
check('withRelayEnv: a set base appends the three settings, which win when parsed', () => {
  const out = withRelayEnv(body, base);
  assert.ok(out.startsWith(body));
  for (const [k, v] of Object.entries(expected)) assert.ok(out.includes(`\n${k}=${v}\n`), k);
  const parsed = dotenv.parse(out);
  for (const [k, v] of Object.entries(expected)) assert.strictEqual(parsed[k], v, k);
  assert.strictEqual(parsed.PORT, '3088');
});
check('withRelayEnv: a body without a final newline still gets separate lines', () => {
  const parsed = dotenv.parse(withRelayEnv('PORT=3088', base));
  assert.strictEqual(parsed.PORT, '3088');
  assert.strictEqual(parsed.AUTH_URL, expected.AUTH_URL);
});

if (failed) process.exit(1);
