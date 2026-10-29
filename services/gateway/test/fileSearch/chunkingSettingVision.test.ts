// A store setting's vision mode (W3): validation (400 shapes), the key that tells per-setting chunk
// sets apart, a file's explicit static strategy (which keeps the store's vision mode), and the
// installation default for new stores (off unless configured; never on where vision is switched off).

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  ChunkingSetting,
  ChunkingStrategyError,
  LEGACY_CHUNKING,
  chunkingKey,
  installationChunking,
  resolveChunking,
  validateChunkingSetting,
} from '../../src/fileSearch/chunkingSetting';

const STRUCTURE: ChunkingSetting = { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true };
const STATIC: ChunkingSetting = { type: 'static', max_tokens: 300, overlap_tokens: 100, contextual: false };
const FILE_STATIC = { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } };
const FILE_STATIC_SETTING: ChunkingSetting = { type: 'static', max_tokens: 200, overlap_tokens: 50, contextual: false };
const CONFIG = { strategy: 'structure' as const, maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true };

function errorOf(fn: () => unknown): ChunkingStrategyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ChunkingStrategyError);
    return e as ChunkingStrategyError;
  }
  throw new Error('expected a ChunkingStrategyError');
}

afterEach(() => {
  delete process.env.FILE_SEARCH_VISION;
});

describe('validateChunkingSetting — vision', () => {
  it('accepts every mode with both types, contextual or not; off (or absent) leaves the field out', () => {
    for (const vision of ['no_text', 'auto', 'all'] as const) {
      expect(validateChunkingSetting({ ...STRUCTURE, vision })).toEqual({ ...STRUCTURE, vision });
      expect(validateChunkingSetting({ ...STATIC, vision })).toEqual({ ...STATIC, vision });
      expect(validateChunkingSetting({ ...STRUCTURE, contextual: false, vision })).toEqual({ ...STRUCTURE, contextual: false, vision });
    }
    expect(validateChunkingSetting({ ...STRUCTURE, vision: 'off' })).toEqual(STRUCTURE);
    expect(validateChunkingSetting(STRUCTURE)).toEqual(STRUCTURE);
    expect(validateChunkingSetting({ ...STRUCTURE, vision: null })).toEqual(STRUCTURE);
  });

  it('an unknown mode is invalid_value naming the supported modes; a non-string is invalid_type', () => {
    const bad = errorOf(() => validateChunkingSetting({ ...STRUCTURE, vision: 'sometimes' }));
    expect(bad).toMatchObject({ status: 400, param: 'chunking.vision', code: 'invalid_value' });
    expect(bad.message).toContain("'off', 'no_text', 'auto' and 'all'");
    expect(errorOf(() => validateChunkingSetting({ ...STRUCTURE, vision: true }))).toMatchObject({
      param: 'chunking.vision', code: 'invalid_type',
    });
    expect(errorOf(() => validateChunkingSetting({ ...STRUCTURE, vision: 'ALL' }))).toMatchObject({ code: 'invalid_value' });
    expect(errorOf(() => validateChunkingSetting({ ...STRUCTURE, vision: 'x' }, 'file_search.chunking')).param)
      .toBe('file_search.chunking.vision');
  });

  it('vision does not lift the contextual rule: contextual still needs structure', () => {
    expect(errorOf(() => validateChunkingSetting({ ...STATIC, contextual: true, vision: 'all' }))).toMatchObject({
      param: 'chunking.contextual', code: 'invalid_value',
    });
  });
});

describe('chunkingKey — vision', () => {
  it('a setting without vision keeps its pre-W3 key; each mode has its own', () => {
    expect(chunkingKey(STRUCTURE)).toBe('structure:800:0:contextual');
    expect(chunkingKey({ ...STRUCTURE, vision: 'off' })).toBe('structure:800:0:contextual');
    const keys = (['no_text', 'auto', 'all'] as const).map((vision) => chunkingKey({ ...STRUCTURE, vision }));
    expect(new Set([chunkingKey(STRUCTURE), ...keys]).size).toBe(4);
    expect(keys[1]).toBe('structure:800:0:contextual:vision-auto');
  });
});

describe('resolveChunking — a file with an explicit static strategy keeps the store\'s vision mode', () => {
  it('its sizes win (OpenAI semantics), the vision mode is the store\'s: it decides how the file is read, not cut', () => {
    expect(resolveChunking({ file: FILE_STATIC, store: { ...STRUCTURE, vision: 'auto' } }))
      .toEqual({ ...FILE_STATIC_SETTING, vision: 'auto' });
    expect(resolveChunking({ file: FILE_STATIC, store: STRUCTURE })).toEqual(FILE_STATIC_SETTING);
    expect(resolveChunking({ file: FILE_STATIC, store: null })).toEqual(FILE_STATIC_SETTING);
    expect(resolveChunking({ file: FILE_STATIC, installation: { ...STRUCTURE, vision: 'no_text' } }))
      .toEqual({ ...FILE_STATIC_SETTING, vision: 'no_text' });
  });

  it('never throws for such a file: an invalid store setting gives its vision only when that mode is valid', () => {
    expect(resolveChunking({ file: FILE_STATIC, store: { type: 'semantic', vision: 'all' } }))
      .toEqual({ ...FILE_STATIC_SETTING, vision: 'all' });
    expect(resolveChunking({ file: FILE_STATIC, store: { type: 'semantic', vision: 'bogus' } })).toEqual(FILE_STATIC_SETTING);
    expect(resolveChunking({ file: FILE_STATIC, store: 'garbage' })).toEqual(FILE_STATIC_SETTING);
  });

  it('a vision change of the store changes the key of such a file too (it is read again by a re-chunk)', () => {
    const before = resolveChunking({ file: FILE_STATIC, store: STRUCTURE });
    const after = resolveChunking({ file: FILE_STATIC, store: { ...STRUCTURE, vision: 'all' } });
    expect(chunkingKey(before)).not.toBe(chunkingKey(after));
  });
});

describe('installationChunking — the vision default for new stores (file_search.parsing.vision.default_mode)', () => {
  it('off by default: a new store gets no vision field, nothing is called unasked', () => {
    expect(installationChunking(CONFIG, 'off')).toEqual(STRUCTURE);
    expect(installationChunking(CONFIG, undefined)).toEqual(STRUCTURE);
  });

  it('a configured mode reaches new stores only; a NULL or recorded store is unchanged', () => {
    const installation = installationChunking(CONFIG, 'auto');
    expect(installation).toEqual({ ...STRUCTURE, vision: 'auto' });
    expect(resolveChunking({ installation })).toEqual({ ...STRUCTURE, vision: 'auto' });
    expect(resolveChunking({ store: null, installation })).toEqual(LEGACY_CHUNKING);
    expect(resolveChunking({ store: STATIC, installation })).toEqual(STATIC);
  });

  it('an invalid mode is off and keeps the configured chunking (not the 800/400 fallback)', () => {
    expect(installationChunking(CONFIG, 'bogus')).toEqual(STRUCTURE);
  });

  it('where vision is switched off (FILE_SEARCH_VISION=off, always in the npm standalone CLI) new stores get none', () => {
    process.env.FILE_SEARCH_VISION = 'off';
    expect(installationChunking(CONFIG, 'all')).toEqual(STRUCTURE);
  });
});
