// Every page title must be unique: search results and browser tabs show the title alone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.vitepress', '.generated', 'superpowers', 'competitive', 'notes', 'public', 'assets']);

export function duplicateTitles(pages) {
  const byTitle = new Map();
  for (const [file, text] of Object.entries(pages)) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const m = fm && /^title:\s*(.+?)\s*$/m.exec(fm[1]);
    if (!m) continue;
    byTitle.set(m[1], [...(byTitle.get(m[1]) ?? []), file]);
  }
  return [...byTitle].filter(([, files]) => files.length > 1).map(([title, files]) => ({ title, files: files.sort() }));
}

function* mdFiles(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* mdFiles(p); else if (p.endsWith('.md')) yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pages = Object.fromEntries([...mdFiles(docs)].map((p) => [relative(docs, p), readFileSync(p, 'utf8')]));
  const dups = duplicateTitles(pages);
  for (const d of dups) console.error(`title "${d.title}" used by ${d.files.join(', ')}`);
  if (dups.length) process.exit(1);
  console.log('page titles are unique');
}
