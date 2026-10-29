import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deadLinks } from './check-links.mjs';

test('relative links must exist on disk, site links must map to a page', () => {
  const root = mkdtempSync(join(tmpdir(), 'links-'));
  mkdirSync(join(root, 'docs', 'guide'), { recursive: true });
  writeFileSync(join(root, 'docs', 'guide', 'faq.md'), '# FAQ');
  writeFileSync(join(root, 'docs', 'guide', 'index.md'), '# Guide');
  writeFileSync(join(root, 'LICENSE'), 'x');
  const md = [
    '[ok](LICENSE) [ok2](docs/guide/faq.md#x) [missing](docs/nope.md)',
    '[site](https://st-gr.github.io/sail-proxy/guide/faq) [site2](https://st-gr.github.io/sail-proxy/guide/) [site-missing](https://st-gr.github.io/sail-proxy/guide/nope)',
    '[ext](https://example.com/) [anchor](#top) [mail](mailto:a@example.com) ![img](docs/assets/none.png)'
  ].join('\n');
  writeFileSync(join(root, 'README.md'), md);
  assert.deepEqual(deadLinks(root, ['README.md']), [
    { file: 'README.md', target: 'docs/nope.md' },
    { file: 'README.md', target: 'https://st-gr.github.io/sail-proxy/guide/nope' },
    { file: 'README.md', target: 'docs/assets/none.png' }
  ]);
});
