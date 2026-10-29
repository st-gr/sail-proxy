import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mustacheHits } from './check-mustache.mjs';

test('reports prose mustaches outside code, inline code and v-pre', () => {
  const md = [
    '# Page',                          // 1
    'Prose with {{x}} renders empty.', // 2  hit
    '```text',                         // 3
    'fenced {{y}}',                    // 4
    '```',                             // 5
    'Inline `{{z}}` is safe.',         // 6
    '::: v-pre',                       // 7
    'Container {{w}} is safe.',        // 8
    ':::',                             // 9
    'Escaped <code v-pre>{{v}}</code>',// 10
    '~~~',                             // 11
    'tilde {{t}}',                     // 12
    '~~~',                             // 13
    'After `ok` then {{again}}'        // 14 hit
  ].join('\n');
  assert.deepEqual(mustacheHits(md), [2, 14]);
});
