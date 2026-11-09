import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostPorts, RESERVED_HOST_PORTS } from './compose-ports.mjs';

const text = readFileSync(new URL('./compose.docs.yml', import.meta.url), 'utf8');

test('every ports list in the override carries the !override tag', () => {
  const lists = text.match(/ports:[^\n]*/g) ?? [];
  assert.ok(lists.length >= 6, `expected at least six ports lists, found ${lists.length}`);
  for (const l of lists) assert.match(l, /ports: !override/);
});

test('no host port of the override is reserved for the dev stack', () => {
  const ports = hostPorts(text);
  assert.ok(ports.length >= 6);
  for (const p of ports) assert.ok(!RESERVED_HOST_PORTS.has(p), `host port ${p} is reserved`);
});

test('every host port binds loopback only', () => {
  for (const m of text.matchAll(/"([^"]+)"/g)) if (/^\d/.test(m[1]) || /^127\./.test(m[1])) assert.match(m[1], /^127\.0\.0\.1:/);
});
