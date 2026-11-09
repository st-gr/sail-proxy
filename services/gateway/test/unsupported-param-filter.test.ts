/**
 * Unsupported Parameter Filter Tests
 *
 * Covers the pure logic that decides which request parameters are dropped
 * before forwarding to SAP AI Core. Prevents HTTP 400s such as
 * "LLM Module: perplexity does not support parameters: ['tools'], for model=sonar".
 */
import { describe, it, expect } from '@jest/globals';
import {
  resolveUnsupportedParams,
  isUnsupportedParam,
  stripUnsupportedParams,
  applyParamRenames,
  defaultParamRenames,
  OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS,
} from '../src/utils/unsupportedParamFilter';

describe('resolveUnsupportedParams', () => {
  it('returns [] when neither provider nor model list is configured', () => {
    expect(resolveUnsupportedParams(undefined, undefined)).toEqual([]);
    expect(resolveUnsupportedParams(null, null)).toEqual([]);
  });

  it('uses the provider list when no per-model override exists', () => {
    expect(resolveUnsupportedParams(['tools', 'response_format'], undefined))
      .toEqual(['tools', 'response_format']);
  });

  it('per-model override REPLACES the provider list', () => {
    expect(resolveUnsupportedParams(['tools', 'tool_choice', 'response_format'], ['tools']))
      .toEqual(['tools']);
  });

  it('an empty per-model override disables stripping for that model', () => {
    // Explicitly opting a model back in (e.g. it gained tool support upstream)
    expect(resolveUnsupportedParams(['tools'], [])).toEqual([]);
  });

  it('ignores non-string / empty entries', () => {
    expect(resolveUnsupportedParams(['tools', '', null as any, 42 as any])).toEqual(['tools']);
  });
});

describe('isUnsupportedParam', () => {
  it('matches exactly and is case-sensitive', () => {
    expect(isUnsupportedParam('tools', ['tools'])).toBe(true);
    expect(isUnsupportedParam('Tools', ['tools'])).toBe(false);
    expect(isUnsupportedParam('tool_choice', ['tools'])).toBe(false);
    expect(isUnsupportedParam('tools', [])).toBe(false);
  });
});

describe('stripUnsupportedParams', () => {
  it('deletes only the listed keys that are present and reports them', () => {
    const body: any = { model: 'sonar', messages: [], tools: [{ type: 'function' }], temperature: 0.7 };
    const dropped = stripUnsupportedParams(body, ['tools', 'response_format']);

    expect(dropped).toEqual(['tools']); // response_format was not present
    expect(body).not.toHaveProperty('tools');
    expect(body.model).toBe('sonar');
    expect(body.temperature).toBe(0.7); // unrelated keys untouched
  });

  it('drops several params and preserves order of the configured list', () => {
    const body: any = { tools: [], tool_choice: 'auto', response_format: { type: 'json_object' }, model: 'sonar' };
    expect(stripUnsupportedParams(body, ['tools', 'tool_choice', 'response_format']))
      .toEqual(['tools', 'tool_choice', 'response_format']);
    expect(Object.keys(body)).toEqual(['model']);
  });

  it('is a no-op for an empty list or a missing target', () => {
    const body: any = { tools: [{ type: 'function' }] };
    expect(stripUnsupportedParams(body, [])).toEqual([]);
    expect(body).toHaveProperty('tools');
    expect(stripUnsupportedParams(null, ['tools'])).toEqual([]);
    expect(stripUnsupportedParams(undefined, ['tools'])).toEqual([]);
  });

  it('does not invent keys that were absent', () => {
    const body: any = { model: 'sonar' };
    expect(stripUnsupportedParams(body, ['tools'])).toEqual([]);
    expect(Object.keys(body)).toEqual(['model']);
  });
});

describe('applyParamRenames', () => {
  it('renames a param the deployment expects under another name (gpt-5.x)', () => {
    const body: any = { model: 'gpt-5.4--deployed', max_tokens: 20, messages: [] };
    expect(applyParamRenames(body, { max_tokens: 'max_completion_tokens' })).toEqual(['max_tokens->max_completion_tokens']);
    expect(body.max_completion_tokens).toBe(20);
    expect(body).not.toHaveProperty('max_tokens'); // never send both
  });

  it('does not overwrite an explicit destination value, but still drops the source', () => {
    const body: any = { max_tokens: 20, max_completion_tokens: 99 };
    expect(applyParamRenames(body, { max_tokens: 'max_completion_tokens' })).toEqual(['max_tokens->max_completion_tokens']);
    expect(body.max_completion_tokens).toBe(99);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('is a no-op when the source key is absent or the map is empty/missing', () => {
    const body: any = { model: 'x' };
    expect(applyParamRenames(body, { max_tokens: 'max_completion_tokens' })).toEqual([]);
    expect(applyParamRenames(body, {})).toEqual([]);
    expect(applyParamRenames(body, undefined)).toEqual([]);
    expect(applyParamRenames(null, { a: 'b' })).toEqual([]);
    expect(body).toEqual({ model: 'x' });
  });

  it('ignores invalid rename targets', () => {
    const body: any = { max_tokens: 5 };
    expect(applyParamRenames(body, { max_tokens: '' as any })).toEqual([]);
    expect(applyParamRenames(body, { max_tokens: 'max_tokens' })).toEqual([]);
    expect(body.max_tokens).toBe(5);
  });
});

describe('OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS', () => {
  it('covers OpenAI and Perplexity deployments but NOT Anthropic', () => {
    // Anthropic deployments use a Bedrock-style contract and are served by /anthropic
    expect(OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS).toContain('openai');
    expect(OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS).toContain('perplexity');
    expect(OPENAI_COMPATIBLE_DEPLOYMENT_PROVIDERS).not.toContain('anthropic');
  });
});

describe('defaultParamRenames (model-family defaults)', () => {
  const wants = { max_tokens: 'max_completion_tokens' };

  it('applies max_completion_tokens to GPT-5+ and o-series (deployed or not)', () => {
    for (const m of ['gpt-5', 'gpt-5.4', 'gpt-5.4--deployed', 'gpt-5.5', 'gpt-6', 'gpt-6-turbo', 'o1', 'o3', 'o4-mini']) {
      expect(defaultParamRenames('openai', m)).toEqual(wants);
    }
  });

  it('leaves GPT-4 and earlier on max_tokens', () => {
    for (const m of ['gpt-4o', 'gpt-4', 'gpt-4.1', 'gpt-35-turbo', 'gpt-3.5-turbo']) {
      expect(defaultParamRenames('openai', m)).toEqual({});
    }
  });

  it('does not misfire on Azure legacy gpt-35-turbo (that is GPT-3.5, not GPT-35)', () => {
    expect(defaultParamRenames('openai', 'gpt-35-turbo')).toEqual({});
    expect(defaultParamRenames('openai', 'gpt-35-turbo-16k')).toEqual({});
  });

  it('a future double-digit family falls back to config (documented limitation)', () => {
    expect(defaultParamRenames('openai', 'gpt-10')).toEqual({});
  });

  it('does not apply to other providers or missing input', () => {
    expect(defaultParamRenames('perplexity', 'sonar--deployed')).toEqual({});
    expect(defaultParamRenames('anthropic', 'anthropic--claude-4.5-haiku--deployed')).toEqual({});
    expect(defaultParamRenames('openai', undefined)).toEqual({});
    expect(defaultParamRenames(undefined, 'gpt-5.4')).toEqual({});
  });

  it('config can override a default per key (self-map disables it)', () => {
    // how the controller merges: defaults first, config wins
    const merged = { ...defaultParamRenames('openai', 'gpt-5.4--deployed'), ...{ max_tokens: 'max_tokens' } };
    const body: any = { max_tokens: 20 };
    expect(applyParamRenames(body, merged)).toEqual([]); // from === to is ignored
    expect(body.max_tokens).toBe(20);
  });
});
