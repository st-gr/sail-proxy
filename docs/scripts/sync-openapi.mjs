// Copies the four OpenAPI documents from openapi/ into docs/public/openapi/, so the API reference page shows the
// documents of its own commit, and Swagger UI's stylesheet next to them (a public file, not a bundle asset, so the
// site's own stylesheet stays the one VitePress links on every page). The copy is gitignored and made again before
// every dev and build.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_DOCUMENTS, SWAGGER_CSS } from '../.vitepress/theme/components/apiDocuments.mjs';

export function syncOpenapi(srcDir, destDir) {
  const files = API_DOCUMENTS.map((d) => d.file);
  for (const f of files) if (!existsSync(join(srcDir, f))) throw new Error(`OpenAPI document ${f} not found in ${srcDir}`);
  mkdirSync(destDir, { recursive: true });
  for (const f of files) copyFileSync(join(srcDir, f), join(destDir, f));
  return files;
}

export function copySwaggerCss(packageRoot, destDir) {
  const src = join(packageRoot, 'swagger-ui.css');
  if (!existsSync(src)) throw new Error(`swagger-ui-dist stylesheet not found at ${src}; run pnpm install`);
  mkdirSync(destDir, { recursive: true });
  const name = SWAGGER_CSS.split('/').pop();
  copyFileSync(src, join(destDir, name));
  return name;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dest = join(docsRoot, 'public', 'openapi');
  const swaggerRoot = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
  console.log(`synced ${[...syncOpenapi(join(docsRoot, '..', 'openapi'), dest), copySwaggerCss(swaggerRoot, dest)].join(', ')}`);
}
