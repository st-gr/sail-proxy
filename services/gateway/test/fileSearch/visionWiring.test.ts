// How vision transcription is wired into extraction (no binaries, no SAP):
// - registry: a PDF's pdftotext text goes through the transcriber only when vision options are
//   given, BEFORE OCR, and OCR leaves the pages vision wrote alone;
// - chunkPipeline: the mode comes from the chunking setting (absent = off: no vision options at
//   all), with the ingestion's memo, the blob's sha256, the deadline, and every call billed to the
//   caller as `file_search/vision` with an `fs-vision-` request id.
let mockConfig: any;
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
  default: { getFileSearchConfig: () => mockConfig },
}));

const mockRunExtractor = jest.fn();
jest.mock('../../src/fileSearch/extractors/runners', () => ({
  ...jest.requireActual('../../src/fileSearch/extractors/runners'),
  runExtractor: (...a: any[]) => mockRunExtractor(...a),
}));

const mockTranscribe = jest.fn();
jest.mock('../../src/fileSearch/visionTranscriber', () => ({
  ...jest.requireActual('../../src/fileSearch/visionTranscriber'),
  transcribePdfPages: (...a: any[]) => mockTranscribe(...a),
}));

const mockOcr = jest.fn();
jest.mock('../../src/fileSearch/extractors/pdfOcr', () => ({
  ...jest.requireActual('../../src/fileSearch/extractors/pdfOcr'),
  ocrPdfPages: (...a: any[]) => mockOcr(...a),
}));

const mockEmit = jest.fn();
jest.mock('../../src/fileSearch/usage', () => ({
  ...jest.requireActual('../../src/fileSearch/usage'),
  emitFileSearchUsage: (...a: any[]) => mockEmit(...a),
}));

import { extractText } from '../../src/fileSearch/extractors/registry';
import { prepareFileChunks } from '../../src/fileSearch/chunkPipeline';
import { VisionMemo } from '../../src/fileSearch/visionTranscriber';
import { OcrMemo } from '../../src/fileSearch/extractors/pdfOcr';

const PDF = Buffer.from('%PDF-fake');
const PDFTOTEXT = 'scanned\f\f';
const STATIC = { type: 'static' as const, max_tokens: 200, overlap_tokens: 60, contextual: false };
const CALLER = { credentialId: 'key-1', authType: 'api_key' as const, onBehalfOf: 'owner@example.test' };

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { contextual: { fileDeadlineMs: 360_000 }, ingestion: { extractTimeoutMs: 5000 }, parsing: { ocr: { languages: ['eng'] } } };
  mockRunExtractor.mockResolvedValue(PDFTOTEXT);
  mockOcr.mockImplementation(async (text: string) => `${text}+ocr`);
  mockTranscribe.mockResolvedValue({ text: 'VISION\f\f', transcribed: [1] });
});

describe('registry', () => {
  it('without vision options the transcriber is never called and OCR sees pdftotext text', async () => {
    expect(await extractText('a.pdf', PDF, { ocr: { deadline: 5 } })).toBe(`${PDFTOTEXT}+ocr`);
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockOcr).toHaveBeenCalledWith(PDFTOTEXT, PDF, { deadline: 5, keepPages: [] });
  });

  it('with vision options the transcriber runs first and OCR keeps off the pages it wrote', async () => {
    const vision = { mode: 'no_text' as const };
    expect(await extractText('a.pdf', PDF, { vision })).toBe('VISION\f\f+ocr');
    expect(mockTranscribe).toHaveBeenCalledWith(PDFTOTEXT, PDF, vision);
    expect(mockOcr).toHaveBeenCalledWith('VISION\f\f', PDF, { keepPages: [1] });
    expect(mockTranscribe.mock.invocationCallOrder[0]).toBeLessThan(mockOcr.mock.invocationCallOrder[0]);
  });

  it('other formats never reach the transcriber', async () => {
    mockRunExtractor.mockResolvedValue('docx text');
    await extractText('a.docx', PDF, { vision: { mode: 'all' } });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });
});

describe('chunkPipeline', () => {
  const opts = (deadline: number) => ({
    extractTimeoutMs: 5000, maxTokensPerFile: 1_000_000, deadline, caller: CALLER, embeddingDimensions: 1536,
    ocr: { memo: new OcrMemo(), sha256: 'sha-1' }, vision: { memo: new VisionMemo() },
  });

  it('a setting without a vision mode (every setting before W3) passes no vision options', async () => {
    await prepareFileChunks('a.pdf', PDF, STATIC, opts(Date.now() + 60_000));
    expect(mockTranscribe).not.toHaveBeenCalled();
    await prepareFileChunks('a.pdf', PDF, { ...STATIC, vision: 'off' } as any, opts(Date.now() + 60_000));
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("the setting's mode, the ingestion's memo, sha256 and deadline reach the transcriber; calls bill file_search/vision", async () => {
    const o = opts(Date.now() + 60_000);
    await prepareFileChunks('a.pdf', PDF, { ...STATIC, vision: 'auto' } as any, o);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const visionOpts = mockTranscribe.mock.calls[0][2];
    expect(visionOpts).toMatchObject({ mode: 'auto', sha256: 'sha-1', deadline: o.deadline });
    expect(visionOpts.memo).toBe(o.vision.memo);

    visionOpts.onCall({ model: 'gemini-3.8-flash', usage: { input: 1500, cacheWrite: 0, cachedRead: 200, output: 700 }, elapsedMs: 1234 });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [caller, event] = mockEmit.mock.calls[0];
    expect(caller).toBe(CALLER);
    expect(event).toMatchObject({
      endpoint: 'file_search/vision', model: 'gemini-3.8-flash', unit: 'tokens', responseTime: 1234,
      inputTokens: 1500, outputTokens: 700, cacheWriteTokens: 0, cacheReadTokens: 200,
    });
    expect(event.requestId).toMatch(/^fs-vision-[0-9a-f-]{36}$/);
  });
});
