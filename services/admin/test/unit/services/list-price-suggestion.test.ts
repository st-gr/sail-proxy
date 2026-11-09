import { readFileSync } from 'fs';
import path from 'path';
import { suggestListPrice } from '../../../src/services/listPriceSuggestion';

describe('suggestListPrice', () => {
  it('openai gpt-4o-mini is suggested per 1K', () => {
    expect(suggestListPrice('openai', 'gpt-4o-mini')).toEqual({ inputCost: 0.00015, outputCost: 0.0006, cacheReadCost: 0.000075, cacheCreationCost: null });
  });

  it('azure falls back from azure/<m> to <m>', () => {
    expect(suggestListPrice('azure-openai', 'gpt-4o-mini')).toEqual({ inputCost: 0.00015, outputCost: 0.0006, cacheReadCost: 0.000075, cacheCreationCost: null });
    expect(suggestListPrice('azure-openai', 'no-such-deployment')).toBeNull();
    jest.isolateModules(() => {
      jest.doMock('../../../src/services/litellmPrices.json', () => ({ prices: {
        'azure/only-prefixed': { litellm_provider: 'azure', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
        'bare-azure': { litellm_provider: 'azure', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 },
        'gpt-x': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 5e-6, output_cost_per_token: 6e-6 },
      } }));
      const { suggestListPrice: isolated } = require('../../../src/services/listPriceSuggestion');
      expect(isolated('azure-openai', 'only-prefixed')?.inputCost).toBe(0.001);
      expect(isolated('azure-openai', 'bare-azure')?.inputCost).toBe(0.003);
      expect(isolated('azure-openai', 'gpt-x')).toBeNull(); // an openai entry is not an azure price
    });
  });

  it('an unknown model gets no suggestion', () => {
    expect(suggestListPrice('openai', 'my-private-model')).toBeNull();
  });

  it('the snapshot carries its MIT notice, which is never looked up as a model', () => {
    const snapshot = JSON.parse(readFileSync(path.join(__dirname, '../../../src/services/litellmPrices.json'), 'utf8'));
    expect(snapshot._notice).toContain('MIT License');
    expect(snapshot._notice).toContain('Berri AI');
    expect(suggestListPrice('openai', '_notice')).toBeNull();
    expect(suggestListPrice('openai', 'gpt-4o-mini')).not.toBeNull();
  });

  it('bedrock looks up <m> then bedrock/<m>', () => {
    expect(suggestListPrice('bedrock', 'ai21.j2-mid-v1')).not.toBeNull();
  });

  it('a provider mismatch gets no suggestion', () => {
    expect(suggestListPrice('openai', 'claude-haiku-4-5')).toBeNull();
    expect(suggestListPrice('anthropic', 'claude-haiku-4-5')).not.toBeNull();
  });
});
