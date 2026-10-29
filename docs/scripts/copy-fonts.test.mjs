import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFonts, FONT_FILES } from './copy-fonts.mjs';

test('copies exactly the five 72 woff2 files and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'fonts-'));
  const src = join(root, 'pkg', 'content', 'Base', 'baseLib', 'baseTheme', 'fonts');
  mkdirSync(src, { recursive: true });
  for (const f of [...FONT_FILES, '72-Black.woff2', '72-Regular.woff']) writeFileSync(join(src, f), f);
  const dest = join(root, 'out');
  const copied = copyFonts(join(root, 'pkg'), dest);
  assert.deepEqual(copied.sort(), [...FONT_FILES].sort());
  assert.deepEqual(readdirSync(dest).sort(), [...FONT_FILES].sort());
  assert.ok(!existsSync(join(dest, '72-Black.woff2')));
});

test('fails with a clear message when the package folder is missing', () => {
  assert.throws(() => copyFonts('/nonexistent/pkg', mkdtempSync(join(tmpdir(), 'fonts-'))), /theming-base-content/);
});
