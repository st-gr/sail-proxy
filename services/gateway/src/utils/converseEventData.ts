/**
 * Parse the data of one event from the emulated Converse stream
 * (`handleEmulatedStreamingRequest` in awsBedrockService).
 *
 * The handler used to run `Function("use strict"; return (<data>))()`, which
 * executed upstream bytes as JavaScript. Its comment says it did that to accept
 * single-quoted (Python-dict style) objects; no fixture, test or payload log in
 * the repo shows such data, and the Converse stream is JSON, but the handler
 * keeps accepting that shape: single-quoted strings are rewritten to JSON
 * strings by a scanner and the result goes through `JSON.parse`. Nothing is
 * evaluated, and anything else that is not JSON (identifiers, calls,
 * parentheses, unquoted keys) makes `JSON.parse` throw.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
  "'": "'", '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f',
};

/** Rewrite single-quoted string literals to JSON strings; copy everything else. */
function singleQuotedToJson(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      // A double-quoted string is copied verbatim; JSON.parse validates it.
      const start = i++;
      while (i < input.length && input[i] !== '"') i += input[i] === '\\' ? 2 : 1;
      if (i >= input.length) throw new SyntaxError('Unterminated double-quoted string');
      out += input.slice(start, ++i);
    } else if (ch === "'") {
      let value = '';
      i++;
      while (i < input.length && input[i] !== "'") {
        if (input[i] !== '\\') { value += input[i++]; continue; }
        const esc = input[i + 1];
        const hexLength = esc === 'u' ? 4 : esc === 'x' ? 2 : 0;
        if (hexLength) {
          const hex = input.slice(i + 2, i + 2 + hexLength);
          if (hex.length !== hexLength || !/^[0-9a-fA-F]+$/.test(hex)) throw new SyntaxError(`Bad \\${esc} escape`);
          value += String.fromCharCode(parseInt(hex, 16));
          i += 2 + hexLength;
        } else if (esc !== undefined && esc in SIMPLE_ESCAPES) {
          value += SIMPLE_ESCAPES[esc];
          i += 2;
        } else {
          throw new SyntaxError(`Unsupported escape \\${esc ?? ''}`);
        }
      }
      if (i >= input.length) throw new SyntaxError('Unterminated single-quoted string');
      i++;
      out += JSON.stringify(value);
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Parse JSON or single-quoted literal event data. Throws on anything else; never evaluates. */
export function parseConverseEventData(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return JSON.parse(singleQuotedToJson(data));
  }
}
