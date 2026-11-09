// W3 Task 6: `file_search.parsing.vision` — the vision transcriber's model and limits and the vision
// mode NEW stores get. Off unless configured (an upgrade starts no vision calls), the defaults pinned
// equal across the gateway, the transcriber and the schema; and when page images would reach the
// model unmasked (pseudonymization force-enabled for file_search content).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FILE_SEARCH_DEFAULTS } from '../../src/services/configService';
import { VISION_DEFAULTS } from '../../src/fileSearch/visionTranscriber';

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../admin/src/schemas/api-config-schema.json'), 'utf8'));
const visionSchema = SCHEMA.$defs.capabilitiesGroup.properties.file_search.properties.parsing.properties.vision;

describe('file_search.parsing.vision defaults', () => {
  it('off for new stores, gemini-3.5-flash-lite, the transcriber\'s limits', () => {
    const d = FILE_SEARCH_DEFAULTS.parsing.vision;
    expect(d.defaultMode).toBe('off');
    expect(d).toEqual({
      model: VISION_DEFAULTS.model, defaultMode: 'off', maxPagesPerFile: VISION_DEFAULTS.maxPagesPerFile,
      concurrency: VISION_DEFAULTS.concurrency, requestTimeoutMs: VISION_DEFAULTS.requestTimeoutMs,
      fileDeadlineMs: VISION_DEFAULTS.fileDeadlineMs, maxInputTokensPerFile: VISION_DEFAULTS.maxInputTokensPerFile,
      maxOutputTokensPerFile: VISION_DEFAULTS.maxOutputTokensPerFile,
    });
  });

  it('the schema states the same defaults and modes, and every key is bounded', () => {
    const p = visionSchema.properties;
    const d = FILE_SEARCH_DEFAULTS.parsing.vision;
    expect(p.model.default).toBe(d.model);
    expect(p.default_mode).toMatchObject({ enum: ['off', 'no_text', 'auto', 'all'], default: 'off' });
    expect(p.max_pages_per_file.default).toBe(d.maxPagesPerFile);
    expect(p.concurrency.default).toBe(d.concurrency);
    expect(p.request_timeout_ms.default).toBe(d.requestTimeoutMs);
    expect(p.file_deadline_ms.default).toBe(d.fileDeadlineMs);
    expect(p.max_input_tokens_per_file.default).toBe(d.maxInputTokensPerFile);
    expect(p.max_output_tokens_per_file.default).toBe(d.maxOutputTokensPerFile);
    for (const key of Object.keys(p).filter((k) => p[k].type === 'integer')) {
      expect(p[key].minimum).toBeGreaterThanOrEqual(1);
      expect(p[key].maximum).toBeGreaterThan(p[key].default);
    }
    expect(visionSchema.additionalProperties).toBe(false);
    // The pseudonymization warning is part of the configuration text.
    expect(visionSchema.description).toMatch(/unmasked/);
    // The warning covers forced masking only; a single request's masking cannot be foreseen.
    expect(visionSchema.description).toMatch(/force-enabled/);
    expect(visionSchema.description).toMatch(/single request/);
    expect(p.default_mode.description).toMatch(/unmasked/);
  });
});

describe('getFileSearchConfig().parsing.vision and the pseudonymization flag (from a config file)', () => {
  let tmpDir: string;
  const load = (apiConfig: unknown): any => {
    fs.writeFileSync(path.join(tmpDir, 'api_config.json'), JSON.stringify({ api_config: apiConfig }));
    jest.resetModules();
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    return require('../../src/services/configService');
  };
  const visionWith = (vision: unknown) => load({ capabilities: { file_search: { parsing: { vision } } } }).getFileSearchConfig().parsing.vision;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-config-'));
    process.env.CONFIG_FILE_PATH = path.join(tmpDir, 'api_config.json');
  });
  afterEach(() => {
    delete process.env.CONFIG_FILE_PATH;
    jest.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the shipped configuration names the model and keeps vision off for new stores', () => {
    delete process.env.CONFIG_FILE_PATH;
    jest.resetModules();
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const vision = require('../../src/services/configService').getFileSearchConfig().parsing.vision;
    expect(vision).toMatchObject({ model: 'gemini-3.5-flash-lite', defaultMode: 'off', maxPagesPerFile: 50 });
    const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../../api_config.json'), 'utf8'))
      .api_config.capabilities.file_search.parsing.vision;
    expect(shipped).toEqual({ model: 'gemini-3.5-flash-lite', default_mode: 'off', max_pages_per_file: 50 });
  });

  it('a configuration without the block (an upgrade) is off with the defaults; new stores get no vision', () => {
    expect(visionWith(undefined)).toEqual(FILE_SEARCH_DEFAULTS.parsing.vision);
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { installationChunking } = require('../../src/fileSearch/chunkingSetting');
    expect(installationChunking()).not.toHaveProperty('vision');
  });

  it('reads configured values in camelCase; an unknown default_mode is off', () => {
    expect(visionWith({ model: 'gemini-3.8-flash', default_mode: 'auto', max_pages_per_file: 20, concurrency: 3,
      request_timeout_ms: 60000, file_deadline_ms: 120000, max_input_tokens_per_file: 50000, max_output_tokens_per_file: 40000 }))
      .toEqual({ model: 'gemini-3.8-flash', defaultMode: 'auto', maxPagesPerFile: 20, concurrency: 3, requestTimeoutMs: 60000,
        fileDeadlineMs: 120000, maxInputTokensPerFile: 50000, maxOutputTokensPerFile: 40000 });
    expect(visionWith({ default_mode: 'everything' }).defaultMode).toBe('off');
    expect(visionWith({ default_mode: 7 }).defaultMode).toBe('off');
  });

  it('a configured default mode reaches new stores, and the transcriber reads the configured limits', () => {
    load({ capabilities: { file_search: { parsing: { vision: { default_mode: 'no_text', model: 'gemini-3.8-flash', max_pages_per_file: 9 } } } } });
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { chunkingForNewStore } = require('../../src/fileSearch/chunkingSetting');
    expect(chunkingForNewStore()).toMatchObject({ vision: 'no_text' });
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { resolveVisionSettings } = require('../../src/fileSearch/visionTranscriber');
    expect(resolveVisionSettings()).toMatchObject({ model: 'gemini-3.8-flash', maxPagesPerFile: 9 });
  });

  it('isPseudonymizationForcedForFileSearch: forced for the openai endpoint or any model; not for another endpoint alone', () => {
    const forced = (api: unknown) => load(api).isPseudonymizationForcedForFileSearch();
    expect(forced({ hooks: { defaults: { openai: { pseudonymization: { enabled: true } } } } })).toBe(true);
    expect(forced({ models: { overrides: { 'some-model': { pseudonymization: { enabled: true } } } } })).toBe(true);
    expect(forced({ hooks: { defaults: { anthropic: { pseudonymization: { enabled: true } } } } })).toBe(false);
    expect(forced({ hooks: { defaults: { openai: { pseudonymization: { enabled: false } } } } })).toBe(false);
    expect(forced({})).toBe(false);
  });
});
