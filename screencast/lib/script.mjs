// videos/<v>/script.md: front matter (flat keys, `casts: a, b`, and `sections:` lines `  - n | MM:SS | title |
// outcome`), then the sections "Spoken script" (paragraphs opened by a [MM:SS] cue), "On-screen cues",
// "Recap and next" and "Pronunciation". Shared by the checker, the narrator, the cards and the recorder.
const TAG = /\[(\d\d):(\d\d)\]/g;

export const toSeconds = (label) => { const [m, s] = label.split(':').map(Number); return m * 60 + s; };
export const toLabel = (seconds) => { const t = Math.round(seconds); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

export function section(body, name) {
  const m = new RegExp(`(?:^|\\n)## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
  return m ? m[1] : undefined;
}

// Every paragraph of the spoken script opens with the second of the video at which it is cued.
export function paragraphs(text) {
  return (text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^\[(\d\d):(\d\d)\]\s*/.exec(p);
    if (!m) throw new Error(`paragraph without a [MM:SS] cue: "${p.slice(0, 40)}"`);
    return { at: Number(m[1]) * 60 + Number(m[2]), label: `${m[1]}:${m[2]}`, text: p.slice(m[0].length).replace(/\s+/g, ' ') };
  });
}

export const wordCount = (text) => text.split('\n').filter((l) => !l.trim().startsWith('<!--')).join(' ').replace(TAG, ' ').split(/\s+/).filter(Boolean).length;

export function parseScript(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) throw new Error('missing front matter (--- fences)');
  const meta = { sections: [], casts: [] }; let inSections = false;
  for (const line of m[1].split('\n')) {
    const sec = /^\s+-\s+(\d+)\s*\|\s*(\d\d:\d\d)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/.exec(line);
    if (inSections && sec) { meta.sections.push({ n: Number(sec[1]), start: toSeconds(sec[2]), label: sec[2], title: sec[3], outcome: sec[4] }); continue; }
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    inSections = kv[1] === 'sections';
    if (kv[1] === 'casts') meta.casts = kv[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (kv[1] !== 'sections') meta[kv[1]] = kv[2].trim();
  }
  const body = m[2];
  const spokenText = section(body, 'Spoken script');
  return {
    meta, body,
    spoken: spokenText === undefined ? [] : paragraphs(spokenText),
    recap: (section(body, 'Recap and next') ?? '').trim().replace(/\s+/g, ' '),
    pronunciation: section(body, 'Pronunciation')
  };
}
