// Parent-section assembly (pure part): the section rebuilt from its chunks,
// exact; a window centred on the hit that never exceeds the limit; the hit
// chunk always inside; gaps and mismatches handled without inventing text.
import { assembleParent, assembleParentSection, SectionChunk } from '../../src/fileSearch/parentSections';
import { pageBreakOffsets, spanPages, structuredChunkPages } from '../../src/fileSearch/pages';
import { chunkStructuredWithSections, countTokens } from '../../src/fileSearch/structureChunker';

function sectionOf(text: string, maxTokens: number, overlapTokens: number) {
  const { chunks, sections } = chunkStructuredWithSections(text, { maxTokens, overlapTokens, format: 'markdown' });
  // the longest section, so it spans several chunks
  const counts = sections.map((_, s) => chunks.filter((c) => c.section === s).length);
  const s = counts.indexOf(Math.max(...counts));
  const ords = chunks.map((c, ord) => ({ ...c, ord })).filter((c) => c.section === s);
  const siblings: SectionChunk[] = ords.map((c) => ({ ord: c.ord, sectionOffset: c.sectionOffset, text: c.text, tokens: c.tokens }));
  return { sectionText: text.slice(sections[s].start, sections[s].end), siblings };
}

const PARAGRAPHS = Array.from({ length: 60 }, (_, i) =>
  `Paragraph ${i} describes setting number ${i}: what it does, its default value ${i * 7}, and when to change it.`).join('\n\n');
const DOC = `# Settings\n\n${PARAGRAPHS}\n\n# Other\n\nShort other section.`;

describe('assembleParent', () => {
  const { sectionText, siblings } = sectionOf(DOC, 120, 40);

  it('the test section spans many overlapping chunks', () => {
    expect(siblings.length).toBeGreaterThan(10);
    expect(siblings.some((c, i) => i > 0 && c.sectionOffset < siblings[i - 1].sectionOffset + siblings[i - 1].text.length)).toBe(true);
  });

  it('rebuilds the whole section exactly when it fits, from any hit and any sibling order', () => {
    const shuffled = [...siblings].reverse();
    for (const hit of siblings) {
      expect(assembleParent(shuffled, hit, 8000)).toBe(sectionText);
    }
  });

  it('over the limit: a window around the hit, never over the limit, holding the hit, inside the section', () => {
    for (const limit of [200, 300, 500]) {
      for (const hit of siblings) {
        const parent = assembleParent(siblings, hit, limit)!;
        expect(parent).not.toBeNull();
        expect(countTokens(parent)).toBeLessThanOrEqual(limit);
        expect(parent).toContain(hit.text);
        expect(sectionText).toContain(parent);
        // the hit sits at its own offset in the window, not at some repeat of its text
        const windowStart = sectionText.indexOf(parent);
        expect(sectionText.slice(windowStart, windowStart + parent.length).indexOf(hit.text))
          .toBe(hit.sectionOffset - windowStart);
      }
    }
  });

  it('centres the window: a middle hit gets text on both sides, about as much each way', () => {
    const hit = siblings[Math.floor(siblings.length / 2)];
    const parent = assembleParent(siblings, hit, 400)!;
    const at = parent.indexOf(hit.text);
    const before = at;
    const after = parent.length - at - hit.text.length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    expect(Math.abs(before - after)).toBeLessThan(0.35 * (before + after));
    // and uses most of the budget
    expect(countTokens(parent)).toBeGreaterThan(400 * 0.6);
  });

  it('a hit at the section start extends only forwards, using the budget', () => {
    const parent = assembleParent(siblings, siblings[0], 400)!;
    expect(parent.startsWith(siblings[0].text)).toBe(true);
    expect(countTokens(parent)).toBeGreaterThan(400 * 0.6);
  });

  it('a hit chunk larger than the limit is returned alone', () => {
    const big = sectionOf(DOC, 800, 0);
    const hit = big.siblings[0];
    expect(countTokens(hit.text)).toBeGreaterThan(300);
    expect(assembleParent(big.siblings, hit, 300)).toBe(hit.text);
  });

  it('a missing sibling ends (or starts) the run at the gap; text is never invented', () => {
    const mid = Math.floor(siblings.length / 2);
    const hit = siblings[mid];
    const withoutAfter = siblings.filter((_, i) => i !== mid + 2);
    const parent = assembleParent(withoutAfter, hit, 8000)!;
    expect(sectionText.startsWith(parent)).toBe(true);
    expect(parent.endsWith(siblings[mid + 1].text)).toBe(true);
    const withoutBefore = siblings.filter((_, i) => i !== mid - 2);
    const parent2 = assembleParent(withoutBefore, hit, 8000)!;
    expect(sectionText.endsWith(parent2)).toBe(true);
    expect(parent2.startsWith(siblings[mid - 1].text)).toBe(true);
  });

  it('null when the hit is not among the siblings or its text does not sit at its offset', () => {
    const hit = siblings[3];
    expect(assembleParent(siblings.filter((c) => c.ord !== hit.ord), hit, 8000)).toBeNull();
    expect(assembleParent(siblings, { ...hit, text: `${hit.text}x` }, 8000)).toBeNull();
    expect(assembleParent(siblings, { ...hit, sectionOffset: hit.sectionOffset + 1 }, 8000)).toBeNull();
  });

  it('whitespace-only siblings keep the rebuild exact', () => {
    const blank = ' \t'.repeat(2000); // ~2000 tokens of whitespace: chunks of only whitespace
    const doc = `# Gap\n\nBefore the gap, some words that matter.\n\n${blank}\n\nAfter the gap, more words that matter.`;
    const { chunks, sections } = chunkStructuredWithSections(doc, { maxTokens: 100, overlapTokens: 0, format: 'markdown' });
    expect(chunks.some((c) => !/\S/.test(c.text))).toBe(true);
    const sibs = chunks.map((c, ord) => ({ ord, sectionOffset: c.sectionOffset, text: c.text, tokens: c.tokens }));
    const hit = sibs[sibs.length - 1];
    expect(assembleParent(sibs, hit, 8000)).toBe(doc.slice(sections[0].start, sections[0].end));
  });
});

describe('assembleParentSection: pages of a parent', () => {
  // Short PDF pages (merged forward into multi-page sections), an empty page, unique words.
  const page = (n: number) => Array.from({ length: 3 }, (_, k) => `Page ${n} line ${k} words w${n}x${k} and more w${n}y${k}.`).join('\n');
  const PDF = [1, 2, 3, 0, 5, 6, 7, 8, 9, 10].map((n) => `${n === 0 ? '' : page(n)}\n\f`).join('');

  it('spans from the page of the window\'s first character to that of its last, at any limit', () => {
    const { chunks, sections } = chunkStructuredWithSections(PDF, { maxTokens: 40, overlapTokens: 10, format: 'pdf' });
    const starts = chunks.map((c) => sections[c.section].start + c.sectionOffset);
    const pages = structuredChunkPages(PDF, chunks, starts);
    expect(sections.some((s) => (PDF.slice(s.start, s.end).match(/\f/g) ?? []).length >= 1)).toBe(true); // merged pages
    const breaks = pageBreakOffsets(PDF);
    let multiPage = 0;
    for (const limit of [40, 80, 200, 8000]) {
      chunks.forEach((c, ord) => {
        if (!/\S/.test(c.text)) return;
        const siblings = chunks.map((x, o) => ({ ord: o, sectionOffset: x.sectionOffset, text: x.text, tokens: x.tokens, section: x.section }))
          .filter((x) => x.section === c.section);
        const parent = assembleParentSection(siblings, { ord, sectionOffset: c.sectionOffset, text: c.text, pages: pages[ord]! }, limit)!;
        const at = PDF.indexOf(parent.text);
        expect(PDF.lastIndexOf(parent.text)).toBe(at);
        expect(parent.pages).toEqual(spanPages(PDF, breaks, at, at + parent.text.length));
        if (parent.pages!.last > parent.pages!.first) multiPage += 1;
      });
    }
    expect(multiPage).toBeGreaterThan(0);
  });

  it('no pages for a hit without pages', () => {
    const { siblings } = sectionOf(DOC, 120, 40);
    expect(assembleParentSection(siblings, siblings[2], 8000)).toEqual({ text: assembleParent(siblings, siblings[2], 8000) });
  });
});
