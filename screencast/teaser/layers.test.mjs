import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerModel, TAGLINE, END_LINES, INSTALL } from './layers.mjs';
import { FINE, SITE, REPO } from '../lib/cards.mjs';

test('the end screen carries the line, the install command, both links and the trademark note verbatim', () => {
  const m = layerModel('end');
  assert.deepEqual(m.lines, ['Enterprise LLM gateway for SAP AI Core.', 'Free.', 'From the community, for the community.']);
  assert.deepEqual(END_LINES, m.lines);
  assert.equal(m.install, 'npm install -g @st-gr/sail-proxy'); assert.equal(INSTALL, m.install);
  assert.equal(m.site, SITE); assert.equal(m.repo, REPO); assert.equal(m.fine, FINE);
  assert.equal(m.cta, 'Give it a try');
  assert.equal(m.edition, 'Lite on your laptop · full stack on Docker or Kyma');
  assert.equal(m.qr, '/teaser/qr-docs.svg'); assert.equal(m.qrLabel, 'Scan for the docs');
  assert.ok(m.opaque);
});

test('the tagline is revealed word by word', () => {
  assert.equal(TAGLINE, 'Enterprise LLM gateway for SAP AI Core.');
  const m = layerModel('tagline', { shown: 3 });
  assert.deepEqual(m.words, ['Enterprise', 'LLM', 'gateway', 'for', 'SAP', 'AI', 'Core.']);
  assert.equal(m.shown, 3);
  assert.throws(() => layerModel('tagline', { shown: 8 }), /1 to 7/);
});

test('text and word layers are transparent and need text', () => {
  assert.equal(layerModel('word', { text: 'Quotas.' }).opaque, false);
  assert.equal(layerModel('text', { lines: ['One gateway.'], style: 'title' }).opaque, false);
  assert.throws(() => layerModel('text', { lines: [] }), /needs at least one line/);
  assert.throws(() => layerModel('word', {}), /needs a word/);
  assert.throws(() => layerModel('spin'), /unknown layer/);
});

test('the diagram card shows the architecture SVG at full resolution', () => {
  const m = layerModel('diagram');
  assert.equal(m.src, '/assets/sail-proxy-deployment-options.svg'); assert.ok(m.opaque);
});
