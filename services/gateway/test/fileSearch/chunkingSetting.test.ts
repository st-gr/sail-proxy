// The effective chunking strategy: file `static` > store setting > installation
// default (at store creation) > static 800/400, its validation, and the OpenAI-shaped
// strategy a file object reports.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { chunkText, resolveChunkingStrategy } from '../../src/fileSearch/chunker';
import {
  ChunkingSetting,
  ChunkingStrategyError,
  LEGACY_CHUNKING,
  fileChunkingStrategyObject,
  installationChunking,
  parseFileChunkingStrategy,
  resolveChunking,
  toStaticChunkingStrategy,
  validateChunkingSetting,
} from '../../src/fileSearch/chunkingSetting';
import { FILE_SEARCH_DEFAULTS } from '../../src/services/configService';
import { STATIC_CHUNK_PINS } from './fixtures/staticChunkPins';

const STRUCTURE: ChunkingSetting = { type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: true };
const STORE_STATIC: ChunkingSetting = { type: 'static', max_tokens: 300, overlap_tokens: 100, contextual: false };
const CONFIG: ChunkingSetting = { type: 'structure', max_tokens: 1000, overlap_tokens: 200, contextual: false };
const FILE_STATIC = { type: 'static', static: { max_chunk_size_tokens: 200, chunk_overlap_tokens: 50 } };
const FILE_STATIC_SETTING: ChunkingSetting = { type: 'static', max_tokens: 200, overlap_tokens: 50, contextual: false };

function errorOf(fn: () => unknown): ChunkingStrategyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ChunkingStrategyError);
    return e as ChunkingStrategyError;
  }
  throw new Error('expected a ChunkingStrategyError');
}

describe('resolveChunking — the order file static > store > installation > 800/400', () => {
  it.each<[string, Parameters<typeof resolveChunking>[0], ChunkingSetting]>([
    ['file static wins over a structure store', { file: FILE_STATIC, store: STRUCTURE }, FILE_STATIC_SETTING],
    ['file static wins over a NULL store', { file: FILE_STATIC, store: null }, FILE_STATIC_SETTING],
    ['file static wins over the installation default', { file: FILE_STATIC, installation: CONFIG }, FILE_STATIC_SETTING],
    ['file auto takes the store setting', { file: { type: 'auto' }, store: STRUCTURE }, STRUCTURE],
    ['no file strategy takes the store setting', { file: null, store: STORE_STATIC }, STORE_STATIC],
    ['a NULL store is static 800/400, never the installation default', { file: null, store: null, installation: CONFIG }, LEGACY_CHUNKING],
    ['an auto file in a NULL store is static 800/400', { file: { type: 'auto' }, store: null }, LEGACY_CHUNKING],
    ['a store being created (store absent) takes the installation default', { installation: CONFIG }, CONFIG],
    ['nothing at all is static 800/400', {}, LEGACY_CHUNKING],
    ['a stored legacy non-static type falls through to the store, as auto did', { file: { type: 'foo' }, store: STORE_STATIC }, STORE_STATIC],
  ])('%s', (_name, layers, expected) => {
    expect(resolveChunking(layers)).toEqual(expected);
  });

  describe('stored legacy file rows resolve as the old worker chunked them, never throwing', () => {
    const LEGACY_REPORT = { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } };
    it.each<[string, unknown]>([
      ['static without params', { type: 'static' }],
      ['static with null params', { type: 'static', static: null }],
      ['static with empty params', { type: 'static', static: {} }],
      ['static without overlap', { type: 'static', static: { max_chunk_size_tokens: 500 } }],
      ['static out of range', { type: 'static', static: { max_chunk_size_tokens: 50, chunk_overlap_tokens: 0 } }],
      ['static overlap over half', { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 401 } }],
      ['static string sizes', { type: 'static', static: { max_chunk_size_tokens: '800', chunk_overlap_tokens: '400' } }],
    ])('%s → static 800/400, even in a structure store', (_name, file) => {
      const setting = resolveChunking({ file, store: STRUCTURE });
      expect(setting).toEqual(LEGACY_CHUNKING);
      expect(fileChunkingStrategyObject(setting)).toEqual(LEGACY_REPORT);
    });

    it('fractional sizes in range are kept exactly as the old worker passed them to the chunker', () => {
      const file = { type: 'static', static: { max_chunk_size_tokens: 300.5, chunk_overlap_tokens: 100.25 } };
      const setting = resolveChunking({ file, store: STRUCTURE });
      expect(setting).toEqual({ type: 'static', max_tokens: 300.5, overlap_tokens: 100.25, contextual: false });
      expect(toStaticChunkingStrategy(setting)).toEqual(resolveChunkingStrategy(file));
      const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
      expect(chunkText(text, toStaticChunkingStrategy(setting))).toEqual(chunkText(text, resolveChunkingStrategy(file)));
      expect(fileChunkingStrategyObject(setting)).toEqual(file);
    });

    it('the request boundary stays strict for the same shapes', () => {
      errorOf(() => parseFileChunkingStrategy({ type: 'static' }));
      errorOf(() => parseFileChunkingStrategy({ type: 'static', static: { max_chunk_size_tokens: 300.5, chunk_overlap_tokens: 100 } }));
    });
  });

  it('LEGACY_CHUNKING is static 800/400 without context', () => {
    expect(LEGACY_CHUNKING).toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
  });

  it('rejects a store setting that does not validate', () => {
    errorOf(() => resolveChunking({ store: { type: 'static', max_tokens: 50, overlap_tokens: 0, contextual: false } }));
  });
});

describe('validateChunkingSetting — the store setting', () => {
  it('accepts both types and the range ends', () => {
    expect(validateChunkingSetting({ type: 'static', max_tokens: 100, overlap_tokens: 50, contextual: false }))
      .toEqual({ type: 'static', max_tokens: 100, overlap_tokens: 50, contextual: false });
    expect(validateChunkingSetting({ type: 'structure', max_tokens: 4096, overlap_tokens: 2048, contextual: true }))
      .toEqual({ type: 'structure', max_tokens: 4096, overlap_tokens: 2048, contextual: true });
  });

  it('defaults contextual to false and drops unknown keys', () => {
    expect(validateChunkingSetting({ type: 'structure', max_tokens: 800, overlap_tokens: 0, extra: 1 }))
      .toEqual({ type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: false });
  });

  it.each<[string, unknown, string]>([
    ['not an object', 'static', 'chunking'],
    ['an array', [], 'chunking'],
    ['an unknown type', { type: 'semantic', max_tokens: 800, overlap_tokens: 0 }, 'chunking.type'],
    ['a missing type', { max_tokens: 800, overlap_tokens: 0 }, 'chunking.type'],
    ['max below 100', { type: 'static', max_tokens: 99, overlap_tokens: 0 }, 'chunking.max_tokens'],
    ['max above 4096', { type: 'structure', max_tokens: 4097, overlap_tokens: 0 }, 'chunking.max_tokens'],
    ['a fractional max', { type: 'static', max_tokens: 800.5, overlap_tokens: 0 }, 'chunking.max_tokens'],
    ['a string max', { type: 'static', max_tokens: '800', overlap_tokens: 0 }, 'chunking.max_tokens'],
    ['a negative overlap', { type: 'static', max_tokens: 800, overlap_tokens: -1 }, 'chunking.overlap_tokens'],
    ['overlap over half of max', { type: 'structure', max_tokens: 800, overlap_tokens: 401 }, 'chunking.overlap_tokens'],
    ['contextual with static', { type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: true }, 'chunking.contextual'],
    ['a non-boolean contextual', { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: 'yes' }, 'chunking.contextual'],
  ])('rejects %s', (_name, raw, param) => {
    const err = errorOf(() => validateChunkingSetting(raw));
    expect(err.param).toBe(param);
    expect(err.status).toBe(400);
  });
});

describe('parseFileChunkingStrategy — the OpenAI request field', () => {
  it('absent is null', () => {
    expect(parseFileChunkingStrategy(undefined)).toBeNull();
    expect(parseFileChunkingStrategy(null)).toBeNull();
  });

  it('auto is kept as auto', () => {
    expect(parseFileChunkingStrategy({ type: 'auto' })).toEqual({ type: 'auto' });
  });

  it('static is normalised to its two OpenAI fields', () => {
    expect(parseFileChunkingStrategy({ ...FILE_STATIC, extra: true })).toEqual(FILE_STATIC);
  });

  it('an unknown type is an OpenAI-style invalid_value naming the supported values', () => {
    for (const type of ['structure', 'other', 'semantic', 'STATIC']) {
      const err = errorOf(() => parseFileChunkingStrategy({ type }));
      expect(err.param).toBe('chunking_strategy.type');
      expect(err.code).toBe('invalid_value');
      expect(err.message).toBe(`Invalid value: '${type}'. Supported values are: 'auto' and 'static'.`);
    }
  });

  it.each<[string, unknown, string, string]>([
    ['not an object', 'auto', 'chunking_strategy', 'invalid_type'],
    ['an array', [{ type: 'auto' }], 'chunking_strategy', 'invalid_type'],
    ['no type', {}, 'chunking_strategy.type', 'missing_required_parameter'],
    ['static without params', { type: 'static' }, 'chunking_strategy.static', 'missing_required_parameter'],
    ['static without max', { type: 'static', static: { chunk_overlap_tokens: 0 } },
      'chunking_strategy.static.max_chunk_size_tokens', 'missing_required_parameter'],
    ['static without overlap', { type: 'static', static: { max_chunk_size_tokens: 800 } },
      'chunking_strategy.static.chunk_overlap_tokens', 'missing_required_parameter'],
    ['static max below 100', { type: 'static', static: { max_chunk_size_tokens: 99, chunk_overlap_tokens: 0 } },
      'chunking_strategy.static.max_chunk_size_tokens', 'invalid_value'],
    ['static max above 4096', { type: 'static', static: { max_chunk_size_tokens: 4097, chunk_overlap_tokens: 0 } },
      'chunking_strategy.static.max_chunk_size_tokens', 'invalid_value'],
    ['static overlap over half', { type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 401 } },
      'chunking_strategy.static.chunk_overlap_tokens', 'invalid_value'],
    ['static string max', { type: 'static', static: { max_chunk_size_tokens: '800', chunk_overlap_tokens: 0 } },
      'chunking_strategy.static.max_chunk_size_tokens', 'invalid_type'],
  ])('rejects %s', (_name, raw, param, code) => {
    const err = errorOf(() => parseFileChunkingStrategy(raw));
    expect(err.param).toBe(param);
    expect(err.code).toBe(code);
  });
});

describe('fileChunkingStrategyObject — what a vector_store.file reports', () => {
  it('a structure file reports {type: other}', () => {
    expect(fileChunkingStrategyObject(STRUCTURE)).toEqual({ type: 'other' });
    expect(fileChunkingStrategyObject({ ...STRUCTURE, contextual: false })).toEqual({ type: 'other' });
  });

  it('a static file reports its resolved static parameters, as OpenAI does', () => {
    expect(fileChunkingStrategyObject(LEGACY_CHUNKING))
      .toEqual({ type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } });
    expect(fileChunkingStrategyObject(FILE_STATIC_SETTING)).toEqual(FILE_STATIC);
  });
});

describe('installationChunking — file_search.chunking', () => {
  const NEW_DEFAULT: ChunkingSetting = { type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true };

  it('the built-in default (no chunking block at all) is static 800/400 without contexts: an upgrade never starts context calls', () => {
    expect(installationChunking(FILE_SEARCH_DEFAULTS.chunking)).toEqual(LEGACY_CHUNKING);
  });

  it('the shipped api_config.json sets the evaluated setting, structure 800/0 with contexts, explicitly', () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '../../api_config.json'), 'utf8'))
      .api_config.capabilities.file_search.chunking;
    expect(shipped).toEqual({ strategy: 'structure', max_chunk_size_tokens: 800, chunk_overlap_tokens: 0, contextual: true });
  });

  it('the new default reaches only new stores: a NULL (pre-W2) store stays static 800/400, a recorded setting stays as recorded', () => {
    const installation = installationChunking({ strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true });
    expect(resolveChunking({ installation })).toEqual(NEW_DEFAULT);
    expect(resolveChunking({ file: null, store: null, installation })).toEqual(LEGACY_CHUNKING);
    expect(resolveChunking({ file: { type: 'auto' }, store: null, installation })).toEqual(LEGACY_CHUNKING);
    const plainStructure = { type: 'structure', max_tokens: 600, overlap_tokens: 50, contextual: false };
    expect(resolveChunking({ file: null, store: plainStructure, installation })).toEqual(plainStructure);
    expect(resolveChunking({ file: null, store: STORE_STATIC, installation })).toEqual(STORE_STATIC);
    expect(resolveChunking({ file: FILE_STATIC, installation })).toEqual(FILE_STATIC_SETTING);
  });

  it('reads a configured structure default', () => {
    expect(installationChunking({ strategy: 'structure', maxChunkSizeTokens: 1000, chunkOverlapTokens: 200, contextual: true }))
      .toEqual({ type: 'structure', max_tokens: 1000, overlap_tokens: 200, contextual: true });
  });

  it('an invalid configured default falls back to static 800/400', () => {
    for (const bad of [
      { strategy: 'static' as const, maxChunkSizeTokens: 800, chunkOverlapTokens: 401, contextual: false },
      { strategy: 'static' as const, maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true },
      { strategy: 'semantic' as any, maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: false },
    ]) {
      expect(installationChunking(bad)).toEqual(LEGACY_CHUNKING);
    }
  });
});

describe('the old static default reproduces today\'s static chunks', () => {
  const corpus = join(__dirname, '../../../../ci/file-search-eval/corpus/markdown');
  // file_search.chunking {strategy: 'static'} restores it (the absent keys default to 800/400, not contextual).
  const OLD_DEFAULT = { strategy: 'static' as const, maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false };
  it.each(STATIC_CHUNK_PINS.filter(([, size, overlap]) => size === 800 && overlap === 400))(
    '%s', (file, _size, _overlap, count, sha256) => {
      const setting = resolveChunking({ installation: installationChunking(OLD_DEFAULT) });
      const chunks = chunkText(readFileSync(join(corpus, file), 'utf8'), toStaticChunkingStrategy(setting));
      expect({ count: chunks.length, sha256: createHash('sha256').update(JSON.stringify(chunks)).digest('hex') })
        .toEqual({ count, sha256 });
    },
  );

  it('a NULL store resolves to the same chunks', () => {
    expect(toStaticChunkingStrategy(resolveChunking({ store: null })))
      .toEqual({ type: 'static', static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } });
  });

  it('toStaticChunkingStrategy refuses a structure setting', () => {
    expect(() => toStaticChunkingStrategy(STRUCTURE)).toThrow(/structure/);
  });
});
