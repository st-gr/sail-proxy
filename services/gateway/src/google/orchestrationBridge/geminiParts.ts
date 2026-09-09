/**
 * One Gemini `Part` → one orchestration content block, and the error type the
 * whole Gemini bridge raises.
 *
 * Split out of requestTranslator.ts so that file keeps a single subject (a
 * REQUEST: turns, tools, generation config) while this one keeps the other
 * (a PART: what a single piece of content becomes, or why it cannot become
 * anything).
 *
 * Pure: no I/O, no config. Nothing here downloads a `fileData` URI or resizes
 * an image — a part this file cannot express THROWS, for the same reason the
 * Responses translator throws on an unknown item type: silently dropping
 * content makes the model answer a question the user did not ask.
 */

/**
 * A Gemini request item this bridge cannot translate.
 *
 * Carries the item's PATH (`contents[0].parts[1].fileData`,
 * `generationConfig.candidateCount`, `tools[0].googleSearch`) because that is
 * what a caller has to change; the controller puts it in the 400
 * INVALID_ARGUMENT body so the client is told which item, not merely that
 * "something" was unsupported.
 */
export class UnsupportedGeminiInputError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`Unsupported Gemini input at ${path}: ${detail}`);
    this.name = 'UnsupportedGeminiInputError';
    this.path = path;
  }
}

/**
 * `parts[].text` joined with newlines — the shape `systemInstruction` uses.
 *
 * A bare string is accepted too: several Gemini SDK versions let a caller pass
 * `systemInstruction: 'be brief'`, and returning '' for it would drop the
 * system prompt without a word.
 */
export function joinPartTexts(parts: any): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/**
 * A content part → an orchestration content block.
 *
 * The two function-calling parts never reach here: `functionCall` becomes an
 * assistant message's `tool_calls` and `functionResponse` a whole `tool`
 * message, so both need turn context this function does not have and the
 * caller takes them first.
 *
 * `inlineData` with an image mime type becomes the `image_url` data-URI block
 * measured live against orchestration by the Responses bridge (see
 * `textBlocks` in ../../responses/orchestrationBridge/requestTranslator.ts) —
 * never Anthropic's `{type:'image', source:{…}}` shape, which orchestration
 * does not take on this path. Every other mime type (audio, video, pdf) has no
 * block to become, so it throws rather than reaching SAP as an image.
 */
export function geminiPartToBlock(part: any, path: string): any {
  if (typeof part?.text === 'string') return { type: 'text', text: part.text };

  if (part?.inlineData) {
    const { mimeType, data } = part.inlineData;
    if (typeof mimeType === 'string' && /^image\//i.test(mimeType) && typeof data === 'string') {
      return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } };
    }
    throw new UnsupportedGeminiInputError(
      `${path}.inlineData`,
      `inline data of type '${mimeType}' cannot be sent through orchestration (images only)`,
    );
  }

  if (part?.fileData) {
    // This module is pure — it cannot fetch a Files-API URI, and the gateway
    // never uploaded one, so the reference means nothing upstream either.
    throw new UnsupportedGeminiInputError(
      `${path}.fileData`,
      'file references are not available on this gateway; send the bytes as inlineData',
    );
  }

  throw new UnsupportedGeminiInputError(path, 'unrecognised part');
}
