/**
 * collectAnthropicImageRefs turns the Anthropic image-block shapes into refs imageTokenCapture.ts
 * can size, so /anthropic captures image tokens the same way /openai and /responses do (Anthropic
 * never reports them in its usage). The heavy controller dependencies are mocked so the module
 * imports cleanly - only the pure extractor is under test here.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn() })
}));
jest.mock('../src/services/sapAIService', () => ({ default: {} }));
jest.mock('../src/services/configService', () => ({ default: {} }));
jest.mock('../src/services/anthropicService', () => ({ default: {} }));
jest.mock('../src/services/anthropicResponseService', () => ({ default: {} }));
jest.mock('../src/services/modelService', () => ({ default: {} }));
jest.mock('../src/services/awsBedrockService', () => ({ default: {} }));
jest.mock('../src/services/pluginExecutor', () => ({ executeBeforePlugins: jest.fn() }));
jest.mock('../src/utils/payloadLogger', () => ({}));
jest.mock('../src/utils/sseWriter', () => ({}));
jest.mock('../src/utils/usageTracker', () => ({
  createUsageMetrics: () => ({}), emitUsageEvent: jest.fn(), updateTokenCounts: jest.fn()
}));
jest.mock('../src/utils/imageTokenCapture', () => ({ captureImageTokensAsync: jest.fn() }));

import { collectAnthropicImageRefs } from '../src/controllers/anthropicController';

describe('collectAnthropicImageRefs', () => {
  it('turns a base64 image block into a data: URL ref', () => {
    const refs = collectAnthropicImageRefs([
      { role: 'user', content: [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
      ] }
    ]);
    expect(refs).toEqual(['data:image/png;base64,QUJD']);
  });

  it('passes a url image source through as a remote URL', () => {
    const refs = collectAnthropicImageRefs([
      { role: 'user', content: [ { type: 'image', source: { type: 'url', url: 'https://x/y.png' } } ] }
    ]);
    expect(refs).toEqual(['https://x/y.png']);
  });

  it('defaults media_type and skips non-image / malformed blocks', () => {
    const refs = collectAnthropicImageRefs([
      { role: 'user', content: [
        { type: 'image', source: { type: 'base64', data: 'ZZZ' } }, // no media_type -> default image/png
        { type: 'image', source: { type: 'base64' } },              // no data -> skipped
        { type: 'text', text: 'x' },                                // not an image
        { type: 'image' }                                            // no source -> skipped
      ] }
    ]);
    expect(refs).toEqual(['data:image/png;base64,ZZZ']);
  });

  it('collects across multiple messages and returns [] for string content or non-array input', () => {
    const refs = collectAnthropicImageRefs([
      { role: 'user', content: [ { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } } ] },
      { role: 'user', content: 'plain text' },
      { role: 'user', content: [ { type: 'image', source: { type: 'url', url: 'https://z/w.png' } } ] }
    ]);
    expect(refs).toEqual(['data:image/jpeg;base64,AAA', 'https://z/w.png']);
    expect(collectAnthropicImageRefs(undefined)).toEqual([]);
    expect(collectAnthropicImageRefs('nope')).toEqual([]);
  });
});
