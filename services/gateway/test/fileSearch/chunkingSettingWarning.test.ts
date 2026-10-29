// An invalid file_search.chunking is read on every store create and every cockpit status call:
// it is warned about once per distinct invalid value, not on every read.

import { describe, it, expect, jest } from '@jest/globals';

const warn = jest.fn();
jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), warn: (...a: unknown[]) => warn(...a), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }),
}));

import { installationChunking, LEGACY_CHUNKING } from '../../src/fileSearch/chunkingSetting';

describe('installationChunking warnings', () => {
  it('warns once per distinct invalid value and never for a valid one', () => {
    const bad = { strategy: 'static' as const, maxChunkSizeTokens: 50, chunkOverlapTokens: 0, contextual: false };
    const otherBad = { strategy: 'static' as const, maxChunkSizeTokens: 800, chunkOverlapTokens: 401, contextual: false };
    for (let i = 0; i < 5; i++) expect(installationChunking({ ...bad })).toEqual(LEGACY_CHUNKING);
    expect(warn).toHaveBeenCalledTimes(1);
    installationChunking(otherBad);
    installationChunking(otherBad);
    expect(warn).toHaveBeenCalledTimes(2);
    installationChunking({ strategy: 'structure', maxChunkSizeTokens: 1000, chunkOverlapTokens: 200, contextual: true });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
