import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingAnchors } from './check-anchors.mjs';

test('an anchor is present when the page HTML has an element with that id', () => {
  const html = { 'developer/debugging': '<h3 id="log-level-resolution">Log level resolution</h3>' };
  const req = [{ page: 'developer/debugging', anchor: 'log-level-resolution' }, { page: 'developer/debugging', anchor: 'nope' }, { page: 'missing/page', anchor: 'x' }];
  assert.deepEqual(missingAnchors(req, (page) => html[page]), [req[1], req[2]]);
});
