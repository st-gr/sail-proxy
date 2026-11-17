/**
 * An extraction tool's stderr can quote the uploaded document. The Error a failed tool run
 * rejects with keeps that text for the file's last_error and the console line, but the entry
 * shipped for the stored log names only the tool and its exit code.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { getDefaultLogger } from '@libs/logger';
import { ExtractorExitError, runExtractor } from '../src/fileSearch/extractors/runners';
import { extractText } from '../src/fileSearch/extractors/registry';
import { startLogShipper, ShippedLogEntry } from '../src/services/logShipper';

const MARKER = 'CONTENT-MARKER-of-Jane-Roe';
const RUN_BINARY_TESTS = process.env.FILE_SEARCH_TEST_BINARIES === '1';
const withPandoc = RUN_BINARY_TESTS ? it : it.skip;

describe("an extraction tool's stderr stays out of the shipped log", () => {
  let consoleLines: string[];
  let shipped: ShippedLogEntry[];
  let stop: () => void;

  beforeEach(() => {
    consoleLines = [];
    shipped = [];
    for (const m of ['info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation((l: unknown) => { consoleLines.push(String(l)); });
    }
    stop = startLogShipper({ publish: async (b) => { shipped.push(...b); }, settings: () => ({ enabled: true, minLevel: 'INFO' }), warn: () => undefined });
  });
  afterEach(() => { stop(); jest.restoreAllMocks(); });

  // The shipper flushes on a 1 s timer; real timers here, because a real child process runs.
  const flushed = async (): Promise<string> => {
    await new Promise((r) => setTimeout(r, 1100));
    return JSON.stringify(shipped);
  };

  it('the Error keeps the stderr for the file and the console; its logText is the tool and the exit code', () => {
    const error = new ExtractorExitError('pandoc', 64, `Error at "source": ${MARKER}`);
    expect(error.message).toBe(`pandoc exited with code 64: Error at "source": ${MARKER}`);
    expect((error as any).logText).toBe('pandoc exited with code 64');
    expect(Object.keys(error)).not.toContain('logText');
    expect(JSON.stringify(error)).not.toContain('logText');
  });

  it('a real failing child process: the console line holds its stderr, the shipped error does not', async () => {
    const error = await runExtractor('sh', ['-c', `echo "${MARKER}" >&2; exit 3`], Buffer.alloc(0), { timeoutMs: 10_000 })
      .then(() => null, (e) => e);
    expect(error).toBeInstanceOf(ExtractorExitError);
    getDefaultLogger().error('IngestWorker', 'Ingestion attempt failed for store vs_1, file file_1', error, { permanent: true });
    const text = await flushed();
    expect(consoleLines.some((l) => l.includes(MARKER))).toBe(true);
    expect(text).not.toContain(MARKER);
    expect(shipped.find((e) => e.component === 'IngestWorker')?.error).toBe('Error: sh exited with code 3');
  });

  withPandoc('through the real extractor with pandoc: pandoc quotes a path with the marker; the console holds it, the stored entry does not', async () => {
    // a csv-table whose file does not exist: pandoc exits with 99 and names the path on stderr
    const doc = Buffer.from(`Title\n=====\n\n.. csv-table:: T\n   :file: /nonexistent/${MARKER}.csv\n`, 'utf8');
    const error = await extractText('upload.rst', doc, { timeoutMs: 20_000 }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(ExtractorExitError);
    expect((error as Error).message).toContain(MARKER);
    const text = await flushed();
    expect(consoleLines.some((l) => l.includes(MARKER))).toBe(true);
    const entry = shipped.find((e) => e.component === 'FileSearchExtractor' && e.level === 'ERROR');
    expect(entry).toBeDefined();
    expect(entry!.message).not.toContain(MARKER);
    expect(entry!.error).toBe('Error: pandoc exited with code 99');
    expect(text).not.toContain(MARKER);
  });
});
