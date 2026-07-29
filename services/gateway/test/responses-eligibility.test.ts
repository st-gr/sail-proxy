/**
 * Eligibility for the /openai/v1/responses route.
 * Order: per-model flag → provider flag → built-in heuristic
 * (deployed AND provider openai AND GPT-5+/o-series family).
 */
import { describe, it, expect } from '@jest/globals';
import { isResponsesFamily, resolveResponsesEligibility } from '../src/utils/responsesEligibility';

describe('isResponsesFamily', () => {
  it('accepts GPT-5+ and o-series, with or without the --deployed alias', () => {
    for (const m of ['gpt-5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex--deployed', 'gpt-6-turbo', 'o1', 'o3', 'o4-mini']) {
      expect(isResponsesFamily(m)).toBe(true);
    }
  });

  it('rejects GPT-4 and earlier, including Azure legacy gpt-35-turbo', () => {
    for (const m of ['gpt-4o', 'gpt-4', 'gpt-4.1', 'gpt-35-turbo', 'gpt-35-turbo-16k', 'gpt-3.5-turbo']) {
      expect(isResponsesFamily(m)).toBe(false);
    }
  });
});

describe('resolveResponsesEligibility', () => {
  const base = { modelName: 'gpt-5.3-codex--deployed', provider: 'openai', isDeployed: true };

  it('uses the heuristic when no flags are set', () => {
    expect(resolveResponsesEligibility(base)).toBe(true);
  });

  it('requires deployed AND provider openai AND family', () => {
    expect(resolveResponsesEligibility({ ...base, isDeployed: false })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, provider: 'perplexity' })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, modelName: 'gpt-4o--deployed' })).toBe(false);
  });

  it('per-model flag decides, overriding the heuristic in both directions', () => {
    expect(resolveResponsesEligibility({ ...base, modelFlag: false })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, modelName: 'gpt-4o--deployed', modelFlag: true })).toBe(true);
  });

  it('provider flag applies when the model flag is absent, and loses to it', () => {
    expect(resolveResponsesEligibility({ ...base, providerFlag: false })).toBe(false);
    expect(resolveResponsesEligibility({ ...base, providerFlag: false, modelFlag: true })).toBe(true);
  });

  it('excludes Perplexity and Anthropic deployments', () => {
    expect(resolveResponsesEligibility({ modelName: 'sonar--deployed', provider: 'perplexity', isDeployed: true })).toBe(false);
    expect(resolveResponsesEligibility({ modelName: 'anthropic--claude-4.5-haiku--deployed', provider: 'anthropic', isDeployed: true })).toBe(false);
  });
});
