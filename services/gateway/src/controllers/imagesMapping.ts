/**
 * Pure mapping between the OpenAI Images API (openai@7 `ImageGenerateParams` /
 * `ImageEditParams` / `ImagesResponse`) and Gemini `generateContent` bodies.
 * Spec: docs/superpowers/specs/2026-09-15-image-generation-design.md §2.
 */
import { usageFromGemini } from '../services/googleGeminiService';

export const MAX_IMAGES = 4;
export const ALLOWED_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface ImagesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { text_tokens: number; image_tokens: number };
  output_tokens_details: { text_tokens: number; image_tokens: number };
}
export interface ImageRequestError { status: number; error: { message: string; type: string; param?: string; code?: string } }
export interface MappedImageRequest { model: string; n: number; size: string; geminiBody: any }
export interface UploadedImage { contentType: string; bytes: Buffer }

const SIZES: Record<string, { aspectRatio: string; imageSize: string }> = {
  '1024x1024': { aspectRatio: '1:1', imageSize: '1K' },
  '1536x1024': { aspectRatio: '3:2', imageSize: '1K' },
  '1024x1536': { aspectRatio: '2:3', imageSize: '1K' },
};
const IGNORED_QUALITIES = ['standard', 'low', 'medium', 'xhigh', 'auto'];
const QUALITY_SIZE: Record<string, string> = { high: '2K', max: '4K' };
const DEFAULT_SIZE = '1024x1024';

function bad(message: string, param: string, code = 'unsupported_parameter'): { ok: false; error: ImageRequestError } {
  return { ok: false, error: { status: 400, error: { message, type: 'invalid_request_error', param, code } } };
}
const isUnset = (v: unknown) => v === undefined || v === null;

export function mapImageRequest(input: { body: Record<string, any>; images?: UploadedImage[]; hasMask?: boolean }):
  { ok: true; value: MappedImageRequest } | { ok: false; error: ImageRequestError } {
  const b = input.body || {};
  if (typeof b.model !== 'string' || !b.model.trim()) return bad('model is required: a Google image model with a deployment, e.g. gemini-3.1-flash-image', 'model', 'missing_parameter');
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) return bad('prompt is required', 'prompt', 'missing_parameter');

  let n = 1;
  if (!isUnset(b.n)) {
    if (!Number.isInteger(b.n) || b.n < 1 || b.n > MAX_IMAGES) return bad(`n must be an integer between 1 and ${MAX_IMAGES}`, 'n', 'invalid_value');
    n = b.n;
  }
  let size = DEFAULT_SIZE;
  let imageConfig: Record<string, string> | undefined;
  if (!isUnset(b.size) && b.size !== 'auto') {
    if (!SIZES[b.size]) return bad(`size must be one of ${Object.keys(SIZES).join(', ')} or auto`, 'size', 'invalid_value');
    size = b.size;
    imageConfig = { ...SIZES[b.size] };
  }
  if (!isUnset(b.quality)) {
    if (QUALITY_SIZE[b.quality]) imageConfig = { ...(imageConfig || {}), imageSize: QUALITY_SIZE[b.quality] };
    else if (!IGNORED_QUALITIES.includes(b.quality)) return bad(`quality ${b.quality} is not supported; use standard, high or max`, 'quality', 'invalid_value');
  }
  if (!isUnset(b.response_format) && b.response_format !== 'b64_json') return bad('the gateway stores no images; use response_format b64_json', 'response_format');
  if (!isUnset(b.output_format) && b.output_format !== 'png') return bad('images are returned as png; output_format jpeg and webp are not supported', 'output_format');
  if (!isUnset(b.stream) && b.stream !== false) return bad('streaming is not supported for images', 'stream');
  if (!isUnset(b.partial_images) && b.partial_images !== 0) return bad('partial_images is not supported', 'partial_images');
  if (!isUnset(b.background) && b.background !== 'auto') return bad('background is not supported', 'background');
  if (!isUnset(b.moderation) && b.moderation !== 'auto') return bad('moderation is not supported', 'moderation');
  for (const p of ['style', 'input_fidelity', 'output_compression']) {
    if (!isUnset(b[p])) return bad(`${p} is not supported`, p);
  }
  if (input.hasMask) return bad('Gemini edits by instruction; mask is not supported', 'mask');

  const parts: any[] = [];
  if (input.images !== undefined) {
    if (input.images.length === 0) return bad('at least one image is required for an edit', 'image', 'missing_parameter');
    for (const img of input.images) {
      if (!ALLOWED_UPLOAD_TYPES.includes(img.contentType)) return bad(`image must be one of ${ALLOWED_UPLOAD_TYPES.join(', ')}`, 'image', 'invalid_value');
      parts.push({ inlineData: { mimeType: img.contentType, data: img.bytes.toString('base64') } });
    }
  }
  parts.push({ text: b.prompt });

  const generationConfig: any = { responseModalities: ['IMAGE', 'TEXT'] };
  if (imageConfig) generationConfig.imageConfig = imageConfig;
  return { ok: true, value: { model: b.model.trim(), n, size, geminiBody: { contents: [{ role: 'user', parts }], generationConfig } } };
}

export function openAiUsageFromGemini(usageMetadata: any): ImagesUsage {
  const u = usageFromGemini(usageMetadata);
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
    input_tokens_details: { text_tokens: Math.max(0, u.inputTokens - u.imageInputTokens), image_tokens: u.imageInputTokens },
    output_tokens_details: { text_tokens: Math.max(0, u.outputTokens - u.imageOutputTokens), image_tokens: u.imageOutputTokens },
  };
}

export function sumUsages(list: ImagesUsage[]): ImagesUsage {
  const zero = openAiUsageFromGemini(undefined);
  return list.reduce((acc, u) => ({
    input_tokens: acc.input_tokens + u.input_tokens,
    output_tokens: acc.output_tokens + u.output_tokens,
    total_tokens: acc.total_tokens + u.total_tokens,
    input_tokens_details: { text_tokens: acc.input_tokens_details.text_tokens + u.input_tokens_details.text_tokens, image_tokens: acc.input_tokens_details.image_tokens + u.input_tokens_details.image_tokens },
    output_tokens_details: { text_tokens: acc.output_tokens_details.text_tokens + u.output_tokens_details.text_tokens, image_tokens: acc.output_tokens_details.image_tokens + u.output_tokens_details.image_tokens },
  }), zero);
}

export function extractImages(geminiResponse: any): string[] {
  const parts = geminiResponse?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p: any) => typeof p?.inlineData?.data === 'string' && /^image\//i.test(String(p.inlineData.mimeType || '')))
    .map((p: any) => p.inlineData.data);
}

export function assembleImagesResponse(images: string[], usage: ImagesUsage, size: string) {
  return { created: Math.floor(Date.now() / 1000), data: images.map((b64_json) => ({ b64_json })), output_format: 'png' as const, size, usage };
}
