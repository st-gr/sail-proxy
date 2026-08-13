// Opt-in integration coverage against the real pandoc / pdftotext binaries.
// Skipped by default so CI stays hermetic on machines that don't have these
// tools installed; the unit suite (test/fileSearch/extractors.test.ts and
// test/fileSearch/runners.test.ts) already covers dispatch, encoding, and
// process-safety logic without needing either binary. Gating pattern matches
// ../integration/migration.test.ts (`const d = COND ? describe : describe.skip`).

import { execFileSync } from 'child_process';
import { extractText } from '../../../src/fileSearch/extractors/registry';

const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
const d = RUN_BINARY_TESTS ? describe : describe.skip;

// A hand-built, minimal-but-valid PDF: one page, one text run. Poppler's
// pdftotext accepts this even without a proper xref table (it falls back to
// its recovery scanner), so this needs no external generator.
function tinyPdfBuffer(text: string): Buffer {
  const content = `BT /F1 24 Tf 10 100 Td (${text}) Tj ET`;
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 200 200]/Contents 5 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    `5 0 obj<</Length ${content.length}>>`,
    'stream',
    content,
    'endstream',
    'endobj',
    'trailer<</Size 6/Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdf, 'latin1');
}

// Generate a tiny .docx by round-tripping through pandoc itself (markdown ->
// docx). This is the real pandoc binary under test, just used here as a
// fixture generator rather than the thing under test.
function tinyDocxBuffer(text: string): Buffer {
  return execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx'], { input: `# ${text}\n` });
}

d('extractors against real binaries (requires FILE_SEARCH_TEST_BINARIES=1)', () => {
  it('extracts text from a generated PDF via pdftotext', async () => {
    const pdf = tinyPdfBuffer('Hello PDF');
    const out = await extractText('doc.pdf', pdf, { timeoutMs: 10000 });
    expect(out).toContain('Hello PDF');
  });

  it('extracts text from a generated DOCX via pandoc', async () => {
    const docx = tinyDocxBuffer('Hello Docx');
    const out = await extractText('doc.docx', docx, { timeoutMs: 10000 });
    expect(out).toContain('Hello Docx');
  });

  it('extracts text from ODT and EPUB via pandoc', async () => {
    const odt = execFileSync('pandoc', ['-f', 'markdown', '-t', 'odt'], { input: '# Hello Odt\n' });
    const epub = execFileSync('pandoc', ['-f', 'markdown', '-t', 'epub'], { input: '# Hello Epub\n' });
    expect(await extractText('doc.odt', odt, { timeoutMs: 10000 })).toContain('Hello Odt');
    expect(await extractText('doc.epub', epub, { timeoutMs: 10000 })).toContain('Hello Epub');
  });

  it('extracts text from RST via pandoc', async () => {
    const rst = Buffer.from('Hello Rst\n==========\n\nBody text.\n', 'utf8');
    const out = await extractText('doc.rst', rst, { timeoutMs: 10000 });
    expect(out).toContain('Hello Rst');
  });

  it('surfaces a captured-stderr error for a corrupt DOCX rather than hanging', async () => {
    const garbage = Buffer.from('this is not a zip/docx file at all', 'utf8');
    await expect(extractText('bad.docx', garbage, { timeoutMs: 10000 })).rejects.toThrow();
  });

  it('never lets a hostile filename reach a shell, even through the real pandoc binary', async () => {
    // The filename is never passed to pandoc's argv or a shell — only the
    // pandoc reader flag (derived from the extension) and the raw bytes on
    // stdin are. A semicolon-laden basename must extract normally, not error
    // out or have any side effect.
    const docx = tinyDocxBuffer('Injection Check');
    const out = await extractText('a"; touch /tmp/file-search-pwned; echo ".docx', docx, { timeoutMs: 10000 });
    expect(out).toContain('Injection Check');
  });
});
