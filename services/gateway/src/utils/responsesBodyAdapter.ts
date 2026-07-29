/**
 * Body-shape adapter for the OpenAI Responses API.
 *
 * The pseudonymization plugin was written for chat-shaped bodies
 * (`messages` / `system`). Responses uses `instructions` and `input`, where
 * `input` is either a plain string or an array of items. Without this adapter
 * a /responses request would bypass PII masking entirely.
 */

/** True when the body looks like a Responses request rather than chat completions. */
export function isResponsesBody(body: any): boolean {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.messages)) return false;
  return body.input !== undefined || typeof body.instructions === 'string';
}

/** Every maskable text node, with a dot path usable by setResponsesInputText. */
export function extractResponsesInputTexts(body: any): Array<{ text: string; path: string }> {
  const out: Array<{ text: string; path: string }> = [];
  if (!body || typeof body !== 'object') return out;

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    out.push({ text: body.instructions, path: 'instructions' });
  }

  if (typeof body.input === 'string') {
    if (body.input.length > 0) out.push({ text: body.input, path: 'input' });
    return out;
  }

  if (!Array.isArray(body.input)) return out;

  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i];
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.content)) {
      for (let c = 0; c < item.content.length; c++) {
        const part = item.content[c];
        if (part && typeof part.text === 'string') {
          out.push({ text: part.text, path: `input.${i}.content.${c}.text` });
        }
        // Refusal parts carry model prose too, and Codex replays the whole
        // conversation — an unmasked refusal would send raw PII back upstream.
        if (part && typeof part.refusal === 'string') {
          out.push({ text: part.refusal, path: `input.${i}.content.${c}.refusal` });
        }
      }
    } else if (typeof item.content === 'string') {
      out.push({ text: item.content, path: `input.${i}.content` });
    }

    if (typeof item.arguments === 'string') {
      out.push({ text: item.arguments, path: `input.${i}.arguments` });
    }
    if (typeof item.output === 'string') {
      out.push({ text: item.output, path: `input.${i}.output` });
    }

    if (Array.isArray(item.summary)) {
      for (let s = 0; s < item.summary.length; s++) {
        const part = item.summary[s];
        if (part && typeof part.text === 'string') {
          out.push({ text: part.text, path: `input.${i}.summary.${s}.text` });
        }
      }
    }
  }
  return out;
}

/** Write a masked string back to the path extract produced. */
export function setResponsesInputText(body: any, path: string, newText: string): void {
  const parts = path.split('.');
  let obj: any = body;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj === undefined || obj === null) return;
    obj = obj[parts[i]];
  }
  if (obj && typeof obj === 'object') obj[parts[parts.length - 1]] = newText;
}

/** Append the copy-note to `instructions` (the Responses equivalent of `system`). */
export function appendResponsesInstructions(body: any, note: string): void {
  if (!body || typeof body !== 'object') return;
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    body.instructions = `${body.instructions}\n\n${note}`;
  } else {
    body.instructions = note;
  }
}

/** Unmask every text-bearing node of a Responses `output` array, in place. */
export function unmaskResponsesOutput(response: any, unmask: (s: string) => string): void {
  if (!response || !Array.isArray(response.output)) return;

  for (const item of response.output) {
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && typeof part.text === 'string') part.text = unmask(part.text);
        if (part && typeof part.refusal === 'string') part.refusal = unmask(part.refusal);
      }
    }
    if (typeof item.arguments === 'string') item.arguments = unmask(item.arguments);
    if (Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s && typeof s.text === 'string') s.text = unmask(s.text);
      }
    }
  }
}
