// The built-in PowerPoint reader: slides in presentation order, each a `## Slide N` section with its
// text frames, tables as pipe tables and speaker notes under `### Notes`, a form feed after every
// slide (pages). Fixtures are built in memory (fixtures/ooxmlFixtures.ts).
jest.mock('../../src/fileSearch/extractors/runners', () => ({
  ...jest.requireActual('../../src/fileSearch/extractors/runners'),
  runExtractor: jest.fn(),
}));

jest.mock('../../src/fileSearch/structureChunkThread', () => {
  const actual = jest.requireActual('../../src/fileSearch/structureChunkThread');
  const { chunkStructuredWithSections: chunk } = jest.requireActual('../../src/fileSearch/structureChunker');
  return {
    ...actual,
    chunkStructuredOffThread: async (text: string, o: any) => {
      const { chunks, sections } = chunk(text, o);
      return { chunks, starts: chunks.map((c: any) => sections[c.section].start + c.sectionOffset), elapsedMs: 1, offThread: false };
    },
  };
});

import { prepareFileChunks } from '../../src/fileSearch/chunkPipeline';
import { readPptx } from '../../src/fileSearch/extractors/ooxml/pptx';
import { DocumentReadError } from '../../src/fileSearch/extractors/ooxml/limits';
import { extractStructuredText, extractText, isPagedFile, isSupportedExtension } from '../../src/fileSearch/extractors/registry';
import { runExtractor } from '../../src/fileSearch/extractors/runners';
import { chunkStructuredWithSections } from '../../src/fileSearch/structureChunker';
import { pageBreakOffsets, structuredChunkPages, staticChunkPages } from '../../src/fileSearch/pages';
import { chunkText } from '../../src/fileSearch/chunker';
import { pptx, pptxEntries, slideXml, withEntry, withoutEntry, zip, notesXml } from './fixtures/ooxmlFixtures';

const DECK = [
  {
    shapes: [
      { title: 'Quarterly review' },
      { text: ['Revenue grew', 'Costs fell'], placeholder: 'body' },
      { table: [['Region', 'Q1'], ['North', '10'], ['South | West', 'line one\nline two']] },
    ],
    notes: ['Mention the new office.', 'Then take questions.'],
  },
  { shapes: [] }, // an empty slide still counts
  { shapes: [{ group: [{ text: ['Inside a group'] }, { text: ['Second in group'] }] }, { title: ['Two-line', 'title'] }], hidden: true },
];

const EXPECTED = [
  '## Slide 1: Quarterly review\n\nRevenue grew\nCosts fell\n\n'
    + '| Region | Q1 |\n| --- | --- |\n| North | 10 |\n| South \\| West | line one line two |\n\n'
    + '### Notes\n\nMention the new office.\nThen take questions.\n\f\n',
  '## Slide 2\n\f\n',
  '## Slide 3 (hidden): Two-line title\n\nInside a group\n\nSecond in group\n\f\n',
].join('');

describe('readPptx', () => {
  it('renders slides in presentation order as Markdown sections with notes and a form feed per slide', async () => {
    expect(await readPptx(pptx(DECK), {})).toBe(EXPECTED);
  });

  it('follows the presentation\'s slide list, not the part names', async () => {
    const text = await readPptx(pptx(DECK, [2, 0, 1]), {});
    expect(text.split('\f\n').slice(0, 3).map((s) => s.split('\n')[0]))
      .toEqual(['## Slide 1 (hidden): Two-line title', '## Slide 2: Quarterly review', '## Slide 3']);
  });

  it('show="false" hides a slide like show="0"', async () => {
    const entries = withEntry(pptxEntries([{ shapes: [{ title: 'A' }] }]), {
      name: 'ppt/slides/slide1.xml', data: slideXml({ shapes: [{ title: 'A' }] }).replace('<p:sld ', '<p:sld show="false" '),
    });
    expect(await readPptx(zip(entries), {})).toBe('## Slide 1 (hidden): A\n\f\n');
  });

  it('is byte-stable for the same file', async () => {
    const bytes = pptx(DECK);
    expect(await readPptx(bytes, {})).toBe(await readPptx(bytes, {}));
  });

  it('leaves out the notes page\'s slide number and header placeholders, and an empty notes page', async () => {
    const text = await readPptx(pptx([{ shapes: [{ title: 'A' }], notes: [] }]), {});
    expect(text).toBe('## Slide 1: A\n\f\n');
  });

  it('a missing notes page is no failure', async () => {
    const entries = pptxEntries([{ shapes: [{ title: 'A' }], notes: ['n'] }]);
    const text = await readPptx(zip(withoutEntry(entries, 'ppt/notesSlides/notesSlide1.xml')), {});
    expect(text).toBe('## Slide 1: A\n\f\n');
  });

  it('keeps document text from looking like Markdown structure, and control characters out', async () => {
    const text = await readPptx(pptx([{ shapes: [{ title: 'T' }, { text: ['# not a heading', '```', '---', 'a\fb\u0007c', '   indented'] }] }]), {});
    expect(text).toBe('## Slide 1: T\n\n\\# not a heading\n\\```\n\\---\na b c\nindented\n\f\n');
    expect(pageBreakOffsets(text)).toHaveLength(1);
  });

  it('decodes entities and character references, line breaks and tabs', async () => {
    const xml = slideXml({ shapes: [{ title: 'T' }] }).replace('</p:spTree>',
      '<p:sp><p:nvSpPr><p:cNvPr id="9" name="x"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody>'
      + '<a:p><a:r><a:t>A &amp; B &lt;c&gt; &#x00E9;&#233;</a:t></a:r><a:br/><a:r><a:t>next</a:t></a:r><a:r><a:t>\tx</a:t></a:r></a:p>'
      + '<a:p><a:fld id="{1}" type="datetime"><a:t>2026-10-09</a:t></a:fld></a:p><a:p><a:r><a:t><![CDATA[raw <b>]]></a:t></a:r></a:p></p:txBody></p:sp></p:spTree>');
    const entries = withEntry(pptxEntries([{ shapes: [] }]), { name: 'ppt/slides/slide1.xml', data: xml });
    expect(await readPptx(zip(entries), {})).toBe('## Slide 1: T\n\nA & B <c> éé\nnext x\n2026-10-09\nraw <b>\n\f\n');
  });
});

describe('the registry', () => {
  const run = runExtractor as jest.MockedFunction<typeof runExtractor>;

  it('accepts .pptx, marks it paged, and never calls an external tool', async () => {
    expect(isSupportedExtension('pptx')).toBe(true);
    expect(isPagedFile('Deck.PPTX')).toBe(true);
    const bytes = pptx(DECK);
    expect(await extractText('deck.pptx', bytes, {})).toBe(EXPECTED);
    expect(await extractStructuredText('deck.pptx', bytes, {})).toEqual({ text: EXPECTED, format: 'markdown' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a slide becomes a section with its notes as a sub-section; slide numbers are pages for both strategies', async () => {
    const { text, format } = await extractStructuredText('deck.pptx', pptx(DECK), {});
    // minSectionTokens 0: every slide stays a section of its own (the default merges short ones forward, below).
    const { chunks, sections } = chunkStructuredWithSections(text, { maxTokens: 400, overlapTokens: 0, format, minSectionTokens: 0 });
    expect(sections.map((s) => s.headingPath)).toEqual([
      'Slide 1: Quarterly review', 'Slide 1: Quarterly review > Notes', 'Slide 2', 'Slide 3 (hidden): Two-line title',
    ]);
    const starts = chunks.map((c) => sections[c.section].start + c.sectionOffset);
    const pages = structuredChunkPages(text, chunks, starts);
    expect(chunks.map((c, i) => [c.headingPath, pages[i] && `${pages[i]!.first}-${pages[i]!.last}`])).toEqual([
      ['Slide 1: Quarterly review', '1-1'], ['Slide 1: Quarterly review > Notes', '1-1'], ['Slide 2', '2-2'],
      ['Slide 3 (hidden): Two-line title', '3-3'],
    ]);
    // By default short slides merge forward: the merged chunk spans their slides.
    const merged = chunkStructuredWithSections(text, { maxTokens: 400, overlapTokens: 0, format });
    const mergedPages = structuredChunkPages(text, merged.chunks, merged.chunks.map((c) => merged.sections[c.section].start + c.sectionOffset));
    expect(mergedPages.map((p) => p && `${p.first}-${p.last}`)).toEqual(['1-3']);
    const strategy = { type: 'static' as const, static: { max_chunk_size_tokens: 100, chunk_overlap_tokens: 0 } };
    const staticChunks = chunkText(text, strategy);
    const staticPages = staticChunkPages(text, strategy);
    expect(staticPages).toHaveLength(staticChunks.length);
    expect(staticPages[0]!.first).toBe(1);
    expect(staticPages[staticPages.length - 1]!.last).toBe(3);
  });
});

describe('through the ingestion pipeline (prepareFileChunks)', () => {
  const words = (prefix: string, n: number): string[] => [Array.from({ length: n }, (_, i) => `${prefix}w${i}`).join(' ')];
  const LONG = [
    { shapes: [{ title: 'One' }, { text: words('s1', 250) }], notes: words('n1', 40) },
    { shapes: [] },
    { shapes: [{ title: 'Three' }, { text: words('s3', 250) }] },
  ];
  const opts = () => ({ extractTimeoutMs: 5000, maxTokensPerFile: 1_000_000, deadline: Date.now() + 600_000, caller: null, embeddingDimensions: 1536 });
  const slideOf = (word: string): number => Number(/^[sn](\d)w/.exec(word)?.[1] ?? NaN);

  it('structure: chunks carry their slide numbers, slide headings in the heading path', async () => {
    const { chunks } = await prepareFileChunks('deck.pptx', pptx(LONG), { type: 'structure', max_tokens: 200, overlap_tokens: 0, contextual: false }, opts());
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      // The slide's words and its heading (an empty slide 2 merges forward into slide 3's section).
      const nums = [...c.text.split(/\s+/).map(slideOf), ...[...c.text.matchAll(/## Slide (\d)/g)].map((m) => Number(m[1]))]
        .filter((n) => !Number.isNaN(n));
      expect([c.pageStart, c.pageEnd]).toEqual([Math.min(...nums), Math.max(...nums)]);
    }
    expect(chunks.some((c) => c.pageStart === 2 && c.pageEnd === 3)).toBe(true);
    expect(chunks[0].headingPath).toBe('Slide 1: One');
    // The empty slide 2 merged forward into slide 3 (W2's short-section rule): siblings share no
    // heading, so that section's path is null; its "## Slide" lines stay in the chunk text.
    expect(chunks[chunks.length - 1]).toMatchObject({ headingPath: null, pageEnd: 3 });
  });

  it('static: the reader\'s text chunked by words, slide numbers as pages', async () => {
    const { chunks } = await prepareFileChunks('deck.pptx', pptx(LONG), { type: 'static', max_tokens: 200, overlap_tokens: 0, contextual: false }, opts());
    const text = await readPptx(pptx(LONG), {});
    expect(chunks.map((c) => c.text)).toEqual(chunkText(text, { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 0 } }).map((c) => c.text));
    for (const c of chunks) {
      const nums = c.text.split(/\s+/).map(slideOf).filter((n) => !Number.isNaN(n));
      expect(c.pageStart).toBeLessThanOrEqual(Math.min(...nums));
      expect(c.pageEnd).toBeGreaterThanOrEqual(Math.max(...nums));
    }
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[chunks.length - 1].pageEnd).toBe(3);
  });

  it('an xlsx gets no pages', async () => {
    const { xlsx } = jest.requireActual('./fixtures/ooxmlFixtures');
    const { chunks } = await prepareFileChunks('b.xlsx', xlsx([{ name: 'S', rows: [['a'], [1]] }]), { type: 'structure', max_tokens: 200, overlap_tokens: 0, contextual: false }, opts());
    expect(chunks.map((c) => [c.text, c.headingPath, c.pageStart])).toEqual([['## Sheet: S\n\n| a |\n| --- |\n| 1 |', 'Sheet: S', null]]);
  });
});

describe('pptx structure failures are permanent read errors', () => {
  it('a zip without a presentation', async () => {
    const entries = withoutEntry(pptxEntries(DECK), 'ppt/presentation.xml');
    await expect(readPptx(zip(entries), {})).rejects.toThrow(DocumentReadError);
    await expect(readPptx(zip(entries), {})).rejects.toThrow(/PowerPoint.*presentation part is missing/);
  });

  it('a listed slide that is missing', async () => {
    const entries = withoutEntry(pptxEntries(DECK), 'ppt/slides/slide2.xml');
    await expect(readPptx(zip(entries), {})).rejects.toThrow(/slide .*missing/);
  });

  it('an Excel file named .pptx', async () => {
    const { xlsx } = jest.requireActual('./fixtures/ooxmlFixtures');
    await expect(readPptx(xlsx([{ name: 'S', rows: [['a']] }]), {})).rejects.toThrow(DocumentReadError);
  });

  it('too many slides', async () => {
    const slides = Array.from({ length: 6 }, () => ({ shapes: [] }));
    await expect(readPptx(pptx(slides), { limits: { maxSlides: 5 } })).rejects.toThrow(/more than 5 slides/);
  });

  it('notes XML that is malformed fails the file', async () => {
    const entries = withEntry(pptxEntries([{ shapes: [], notes: ['x'] }]), {
      name: 'ppt/notesSlides/notesSlide1.xml', data: notesXml(['x']).replace('</p:notes>', '</p:wrong>'),
    });
    await expect(readPptx(zip(entries), {})).rejects.toThrow(DocumentReadError);
  });
});
