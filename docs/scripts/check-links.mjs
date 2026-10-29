// Dead-link sweep over the Markdown files VitePress does not build: the README, the folder stubs
// and the PR template. A relative link must exist on disk; a site link must map to a page in docs/.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://st-gr.github.io/sail-proxy/';
const LINK = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
export const FILES = ['README.md', 'docker/README.md', 'kyma/README.md', 'services/admin/README.md', 'services/ollama/README.md', 'npm-dist/sail-proxy/README.md', '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md'];

function pageExists(root, sitePath) {
  const p = sitePath.replace(/[#?].*$/, '').replace(/\.html$/, '');
  if (p === '' || p.endsWith('/')) return existsSync(join(root, 'docs', p, 'index.md'));
  return existsSync(join(root, 'docs', `${p}.md`)) || existsSync(join(root, 'docs', p, 'index.md'));
}

export function deadLinks(root, files) {
  const out = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(LINK)) {
      const target = m[1];
      if (target.startsWith('#') || target.startsWith('mailto:')) continue;
      if (target.startsWith(SITE)) { if (!pageExists(root, target.slice(SITE.length))) out.push({ file, target }); continue; }
      if (/^[a-z]+:/i.test(target)) continue;
      const local = resolve(root, dirname(file), target.replace(/[#?].*$/, ''));
      if (!existsSync(local)) out.push({ file, target });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dead = deadLinks(root, FILES.filter((f) => existsSync(join(root, f))));
  for (const d of dead) console.error(`${d.file}: dead link ${d.target}`);
  if (dead.length) process.exit(1);
  console.log('README link sweep passed');
}
