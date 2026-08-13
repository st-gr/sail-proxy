/**
 * Eligibility for the /openai/v1/responses route.
 * Order: per-model flag → provider flag → built-in heuristic
 * (deployed AND provider openai AND GPT-5+/o-series family).
 */
import { describe, it, expect } from '@jest/globals';
import { isResponsesFamily, resolveResponsesEligibility, deployedSiblingName, resolveResponsesRoute } from '../src/utils/responsesEligibility';

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

describe('deployedSiblingName', () => {
  it('names the deployed twin of a bare foundation-model id', () => {
    expect(deployedSiblingName('gpt-5.3-codex')).toBe('gpt-5.3-codex--deployed');
    expect(deployedSiblingName('anthropic--claude-4.5-haiku')).toBe('anthropic--claude-4.5-haiku--deployed');
  });

  it('returns null when there cannot be a sibling', () => {
    // Already deployed — suffixing again would produce a name nothing serves.
    expect(deployedSiblingName('gpt-5.3-codex--deployed')).toBeNull();
    expect(deployedSiblingName('')).toBeNull();
  });
});

describe('resolveResponsesRoute', () => {
  it('routes a deployed GPT-5 model natively, exactly as before', () => {
    expect(resolveResponsesRoute({
      modelName: 'gpt-5.3-codex--deployed', provider: 'openai', isDeployed: true, existsInCatalogue: true,
    })).toBe('native');
  });

  it('routes a catalogue model that cannot serve natively to orchestration', () => {
    expect(resolveResponsesRoute({
      modelName: 'anthropic--claude-4.8-opus', provider: 'anthropic', isDeployed: false, existsInCatalogue: true,
    })).toBe('orchestration');
  });

  it('refuses a model that is not in the catalogue at all', () => {
    expect(resolveResponsesRoute({
      modelName: 'no-such-model', provider: '', isDeployed: false, existsInCatalogue: false,
    })).toBe('refuse');
  });

  it('honours an explicit config veto even for a catalogue model', () => {
    expect(resolveResponsesRoute({
      modelName: 'sonar', provider: 'perplexity', isDeployed: false, existsInCatalogue: true, modelFlag: false,
    })).toBe('refuse');
  });

  it('honours an explicit config opt-in for a deployed non-openai model', () => {
    expect(resolveResponsesRoute({
      modelName: 'anthropic--claude-4.8-opus--deployed', provider: 'anthropic', isDeployed: true,
      existsInCatalogue: true, modelFlag: true,
    })).toBe('native');
  });

  it('makes an opt-in flag mean native UNCONDITIONALLY, even with no deployment', () => {
    // The invariant resolveResponsesRoute's own docstring states and forbids breaking:
    // `true` is not "native if deployed, else orchestration". The flag means "serve this
    // model's OWN deployment on this route", so with no deployment the caller must get
    // the existing "no deployment URL" 400 rather than be silently redirected to a
    // serving path it never asked for. Every other test here passes under the mutant
    // `flag === true ? (isDeployed ? 'native' : 'orchestration')` — this is the one that
    // does not, on either flag source.
    expect(resolveResponsesRoute({
      modelName: 'anthropic--claude-4.8-opus', provider: 'anthropic', isDeployed: false,
      existsInCatalogue: true, modelFlag: true,
    })).toBe('native');
    expect(resolveResponsesRoute({
      modelName: 'anthropic--claude-4.8-opus', provider: 'anthropic', isDeployed: false,
      existsInCatalogue: true, providerFlag: true,
    })).toBe('native');
  });

  it('lets a model-level flag override the provider-level one, in both directions', () => {
    expect(resolveResponsesRoute({
      modelName: 'gpt-5.3-codex--deployed', provider: 'openai', isDeployed: true,
      existsInCatalogue: true, modelFlag: false, providerFlag: true,
    })).toBe('refuse');
    expect(resolveResponsesRoute({
      modelName: 'anthropic--claude-4.8-opus', provider: 'anthropic', isDeployed: false,
      existsInCatalogue: true, modelFlag: true, providerFlag: false,
    })).toBe('native');
  });
});
