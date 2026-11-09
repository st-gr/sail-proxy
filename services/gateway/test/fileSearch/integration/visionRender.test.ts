// W3 Task 5 against the real poppler (pdftotext, pdfinfo, pdftoppm) and sharp, with a fake model:
// opt-in with FILE_SEARCH_TEST_BINARIES=1 like the other extractor suites.
// - a page of the scanned eval-corpus PDF reaches the model as a grey PNG data URL whose long side
//   is the bound (1568 px), rendered at the bounded dpi;
// - a page declaring a huge box is rendered small and quickly, never above the bound;
// - auto mode's layout pass picks the corpus table PDF's table pages and none of a prose PDF's.
import { readFileSync } from 'fs';
import { join } from 'path';
import sharp, { Metadata } from 'sharp';
import { runExtractor } from '../../../src/fileSearch/extractors/runners';
import { pageCount, splitPages } from '../../../src/fileSearch/extractors/pdfOcr';
import {
  defaultVisionDeps, selectVisionPages, transcribePdfPages, VisionDeps, VisionMemo,
} from '../../../src/fileSearch/visionTranscriber';
import type { CompletionCall } from '../../../src/fileSearch/orchestrationCompletion';

jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({ ingestion: { extractTimeoutMs: 60_000 }, parsing: { ocr: { languages: ['eng'] } } }),
  default: { getFileSearchConfig: () => ({ ingestion: { extractTimeoutMs: 60_000 }, parsing: { ocr: { languages: ['eng'] } } }) },
}));

const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
const d = RUN_BINARY_TESTS ? describe : describe.skip;

const CORPUS = join(__dirname, '../../../../../ci/file-search-eval/corpus');

function withFakeModel(): { deps: VisionDeps; calls: CompletionCall[] } {
  const calls: CompletionCall[] = [];
  return {
    calls,
    deps: {
      ...defaultVisionDeps,
      complete: async (call) => {
        calls.push(call);
        return { text: `transcribed ${call.messages[0].text}`, usage: { input: 1500, cacheWrite: 0, cachedRead: 0, output: 300 }, elapsedMs: 1 };
      },
    },
  };
}

async function decode(dataUrl: string): Promise<Metadata> {
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  return sharp(Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')).metadata();
}

d('vision rendering with the real binaries (FILE_SEARCH_TEST_BINARIES=1)', () => {
  it('a scanned corpus page reaches the model as a grey PNG with a 1568 px long side', async () => {
    const pdf = readFileSync(join(CORPUS, 'scanned/user-chapter-1-introduction.pdf'));
    const text = await runExtractor('pdftotext', ['-', '-'], pdf, { timeoutMs: 60_000 });
    const pages = pageCount(text);
    expect(pages).toBeGreaterThanOrEqual(2);
    const { deps, calls } = withFakeModel();
    const memo = new VisionMemo();
    const out = await transcribePdfPages(text, pdf, { mode: 'no_text', memo, settings: { maxPagesPerFile: 2 } }, deps);
    expect(defaultVisionDeps.unavailable()).toBeNull();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // eslint-disable-next-line no-await-in-loop
      const meta = await decode(call.messages[0].images![0]);
      expect(meta.format).toBe('png');
      expect(meta.channels).toBe(1);
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
      expect(Math.max(meta.width!, meta.height!)).toBeGreaterThan(1400);
    }
    expect(out.transcribed).toEqual([1, 2]);
    expect(splitPages(out.text)[0]).toBe('transcribed Transcribe page 1.\n');
    expect(pageCount(out.text)).toBe(pages);
    expect(memo.totals()).toMatchObject({ visionPages: 2, skippedPages: pages - 2, failedPages: 0 });
  }, 120_000);

  it('a page declaring a huge box renders small and fast, within the bound', async () => {
    // A one-page PDF with a 10,000 pt MediaBox (pdfOcr's gated suite uses the same shape).
    const pdf = Buffer.from([
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'), 'latin1');
    const { deps, calls } = withFakeModel();
    const started = Date.now();
    await transcribePdfPages('\f', pdf, { mode: 'all' }, deps);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(calls).toHaveLength(1);
    const meta = await decode(calls[0].messages[0].images![0]);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
  }, 60_000);

  it("auto's layout pass picks the table PDF's table pages and no page of a prose PDF", async () => {
    const select = async (file: string) => {
      const pdf = readFileSync(join(CORPUS, file));
      // Through the runner (bounded), never execFileSync with `input`: on macOS such a synchronous child
      // can wait for its stdin forever, and the synchronous call blocks jest's own timeout (a 1h50m hang).
      const text = await runExtractor('pdftotext', ['-', '-'], pdf, { timeoutMs: 60_000 });
      const layout = await defaultVisionDeps.layoutText(pdf, 60_000);
      return selectVisionPages('auto', splitPages(text), pageCount(text), splitPages(layout));
    };
    expect(await select('table/developer-tables.pdf')).toEqual([1, 2, 3, 4, 5]);
    expect(await select('pdf/developer-chapter-2-architecture.pdf')).toEqual([]);
    expect(await select('pdf/developer-chapter-13-plugin-system.pdf')).toEqual([]);
  }, 60_000);
});
