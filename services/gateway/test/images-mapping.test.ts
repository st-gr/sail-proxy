import { describe, it, expect } from '@jest/globals';
import { mapImageRequest, openAiUsageFromGemini, sumUsages, extractImages, assembleImagesResponse } from '../src/controllers/imagesMapping';

const ok = (body: any, extra: any = {}) => {
  const r = mapImageRequest({ body, ...extra });
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const err = (body: any, extra: any = {}) => {
  const r = mapImageRequest({ body, ...extra });
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('mapImageRequest — generations', () => {
  it('maps prompt, defaults n to 1, no imageConfig without size', () => {
    const v = ok({ model: 'gemini-3.1-flash-image', prompt: 'a red circle' });
    expect(v).toMatchObject({ model: 'gemini-3.1-flash-image', n: 1, size: '1024x1024' });
    expect(v.geminiBody).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'a red circle' }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    });
  });
  it.each([
    ['1024x1024', { aspectRatio: '1:1', imageSize: '1K' }],
    ['1536x1024', { aspectRatio: '3:2', imageSize: '1K' }],
    ['1024x1536', { aspectRatio: '2:3', imageSize: '1K' }],
  ])('maps size %s', (size, imageConfig) => {
    expect(ok({ model: 'm', prompt: 'p', size }).geminiBody.generationConfig.imageConfig).toEqual(imageConfig);
  });
  it('size auto and quality standard/low/medium/xhigh/auto add nothing', () => {
    expect(ok({ model: 'm', prompt: 'p', size: 'auto', quality: 'standard' }).geminiBody.generationConfig.imageConfig).toBeUndefined();
    expect(ok({ model: 'm', prompt: 'p', quality: 'auto' }).geminiBody.generationConfig.imageConfig).toBeUndefined();
  });
  it('quality high and max raise imageSize, keeping the aspect ratio', () => {
    expect(ok({ model: 'm', prompt: 'p', size: '1536x1024', quality: 'high' }).geminiBody.generationConfig.imageConfig).toEqual({ aspectRatio: '3:2', imageSize: '2K' });
    expect(ok({ model: 'm', prompt: 'p', quality: 'max' }).geminiBody.generationConfig.imageConfig).toEqual({ imageSize: '4K' });
  });
  it('accepts n 1..4 and response_format b64_json, output_format png', () => {
    expect(ok({ model: 'm', prompt: 'p', n: 4, response_format: 'b64_json', output_format: 'png' }).n).toBe(4);
  });
  it.each([
    [{ prompt: 'p' }, 'model'],
    [{ model: 'm' }, 'prompt'],
    [{ model: 'm', prompt: '' }, 'prompt'],
    [{ model: 'm', prompt: 'p', n: 0 }, 'n'],
    [{ model: 'm', prompt: 'p', n: 5 }, 'n'],
    [{ model: 'm', prompt: 'p', n: 1.5 }, 'n'],
    [{ model: 'm', prompt: 'p', size: '256x256' }, 'size'],
    [{ model: 'm', prompt: 'p', size: '1792x1024' }, 'size'],
    [{ model: 'm', prompt: 'p', quality: 'hd' }, 'quality'],
    [{ model: 'm', prompt: 'p', response_format: 'url' }, 'response_format'],
    [{ model: 'm', prompt: 'p', output_format: 'jpeg' }, 'output_format'],
    [{ model: 'm', prompt: 'p', stream: true }, 'stream'],
    [{ model: 'm', prompt: 'p', partial_images: 2 }, 'partial_images'],
    [{ model: 'm', prompt: 'p', background: 'transparent' }, 'background'],
    [{ model: 'm', prompt: 'p', moderation: 'low' }, 'moderation'],
    [{ model: 'm', prompt: 'p', style: 'vivid' }, 'style'],
    [{ model: 'm', prompt: 'p', input_fidelity: 'high' }, 'input_fidelity'],
    [{ model: 'm', prompt: 'p', output_compression: 50 }, 'output_compression'],
  ])('refuses %j with 400 on param %s', (body, param) => {
    const e = err(body);
    expect(e.status).toBe(400);
    expect(e.error.type).toBe('invalid_request_error');
    expect(e.error.param).toBe(param);
  });
  it('accepts defaults spelled out explicitly (stream false, partial_images 0, background auto, moderation auto) and ignores user', () => {
    expect(ok({ model: 'm', prompt: 'p', stream: false, partial_images: 0, background: 'auto', moderation: 'auto', user: 'u1' }).n).toBe(1);
  });
  it('response_format url names the reason', () => {
    expect(err({ model: 'm', prompt: 'p', response_format: 'url' }).error.message).toContain('b64_json');
  });
});

describe('mapImageRequest — edits', () => {
  const png = { contentType: 'image/png', bytes: Buffer.from([1, 2, 3]) };
  const jpg = { contentType: 'image/jpeg', bytes: Buffer.from([4, 5]) };
  it('puts the uploaded images before the prompt as inlineData parts', () => {
    const v = ok({ model: 'm', prompt: 'make it blue' }, { images: [png, jpg] });
    expect(v.geminiBody.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } },
      { inlineData: { mimeType: 'image/jpeg', data: Buffer.from([4, 5]).toString('base64') } },
      { text: 'make it blue' },
    ]);
  });
  it('refuses a mask, a non-image upload, and an edit without images', () => {
    expect(err({ model: 'm', prompt: 'p' }, { images: [png], hasMask: true }).error.param).toBe('mask');
    expect(err({ model: 'm', prompt: 'p' }, { images: [{ contentType: 'application/pdf', bytes: Buffer.from([1]) }] }).error.param).toBe('image');
    expect(err({ model: 'm', prompt: 'p' }, { images: [] }).error.param).toBe('image');
  });
});

describe('usage and response assembly', () => {
  const gemini = { promptTokenCount: 20, candidatesTokenCount: 1296,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 17 }, { modality: 'IMAGE', tokenCount: 3 }],
    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }, { modality: 'TEXT', tokenCount: 6 }] };
  it('openAiUsageFromGemini splits text and image on both sides', () => {
    expect(openAiUsageFromGemini(gemini)).toEqual({
      input_tokens: 20, output_tokens: 1296, total_tokens: 1316,
      input_tokens_details: { text_tokens: 17, image_tokens: 3 },
      output_tokens_details: { text_tokens: 6, image_tokens: 1290 },
    });
    expect(openAiUsageFromGemini(undefined).total_tokens).toBe(0);
  });
  it('sumUsages adds every figure', () => {
    const u = openAiUsageFromGemini(gemini);
    expect(sumUsages([u, u]).output_tokens_details).toEqual({ text_tokens: 12, image_tokens: 2580 });
    expect(sumUsages([]).total_tokens).toBe(0);
  });
  it('extractImages keeps only image inlineData parts, in order', () => {
    expect(extractImages({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: 'AAA=' } }, { inlineData: { mimeType: 'audio/wav', data: 'BBB=' } }] } }] })).toEqual(['AAA=']);
    expect(extractImages({})).toEqual([]);
  });
  it('assembleImagesResponse builds the OpenAI shape with png and the requested size', () => {
    const r = assembleImagesResponse(['AAA=', 'BBB='], openAiUsageFromGemini(gemini), '1024x1536');
    expect(r.data).toEqual([{ b64_json: 'AAA=' }, { b64_json: 'BBB=' }]);
    expect(r.output_format).toBe('png');
    expect(r.size).toBe('1024x1536');
    expect(typeof r.created).toBe('number');
  });
});
