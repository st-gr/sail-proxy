// Task 11 review (C2): a lock-ordering deadlock between an ingestion write
// (ingestWorker.ts's commitChunks) and a store/store-file delete surfaces
// from Postgres as error code '40P01' (deadlock_detected). Before this fix,
// deleteVectorStore/deleteVectorStoreFile let that fall through to
// next(error) -> errorHandler.ts's generic 500, echoing the raw driver
// message. This is a new, narrowly-scoped mocked test file (not a
// modification of the existing test/fileSearch/vectorStoresController.test.ts,
// which mocks the same repository functions for its own, broader purpose)
// so the mapping itself has a direct regression guard independent of ever
// reproducing a real deadlock, which repository.ts's lock-ordering fix
// makes intentionally hard to trigger live (see
// integration/ingestWorker.test.ts's "ingestion-locks-first" tests for the
// live proof that the fix closes the race that used to cause 40P01 here).
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../src/fileSearch/db', () => ({
  isFileSearchAvailable: () => true,
  getPool: () => ({ query: jest.fn() }),
}));

jest.mock('../../src/services/configService', () => ({
  getFileSearchConfig: () => ({ limits: { maxFilesPerStore: 10000 } }),
}));

jest.mock('../../src/fileSearch/repository', () => {
  const actual: any = jest.requireActual('../../src/fileSearch/repository');
  return { ...actual, deleteStoreFile: jest.fn(), deleteStoreCascade: jest.fn() };
});

import * as vectorStoresController from '../../src/controllers/vectorStoresController';
import { deleteStoreFile, deleteStoreCascade } from '../../src/fileSearch/repository';

const mockDeleteStoreFile = deleteStoreFile as any;
const mockDeleteStoreCascade = deleteStoreCascade as any;

function makeRes(): any {
  const res: any = { headersSent: false, statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function baseReq(overrides: Record<string, any> = {}): any {
  return {
    headers: {}, params: { id: 'vs_aaaaaaaaaaaaaaaaaaaaaaaa', file_id: 'file-aaaaaaaaaaaaaaaaaaaaaaaa' },
    query: {}, body: {}, apiKeyInfo: { email: 'owner@example.com' },
    ...overrides,
  };
}

function deadlockError(): any {
  const err: any = new Error('deadlock detected');
  err.code = '40P01';
  return err;
}

describe('vectorStoresController deadlock (40P01) mapping (Task 11 review C2)', () => {
  it('deleteVectorStoreFile maps a 40P01 to a clean, retryable 409 instead of a raw 500', async () => {
    mockDeleteStoreFile.mockRejectedValue(deadlockError());
    const res = makeRes();
    const next = jest.fn();

    await vectorStoresController.deleteVectorStoreFile(baseReq(), res, next);

    expect(next).not.toHaveBeenCalled(); // never reaches errorHandler.ts's generic 500
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error.code).toBe('concurrent_modification');
    // The client-facing message must never echo the raw driver text.
    expect(res.body.error.message.toLowerCase()).not.toContain('deadlock');
    expect(res.body.error.message.toLowerCase()).not.toContain('40p01');
  });

  it('deleteVectorStore maps a 40P01 to a clean, retryable 409 instead of a raw 500', async () => {
    mockDeleteStoreCascade.mockRejectedValue(deadlockError());
    const res = makeRes();
    const next = jest.fn();

    await vectorStoresController.deleteVectorStore(baseReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error.code).toBe('concurrent_modification');
    expect(res.body.error.message.toLowerCase()).not.toContain('deadlock');
  });

  it('a non-deadlock error from deleteVectorStoreFile still falls through to next() unchanged', async () => {
    const otherError = new Error('connection reset');
    mockDeleteStoreFile.mockRejectedValue(otherError);
    const res = makeRes();
    const next = jest.fn();

    await vectorStoresController.deleteVectorStoreFile(baseReq(), res, next);

    expect(next).toHaveBeenCalledWith(otherError);
    expect(res.status).not.toHaveBeenCalled();
  });
});
