/**
 * Body-shape adapter for the Google Gemini generateContent API.
 *
 * The pseudonymization plugin was written for chat-shaped bodies
 * (`messages` / `system`). Gemini uses `contents` (an array of turns, each
 * with `parts`) and an optional `systemInstruction`. Without this adapter a
 * /google request would bypass PII masking entirely.
 */

/** True when the body looks like a Gemini request rather than chat completions / Responses. */
export function isGeminiBody(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.messages)) return false;
  if (body.input !== undefined) return false;
  return Array.isArray(body.contents);
}

/**
 * Every maskable text node, with a dot path usable by setGeminiInputText.
 * Only `.text` parts are maskable — `functionResponse` JSON and `inlineData`
 * are never masked/unmasked.
 */
export function extractGeminiInputTexts(body: any): Array<{ text: string; path: string }> {
  const out: Array<{ text: string; path: string }> = [];
  if (!body || typeof body !== 'object') return out;

  // `systemInstruction: 'be brief'` — several Gemini SDK versions accept the bare
  // string, and geminiParts.ts's `joinPartTexts` translates it, so it reaches the
  // model. Walking only `.parts[]` left that whole system prompt unmasked.
  if (typeof body.systemInstruction === 'string' && body.systemInstruction.length > 0) {
    out.push({ text: body.systemInstruction, path: 'systemInstruction' });
  } else if (Array.isArray(body.systemInstruction?.parts)) {
    for (let i = 0; i < body.systemInstruction.parts.length; i++) {
      const part = body.systemInstruction.parts[i];
      if (part && typeof part.text === 'string' && part.text.length > 0) {
        out.push({ text: part.text, path: `systemInstruction.parts.${i}.text` });
      }
    }
  }

  if (!Array.isArray(body.contents)) return out;

  for (let i = 0; i < body.contents.length; i++) {
    const content = body.contents[i];
    if (!content || !Array.isArray(content.parts)) continue;
    for (let j = 0; j < content.parts.length; j++) {
      const part = content.parts[j];
      if (part && typeof part.text === 'string' && part.text.length > 0) {
        out.push({ text: part.text, path: `contents.${i}.parts.${j}.text` });
      }
    }
  }

  return out;
}

/**
 * Write a masked string back to the path extract produced.
 *
 * A single-segment path (`systemInstruction`, the bare-string form) is assigned
 * straight onto the body, which is why the walk below stops one segment short.
 */
export function setGeminiInputText(body: any, path: string, newText: string): void {
  const parts = path.split('.');
  let obj: any = body;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj === undefined || obj === null) return;
    obj = obj[parts[i]];
  }
  if (obj && typeof obj === 'object') obj[parts[parts.length - 1]] = newText;
}

/**
 * Append the copy-note as a new text part of `systemInstruction` (creating it).
 *
 * A NON-EMPTY bare-string form is normalised, never replaced: overwriting it with
 * `{ parts: [] }` silently deleted the caller's whole system prompt — and after
 * masking, the string sitting there is the MASKED prompt, so the deletion took the
 * masked text out of the request while leaving its placeholders in the map.
 *
 * An EMPTY string carries nothing to preserve (`extractGeminiInputTexts` skips it
 * for the same reason), so it falls through to the empty container below rather
 * than becoming a `{ text: '' }` part the model would be shown alongside the note.
 */
export function appendGeminiInstructions(body: any, note: string): void {
  if (!body || typeof body !== 'object') return;
  if (typeof body.systemInstruction === 'string' && body.systemInstruction.length > 0) {
    body.systemInstruction = { parts: [{ text: body.systemInstruction }] };
  }
  if (!body.systemInstruction || typeof body.systemInstruction !== 'object') {
    body.systemInstruction = { parts: [] };
  }
  if (!Array.isArray(body.systemInstruction.parts)) {
    body.systemInstruction.parts = [];
  }
  body.systemInstruction.parts.push({ text: note });
}

/** Recursively unmask every string value of a functionCall's `args`, in place. */
function unmaskArgsStrings(value: any, unmask: (s: string) => string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') value[i] = unmask(value[i]);
      else unmaskArgsStrings(value[i], unmask);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = unmask(value[key]);
    else unmaskArgsStrings(value[key], unmask);
  }
}

/**
 * Unmask every text-bearing node of a Gemini response's `candidates`, in place.
 * Touches `.text` parts and string values inside `functionCall.args` (a masked
 * entity can flow into a tool argument); never `functionResponse` or `inlineData`.
 * Stream frames share this exact shape, so this same function unmasks both a
 * final response and a per-chunk streamed frame.
 */
export function unmaskGeminiOutput(response: any, unmask: (s: string) => string): void {
  if (!response || !Array.isArray(response.candidates)) return;

  for (const candidate of response.candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') part.text = unmask(part.text);
      if (part.functionCall?.args && typeof part.functionCall.args === 'object') {
        unmaskArgsStrings(part.functionCall.args, unmask);
      }
    }
  }
}
