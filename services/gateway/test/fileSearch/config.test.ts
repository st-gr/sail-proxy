import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getFileSearchConfig } from '../../src/services/configService';
import { installationChunking } from '../../src/fileSearch/chunkingSetting';

describe('getFileSearchConfig', () => {
  it('returns the shipped defaults', () => {
    const c = getFileSearchConfig();
    expect(c.enabled).toBe(true);
    expect(c.embeddingDimensions).toBe(1536);
    expect(c.chunking).toEqual({ strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true });
    expect(c.contextual).toEqual({
      model: 'gemini-3.5-flash-lite', maxDocumentTokens: 32000, concurrency: 4, requestTimeoutMs: 30000, fileDeadlineMs: 360000,
      maxInputTokensPerFile: 20000000,
    });
    expect(c.parentSections).toEqual({ maxTokens: 1500, scope: 'tool' });
    expect(c.hybrid.candidates).toBe(50);
    expect(c.hybrid.lexicalQuery).toBe('any');
    expect(c.hybrid.rerank.enabled).toBe('auto');
    expect(c.hybrid.rerank.model).toBe('cohere-reranker');
    expect(c.hybrid.rerank.input).toBe('context_and_text');
    expect(c.blobStorage.backend).toBe('db');
    expect(c.ann).toEqual({ enabled: false, exactMaxChunks: 20000, minFraction: 0.05 });
  });

  it('never returns cohere-reranker-35, which this tenant does not deploy', () => {
    expect(getFileSearchConfig().hybrid.rerank.model).not.toBe('cohere-reranker-35');
  });

  describe('contextual', () => {
    let tmpDir: string;
    const contextualWith = (contextual: unknown): any => {
      fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: { capabilities: { file_search: { contextual } } } }));
      jest.resetModules();
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      return require('../../src/services/configService').getFileSearchConfig().contextual;
    };
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextual-config-'));
      process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    });
    afterEach(() => {
      delete process.env.CONFIG_FILE_PATH;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads every key and defaults each absent one', () => {
      expect(contextualWith({
        model: 'anthropic--claude-4.5-haiku', max_document_tokens: 16000, concurrency: 2, request_timeout_ms: 5000, file_deadline_ms: 60000,
        max_input_tokens_per_file: 500000,
      })).toEqual({
        model: 'anthropic--claude-4.5-haiku', maxDocumentTokens: 16000, concurrency: 2, requestTimeoutMs: 5000, fileDeadlineMs: 60000,
        maxInputTokensPerFile: 500000,
      });
      expect(contextualWith({ concurrency: 8 })).toEqual({
        model: 'gemini-3.5-flash-lite', maxDocumentTokens: 32000, concurrency: 8, requestTimeoutMs: 30000, fileDeadlineMs: 360000,
        maxInputTokensPerFile: 20000000,
      });
    });
  });

  describe('chunking and rerank input', () => {
    let tmpDir: string;
    const fileSearchWith = (fileSearch: unknown): any => {
      fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: { capabilities: { file_search: fileSearch } } }));
      jest.resetModules();
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      return require('../../src/services/configService').getFileSearchConfig();
    };
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunking-config-'));
      process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    });
    afterEach(() => {
      delete process.env.CONFIG_FILE_PATH;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('a block without a strategy (every configuration from before it existed) stays static with its sizes, never contextual', () => {
      expect(fileSearchWith({ chunking: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }).chunking)
        .toEqual({ strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false });
      expect(fileSearchWith({ chunking: { max_chunk_size_tokens: 500, chunk_overlap_tokens: 100 } }).chunking)
        .toEqual({ strategy: 'static', maxChunkSizeTokens: 500, chunkOverlapTokens: 100, contextual: false });
      expect(fileSearchWith({ chunking: { max_chunk_size_tokens: 600 } }).chunking)
        .toEqual({ strategy: 'static', maxChunkSizeTokens: 600, chunkOverlapTokens: 400, contextual: false });
      // and it resolves to a static store setting: no context calls
      expect(installationChunking(fileSearchWith({ chunking: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } }).chunking))
        .toEqual({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
    });

    it('a missing or empty block is static 800/400 without contexts, as the form shows it', () => {
      const plainStatic = { strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false };
      expect(fileSearchWith({}).chunking).toEqual(plainStatic);
      expect(fileSearchWith({ chunking: {} }).chunking).toEqual(plainStatic);
      expect(fileSearchWith({ chunking: null }).chunking).toEqual(plainStatic);
    });

    it('the shipped file sets structure 800/0 with contexts explicitly, so new installations are unchanged', () => {
      const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../../api_config.json'), 'utf8'))
        .api_config.capabilities.file_search;
      expect(shipped.chunking).toEqual({ strategy: 'structure', max_chunk_size_tokens: 800, chunk_overlap_tokens: 0, contextual: true });
      expect(installationChunking(fileSearchWith(shipped).chunking))
        .toEqual({ type: 'structure', max_tokens: 800, overlap_tokens: 0, contextual: true });
    });

    it('an absent contextual is off, whatever the strategy: the form\'s switch shows off and no context call is made', () => {
      expect(fileSearchWith({ chunking: { strategy: 'structure' } }).chunking)
        .toEqual({ strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: false });
      expect(installationChunking(fileSearchWith({ chunking: { strategy: 'structure', max_chunk_size_tokens: 1000 } }).chunking))
        .toEqual({ type: 'structure', max_tokens: 1000, overlap_tokens: 0, contextual: false });
    });

    it('contextual true without a strategy means structure (contexts exist only there)', () => {
      expect(fileSearchWith({ chunking: { contextual: true } }).chunking)
        .toEqual({ strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true });
      expect(installationChunking(fileSearchWith({ chunking: { max_chunk_size_tokens: 600, contextual: true } }).chunking))
        .toEqual({ type: 'structure', max_tokens: 600, overlap_tokens: 0, contextual: true });
      expect(fileSearchWith({ chunking: { contextual: false } }).chunking)
        .toEqual({ strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false });
    });

    it('absent overlap defaults by the strategy: structure 0, static 400', () => {
      expect(fileSearchWith({ chunking: { strategy: 'static' } }).chunking)
        .toEqual({ strategy: 'static', maxChunkSizeTokens: 800, chunkOverlapTokens: 400, contextual: false });
      expect(fileSearchWith({ chunking: { strategy: 'structure', contextual: true } }).chunking)
        .toEqual({ strategy: 'structure', maxChunkSizeTokens: 800, chunkOverlapTokens: 0, contextual: true });
      expect(fileSearchWith({ chunking: { strategy: 'static', max_chunk_size_tokens: 500, chunk_overlap_tokens: 100, contextual: false } }).chunking)
        .toEqual({ strategy: 'static', maxChunkSizeTokens: 500, chunkOverlapTokens: 100, contextual: false });
    });

    it('reads hybrid.rerank.input; anything else is the default, context and text', () => {
      expect(fileSearchWith({ hybrid: { rerank: { input: 'text' } } }).hybrid.rerank.input).toBe('text');
      expect(fileSearchWith({ hybrid: { rerank: { input: 'context_and_text' } } }).hybrid.rerank.input).toBe('context_and_text');
      expect(fileSearchWith({ hybrid: { rerank: { input: 'both' } } }).hybrid.rerank.input).toBe('context_and_text');
      expect(fileSearchWith({ hybrid: { rerank: { enabled: false } } }).hybrid.rerank).toEqual({ enabled: false, model: 'cohere-reranker', input: 'context_and_text' });
    });
  });

  describe('parent_sections', () => {
    let tmpDir: string;
    const parentSectionsWith = (parent_sections: unknown): any => {
      fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: { capabilities: { file_search: { parent_sections } } } }));
      jest.resetModules();
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      return require('../../src/services/configService').getFileSearchConfig().parentSections;
    };
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-sections-config-'));
      process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    });
    afterEach(() => {
      delete process.env.CONFIG_FILE_PATH;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads both keys and defaults each absent one', () => {
      expect(parentSectionsWith({ max_tokens: 3000, scope: 'all' })).toEqual({ maxTokens: 3000, scope: 'all' });
      expect(parentSectionsWith({ scope: 'off' })).toEqual({ maxTokens: 1500, scope: 'off' });
      expect(parentSectionsWith(undefined)).toEqual({ maxTokens: 1500, scope: 'tool' });
    });
  });

  describe('hybrid.lexical_query', () => {
    let tmpDir: string;
    const lexicalQueryWith = (hybrid: unknown): string => {
      fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: { capabilities: { file_search: { hybrid } } } }));
      jest.resetModules();
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      return require('../../src/services/configService').getFileSearchConfig().hybrid.lexicalQuery;
    };
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexical-query-config-'));
      process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    });
    afterEach(() => {
      delete process.env.CONFIG_FILE_PATH;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads "all", and treats an absent or unknown value as the default "any"', () => {
      expect(lexicalQueryWith({ lexical_query: 'all' })).toBe('all');
      expect(lexicalQueryWith({ lexical_query: 'any' })).toBe('any');
      expect(lexicalQueryWith({})).toBe('any');
      expect(lexicalQueryWith({ lexical_query: 'ALL' })).toBe('any');
    });
  });

  describe('ann', () => {
    let tmpDir: string;
    const annWith = (ann: unknown): any => {
      fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: { capabilities: { file_search: { ann } } } }));
      jest.resetModules();
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      return require('../../src/services/configService').getFileSearchConfig().ann;
    };
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-config-'));
      process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
    });
    afterEach(() => {
      delete process.env.CONFIG_FILE_PATH;
      jest.resetModules();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is off with the shipped thresholds when the block or a key is absent', () => {
      expect(annWith(undefined)).toEqual({ enabled: false, exactMaxChunks: 20000, minFraction: 0.05 });
      expect(annWith({})).toEqual({ enabled: false, exactMaxChunks: 20000, minFraction: 0.05 });
      expect(annWith({ enabled: true })).toEqual({ enabled: true, exactMaxChunks: 20000, minFraction: 0.05 });
    });

    it('reads every key', () => {
      expect(annWith({ enabled: true, exact_max_chunks: 5000, min_fraction: 0.02 }))
        .toEqual({ enabled: true, exactMaxChunks: 5000, minFraction: 0.02 });
    });

    it('switches on only for the boolean true', () => {
      expect(annWith({ enabled: 'true' }).enabled).toBe(false);
      expect(annWith({ enabled: 1 }).enabled).toBe(false);
    });

    it('clamps the thresholds to the schema ranges and defaults a value that is not a number', () => {
      expect(annWith({ exact_max_chunks: -5, min_fraction: -0.1 })).toEqual({ enabled: false, exactMaxChunks: 0, minFraction: 0 });
      expect(annWith({ exact_max_chunks: 5e9, min_fraction: 7 })).toEqual({ enabled: false, exactMaxChunks: 1000000, minFraction: 1 });
      expect(annWith({ exact_max_chunks: 1234.9 }).exactMaxChunks).toBe(1234);
      expect(annWith({ exact_max_chunks: '100', min_fraction: null })).toEqual({ enabled: false, exactMaxChunks: 20000, minFraction: 0.05 });
      expect(annWith({ exact_max_chunks: Number.NaN })).toEqual({ enabled: false, exactMaxChunks: 20000, minFraction: 0.05 });
    });
  });
});
