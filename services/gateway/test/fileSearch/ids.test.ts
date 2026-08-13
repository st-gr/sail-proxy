import { describe, it, expect } from '@jest/globals';
import { newFileId, newVectorStoreId } from '../../src/fileSearch/ids';

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
