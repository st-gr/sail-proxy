import { DeployedTwin, resolveDeployedTwin } from '../utils/deployedTwin';

/**
 * SAP's inference proxy allowlists only these three subpaths for a Gemini
 * deployment; `:countTokens`, `:batchEmbedContents` and `:predict` are
 * refused with a 400 "Subpath ... is not allowed" before reaching the model.
 */
export const GEMINI_METHODS = ['generateContent', 'streamGenerateContent', 'embedContent'] as const;
export type GeminiMethod = typeof GEMINI_METHODS[number];

/**
 * The `@google/genai` SDK builds `<baseUrl>/<apiVersion>/models/<model>:<method>`,
 * so Express receives `<model>:<method>` as one route segment. This splits it
 * back apart on the last colon, accepting only the SAP-supported methods.
 */
export function parseModelMethod(segment: string): { model: string; method: GeminiMethod } | null {
  const idx = segment.lastIndexOf(':');
  if (idx <= 0) return null;
  const model = segment.slice(0, idx);
  const method = segment.slice(idx + 1);
  if (!(GEMINI_METHODS as readonly string[]).includes(method)) return null;
  return { model, method: method as GeminiMethod };
}

/** The twin resolver lives in utils/deployedTwin.ts; these names keep the Gemini route's imports stable. */
export type GeminiDeployment = DeployedTwin;
export const resolveGeminiDeployment = resolveDeployedTwin;

/**
 * A Gemini deployment's inference URL is `<SAP_AI_CORE_URL>/v2/inference/deployments/<id>`;
 * SAP requires the `/models/<model>:<method>` subpath appended. The genai SDK
 * does not send `?alt=sse` on its own, so streaming forces it here.
 */
export function geminiUrl(deploymentUrl: string, baseModel: string, method: GeminiMethod, alt?: string): string {
  return `${deploymentUrl}/models/${baseModel}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`;
}

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Prompt tokens Gemini attributes to the IMAGE modality (image input). */
  imageInputTokens: number;
  /** Candidate tokens Gemini attributes to the IMAGE modality (generated images); part of outputTokens. */
  imageOutputTokens: number;
}

/** Sum of `tokenCount` over the entries of a `*TokensDetails` array whose modality matches (case-insensitive). */
function modalityTokens(details: any, modality: string): number {
  if (!Array.isArray(details)) return 0;
  return details.reduce((sum: number, d: any) => {
    if (String(d?.modality ?? '').toUpperCase() !== modality) return sum;
    const n = Number(d?.tokenCount);
    // Clamped: a negative count is nonsense SAP has never sent, and subtracting it would
    // inflate the text share (`outputTokens - imageOutputTokens`) above outputTokens itself.
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);
}

/**
 * Gemini folds extended-thinking tokens into `thoughtsTokenCount`, separate
 * from `candidatesTokenCount`; the gateway's usage accounting counts both as
 * output alongside the input and cache-read figures. Image tokens (generated
 * images, image prompts) are reported INSIDE those totals and additionally
 * broken out per modality in `candidatesTokensDetails` / `promptTokensDetails`;
 * the split is carried separately so image output can be priced at its own rate
 * while every existing total stays inclusive.
 */
export function usageFromGemini(usageMetadata: any): GeminiUsage {
  const u = usageMetadata || {};
  return {
    inputTokens: u.promptTokenCount || 0,
    outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    cacheReadTokens: u.cachedContentTokenCount || 0,
    imageInputTokens: modalityTokens(u.promptTokensDetails, 'IMAGE'),
    imageOutputTokens: modalityTokens(u.candidatesTokensDetails, 'IMAGE'),
  };
}

/**
 * Streamed responses carry cumulative `usageMetadata` per chunk, with the
 * last chunk holding the running totals; a chunk boundary can split a
 * `data:` line mid-JSON, so an unparsable line must not clobber the total
 * already captured from an earlier, complete chunk.
 */
export function usageFromSse(chunkText: string, previous: any | null): any | null {
  let result = previous;
  for (const line of chunkText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.usageMetadata) result = parsed.usageMetadata;
    } catch {
      // partial chunk — keep whatever usage was already captured
    }
  }
  return result;
}

const GEMINI_STATUS_TEXT: Record<number, string> = {
  400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE'
};

/**
 * Gemini's REST error envelope names a status enum rather than just an HTTP
 * code; Gemini clients (the CLI, the genai SDK) expect this exact shape.
 */
export function geminiError(status: number, message: string): { error: { code: number; message: string; status: string } } {
  return { error: { code: status, message, status: GEMINI_STATUS_TEXT[status] || 'INTERNAL' } };
}

/**
 * SAP's `embedContent` response carries no `usageMetadata` (unlike the chat
 * methods), so the gateway estimates input tokens client-side from the
 * request text instead of accounting a real figure.
 */
export function estimateEmbedTokens(body: any): number {
  const contents = body?.contents ?? (body?.content ? [body.content] : []);
  let chars = 0;
  for (const content of contents) {
    for (const part of content?.parts ?? []) {
      if (typeof part?.text === 'string') chars += part.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

/** True when the request asks for generated images: `generationConfig.responseModalities` lists IMAGE. */
export function requestsImageOutput(body: any): boolean {
  const modalities = body?.generationConfig?.responseModalities;
  return Array.isArray(modalities) && modalities.some((m: any) => String(m).toUpperCase() === 'IMAGE');
}
