import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselessRefs } from './check-base.mjs';

test('finds hrefs and srcs that skip the base path', () => {
  const html = '<a href="/guide/faq">x</a><a href="/sail-proxy/guide/faq">ok</a><img src="/assets/a.png"><img src="/sail-proxy/assets/a.png"><a href="https://x.y/">ext</a>';
  assert.deepEqual(baselessRefs(html, '/sail-proxy/'), ['/guide/faq', '/assets/a.png']);
});

test('an empty page has no findings', () => {
  assert.deepEqual(baselessRefs('<html></html>', '/sail-proxy/'), []);
});
