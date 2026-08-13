// Structural coverage for Task 4: LEASE_MINUTES (ingestWorker.ts) used to be
// interpolated directly into SQL at two sites -- reapZombies's housekeeping
// UPDATE and claimNext's own claiming UPDATE -- as `interval '${LEASE_MINUTES}
// minutes'`. LEASE_MINUTES is a module-local integer today, so nothing was
// actually injectable, but it was the one non-parameterised value left in the
// file, and the obvious next change (making the lease configurable) would
// have turned it into a real injection site. This test proves the value now
// reaches Postgres as a bound parameter, multiplied against a fixed
// `interval '1 minute'` literal, at BOTH sites -- not just one.
//
// Deliberately NOT a behavioural test: `$N::int * interval '1 minute'` and
// `interval '15 minutes'` select exactly the same rows, so a behavioural
// test would pass identically before and after this change and prove
// nothing about which form is actually in use. What proves the two forms
// are equivalent is the pre-existing ingestWorker suites (this file's
// sibling hermetic test/fileSearch/ingestWorker.test.ts, and the
// live-Postgres test/fileSearch/integration/ingestWorker.test.ts) staying
// green -- unchanged, still exercising real claim/lease/reap paths -- after
// this rewrite. This file only checks the SQL text and params shape;
// claimNext itself is exercised here against a mocked pool, hermetically,
// so it does not need FILE_SEARCH_TEST_DSN to run.
let mockPool: any;

jest.mock('../../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: jest.fn(() => mockPool),
  isFileSearchAvailable: jest.fn(() => true),
}));

const mockConfig = {
  enabled: true,
  embeddingModel: 'test-model',
  embeddingDimensions: 3,
  limits: { maxFileBytes: 1000000, maxTokensPerFile: 1000000, maxFilesPerStore: 10000 },
  ingestion: { concurrency: 1, extractTimeoutMs: 1000, maxRetries: 3 },
  blobStorage: { backend: 'db', localPath: '', s3: { bucket: '', prefix: '', endpoint: '', region: '' } },
};

jest.mock('../../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => mockConfig,
}));

import { claimNext } from '../../../src/fileSearch/ingestWorker';

interface CapturedQuery { sql: string; params: any[]; }

/** Drives one real claimNext() call against a mocked pool that just records
 *  every query it receives (returning an empty row set each time, so
 *  claimNext resolves null without needing any seeded data). claimNext
 *  itself issues exactly two queries in this order: reapZombies's UPDATE
 *  first, then its own claiming UPDATE -- both captured here, unmodified. */
async function captureClaimQueries(): Promise<CapturedQuery[]> {
  const calls: CapturedQuery[] = [];
  mockPool = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    }),
  };
  const result = await claimNext();
  expect(result).toBeNull(); // no rows in the mocked pool -- confirms both queries actually ran to completion
  return calls;
}

describe('ingest lease interval: bound as a parameter, not interpolated (structural, no database)', () => {
  it('claimNext issues exactly two queries per call: reapZombies\'s housekeeping UPDATE, then its own claiming UPDATE', async () => {
    const calls = await captureClaimQueries();
    expect(calls.length).toBe(2);
  });

  it('reapZombies\'s housekeeping UPDATE binds LEASE_MINUTES as a parameter, never interpolating it into the SQL', async () => {
    const calls = await captureClaimQueries();
    const reapQuery = calls.find((c) => /SET status = 'failed'/.test(c.sql));
    expect(reapQuery).toBeDefined();
    expect(reapQuery!.sql).not.toMatch(/interval\s+'\d+\s+minutes'/i);
    expect(reapQuery!.sql).toMatch(/\$\d+\s*::\s*int\s*\*\s*interval\s+'1 minute'/i);
    expect(reapQuery!.params).toContain(15);
  });

  it('claimNext\'s own claiming UPDATE binds LEASE_MINUTES as a parameter, never interpolating it into the SQL', async () => {
    const calls = await captureClaimQueries();
    const claimQuery = calls.find((c) => /claimed_at = now\(\)/.test(c.sql));
    expect(claimQuery).toBeDefined();
    expect(claimQuery!.sql).not.toMatch(/interval\s+'\d+\s+minutes'/i);
    expect(claimQuery!.sql).toMatch(/\$\d+\s*::\s*int\s*\*\s*interval\s+'1 minute'/i);
    expect(claimQuery!.params).toContain(15);
  });

  it('neither query leaves a bare interval literal anywhere in its SQL text (catches a mutation reverting either site)', async () => {
    const calls = await captureClaimQueries();
    for (const { sql } of calls) {
      expect(sql).not.toMatch(/interval\s+'\d+\s+minutes'/i);
    }
  });
});
