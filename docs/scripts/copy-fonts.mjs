// Copies the SAP 72 typeface (Apache-2.0, @sap-theming/theming-base-content) into the theme at
// build time. The woff2 files are never committed; fonts.css references this folder.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONT_FILES = ['72-Regular.woff2', '72-Bold.woff2', '72-Italic.woff2', '72-Light.woff2', '72-CondensedBold.woff2'];
const FONT_DIR = join('content', 'Base', 'baseLib', 'baseTheme', 'fonts');

export function copyFonts(packageRoot, destDir) {
  const src = join(packageRoot, FONT_DIR);
  if (!existsSync(src)) throw new Error(`@sap-theming/theming-base-content fonts not found at ${src}; run pnpm install`);
  mkdirSync(destDir, { recursive: true });
  for (const f of FONT_FILES) copyFileSync(join(src, f), join(destDir, f));
  return [...FONT_FILES];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('@sap-theming/theming-base-content/package.json'));
  const here = dirname(fileURLToPath(import.meta.url));
  const copied = copyFonts(packageRoot, join(here, '..', '.vitepress', 'theme', 'fonts'));
  console.log(`copied ${copied.length} font files`);
}
