import { parseModelMethod, resolveGeminiDeployment, geminiUrl, usageFromGemini, usageFromSse, geminiError, estimateEmbedTokens, requestsImageOutput } from '../src/services/googleGeminiService';

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
    expect(usageFromGemini({ promptTokenCount: 7, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 2 })).toEqual({ inputTokens: 7, outputTokens: 8, cacheReadTokens: 2, imageInputTokens: 0, imageOutputTokens: 0 });
    expect(usageFromGemini(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, imageInputTokens: 0, imageOutputTokens: 0 });
  });
  it('splits image tokens out of the modality details and keeps outputTokens inclusive', () => {
    const usage = usageFromGemini({
      promptTokenCount: 17, candidatesTokenCount: 1296, totalTokenCount: 1313,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 17 }],
      candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }, { modality: 'TEXT', tokenCount: 6 }],
    });
    expect(usage).toEqual({ inputTokens: 17, outputTokens: 1296, cacheReadTokens: 0, imageInputTokens: 0, imageOutputTokens: 1290 });
  });
  it('counts IMAGE prompt tokens as image input and tolerates missing or malformed details', () => {
    expect(usageFromGemini({ promptTokenCount: 300, candidatesTokenCount: 5,
      promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 258 }, { modality: 'TEXT', tokenCount: 42 }] }))
      .toMatchObject({ inputTokens: 300, imageInputTokens: 258, imageOutputTokens: 0 });
    expect(usageFromGemini({ promptTokenCount: 3, candidatesTokenCount: 2, candidatesTokensDetails: 'nope' }))
      .toMatchObject({ imageInputTokens: 0, imageOutputTokens: 0 });
    expect(usageFromGemini({ promptTokenCount: 3, candidatesTokenCount: 2, candidatesTokensDetails: [{ modality: 'image', tokenCount: '2' }] }))
      .toMatchObject({ imageOutputTokens: 2 });
    // A negative count is clamped, not subtracted: it would otherwise push the text share
    // (outputTokens − imageOutputTokens) above outputTokens itself.
    expect(usageFromGemini({ promptTokenCount: 3, candidatesTokenCount: 8, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: -5 }, { modality: 'IMAGE', tokenCount: 2 }] }))
      .toMatchObject({ outputTokens: 8, imageOutputTokens: 2 });
    expect(usageFromGemini(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, imageInputTokens: 0, imageOutputTokens: 0 });
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

describe('requestsImageOutput', () => {
  it('is true only when generationConfig.responseModalities names IMAGE (any case)', () => {
    expect(requestsImageOutput({ generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })).toBe(true);
    expect(requestsImageOutput({ generationConfig: { responseModalities: ['image'] } })).toBe(true);
    expect(requestsImageOutput({ generationConfig: { responseModalities: ['TEXT'] } })).toBe(false);
    expect(requestsImageOutput({ generationConfig: { responseModalities: 'IMAGE' } })).toBe(false);
    expect(requestsImageOutput({ generationConfig: {} })).toBe(false);
    expect(requestsImageOutput(undefined)).toBe(false);
  });
});
