import { dropUnsupportedSampling } from '../src/utils/samplingSupport';

describe('dropUnsupportedSampling', () => {
  it('Claude: keeps temperature and drops top_p when both are set', () => {
    const params: any = { temperature: 0, top_p: 1 };
    expect(dropUnsupportedSampling('anthropic--claude-4.5-haiku', params)).toEqual(['top_p']);
    expect(params).toEqual({ temperature: 0 });
  });
  it('Claude: a lone top_p or a lone temperature is left alone', () => {
    const lone: any = { top_p: 0.9 };
    expect(dropUnsupportedSampling('anthropic--claude-4.6-sonnet', lone)).toEqual([]);
    expect(lone).toEqual({ top_p: 0.9 });
    const temp: any = { temperature: 0.5 };
    expect(dropUnsupportedSampling('anthropic--claude-4.6-sonnet', temp)).toEqual([]);
    expect(temp).toEqual({ temperature: 0.5 });
  });
  it('gpt-5 family: drops top_p always and temperature unless it is 1', () => {
    const both: any = { temperature: 0, top_p: 1, max_tokens: 10 };
    expect(dropUnsupportedSampling('gpt-5-mini', both)).toEqual(['top_p', 'temperature']);
    expect(both).toEqual({ max_tokens: 10 });
    const one: any = { temperature: 1, top_p: 0.95 };
    expect(dropUnsupportedSampling('gpt-5.4', one)).toEqual(['top_p']);
    expect(one).toEqual({ temperature: 1 });
    const seven: any = { temperature: 0.7 };
    expect(dropUnsupportedSampling('gpt-5.6-sol--deployed', seven)).toEqual(['temperature']);
    expect(seven).toEqual({});
  });
  it('o-series counts as the same family', () => {
    const p: any = { temperature: 0, top_p: 1 };
    expect(dropUnsupportedSampling('o4-mini', p)).toEqual(['top_p', 'temperature']);
    expect(p).toEqual({});
  });
  it('gpt-4.x, Gemini and Mistral keep both', () => {
    for (const m of ['gpt-4.1', 'gpt-4o', 'gemini-2.5-pro', 'mistralai--mistral-medium', 'gpt-35-turbo']) {
      const p: any = { temperature: 0, top_p: 1 };
      expect(dropUnsupportedSampling(m, p)).toEqual([]);
      expect(p).toEqual({ temperature: 0, top_p: 1 });
    }
  });
  it('nothing to drop returns an empty list without touching params', () => {
    const p: any = { max_tokens: 5 };
    expect(dropUnsupportedSampling('gpt-5', p)).toEqual([]);
    expect(p).toEqual({ max_tokens: 5 });
  });
});
