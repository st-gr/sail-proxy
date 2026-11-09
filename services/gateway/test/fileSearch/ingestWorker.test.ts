// Hermetic (no database, no DSN) tests for the ingest worker's shape:
// availability gating, idempotent start/stop, and that stop wakes an idle
// loop immediately rather than waiting out the poll interval. The properties
// that actually need a real database — the claim race, lease recovery, the
// retry budget, and the store-delete interleave — cannot be demonstrated
// against a mock and live in test/fileSearch/integration/ingestWorker.test.ts
// instead (per the task brief's explicit instruction).
let mockAvailable = false;
let mockPool: any = null;

jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: jest.fn(() => mockPool),
  isFileSearchAvailable: jest.fn(() => mockAvailable),
}));

const mockConfig = {
  enabled: true,
  embeddingModel: 'test-model',
  embeddingDimensions: 3,
  limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
  ingestion: { concurrency: 1, extractTimeoutMs: 1000, maxRetries: 3 },
  blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
};

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

import {
  claimNext, processOne, startIngestWorker, stopIngestWorker, __isRunningForTests, __sanitizeErrorMessageForTests,
} from '../../src/fileSearch/ingestWorker';
import { getDefaultLogger } from '@libs/logger';
import * as runners from '../../src/fileSearch/extractors/runners';

describe('ingestWorker (hermetic, no database)', () => {
  beforeEach(() => {
    mockAvailable = false;
    mockPool = null;
    mockConfig.ingestion.concurrency = 1;
    mockConfig.ingestion.extractTimeoutMs = 1000;
  });

  afterEach(async () => {
    await stopIngestWorker();
  });

  it('claimNext returns null when file_search has no pool configured', async () => {
    mockPool = null;
    expect(await claimNext()).toBeNull();
  });

  it('claimNext still returns its committed claim when stamping the job\'s started_at fails', async () => {
    const warn = jest.spyOn(getDefaultLogger(), 'warn');
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('UPDATE fs_jobs')) throw new Error('connection reset');
      if (sql.includes('claimed_at = now()')) return { rows: [{ store_id: 'vs_1', file_id: 'file-1', batch_id: 'vsfb_1' }] };
      return { rows: [] };
    });
    mockPool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    await expect(claimNext()).resolves.toEqual({ storeId: 'vs_1', fileId: 'file-1' });
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE fs_jobs'))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('processOne resolves without throwing when file_search has no pool configured', async () => {
    mockPool = null;
    await expect(processOne('vs_1', 'file-1')).resolves.toBeUndefined();
  });

  it('startIngestWorker is a no-op (does not start loops) when file_search is unavailable', () => {
    mockAvailable = false;
    startIngestWorker();
    expect(__isRunningForTests()).toBe(false);
  });

  it('startIngestWorker sweeps leftover fs-extract-* directories older than the extraction timeout', async () => {
    mockAvailable = true;
    mockConfig.ingestion.extractTimeoutMs = 12_345;
    const query = jest.fn().mockResolvedValue({ rows: [] });
    mockPool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const info = jest.spyOn(getDefaultLogger(), 'info');
    const sweep = jest.spyOn(runners, 'sweepStaleExtractDirs').mockResolvedValue(3);
    startIngestWorker();
    await new Promise((r) => setImmediate(r));
    expect(sweep).toHaveBeenCalledWith(10 * 60_000);
    expect(info).toHaveBeenCalledWith('IngestWorker', expect.stringMatching(/Removed 3 .*fs-extract/));
    sweep.mockRestore();
    await stopIngestWorker();
  });

  it('adds a minute of margin to a long extraction timeout', async () => {
    mockAvailable = true;
    mockConfig.ingestion.extractTimeoutMs = 20 * 60_000;
    const query = jest.fn().mockResolvedValue({ rows: [] });
    mockPool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const sweep = jest.spyOn(runners, 'sweepStaleExtractDirs').mockResolvedValue(0);
    startIngestWorker();
    expect(sweep).toHaveBeenCalledWith(21 * 60_000);
    sweep.mockRestore();
    await stopIngestWorker();
  });

  it('startIngestWorker is not stopped by a failing sweep', async () => {
    mockAvailable = true;
    const query = jest.fn().mockResolvedValue({ rows: [] });
    mockPool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    const sweep = jest.spyOn(runners, 'sweepStaleExtractDirs').mockRejectedValue(new Error('EACCES'));
    expect(() => startIngestWorker()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(__isRunningForTests()).toBe(true);
    sweep.mockRestore();
    await stopIngestWorker();
  });

  it('stopIngestWorker resolves without throwing when the worker was never started', async () => {
    expect(__isRunningForTests()).toBe(false);
    await expect(stopIngestWorker()).resolves.toBeUndefined();
  });

  it('startIngestWorker is idempotent: a second call while already running does not start a second set of loops', () => {
    mockAvailable = true;
    mockConfig.ingestion.concurrency = 2; // distinguishable from 1: a real second start would double 2 -> 4, not 1 -> 2
    const query = jest.fn().mockResolvedValue({ rows: [] });
    mockPool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    startIngestWorker();
    startIngestWorker(); // must be a genuine no-op, not a second set of loops

    // Deliberately synchronous, no await/setImmediate: each of `concurrency`
    // loops runs synchronously from startIngestWorker's for-loop down through
    // runLoop -> claimNext -> reapZombies's own `await pool.connect()` call
    // (which is itself reached synchronously, since calling an async
    // function executes its body up to its first await without yielding) —
    // so by the time both startIngestWorker() calls above have returned,
    // exactly `concurrency` connect calls have fired, no more, regardless of
    // how many queries a single claimNext cycle issues internally (any
    // later ones haven't had a microtask tick to run yet). A real second
    // set of loops would double this to 4 in the same synchronous window.
    expect(mockPool.connect.mock.calls.length).toBe(2);
    expect(__isRunningForTests()).toBe(true);
  });

  it('stopIngestWorker wakes an idle loop immediately rather than waiting out the poll interval', async () => {
    mockAvailable = true;
    // Always returns no claimable row, so the loop immediately goes idle and
    // sleeps for POLL_INTERVAL_MS (2000ms) unless woken.
    const query = jest.fn().mockResolvedValue({ rows: [] });
    mockPool = { query, connect: jest.fn(async () => ({ query, release: jest.fn() })) };
    startIngestWorker();
    expect(__isRunningForTests()).toBe(true);

    const start = Date.now();
    await stopIngestWorker();
    const elapsedMs = Date.now() - start;

    expect(__isRunningForTests()).toBe(false);
    // Comfortably under the 2000ms poll interval — proves the emitted
    // 'wake' event resolved the sleep rather than the loop simply timing out
    // on its own right as the test happened to finish.
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// __sanitizeErrorMessageForTests — final whole-branch review, Important #3.
// last_error is written unmodified and served back over
// GET /vector_stores/{id}/files -- it can carry a raw Postgres driver
// message (control characters, unbounded length) or a spawn-failure message
// embedding an extractor binary's absolute filesystem path (see
// runners.ts's resolveBinary doc comment). Direct, hermetic coverage of the
// transformation itself; ingestWorker.integration.test.ts additionally
// proves it's genuinely wired into handleFailure against a real Postgres
// error and a realistic spawn error.
// ---------------------------------------------------------------------------
describe('__sanitizeErrorMessageForTests', () => {
  it('strips control characters', () => {
    const withControlChars = `bad\x00null\x1bescape\x07bell${String.fromCharCode(127)}del`;
    const sanitized = __sanitizeErrorMessageForTests(withControlChars);
    // eslint-disable-next-line no-control-regex
    expect(sanitized).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(sanitized).toContain('bad');
    expect(sanitized).toContain('del');
  });

  it('collapses an absolute filesystem path to a placeholder, exactly the shape runners.ts\'s spawn-launch-failure message produces', () => {
    const sanitized = __sanitizeErrorMessageForTests('Failed to launch pandoc: spawn /usr/local/bin/pandoc EACCES');
    expect(sanitized).not.toContain('/usr/local/bin/pandoc');
    expect(sanitized).toBe('Failed to launch pandoc: spawn [path] EACCES');
  });

  it('leaves a genuine Postgres driver message (no path, no control characters) readable and intact', () => {
    const pgMessage = 'expected 3 dimensions, not 2';
    expect(__sanitizeErrorMessageForTests(pgMessage)).toBe(pgMessage);
  });

  it('truncates a message well beyond the persisted length bound', () => {
    const huge = 'x'.repeat(2000);
    const sanitized = __sanitizeErrorMessageForTests(huge);
    expect(sanitized.length).toBeLessThan(600);
    expect(sanitized).toMatch(/truncated/);
  });

  it('does not truncate a message comfortably under the bound', () => {
    const short = 'a normal, human-readable failure message';
    expect(__sanitizeErrorMessageForTests(short)).toBe(short);
  });
});
