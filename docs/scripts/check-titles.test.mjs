import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTitles } from './check-titles.mjs';

test('reports titles used by more than one page', () => {
  const pages = { 'a.md': '---\ntitle: Authentication\n---\n', 'b.md': '---\ntitle: Authentication\ndescription: d\n---\n', 'c.md': '---\ntitle: Other\n---\n', 'd.md': '# No front matter\n' };
  assert.deepEqual(duplicateTitles(pages), [{ title: 'Authentication', files: ['a.md', 'b.md'] }]);
});
