import { parseModelMethod, resolveGeminiDeployment, geminiUrl, usageFromGemini, usageFromSse, geminiError, estimateEmbedTokens } from '../src/services/googleGeminiService';

describe('parseModelMethod', () => {
  it('splits model and method', () => {
    expect(parseModelMethod('gemini-3.5-flash:generateContent')).toEqual({ model: 'gemini-3.5-flash', method: 'generateContent' });
    expect(parseModelMethod('gemini-embedding-2:embedContent')).toEqual({ model: 'gemini-embedding-2', method: 'embedContent' });
  });
  it('rejects unsupported methods and malformed segments', () => {
    expect(parseModelMethod('gemini-3.5-flash:countTokens')).toBeNull();
    expect(parseModelMethod('gemini-3.5-flash')).toBeNull();
    expect(parseModelMethod(':generateContent')).toBeNull();
  });
});

describe('resolveGeminiDeployment', () => {
  const details: Record<string, any> = {
    'gemini-3.5-flash': { id: 'gemini-3.5-flash' },
    'gemini-3.5-flash--deployed': { id: 'gemini-3.5-flash--deployed', deploymentUrl: 'https://x/v2/inference/deployments/d1' },
    'gemini-2.5-pro': { id: 'gemini-2.5-pro' }
  };
  const get = async (id: string) => details[id] ?? null;
  it('uses the bare model when the twin carries the deployment', async () => {
    await expect(resolveGeminiDeployment('gemini-3.5-flash', get)).resolves.toEqual({ id: 'gemini-3.5-flash--deployed', baseModel: 'gemini-3.5-flash', deploymentUrl: 'https://x/v2/inference/deployments/d1' });
  });
  it('accepts the --deployed id directly', async () => {
    await expect(resolveGeminiDeployment('gemini-3.5-flash--deployed', get)).resolves.toMatchObject({ id: 'gemini-3.5-flash--deployed', baseModel: 'gemini-3.5-flash' });
  });
  it('returns null for an undeployed or unknown model', async () => {
    await expect(resolveGeminiDeployment('gemini-2.5-pro', get)).resolves.toBeNull();
    await expect(resolveGeminiDeployment('nope', get)).resolves.toBeNull();
  });
});

describe('geminiUrl', () => {
  it('builds the SAP subpath and forces alt=sse for streaming', () => {
    expect(geminiUrl('https://x/v2/inference/deployments/d1', 'gemini-3.5-flash', 'generateContent')).toBe('https://x/v2/inference/deployments/d1/models/gemini-3.5-flash:generateContent');
    expect(geminiUrl('https://x/v2/inference/deployments/d1', 'gemini-3.5-flash', 'streamGenerateContent')).toBe('https://x/v2/inference/deployments/d1/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
  });
});

describe('usageFromGemini / usageFromSse', () => {
  it('maps usageMetadata, counting thoughts as output', () => {
    expect(usageFromGemini({ promptTokenCount: 7, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 2 })).toEqual({ inputTokens: 7, outputTokens: 8, cacheReadTokens: 2 });
    expect(usageFromGemini(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });
  it('keeps the last usageMetadata across SSE chunks and survives partial lines', () => {
    const c1 = 'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":1}}\n\n';
    const c2 = 'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4,"totalTokenCount":11}}\n\n';
    const u1 = usageFromSse(c1, null); expect(u1.candidatesTokenCount).toBe(1);
    const u2 = usageFromSse(c2, u1); expect(u2.candidatesTokenCount).toBe(4);
    expect(usageFromSse('data: {"cand', u2)).toBe(u2);
    expect(usageFromSse('', null)).toBeNull();
  });
});

describe('geminiError / estimateEmbedTokens', () => {
  it('shapes errors the Gemini way', () => {
    expect(geminiError(404, 'no')).toEqual({ error: { code: 404, message: 'no', status: 'NOT_FOUND' } });
    expect(geminiError(403, 'x').error.status).toBe('PERMISSION_DENIED');
    expect(geminiError(400, 'x').error.status).toBe('INVALID_ARGUMENT');
    expect(geminiError(503, 'x').error.status).toBe('UNAVAILABLE');
    expect(geminiError(500, 'x').error.status).toBe('INTERNAL');
  });
  it('estimates embedding input tokens from the text parts', () => {
    expect(estimateEmbedTokens({ content: { parts: [{ text: 'abcdefgh' }] } })).toBe(2);
    expect(estimateEmbedTokens({ contents: [{ parts: [{ text: 'abc' }, { text: 'de' }] }] })).toBe(2);
    expect(estimateEmbedTokens({})).toBe(0);
  });
});
