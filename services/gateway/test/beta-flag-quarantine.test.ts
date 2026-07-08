/**
 * Runtime beta-flag quarantine tests.
 *
 * When SAP AI Core returns HTTP 400 "invalid beta flag", the flags sent on
 * that request are quarantined in memory (per model) so subsequent requests
 * omit them and succeed.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('@libs/logger', () => ({
  getDefaultLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

import {
  getQuarantinedFlags,
  quarantineFlags,
  isInvalidBetaFlagError,
  resolveRejectedFlags,
  recordBetaFlagRejection,
  clearQuarantine,
} from '../src/services/betaFlagQuarantine';
import { filterBetaFeatures, mergeBetaFeatures } from '../src/utils/betaFeatureFilter';

const BEDROCK_ERROR = { type: 'error', error: { type: 'invalid_request_error', message: 'invalid beta flag' } };
const FIRST_PARTY_ERROR = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Unexpected value(s) `structured-outputs-2025-12-15` for the `anthropic-beta` header.' },
};

describe('betaFlagQuarantine', () => {
  beforeEach(() => clearQuarantine());

  afterEach(() => { jest.restoreAllMocks(); });

  it('starts empty and isolates quarantine per model', () => {
    expect(getQuarantinedFlags('model-a')).toEqual([]);
    quarantineFlags('model-a', ['flag-2026-01-01']);
    expect(getQuarantinedFlags('model-a')).toEqual(['flag-2026-01-01']);
    expect(getQuarantinedFlags('model-b')).toEqual([]);
  });

  it('detects Bedrock-style invalid beta flag 400s', () => {
    expect(isInvalidBetaFlagError(400, BEDROCK_ERROR)).toBe(true);
    expect(isInvalidBetaFlagError(400, FIRST_PARTY_ERROR)).toBe(true);
  });

  it('ignores non-400s and unrelated 400s', () => {
    expect(isInvalidBetaFlagError(429, BEDROCK_ERROR)).toBe(false);
    expect(isInvalidBetaFlagError(400, { error: { message: 'max_tokens is required' } })).toBe(false);
    expect(isInvalidBetaFlagError(undefined, BEDROCK_ERROR)).toBe(false);
  });

  it('quarantines only the named flag when the error names one', () => {
    const sent = ['claude-code-20250219', 'structured-outputs-2025-12-15'];
    expect(resolveRejectedFlags(FIRST_PARTY_ERROR, sent)).toEqual(['structured-outputs-2025-12-15']);
  });

  it('quarantines all sent flags when the error names none (Bedrock)', () => {
    const sent = ['claude-code-20250219', 'effort-2025-11-24'];
    expect(resolveRejectedFlags(BEDROCK_ERROR, sent)).toEqual(sent);
  });

  it('quarantines only the named compact-date flag (e.g. claude-code-20250219)', () => {
    const err = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Unexpected value(s) `claude-code-20250219` for the `anthropic-beta` header.' },
    };
    const sent = ['claude-code-20250219', 'effort-2025-11-24'];
    expect(resolveRejectedFlags(err, sent)).toEqual(['claude-code-20250219']);
  });

  it('does not treat a sent flag as named when the error mentions a different flag', () => {
    const err = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Unexpected value(s) `some-other-flag-2026-01-01` for the `anthropic-beta` header.' },
    };
    const sent = ['claude-code-20250219', 'effort-2025-11-24'];
    expect(resolveRejectedFlags(err, sent)).toEqual(sent); // falls back to all-sent
  });

  it('recordBetaFlagRejection stores flags retrievable for filtering', () => {
    recordBetaFlagRejection('anthropic--claude-4.7-opus--deployed', BEDROCK_ERROR, ['claude-code-20250219']);
    expect(getQuarantinedFlags('anthropic--claude-4.7-opus--deployed')).toEqual(['claude-code-20250219']);
  });

  it('subsequent request drops quarantined flags via the standard filter chain', () => {
    recordBetaFlagRejection('model-a', BEDROCK_ERROR, ['bad-flag-2026-01-01']);
    const result = filterBetaFeatures(['good-flag-2025-01-01', 'bad-flag-2026-01-01'], {
      supported: [],
      excluded: mergeBetaFeatures([], getQuarantinedFlags('model-a')),
    });
    expect(result).toEqual(['good-flag-2025-01-01']);
  });

  it('expires a quarantined flag after the 30-minute TTL', () => {
    const start = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    quarantineFlags('model-a', ['flag-2026-01-01']);
    expect(getQuarantinedFlags('model-a')).toEqual(['flag-2026-01-01']);

    const TTL_MS = 30 * 60 * 1000;
    nowSpy.mockReturnValue(start + TTL_MS - 1);
    expect(getQuarantinedFlags('model-a')).toEqual(['flag-2026-01-01']);

    nowSpy.mockReturnValue(start + TTL_MS + 1);
    expect(getQuarantinedFlags('model-a')).toEqual([]);
  });

  it('refreshes the timestamp when a flag is re-quarantined', () => {
    const start = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    quarantineFlags('model-a', ['flag-2026-01-01']);

    const TTL_MS = 30 * 60 * 1000;
    nowSpy.mockReturnValue(start + TTL_MS - 1);
    quarantineFlags('model-a', ['flag-2026-01-01']); // refresh

    nowSpy.mockReturnValue(start + TTL_MS - 1 + TTL_MS - 1);
    expect(getQuarantinedFlags('model-a')).toEqual(['flag-2026-01-01']);

    nowSpy.mockReturnValue(start + TTL_MS - 1 + TTL_MS + 1);
    expect(getQuarantinedFlags('model-a')).toEqual([]);
  });
});
