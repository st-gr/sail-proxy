// The video catalogue (screencast/videos/catalog.json) must agree with the scripts and the videos page: ids
// and titles well formed and unique, chapters starting at 0 and ascending once timed, chapter titles equal
// to the script's sections, published VTT and poster files present when flagged, every video embedded.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '../../screencast/lib/script.mjs';

export function problemsOf({ catalog, scripts, page, exists, folders = [] }) {
  const out = []; const titles = new Map();
  for (const v of catalog) {
    const id = v.id;
    if (!/^\d\d-[a-z0-9-]+$/.test(id)) out.push(`${id}: id must look like 03-docker-compose`);
    if (!v.title || !v.subtitle) out.push(`${id}: title and subtitle are required`);
    titles.set(v.title, (titles.get(v.title) ?? 0) + 1);
    if (!(v.youtubeId === null || /^[\w-]{11}$/.test(v.youtubeId))) out.push(`${id}: youtubeId must be 11 characters or null`);
    if (!Number.isInteger(v.duration) || v.duration < 0) out.push(`${id}: duration must be a whole number of seconds, 0 or more`);
    if (!Number.isInteger(v.targetSeconds) || v.targetSeconds <= 0) out.push(`${id}: targetSeconds must be a positive whole number`);
    const ch = v.chapters ?? [];
    if (!ch.length || ch[0].title !== 'Introduction') out.push(`${id}: the first chapter must be Introduction`);
    const timed = ch.filter((c) => c.t !== null);
    if (timed.length && ch[0].t !== 0) out.push(`${id}: the first chapter must start at 0`);
    for (let i = 1; i < timed.length; i++) if (timed[i].t <= timed[i - 1].t) { out.push(`${id}: chapter times must ascend`); break; }
    const s = scripts[id];
    const produced = v.duration > 0 || v.vtt || v.poster || v.youtubeId !== null;
    if (!s && produced) out.push(`${id}: no script`);
    if (s) {
      const want = s.meta.sections.map((x) => x.title);
      const have = ch.slice(1).map((c) => c.title);
      if (want.join('|') !== have.join('|')) out.push(`${id}: chapters after Introduction must match the script sections (${want.join(', ')})`);
      if (s.meta.title !== v.title) out.push(`${id}: title differs from the script's`);
    }
    if (v.vtt && !exists(`${id}.vtt`)) out.push(`${id}: vtt is set but docs/public/videos/${id}.vtt is missing`);
    if (v.poster && !exists(`${id}.jpg`)) out.push(`${id}: poster is set but docs/public/videos/${id}.jpg is missing`);
    if (!page.includes(`<VideoEmbed video="${id}" />`)) out.push(`${id}: not embedded in guide/videos.md`);
  }
  const ids = new Set(catalog.map((v) => v.id));
  for (const f of folders) if (!ids.has(f)) out.push(`orphan script folder ${f}`);
  for (const [t, n] of titles) if (n > 1) out.push(`duplicate title "${t}"`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docs = join(dirname(fileURLToPath(import.meta.url)), '..'); const root = join(docs, '..');
  const catalog = JSON.parse(readFileSync(join(root, 'screencast', 'videos', 'catalog.json'), 'utf8'));
  const scripts = {}; const videos = join(root, 'screencast', 'videos');
  const folders = readdirSync(videos, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(videos, d.name, 'script.md'))).map((d) => d.name);
  for (const v of catalog) { const p = join(root, 'screencast', 'videos', v.id, 'script.md'); if (existsSync(p)) scripts[v.id] = parseScript(readFileSync(p, 'utf8')); }
  const problems = problemsOf({ catalog, scripts, page: readFileSync(join(docs, 'guide', 'videos.md'), 'utf8'), exists: (f) => existsSync(join(docs, 'public', 'videos', f)), folders });
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length) process.exit(1);
  console.log(`video catalogue consistent (${catalog.length} videos)`);
}
