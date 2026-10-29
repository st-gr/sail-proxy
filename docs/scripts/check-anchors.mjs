// The cockpit's configuration form links help text to heading anchors on the site; a reworded
// heading breaks that help silently. required-anchors.json lists them; the built HTML must have them.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function missingAnchors(required, htmlOf) {
  return required.filter(({ page, anchor }) => {
    const html = htmlOf(page);
    return !html || !new RegExp(`id="${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = join(docs, '.vitepress', 'dist');
  const required = JSON.parse(readFileSync(join(docs, 'scripts', 'required-anchors.json'), 'utf8'));
  const htmlOf = (page) => { const f = join(dist, `${page}.html`); return existsSync(f) ? readFileSync(f, 'utf8') : undefined; };
  const missing = missingAnchors(required, htmlOf);
  for (const m of missing) console.error(`missing anchor: /${m.page}#${m.anchor}`);
  if (missing.length) process.exit(1);
  console.log(`${required.length} required anchors present`);
}
