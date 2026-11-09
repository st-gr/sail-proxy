// Legacy Word (.doc) against the real antiword binary. Skipped unless FILE_SEARCH_TEST_BINARIES=1
// (as integration/extractors.test.ts); the dispatch, the switch and the runner limits are covered
// with a fake antiword by test/fileSearch/legacyDoc.test.ts.
//
// fixtures/legacy-word.doc: a Word 97–2003 file of three invented lines (no author or other
// metadata), written by macOS `textutil -convert doc`.
import * as fs from 'fs';
import * as path from 'path';
import { extractText, extractStructuredText } from '../../../src/fileSearch/extractors/registry';
import { readLegacyDoc } from '../../../src/fileSearch/extractors/legacyDoc';
import { DocumentReadError } from '../../../src/fileSearch/extractors/ooxml/limits';
import { ExtractionOutputTooLargeError, ExtractionTimeoutError, resolveBinary } from '../../../src/fileSearch/extractors/runners';

const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
// antiword has no Homebrew formula, so a macOS run with the binary suites on may not have it. CI
// installs it and fails its install step without it (.github/workflows/ci.yml), so there this
// suite always runs; elsewhere it skips, saying so.
const ANTIWORD_INSTALLED = (() => { try { resolveBinary('antiword'); return true; } catch { return false; } })();
const d = RUN_BINARY_TESTS && ANTIWORD_INSTALLED ? describe : describe.skip;
if (RUN_BINARY_TESTS && !ANTIWORD_INSTALLED) {
  // eslint-disable-next-line no-console
  console.warn('[legacyDoc.test.ts] SKIPPED — antiword is not on PATH; the real-binary .doc checks did not run.');
}

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'legacy-word.doc'));

d('legacy .doc against the real antiword (requires FILE_SEARCH_TEST_BINARIES=1)', () => {
  const savedSwitch = process.env.FILE_SEARCH_DOC;
  beforeEach(() => { delete process.env.FILE_SEARCH_DOC; });
  afterAll(() => {
    if (savedSwitch === undefined) delete process.env.FILE_SEARCH_DOC; else process.env.FILE_SEARCH_DOC = savedSwitch;
  });

  it('extracts the text of a Word 97–2003 file, as UTF-8', async () => {
    const text = await extractText('minutes.doc', FIXTURE, { timeoutMs: 10_000 });
    expect(text).toContain('Legacy Word fixture');
    expect(text).toContain('The quarterly harbour report lists seventeen lighthouses.');
    expect(text).toContain('Äpfel und Birnen kosten 3 Euro.');
  });

  it('gives the structure strategy the same text, as plain blocks', async () => {
    const structured = await extractStructuredText('minutes.doc', FIXTURE, { timeoutMs: 10_000 });
    expect(structured.format).toBe('plain');
    expect(structured.text).toBe(await extractText('minutes.doc', FIXTURE, { timeoutMs: 10_000 }));
  });

  it.each([
    ['random bytes', Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256))],
    ['a truncated Word file', FIXTURE.subarray(0, 3000)],
    ['an empty file', Buffer.alloc(0)],
    ['plain text named .doc', Buffer.from('just some text\n')],
  ])('refuses %s with a permanent DocumentReadError', async (_label, bytes) => {
    await expect(extractText('broken.doc', bytes, { timeoutMs: 10_000 })).rejects.toThrow(DocumentReadError);
  });

  // The timeout kill itself is proven with a converter that never ends (legacyDoc.test.ts, fake
  // antiword): the real one reads this fixture in a few milliseconds, too fast to race a timer.
  it('refuses a hostile file — an OLE header over 4 MiB of noise — within the timeout (5 s, with a 15 s ceiling for slow runners)', async () => {
    const noise = Buffer.from(Array.from({ length: 4 * 1024 * 1024 }, (_, i) => (i * 2654435761) % 251));
    const hostile = Buffer.concat([FIXTURE.subarray(0, 512), noise]);
    const started = Date.now();
    const error = await extractText('hostile.doc', hostile, { timeoutMs: 5_000 }).catch((e) => e);
    expect(error instanceof DocumentReadError || error instanceof ExtractionTimeoutError).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('is aborted at the output cap', async () => {
    await expect(readLegacyDoc(FIXTURE, { timeoutMs: 10_000, maxOutputBytes: 8 })).rejects.toThrow(ExtractionOutputTooLargeError);
  });

  it('stays off with FILE_SEARCH_DOC=off although antiword is installed (npm standalone CLI)', async () => {
    process.env.FILE_SEARCH_DOC = 'off';
    await expect(extractText('minutes.doc', FIXTURE, { timeoutMs: 10_000 }))
      .rejects.toThrow('legacy .doc files are not supported on this deployment');
  });
});
