/**
 * Which request bodies the pseudonymization plugin can mask. With masking forced, a body the
 * plugin has no extractor for is refused (failClosed.ts) instead of being sent unmasked.
 */

/**
 * The fields of a request body the plugin has no extractor for, which would reach the
 * upstream unmasked: a body that is not a JSON object, a top-level prompt string
 * (`prompt` — Llama, Mistral, Cohere — `inputText` — Titan — or `message` — Cohere), or a body
 * with no conversation the plugin reads (`messages`, or `recognized`: a Responses or Gemini body).
 * Returns a description for the log (never the content), or null when the shape is covered.
 */
export function unsupportedBodyShape(body: any, recognized: boolean): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request body is not a JSON object';
  const promptFields = ['prompt', 'inputText', 'message'].filter((key) => body[key] !== undefined && body[key] !== null);
  if (promptFields.length > 0) return `request body carries ${promptFields.join(', ')}, which the plugin does not read`;
  if (!recognized && !Array.isArray(body.messages)) return 'request body has no conversation the plugin reads';
  if (Array.isArray(body.messages)) {
    const bad = body.messages.findIndex((m: any) => m?.content !== undefined && m?.content !== null
      && typeof m.content !== 'string' && !Array.isArray(m.content));
    if (bad !== -1) return `messages[${bad}].content has a shape the plugin does not read`;
  }
  return null;
}
