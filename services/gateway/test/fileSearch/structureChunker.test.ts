import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  chunkStructured,
  countTokens,
  structuredSections,
  StructuredChunk,
  StructuredChunkOptions,
} from '../../src/fileSearch/structureChunker';
import { markdownSections } from '../../src/fileSearch/structureScanner';

const CORPUS = join(__dirname, '../../../../ci/file-search-eval/corpus/markdown');

/**
 * The contract parent-section assembly relies on: each chunk is an exact
 * substring of its section at its offset; a section's chunks start at 0, leave
 * no gap and end at the section's end, so joining them by offset gives the
 * section back; only whitespace lies outside the sections.
 */
function expectContract(text: string, opts: StructuredChunkOptions): StructuredChunk[] {
  const sections = structuredSections(text, opts);
  const chunks = chunkStructured(text, opts);
  let cursor = 0;
  sections.forEach((section, ordinal) => {
    expect(text.slice(cursor, section.start).trim()).toBe('');
    cursor = section.end;
    const own = chunks.filter((c) => c.section === ordinal);
    expect(own.length).toBeGreaterThan(0);
    const sectionText = text.slice(section.start, section.end);
    let rebuilt = '';
    let previousOffset = -1;
    let run: { start: number; end: number; tokens: number } | undefined;
    for (const c of own) {
      expect(c.sectionOffset).toBeGreaterThan(previousOffset); // starts strictly after its predecessor
      previousOffset = c.sectionOffset;
      expect(c.text).toBe(sectionText.slice(c.sectionOffset, c.sectionOffset + c.text.length));
      expect(c.sectionOffset).toBeLessThanOrEqual(rebuilt.length); // no gap
      expect(c.sectionOffset + c.text.length).toBeGreaterThan(rebuilt.length); // progress
      rebuilt += c.text.slice(rebuilt.length - c.sectionOffset);
      expect(c.headingPath).toBe(section.headingPath);
      expect((c.headingPath ?? '').length).toBeLessThanOrEqual(1000);
      if (c.tableHeader !== undefined) {
        // The header is in the section before the chunk, not at its start.
        const at = sectionText.lastIndexOf(c.tableHeader, c.sectionOffset);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at + c.tableHeader.length).toBeLessThanOrEqual(c.sectionOffset);
      }
      expect(c.tokens).toBe(countTokens(c.text));
      expect(c.tokens).toBeLessThanOrEqual(opts.maxTokens);
      // A whitespace-only chunk exists only where its whitespace run does not
      // fit in one chunk beside a single further character (coverage leaves no
      // other choice); a code point is at most 4 tokens.
      if (c.text.trim() === '') {
        // Consecutive whitespace-only chunks share one run: measure it once.
        if (!run || c.sectionOffset < run.start || c.sectionOffset >= run.end) {
          let a = c.sectionOffset;
          let b = c.sectionOffset + c.text.length;
          while (a > 0 && /\s/.test(sectionText[a - 1])) a -= 1;
          while (b < sectionText.length && /\s/.test(sectionText[b])) b += 1;
          run = { start: a, end: b, tokens: countTokens(sectionText.slice(a, b)) };
        }
        expect(run.tokens + 4).toBeGreaterThan(opts.maxTokens);
      }
    }
    expect(own[0].sectionOffset).toBe(0);
    expect(rebuilt).toBe(sectionText);
  });
  expect(text.slice(cursor).trim()).toBe('');
  // Sections are numbered 0..n-1 in chunk order.
  const order = chunks.map((c) => c.section);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(new Set(order).size).toBe(sections.length);
  return chunks;
}

const md = (maxTokens: number, overlapTokens: number, extra: Partial<StructuredChunkOptions> = {}): StructuredChunkOptions =>
  ({ maxTokens, overlapTokens, format: 'markdown', ...extra });

function paragraph(words: number, seed = 0): string {
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'gateway', 'store', 'chunk', 'token', 'route'];
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(vocab[(i * 7 + seed) % vocab.length]);
  return `${out.join(' ')}.`;
}

describe('chunkStructured on the evaluation corpus', () => {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.md')).sort();
  const sizes: Array<[number, number]> = [[800, 400], [800, 0], [200, 50], [100, 0], [4096, 0]];
  it.each(files.flatMap((f) => sizes.map(([s, o]) => [f, s, o] as [string, number, number])))(
    '%s at %d/%d keeps the substring and coverage contract',
    (file, size, overlap) => {
      const text = readFileSync(join(CORPUS, file), 'utf8');
      const chunks = expectContract(text, md(size, overlap));
      expect(chunks.length).toBeGreaterThan(0);
    }
  );

  it('does not take shell comments inside fenced code for headings', () => {
    const text = readFileSync(join(CORPUS, 'developer-chapter-11-debugging.md'), 'utf8');
    const paths = markdownSections(text).map((s) => s.headingPath ?? '');
    expect(paths.some((p) => /Enable debug logging|Find what's using the port/.test(p))).toBe(false);
    expect(paths).toContain('SAIL-PROXY Developer Guide > Debugging & Troubleshooting > Common Issues and Solutions > Port Conflicts');
  });

  it('does not take YAML front matter for a setext heading', () => {
    const text = readFileSync(join(CORPUS, 'user-chapter-6-opencode.md'), 'utf8');
    const paths = markdownSections(text).map((s) => s.headingPath);
    expect(paths[0]).toBeNull();
    expect(paths.some((p) => p !== null && p.includes('fontsize'))).toBe(false);
    expect(paths).toContain('SAIL-PROXY User Guide > Using with opencode > Prerequisites');
  });
});

describe('sections and heading paths', () => {
  const body = paragraph(150);

  it('joins the heading chain with " > " and keeps it out of the chunk text', () => {
    const text = `# Install\n\n${body}\n\n## Docker\n\n${body}\n\n### Ports\n\n${body}\n\n## Kyma\n\n${body}\n`;
    const chunks = expectContract(text, md(800, 0));
    expect(chunks.map((c) => c.headingPath)).toEqual(['Install', 'Install > Docker', 'Install > Docker > Ports', 'Install > Kyma']);
    expect(chunks[2].text.startsWith('### Ports\n')).toBe(true);
    expect(chunks.every((c) => !c.text.includes(' > '))).toBe(true);
  });

  it('a file without headings is one section with no heading path', () => {
    const text = `${paragraph(300)}\n\n${paragraph(300, 3)}\n\n${paragraph(300, 5)}\n`;
    const chunks = expectContract(text, md(200, 50));
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((c) => c.section))).toEqual(new Set([0]));
    expect(chunks.every((c) => c.headingPath === null)).toBe(true);
  });

  it('keeps text before the first heading as its own section', () => {
    const text = `${body}\n\n# First\n\n${body}\n`;
    const chunks = expectContract(text, md(800, 0));
    expect(chunks.map((c) => c.headingPath)).toEqual([null, 'First']);
  });

  it('reads setext headings, multi-line ones included', () => {
    const text = `Title\n=====\n\n${body}\n\nA two line\nsubtitle\n--------\n\n${body}\n`;
    const chunks = expectContract(text, md(800, 0));
    expect(chunks.map((c) => c.headingPath)).toEqual(['Title', 'Title > A two line subtitle']);
    expect(chunks[1].text.startsWith('A two line\nsubtitle\n----')).toBe(true);
  });

  it('a lone --- after a blank line or a list item is a thematic break, not a heading', () => {
    const text = `# Top\n\n${body}\n\n---\n\n- item\n---\n\n${body}\n`;
    expect(markdownSections(text).map((s) => s.headingPath)).toEqual(['Top']);
  });

  it('strips ATX closing hashes and ignores #tags, indented and fenced pseudo-headings', () => {
    const text = [
      '## Title ##', body, '#hashtag line', '    # indented code', '```sh', '# a comment', '## also code', '```',
      '~~~', '# tilde fenced', '~~~', '# C# ##', body,
    ].join('\n');
    expect(markdownSections(text).map((s) => s.headingPath)).toEqual(['Title', 'C#']);
  });

  it('an unclosed fence runs to the end of the file', () => {
    const text = `# A\n\n${body}\n\n\`\`\`\n# not a heading\n${body}\n`;
    expect(markdownSections(text).map((s) => s.headingPath)).toEqual(['A']);
  });

  it('handles CRLF line endings: headings found, no \\r in paths, exact substrings', () => {
    const lf = `# Install\n\n${body}\n\nSetext\n------\n\n${body}\n\n\`\`\`\n# code\n\`\`\`\n\n## Ports ##\n\n${body}\n`;
    const text = lf.replace(/\n/g, '\r\n');
    const chunks = expectContract(text, md(800, 0, { minSectionTokens: 0 }));
    // '------' makes a level-2 heading, a sibling of '## Ports'.
    expect(chunks.map((c) => c.headingPath)).toEqual(['Install', 'Install > Setext', 'Install > Ports']);
    expect(chunks.every((c) => !(c.headingPath ?? '').includes('\r'))).toBe(true);
    // Long CRLF sections still split on line boundaries.
    const long = expectContract(`# H\r\n\r\n${`${paragraph(20)}\r\n`.repeat(200)}`, md(100, 20));
    expect(long.length).toBeGreaterThan(5);
    for (const c of long.slice(0, -1)) expect(c.text.endsWith('\r\n')).toBe(true);
  });

  it('a file of only headings merges forward into one section; the path is what the merged headings share', () => {
    const text = '# A\n## B\n### C\n# D\n';
    const chunks = expectContract(text, md(800, 0));
    expect(chunks).toHaveLength(1);
    // A leads into A > B > C (child path kept), which shares nothing with D.
    expect(chunks[0]).toMatchObject({ section: 0, sectionOffset: 0, headingPath: null, text: '# A\n## B\n### C\n# D' });
    const nested = expectContract('# A\n## B\n### C\n', md(800, 0));
    expect(nested[0].headingPath).toBe('A > B > C');
    const unmerged = expectContract(text, md(800, 0, { minSectionTokens: 0 }));
    expect(unmerged.map((c) => [c.section, c.headingPath, c.text])).toEqual([
      [0, 'A', '# A'], [1, 'A > B', '## B'], [2, 'A > B > C', '### C'], [3, 'D', '# D'],
    ]);
  });

  it('a heading-only section merges into the next one; the merged section keeps one id and valid offsets', () => {
    const text = `# Install\n\n## Docker\n\n${body}\n\n## Kyma\n\n${body}\n`;
    const chunks = expectContract(text, md(800, 0));
    expect(chunks.map((c) => [c.section, c.headingPath])).toEqual([[0, 'Install > Docker'], [1, 'Install > Kyma']]);
    expect(chunks[0].text.startsWith('# Install\n\n## Docker\n')).toBe(true);
    // Also when the merged section is too long for one chunk.
    const long = `# Install\n\n## Docker\n\n${Array.from({ length: 12 }, (_, i) => paragraph(80, i)).join('\n\n')}\n`;
    const split = expectContract(long, md(200, 50));
    expect(new Set(split.map((c) => c.section))).toEqual(new Set([0]));
    expect(split[0].text.startsWith('# Install')).toBe(true);
  });

  it('merges a small section into a long next one; a small last section stays on its own', () => {
    const text = `# Small\n\nshort\n\n# Big\n\n${paragraph(400)}\n\n# Tail\n\nbye\n`;
    const chunks = expectContract(text, md(200, 0));
    // Siblings share no heading: the merged section's path is null, not "Big".
    expect(chunks[0]).toMatchObject({ section: 0, sectionOffset: 0, headingPath: null });
    expect(chunks[0].text.startsWith('# Small\n\nshort\n\n# Big\n')).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ section: 1, sectionOffset: 0, headingPath: 'Tail', text: '# Tail\n\nbye' });
  });

  it('stops merging once the merged section reaches the minimum', () => {
    const text = `# A\n\n${paragraph(60)}\n\n# B\n\n${paragraph(60, 1)}\n\n# C\n\n${paragraph(60, 2)}\n`;
    const chunks = expectContract(text, md(800, 0));
    expect(chunks.map((c) => [c.section, c.headingPath])).toEqual([[0, null], [1, 'C']]);
  });

  describe('chained merges keep a truthful heading path', () => {
    const big = (seed: number): string => paragraph(200, seed);
    const paths = (text: string): Array<string | null> =>
      structuredSections(text, md(800, 0)).map((s) => s.headingPath);

    it('# A tiny / # B tiny / # C big → null (A and B share nothing with C)', () => {
      expect(paths(`# A\n\ntiny\n\n# B\n\ntiny\n\n# C\n\n${big(1)}\n`)).toEqual([null]);
    });

    it('# G / ## A tiny / ## B tiny / ## C big → G for the merged section', () => {
      expect(paths(`# G\n\n${big(0)}\n\n## A\n\ntiny\n\n## B\n\ntiny\n\n## C\n\n${big(1)}\n`)).toEqual(['G', 'G']);
    });

    it('# G / ## A tiny / # H / ## C big → null', () => {
      expect(paths(`# G\n\n${big(0)}\n\n## A\n\ntiny\n\n# H\n\n## C\n\n${big(1)}\n`)).toEqual(['G', null]);
    });

    it('a heading-only parent chain still leads into its child', () => {
      expect(paths(`# A\n\n## B\n\n### C\n\n${big(1)}\n`)).toEqual(['A > B > C']);
    });

    it('FAQ-style runs of short siblings merge to the parent, never to one question', () => {
      const questions = Array.from({ length: 12 }, (_, i) => `## Question ${i}\n\nShort answer ${i}.`).join('\n\n');
      const text = `# FAQ\n\n${big(0)}\n\n${questions}\n\n## Last\n\n${big(2)}\n`;
      const sections = structuredSections(text, md(800, 0));
      for (const s of sections) {
        const own = text.slice(s.start, s.end);
        const count = (own.match(/^## /gm) ?? []).length;
        if (count > 1) expect(s.headingPath).toBe('FAQ');
        if (count === 1) expect(s.headingPath).toBe(`FAQ > ${/^## (.*)$/m.exec(own)?.[1]}`);
      }
      expect(sections.filter((s) => (text.slice(s.start, s.end).match(/^## /gm) ?? []).length > 1).length).toBeGreaterThan(0);
      expectContract(text, md(800, 0));
    });
  });

  it('siblings under one parent merge to the parent path', () => {
    const text = `# Guide\n\n${paragraph(150)}\n\n## Small\n\nshort\n\n## Big\n\n${paragraph(150, 1)}\n`;
    const chunks = expectContract(text, md(800, 0));
    expect(chunks.map((c) => [c.section, c.headingPath])).toEqual([[0, 'Guide'], [1, 'Guide']]);
    expect(chunks[1].text.startsWith('## Small\n\nshort\n\n## Big')).toBe(true);
  });

  it('caps heading text at 200 and the heading path at 1000 characters', () => {
    const huge = 'H'.repeat(100000);
    const levels = Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} ${huge}😀\n\n${paragraph(150, i)}\n`).join('\n');
    const chunks = expectContract(levels, md(800, 0));
    const paths = chunks.map((c) => c.headingPath ?? '');
    expect(Math.max(...paths.map((p) => p.length))).toBeLessThanOrEqual(1000);
    expect(paths[0].length).toBe(200);
    expect(paths.at(-1)?.length).toBeGreaterThan(900);
    // Setext text over many lines is capped too.
    const setext = `${'word '.repeat(20000)}\n${'more '.repeat(20000)}\n===\n\n${paragraph(150)}\n`;
    expect(markdownSections(setext)[0].headingPath?.length).toBeLessThanOrEqual(200);
  });

  it('bounds what a huge heading costs per chunk (heading path stored on every chunk)', () => {
    const text = `# ${'x'.repeat(200000)}\n\n${Array.from({ length: 120 }, (_, i) => paragraph(120, i)).join('\n\n')}\n`;
    const chunks = expectContract(text, md(200, 0));
    const stored = chunks.reduce((n, c) => n + (c.headingPath ?? '').length, 0);
    expect(stored).toBeLessThanOrEqual(chunks.length * 200);
  });
});

describe('blocks, tables and code', () => {
  const table = (rows: number): string =>
    ['| key | value |', '| --- | ----- |', ...Array.from({ length: rows }, (_, i) => `| k${i} | ${paragraph(6, i)} |`)].join('\n');
  const code = (lines: number): string =>
    ['```ts', ...Array.from({ length: lines }, (_, i) => `const v${i} = compute(${i}); // ${paragraph(4, i)}`), '```'].join('\n');

  it('keeps a table that fits whole inside one chunk of a long section', () => {
    const t = table(8);
    const text = `# T\n\n${paragraph(120)}\n\n${t}\n\n${paragraph(120, 2)}\n\n${paragraph(120, 4)}\n`;
    const chunks = expectContract(text, md(250, 0));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.text.includes(t))).toBe(true);
  });

  it('splits a single huge table on row boundaries', () => {
    const text = `# Table\n\n${table(400)}\n`;
    const chunks = expectContract(text, md(150, 30));
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith('|\n')).toBe(true);
    for (const c of chunks.slice(1)) expect(c.text.startsWith('| ')).toBe(true);
  });

  it('records the table header on continuation chunks of a split table, never in the text', () => {
    const header = '| key | value |\n| --- | ----- |';
    const text = `# Table\n\nIntro line.\n${table(400)}\nafter the table\n\n${table(3)}\n`;
    const chunks = expectContract(text, md(150, 30));
    const inTable = chunks.filter((c) => c.text.startsWith('| k'));
    expect(inTable.length).toBeGreaterThan(5);
    for (const c of inTable) expect(c.tableHeader).toBe(header);
    expect(chunks[0].tableHeader).toBeUndefined(); // starts before the header
    expect(chunks.filter((c) => !c.text.startsWith('| k')).every((c) => c.tableHeader === undefined)).toBe(true);
    // Tables in pdf/plain text are not interpreted.
    expect(chunkStructured(text, { maxTokens: 150, overlapTokens: 30, format: 'plain' }).some((c) => c.tableHeader)).toBe(false);
  });

  it('no table header inside fenced code, and none without a pipe in the delimiter row', () => {
    const fencedTable = ['```', ...table(300).split('\n'), '```'].join('\n');
    const fenced = expectContract(`# Code\n\n${fencedTable}\n`, md(150, 0));
    expect(fenced.length).toBeGreaterThan(5);
    expect(fenced.some((c) => c.tableHeader !== undefined)).toBe(false);
    const rows = Array.from({ length: 300 }, (_, i) => `k${i} | ${paragraph(6, i)}`).join('\n');
    const setextLike = expectContract(`# Text\n\nheader | value\n---\n${rows}\n`, md(150, 0));
    expect(setextLike.some((c) => c.tableHeader !== undefined)).toBe(false);
    // A pipe-less-edged GFM table still counts: the delimiter row has a pipe.
    const bare = expectContract(`# T\n\nkey | value\n--- | ---\n${rows}\n`, md(150, 0));
    expect(bare.filter((c) => c.tableHeader === 'key | value\n--- | ---').length).toBeGreaterThan(5);
  });

  it('keeps a code block that fits whole, blank lines inside it included', () => {
    const block = '```py\ndef a():\n    return 1\n\n\n# comment\ndef b():\n    return 2\n```';
    const text = `# Code\n\n${paragraph(150)}\n\n${block}\n\n${paragraph(150, 1)}\n`;
    const chunks = expectContract(text, md(220, 0));
    expect(chunks.some((c) => c.text.includes(block))).toBe(true);
    expect(chunks.map((c) => c.headingPath)).toEqual(chunks.map(() => 'Code'));
  });

  it('splits a huge code block on line boundaries and never reads its lines as headings', () => {
    const block = code(300).replace('const v5 ', '# Not a heading\nconst v5 ');
    const text = `# Code\n\n${block}\n`;
    const chunks = expectContract(text, md(120, 40));
    expect(chunks.length).toBeGreaterThan(10);
    expect(new Set(chunks.map((c) => c.headingPath))).toEqual(new Set(['Code']));
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith('\n')).toBe(true);
  });

  it('overlaps consecutive chunks inside a section, never across sections', () => {
    const lines = Array.from({ length: 120 }, (_, i) => paragraph(12, i)).join('\n');
    const text = `# A\n\n${lines}\n\n# B\n\n${lines}\n`;
    const chunks = expectContract(text, md(200, 60));
    const a = chunks.filter((c) => c.section === 0);
    for (let i = 1; i < a.length; i += 1) {
      expect(a[i].sectionOffset).toBeLessThan(a[i - 1].sectionOffset + a[i - 1].text.length);
    }
    expect(chunks.find((c) => c.section === 1)?.sectionOffset).toBe(0);
    const noOverlap = expectContract(text, md(200, 0)).filter((c) => c.section === 0);
    for (let i = 1; i < noOverlap.length; i += 1) {
      expect(noOverlap[i].sectionOffset).toBe(noOverlap[i - 1].sectionOffset + noOverlap[i - 1].text.length);
    }
  });

  it('nested lists stay intact and covered', () => {
    const list = Array.from({ length: 60 }, (_, i) =>
      `- item ${i} ${paragraph(5, i)}\n  - child ${i}\n    1. grandchild ${paragraph(4, i)}\n`).join('');
    const text = `# Lists\n\n${list}\n## Next\n\n${paragraph(150)}\n`;
    const chunks = expectContract(text, md(150, 30));
    expect(chunks.filter((c) => c.headingPath === 'Lists').length).toBeGreaterThan(3);
    expect(chunks.at(-1)?.headingPath).toBe('Lists > Next');
  });

  it('cuts one very long line by tokens, preferring sentence ends', () => {
    const line = Array.from({ length: 200 }, (_, i) => `Sentence ${i} says ${paragraph(10, i)}`).join(' ');
    const chunks = expectContract(`# Long\n\n${line}\n`, md(120, 30));
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.slice(1, -1).filter((c) => c.text.startsWith('Sentence ')).length).toBeGreaterThan(5);
  });

  it('a whitespace run that fits in a chunk never becomes a chunk of its own', () => {
    let ws = '';
    while (countTokens(ws) < 300) ws += ' \t\u00a0 \t';
    const line = (seed: number): string => Array.from({ length: 80 }, (_, i) => `word${(i * 7 + seed) % 50}`).join(' ');
    let x = line(1);
    while (countTokens(x) < 600) x += ` ${line(2)}`;
    const text = `# H\n\n${x}\n${ws}\n${x}\n`;
    for (const overlap of [0, 100]) {
      const chunks = expectContract(text, md(800, overlap));
      expect(chunks.every((c) => c.text.trim() !== '')).toBe(true);
    }
  });

  it('cuts a long line without any whitespace (minified) within the limit', () => {
    const blob = 'x9Az'.repeat(5000);
    const chunks = expectContract(blob, { maxTokens: 100, overlapTokens: 0, format: 'plain' });
    expect(chunks.length).toBeGreaterThan(10);
  });
});

describe('offsets with non-BMP characters', () => {
  it('counts offsets in UTF-16 units and never cuts a surrogate pair', () => {
    const emojiLine = '😀a🎉🚀b𝔘𝔫c𝔦𝔠𝔬𝔡𝔢'.repeat(400);
    const text = `# Emoji 🎉\n\n${paragraph(50)} 😀\n\n## Wide 𝔘\n\n${emojiLine}\n\n${paragraph(100)}\n`;
    const chunks = expectContract(text, md(100, 20, { minSectionTokens: 0 }));
    expect(chunks[0].headingPath).toBe('Emoji 🎉');
    expect(chunks.some((c) => c.headingPath === 'Emoji 🎉 > Wide 𝔘')).toBe(true);
    for (const c of chunks) {
      expect(c.text.charCodeAt(0) >= 0xdc00 && c.text.charCodeAt(0) <= 0xdfff).toBe(false);
      const lastCode = c.text.charCodeAt(c.text.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      expect(Buffer.from(c.text, 'utf8').toString('utf8')).toBe(c.text); // well-formed
    }
    const sections = structuredSections(text, md(100, 20, { minSectionTokens: 0 }));
    const second = sections[1];
    expect(text.slice(second.start, second.start + 10)).toBe('## Wide 𝔘');
    expect('## Wide 𝔘'.length).toBe(10); // UTF-16 units, not code points (9) or bytes
  });
});

describe('empty and degenerate input', () => {
  it.each(['', '   ', '\n\n\r\n', '\f\f'])('returns no chunks for %j', (text) => {
    expect(chunkStructured(text, md(800, 400))).toEqual([]);
    expect(chunkStructured(text, { maxTokens: 800, overlapTokens: 0, format: 'pdf' })).toEqual([]);
    expect(chunkStructured(text, { maxTokens: 800, overlapTokens: 0, format: 'plain' })).toEqual([]);
  });

  it('counts special-token text as plain text instead of throwing', () => {
    const chunks = expectContract('# H\n\nsee <|endoftext|> and <|fim_prefix|> here\n', md(800, 0));
    expect(chunks).toHaveLength(1);
  });

  it('rejects impossible sizes', () => {
    expect(() => chunkStructured('x', md(0, 0))).toThrow(/maxTokens/);
    expect(() => chunkStructured('x', md(15, 0))).toThrow(/maxTokens/);
    expect(() => chunkStructured('x', md(16, 0))).not.toThrow();
    expect(() => chunkStructured('x', md(100, 100))).toThrow(/overlapTokens/);
    expect(() => chunkStructured('x', md(100, -1))).toThrow(/overlapTokens/);
  });

  it('cuts a megabyte-long single line in bounded time (one count per piece, not per remainder)', () => {
    const line = JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `item${i}`, v: [i, i * 2] })));
    expect(line.length).toBeGreaterThan(700000);
    const started = Date.now();
    const chunks = chunkStructured(line, { maxTokens: 800, overlapTokens: 400, format: 'plain' });
    // Linear takes well under a second here; the quadratic cut it guards against took seconds at 20 KB.
    expect(Date.now() - started).toBeLessThan(30000);
    expect(chunks.map((c) => c.text).join('').length).toBeGreaterThanOrEqual(line.length);
    expect(chunks.every((c) => c.tokens <= 800)).toBe(true);
  });

  it('stays linear on hostile heading lines', () => {
    const hostile = `# a${' '.repeat(200000)}b\n${'#'.repeat(3)} x${' '.repeat(200000)}#y\n`;
    const started = Date.now();
    markdownSections(hostile);
    // Loose enough for a slower CI runner; a quadratic scan of these 400k-character lines takes far longer.
    expect(Date.now() - started).toBeLessThan(6000);
  });
});

describe('long pre-tokens (the tokenizer is quadratic on one long run)', () => {
  const MB = 1024 * 1024;
  function letters(n: number): string {
    let s = 0x2545f4914f6cdd1dn;
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      out.push(String.fromCharCode(97 + Number(s >> 59n) % 26));
    }
    return out.join('');
  }
  const cases: Array<[string, () => string]> = [
    ['1 MB of [a-z]', () => letters(MB)],
    ['1 MB of spaces', () => `x${' '.repeat(MB)}y`],
    ['1 MB of one CJK letter', () => '中'.repeat(MB / 2)],
    ['1 MB of one emoji', () => '😀'.repeat(MB / 4)],
  ];

  it('counts a 100k-letter run in bounded time', () => {
    const run = letters(100000);
    const started = Date.now();
    expect(countTokens(run)).toBeGreaterThan(1000);
    // ~0.1 s bounded, 4.4–6 s unbounded (quadratic BPE) on the development machine.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // A bound calibrated on this machine: linear chunking of 1 MB takes seconds
  // even on a slow runner, the quadratic path took 100+ s here.
  let bound: number | undefined;
  function timeBound(): number {
    if (bound === undefined) {
      countTokens('warm up the encoder');
      const sample = paragraph(8000); // ~50 KB of ordinary text
      const started = Date.now();
      countTokens(sample);
      bound = Math.max(20000, 25 * Math.max(1, Date.now() - started));
    }
    return bound;
  }

  it.each(cases)('%s chunks in linear time and keeps the contract', (_name, make) => {
    const text = make();
    for (const format of ['markdown', 'plain'] as const) {
      const opts = { maxTokens: 800, overlapTokens: 400, format };
      const started = Date.now();
      chunkStructured(text, opts);
      expect(Date.now() - started).toBeLessThan(timeBound());
      expectContract(text, opts);
    }
  }, 120_000);

  it('a long run inside a Markdown section next to normal text', () => {
    const text = `# A\n\n${paragraph(200)}\n\n${letters(200000)}\n\n## B\n\n${' '.repeat(100000)}x ${paragraph(50)}\n`;
    const started = Date.now();
    chunkStructured(text, md(300, 100));
    expect(Date.now() - started).toBeLessThan(timeBound());
    expectContract(text, md(300, 100));
  }, 120_000);
});

describe('pdf and plain formats', () => {
  it('pdf: one section per page, empty pages skipped, no heading path', () => {
    const page = (n: number): string => `Page ${n} heading\n\n${paragraph(200, n)}\n\n${paragraph(200, n + 1)}\n`;
    const text = `${page(1)}\f${page(2)}\f\f   \f${page(3)}\f`;
    const chunks = expectContract(text, { maxTokens: 800, overlapTokens: 0, format: 'pdf' });
    expect(chunks.map((c) => c.section)).toEqual([0, 1, 2]);
    expect(chunks.every((c) => c.headingPath === null && !c.text.includes('\f'))).toBe(true);
    expect(chunks[1].text.startsWith('Page 2 heading')).toBe(true);
  });

  it('pdf: long pages split on paragraphs, tiny pages merge forward', () => {
    const text = `cover\f${paragraph(200, 1)}\n\n${paragraph(200, 2)}\n\n${paragraph(200, 3)}\f`;
    const chunks = expectContract(text, { maxTokens: 300, overlapTokens: 0, format: 'pdf' });
    expect(chunks[0].text.startsWith('cover\f')).toBe(true);
    expect(new Set(chunks.map((c) => c.section))).toEqual(new Set([0]));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('plain: one section, split on blank lines; markdown syntax means nothing', () => {
    const text = `# not a heading\n\n${paragraph(200)}\n\n\`\`\`\n\n${paragraph(200, 1)}\n`;
    const chunks = expectContract(text, { maxTokens: 300, overlapTokens: 0, format: 'plain' });
    expect(chunks.every((c) => c.section === 0 && c.headingPath === null)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('whitespace runs at the chunk-size boundary (property)', () => {
  // Strings of an exact token count where the tokenizer allows it: the
  // largest repetition of `unit` that fits, then single characters of it.
  function ofTokens(n: number, unit: string): string {
    let lo = 0;
    let hi = 1;
    while (countTokens(unit.repeat(hi)) <= n) hi *= 2;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (countTokens(unit.repeat(mid)) <= n) lo = mid;
      else hi = mid;
    }
    let s = unit.repeat(lo);
    for (const ch of unit) {
      if (countTokens(s) === n) break;
      if (countTokens(s + ch) <= n) s += ch;
    }
    return s;
  }
  function wordsOfTokens(n: number): string {
    const words = ['alpha', 'beta', 'gamma.', 'delta', 'epsilon', 'gateway!', 'store', 'chunk?', 'token', 'route'];
    let s = '';
    for (let i = 0; countTokens(s) < n; i += 1) s += `${s ? ' ' : ''}${words[i % words.length]}`;
    while (countTokens(s) > n) s = s.slice(0, -1);
    return s;
  }
  const units: Array<[string, string]> = [
    ['spaces', ' '], ['space-tab', ' \t'], ['nbsp-mix', ' \u00a0\t '], ['blank-lines', '\n \n\t'],
  ];
  const shapes: Array<(w: string, b: string) => string> = [
    (w, b) => `${b}\n${w}\n${b}\n`,
    (w, b) => `# H\n\nintro${w}${b}${w}${b}`,
    (w, b) => `a\n\n${w}\n\n${b}\n\n${w}\n\nz`,
  ];

  it.each([16, 100, 800])('max %d: runs of max-1/max/max+1 before blocks of max-1/max/max+1', (max) => {
    for (const [, unit] of units) {
      for (const dw of [-1, 0, 1]) {
        const w = ofTokens(max + dw, unit);
        for (const db of [-1, 0, 1]) {
          const b = wordsOfTokens(max + db);
          shapes.forEach((shape, k) => {
            // The first shape in every overlap; the others without overlap. At
            // 800 (slow strings) only plain without overlap, plus markdown for
            // the heading shape; the blank-line cases below cover 800 in every
            // format and overlap.
            const formats = max === 800 ? (k === 1 ? ['plain', 'markdown'] as const : ['plain'] as const) : ['markdown', 'plain', 'pdf'] as const;
            const overlaps = max === 800 ? [0] : (k === 0 ? [0, Math.floor(max / 4), Math.floor(max / 2)] : [0]);
            for (const format of formats) {
              for (const overlap of overlaps) expectContract(shape(w, b), { maxTokens: max, overlapTokens: overlap, format });
            }
          });
        }
      }
    }
  }, 120_000);

  it.each([786, 787, 788, 789])('a %d-token run of blank lines joins the next block at max 800', (target) => {
    let w = '';
    while (countTokens(w + '\n \n\t') < target) w += '\n \n\t';
    const b = wordsOfTokens(799);
    for (const format of ['markdown', 'plain', 'pdf'] as const) {
      for (const overlap of [0, 200, 400]) {
        const chunks = expectContract(`${b}\n${w}\n${b}\n`, { maxTokens: 800, overlapTokens: overlap, format });
        expect(chunks.every((c) => c.text.trim() !== '')).toBe(true);
      }
    }
  });
});

describe('random documents (property)', () => {
  // Deterministic PRNG so a failure reproduces.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  function randomDoc(seed: number): string {
    const r = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const parts: string[] = [];
    const n = 5 + Math.floor(r() * 40);
    for (let i = 0; i < n; i += 1) {
      const kind = pick(['atx', 'setext', 'para', 'para', 'table', 'code', 'list', 'blank', 'emoji', 'longline', 'hr']);
      if (kind === 'atx') parts.push(`${'#'.repeat(1 + Math.floor(r() * 6))} H${i}${pick(['', ' ##', ' 😀'])}`);
      if (kind === 'setext') parts.push(`S${i}\n${pick(['===', '---'])}`);
      if (kind === 'para') parts.push(paragraph(5 + Math.floor(r() * 300), i));
      if (kind === 'table') parts.push(['| a | b |', '|---|---|', ...Array.from({ length: Math.floor(r() * 80) }, (_, k) => `| ${k} | ${paragraph(5, k)} |`)].join('\n'));
      if (kind === 'code') parts.push(['```', ...Array.from({ length: Math.floor(r() * 80) }, (_, k) => pick([`# c${k}`, '', `x = ${k}`])), pick(['```', ''])].join('\n'));
      if (kind === 'list') parts.push(Array.from({ length: 1 + Math.floor(r() * 30) }, (_, k) => `${'  '.repeat(k % 3)}- ${paragraph(6, k)}`).join('\n'));
      if (kind === 'blank') parts.push('   ');
      if (kind === 'emoji') parts.push('😀𝔘a'.repeat(1 + Math.floor(r() * 300)));
      if (kind === 'longline') parts.push(Array.from({ length: 300 }, (_, k) => `w${k}.`).join(pick([' ', ''])));
      if (kind === 'hr') parts.push('---');
    }
    const doc = parts.join(pick(['\n\n', '\n', '\n\n\n']));
    return r() < 0.3 ? doc.replace(/\n/g, '\r\n') : doc;
  }

  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %d keeps the contract in every format', (seed) => {
    const text = randomDoc(seed);
    const r = rng(seed * 31);
    const max = 100 + Math.floor(r() * 700);
    const overlap = Math.floor(r() * (max / 2));
    for (const format of ['markdown', 'pdf', 'plain'] as const) {
      expectContract(text, { maxTokens: max, overlapTokens: overlap, format });
    }
  });
});
