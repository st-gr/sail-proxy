import { deployedSiblingName } from '../utils/responsesEligibility';

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

export interface GeminiDeployment { id: string; baseModel: string; deploymentUrl: string }

/**
 * The gateway lists every deployment twice: the bare model (orchestration
 * entry, no deploymentUrl) and its `<model>--deployed` twin (has the URL).
 * Resolves whichever of the two actually carries a deploymentUrl.
 */
export async function resolveGeminiDeployment(model: string, getDetails: (id: string) => Promise<any>): Promise<GeminiDeployment | null> {
  const baseModel = model.endsWith('--deployed') ? model.slice(0, -'--deployed'.length) : model;
  const direct = await getDetails(model);
  if (direct?.deploymentUrl) return { id: model, baseModel, deploymentUrl: direct.deploymentUrl };
  const twin = deployedSiblingName(model);
  if (twin) {
    const twinDetails = await getDetails(twin);
    if (twinDetails?.deploymentUrl) return { id: twin, baseModel, deploymentUrl: twinDetails.deploymentUrl };
  }
  return null;
}

/**
 * A Gemini deployment's inference URL is `<SAP_AI_CORE_URL>/v2/inference/deployments/<id>`;
 * SAP requires the `/models/<model>:<method>` subpath appended. The genai SDK
 * does not send `?alt=sse` on its own, so streaming forces it here.
 */
export function geminiUrl(deploymentUrl: string, baseModel: string, method: GeminiMethod, alt?: string): string {
  return `${deploymentUrl}/models/${baseModel}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`;
}

export interface GeminiUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number }

/**
 * Gemini folds extended-thinking tokens into `thoughtsTokenCount`, separate
 * from `candidatesTokenCount`; the gateway's usage accounting counts both as
 * output alongside the input and cache-read figures.
 */
export function usageFromGemini(usageMetadata: any): GeminiUsage {
  const u = usageMetadata || {};
  return {
    inputTokens: u.promptTokenCount || 0,
    outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    cacheReadTokens: u.cachedContentTokenCount || 0
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
