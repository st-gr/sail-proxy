// VitePress compiles page prose as a Vue template: a bare {{ ... }} is interpolated and renders
// empty with no build error. Prose mustaches must sit in code (fenced or inline), in a
// ::: v-pre container, or on a line that carries v-pre (e.g. <code v-pre>).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.vitepress', '.generated', 'superpowers', 'competitive', 'notes', 'public', 'assets']);

export function mustacheHits(markdown) {
  const hits = [];
  let fence = null; // the opening fence run (``` or ~~~...) while inside a fenced block
  let vPre = false;
  markdown.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    const f = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && trimmed.slice(f[1].length).trim() === '') fence = null;
      return;
    }
    if (f) { fence = f[1]; return; }
    if (vPre) { if (/^:::\s*$/.test(trimmed)) vPre = false; return; }
    if (/^:::\s*v-pre\b/.test(trimmed)) { vPre = true; return; }
    if (line.includes('v-pre')) return;
    const prose = line.replace(/(`+)[\s\S]*?\1/g, '');
    if (prose.includes('{{')) hits.push(i + 1);
  });
  return hits;
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
  let count = 0;
  for (const p of mdFiles(docs)) {
    for (const n of mustacheHits(readFileSync(p, 'utf8'))) {
      console.error(`${relative(docs, p)}:${n}`);
      count++;
    }
  }
  if (count) process.exit(1);
  console.log('no unescaped mustache text');
}
