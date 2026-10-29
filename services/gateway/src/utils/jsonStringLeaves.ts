/**
 * Rewrite the string leaves of a JSON text, for tool-call arguments (OpenAI
 * `function.arguments`, Responses `function_call.arguments`), which arrive as JSON
 * serialized into a string.
 *
 * Masking or restoring such a string as plain text works on its ESCAPED form: a restored
 * value containing `"` or `\` lands unescaped inside a JSON string literal and the
 * arguments no longer parse. Rewriting the parsed leaves and re-serializing escapes them.
 *
 * Returns the text unchanged (byte for byte) when no leaf changed, and null when the text
 * is not JSON, so the caller can fall back to a plain-text rewrite. Object keys are left
 * as they are.
 */
export function mapJsonStringLeaves(text: string, fn: (s: string) => string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  let changed = false;
  const walk = (value: any): any => {
    if (typeof value === 'string') {
      const next = fn(value);
      if (next !== value) changed = true;
      return next;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i]);
      return value;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = walk(value[k]);
      return value;
    }
    return value;
  };

  const result = walk(parsed);
  return changed ? JSON.stringify(result) : text;
}

const JSON_STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;

/**
 * Rewrite every string literal of a JSON text, object keys included, IN the text: each
 * literal is decoded, passed to `fn` and, only when that changed it, re-encoded in place.
 * Every other byte (numbers of any size, whitespace, untouched literals) stays as sent,
 * and a value containing `"` or `\` is re-encoded with its escapes.
 *
 * For text that must reach a client or a deployment as it was written: restoring
 * placeholders in tool-call arguments on the response side, and re-masking them before a
 * hosted-tool continuation. Returns null when the text is not JSON, so the caller can fall
 * back to a plain-text rewrite. In valid JSON a `"` outside a string literal cannot occur,
 * so the literal scan below sees exactly the string tokens.
 */
export function mapJsonStringLiterals(text: string, fn: (s: string) => string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text.replace(JSON_STRING_LITERAL, (literal) => {
    const decoded: string = JSON.parse(literal);
    const next = fn(decoded);
    return next === decoded ? literal : JSON.stringify(next);
  });
}
