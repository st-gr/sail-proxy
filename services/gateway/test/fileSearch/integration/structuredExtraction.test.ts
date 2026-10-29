// Structured extraction against the real pandoc / pdftotext binaries. Opt-in
// like ./extractors.test.ts (FILE_SEARCH_TEST_BINARIES=1); the unit suite
// (../structuredExtraction.test.ts) covers dispatch and arguments without them.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { extractStructuredText, extractText } from '../../../src/fileSearch/extractors/registry';
import { chunkStructured, structuredSections } from '../../../src/fileSearch/structureChunker';
import { runExtractorBuffer } from '../../../src/fileSearch/extractors/runners';

const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
const d = RUN_BINARY_TESTS ? describe : describe.skip;

const PDF_DIR = join(__dirname, '../../../../../ci/file-search-eval/corpus/pdf');

const SOURCE = [
  '# Install',
  '',
  'Intro paragraph that is long enough to be a real paragraph of the document.',
  '',
  '## Ports',
  '',
  '| Port | Service |',
  '|------|---------|',
  '| 8080 | gateway |',
  '| 4004 | admin   |',
  '',
  '+-------+-------+',
  '| A     | B     |',
  '+=======+=======+',
  '| para1 | cellx |',
  '|       |       |',
  '| para2 |       |',
  '+-------+-------+',
  '',
  '```sh',
  '# a shell comment, not a heading',
  'docker run -p 8080:8080 image',
  '```',
  '',
].join('\n');

d('structured extraction against real binaries (requires FILE_SEARCH_TEST_BINARIES=1)', () => {
  it('pandoc formats come back as GitHub-flavoured Markdown with headings, pipe tables and fences', async () => {
    for (const writer of ['docx', 'odt', 'epub']) {
      // eslint-disable-next-line no-await-in-loop -- through the bounded runner, never a synchronous child fed on stdin
      const bytes = await runExtractorBuffer('pandoc', ['-f', 'markdown', '-t', writer], Buffer.from(SOURCE, 'utf8'), { timeoutMs: 30_000 });
      const { text, format } = await extractStructuredText(`doc.${writer}`, bytes, { timeoutMs: 20000 });
      expect(format).toBe('markdown');
      expect(text).toMatch(/^# Install$/m);
      expect(text).toMatch(/^## Ports$/m);
      // Data rows, not the header row: pandoc 3.1.x's odt reader drops a pipe
      // table's header row (3.8+ keeps it).
      expect(text).toMatch(/^\| *8080 *\| *gateway *\|$/m);
      expect(text).toMatch(/^\| *4004 *\| *admin *\|$/m);
      expect(text).toContain('# a shell comment, not a heading');
      expect(text).toContain('para2'); // a table with block content stays (as HTML)
      expect(text).not.toContain('<span id=');
      const chunks = chunkStructured(text, { maxTokens: 800, overlapTokens: 0, format, minSectionTokens: 0 });
      expect(chunks.map((c) => c.headingPath)).toEqual(['Install', 'Install > Ports']);
      // The plain-text path (static) is unchanged: no heading markers.
      expect(await extractText(`doc.${writer}`, bytes, { timeoutMs: 20000 })).not.toMatch(/^# Install$/m);
    }
  });

  it('rst headings become ATX headings', async () => {
    const rst = Buffer.from('Install\n=======\n\nBody.\n\nPorts\n-----\n\nMore.\n', 'utf8');
    const { text } = await extractStructuredText('doc.rst', rst, { timeoutMs: 20000 });
    const chunks = chunkStructured(text, { maxTokens: 800, overlapTokens: 0, format: 'markdown', minSectionTokens: 0 });
    expect(chunks.map((c) => c.headingPath)).toEqual(['Install', 'Install > Ports']);
  });

  it('PDFs: the static pdftotext text, one section per non-empty page', async () => {
    for (const file of readdirSync(PDF_DIR).filter((f) => f.endsWith('.pdf'))) {
      const bytes = readFileSync(join(PDF_DIR, file));
      const { text, format } = await extractStructuredText(file, bytes, { timeoutMs: 60000 });
      expect(format).toBe('pdf');
      expect(text).toBe(await extractText(file, bytes, { timeoutMs: 60000 }));
      const pages = text.split('\f').filter((p) => p.trim() !== '').length;
      const opts = { maxTokens: 800, overlapTokens: 400, format, minSectionTokens: 0 } as const;
      expect(structuredSections(text, opts)).toHaveLength(pages);
      const chunks = chunkStructured(text, opts);
      for (const c of chunks) expect(c.text.includes('\f')).toBe(false);
    }
  });
});
