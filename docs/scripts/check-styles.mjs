// After a build, every page must link the site's stylesheet (assets/style.*.css), and only the API reference page may
// link Swagger UI's. VitePress links the first .css asset of the bundle on every page, so an extra CSS asset in the
// bundle replaces the site's stylesheet everywhere. Usage: node scripts/check-styles.mjs [distDir]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLESHEET = /<link\b[^>]*\bhref="([^"]+\.css)"/g;
const SITE_CSS = /\/assets\/style\.[\w-]+\.css$/;
const SWAGGER_CSS = /swagger-ui[^/]*\.css$/;
const SWAGGER_PAGE = 'reference/api.html';

export function styleProblems(pages) {
  const out = [];
  for (const [page, html] of Object.entries(pages)) {
    const links = [...html.matchAll(STYLESHEET)].map((m) => m[1]);
    if (!links.some((l) => SITE_CSS.test(l))) out.push(`${page}: does not link the site stylesheet`);
    if (page !== SWAGGER_PAGE && links.some((l) => SWAGGER_CSS.test(l))) out.push(`${page}: links Swagger UI's stylesheet`);
  }
  return out;
}

function* htmlFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (p.endsWith('.html')) yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.vitepress', 'dist');
  const pages = Object.fromEntries([...htmlFiles(dist)].map((f) => [relative(dist, f).split(sep).join('/'), readFileSync(f, 'utf8')]));
  const problems = styleProblems(pages);
  for (const p of problems) console.error(p);
  if (problems.length) { console.error(`${problems.length} stylesheet problem(s)`); process.exit(1); }
  console.log(`stylesheet check passed (${Object.keys(pages).length} pages)`);
}
