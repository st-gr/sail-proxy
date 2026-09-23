import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({ getDefaultLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }) }));

import { foldNativeGeminiUsage } from '../src/controllers/googleWire';
import { createUsageMetrics, updateTokenCounts } from '../src/utils/usageTracker';

describe('image token folding', () => {
  it('foldNativeGeminiUsage carries the modality split onto the metrics and keeps outputTokens inclusive', () => {
    const metrics = createUsageMetrics();
    foldNativeGeminiUsage(metrics, {
      promptTokenCount: 17, candidatesTokenCount: 1296,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 17 }],
      candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }, { modality: 'TEXT', tokenCount: 6 }],
    });
    expect(metrics).toMatchObject({ inputTokens: 17, outputTokens: 1296, imageInputTokens: 0, imageOutputTokens: 1290 });
  });
  it('foldNativeGeminiUsage accumulates across two folds', () => {
    const metrics = createUsageMetrics();
    foldNativeGeminiUsage(metrics, { promptTokenCount: 1, candidatesTokenCount: 10, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 8 }] });
    foldNativeGeminiUsage(metrics, { promptTokenCount: 1, candidatesTokenCount: 10, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 8 }] });
    expect(metrics.imageOutputTokens).toBe(16);
    expect(metrics.outputTokens).toBe(20);
  });
  it('updateTokenCounts accepts image output tokens as its seventh argument and starts at zero', () => {
    const metrics = createUsageMetrics();
    expect(metrics.imageOutputTokens).toBe(0);
    updateTokenCounts(metrics, 1, 2, 0, 0, 3, 4);
    updateTokenCounts(metrics, 1, 2, 0, 0, 0, 5);
    expect(metrics.imageInputTokens).toBe(3);
    expect(metrics.imageOutputTokens).toBe(9);
  });
});
