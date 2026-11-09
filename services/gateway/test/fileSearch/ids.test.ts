import { describe, it, expect } from '@jest/globals';
import { newFileId, newVectorStoreId, newJobId } from '../../src/fileSearch/ids';

describe('newFileId', () => {
  it('is prefixed with file- followed by 24 hex characters', () => {
    expect(newFileId()).toMatch(/^file-[0-9a-f]{24}$/);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newFileId()));
    expect(ids.size).toBe(1000);
  });
});

describe('newVectorStoreId', () => {
  it('is prefixed with vs_ followed by 24 hex characters', () => {
    expect(newVectorStoreId()).toMatch(/^vs_[0-9a-f]{24}$/);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newVectorStoreId()));
    expect(ids.size).toBe(1000);
  });
});

describe('newJobId', () => {
  // The schema backfill mints 'job_' || substr(md5(batch_id), 1, 24): a new
  // job id must have exactly that shape, so the two cannot be told apart.
  it('is prefixed with job_ followed by 24 lowercase hex characters', () => {
    expect(newJobId()).toMatch(/^job_[0-9a-f]{24}$/);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newJobId()));
    expect(ids.size).toBe(1000);
  });
});
