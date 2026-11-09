/**
 * Beta Feature Filter Tests
 *
 * Tests the pure filtering logic used by awsBedrockService to decide which
 * anthropic_beta flags are forwarded to SAP AI Core.
 *
 * Semantics:
 * - allowlist (supported): when non-empty, only listed flags survive
 * - denylist (excluded): always applied on top of the allowlist
 * - empty allowlist === allowlist absent === no allowlist filtering
 */
import { describe, it, expect } from '@jest/globals';
import {
  parseAnthropicBetaHeader,
  mergeBetaFeatures,
  filterBetaFeatures
} from '../src/utils/betaFeatureFilter';

describe('parseAnthropicBetaHeader', () => {
  it('parses a comma-separated string with whitespace', () => {
    expect(parseAnthropicBetaHeader('a-1, b-2 ,c-3')).toEqual(['a-1', 'b-2', 'c-3']);
  });

  it('parses an array of header values, splitting embedded commas', () => {
    expect(parseAnthropicBetaHeader(['a-1,b-2', 'c-3'])).toEqual(['a-1', 'b-2', 'c-3']);
  });

  it('returns [] for undefined or empty input', () => {
    expect(parseAnthropicBetaHeader(undefined)).toEqual([]);
    expect(parseAnthropicBetaHeader('')).toEqual([]);
    expect(parseAnthropicBetaHeader([])).toEqual([]);
  });

  it('drops empty segments from trailing/duplicate commas', () => {
    expect(parseAnthropicBetaHeader('a-1,,b-2,')).toEqual(['a-1', 'b-2']);
  });
});

describe('mergeBetaFeatures', () => {
  it('merges lists preserving order and deduplicating', () => {
    expect(mergeBetaFeatures(['a', 'b'], ['b', 'c'], ['a', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns [] when all lists are empty', () => {
    expect(mergeBetaFeatures([], [])).toEqual([]);
  });
});

describe('filterBetaFeatures', () => {
  const CLAUDE_CODE_FLAGS = [
    'claude-code-20250219',
    'context-1m-2025-08-07',
    'interleaved-thinking-2025-05-14',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'effort-2025-11-24'
  ];

  it('denylist-only: behaves exactly like today (allowlist empty)', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, {
      supported: [],
      excluded: ['thinking-token-count-2026-05-13']
    });
    expect(result).toEqual([
      'claude-code-20250219',
      'context-1m-2025-08-07',
      'interleaved-thinking-2025-05-14',
      'context-management-2025-06-27',
      'effort-2025-11-24'
    ]);
  });

  it('no lists configured: passthrough unchanged', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, { supported: [], excluded: [] });
    expect(result).toEqual(CLAUDE_CODE_FLAGS);
  });

  it('allowlist filtering: only allowlisted flags survive', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, {
      supported: ['context-1m-2025-08-07', 'interleaved-thinking-2025-05-14'],
      excluded: []
    });
    expect(result).toEqual(['context-1m-2025-08-07', 'interleaved-thinking-2025-05-14']);
  });

  it('allowlist + denylist: denylist wins over allowlist', () => {
    const result = filterBetaFeatures(CLAUDE_CODE_FLAGS, {
      supported: ['context-1m-2025-08-07', 'thinking-token-count-2026-05-13'],
      excluded: ['thinking-token-count-2026-05-13']
    });
    expect(result).toEqual(['context-1m-2025-08-07']);
  });

  it('returns [] when allowlist excludes everything', () => {
    const result = filterBetaFeatures(['unknown-flag-2026-01-01'], {
      supported: ['context-1m-2025-08-07'],
      excluded: []
    });
    expect(result).toEqual([]);
  });

  it('injected-feature scenario: injected flags are also subject to the allowlist', () => {
    // Simulates a misconfigured inject_beta_features reintroducing an unsupported flag
    const headerFlags = ['claude-code-20250219'];
    const injected = ['context-1m-2025-08-07', 'not-supported-by-sap-2026-01-01'];
    const merged = mergeBetaFeatures(headerFlags, injected);
    const result = filterBetaFeatures(merged, {
      supported: ['claude-code-20250219', 'context-1m-2025-08-07'],
      excluded: []
    });
    expect(result).toEqual(['claude-code-20250219', 'context-1m-2025-08-07']);
  });
});
