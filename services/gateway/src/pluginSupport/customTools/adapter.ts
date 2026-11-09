/**
 * Translate Codex's freeform `custom` tool (apply_patch) into an ordinary function
 * tool outbound, and restore the `custom_tool_call` shapes on the way back.
 *
 * BOTH SAP routes reject the type, with different wording (measured 2026-08-11):
 *   deployed       -> "The following tool is not allowed for model 'gpt-5.3-codex': custom."
 *   orchestration  -> "'custom' is not one of ['function']"
 * so the translation belongs at the shared plugin layer, where one implementation
 * serves both — the same place `namespace` and `web_search` are already handled.
 *
 * BOTH halves are required, for the reason namespaceTools/adapter.ts documents at
 * length: Codex routes a call by the shape it declared. Translate the declaration
 * without restoring the call and Codex receives a `function_call` for a tool it
 * registered as `custom`, which fails at the client instead of at the API — a
 * silent failure is worse than the 400 it replaces.
 *
 * WHAT IS LOST: the lark grammar. A `custom` tool constrains decoding to the
 * grammar; a function tool cannot express that in JSON Schema. The grammar is
 * carried into the description instead, which is a soft constraint — the model can
 * still emit a malformed patch, and Codex's apply_patch parser will reject it and
 * let the model retry. That degradation is accepted; the alternative is no
 * apply_patch at all, which is the status quo.
 *
 * Pure: no I/O, no config, no logging.
 *
 * @see responsesCustomToolsPlugin.ts - the only consumer
 * @see namespaceTools/adapter.ts - the template this imitates
 */

export type CustomToolMode = 'translate' | 'strip';

/** Translate by default: the alternative is a hard 400 that kills the turn. */
export const DEFAULT_CUSTOM_TOOL_MODE: CustomToolMode = 'translate';

/** The single string parameter a translated freeform tool takes. */
export const FREEFORM_PARAM = 'input';

const VALID_MODES: CustomToolMode[] = ['translate', 'strip'];

/** Anything that is not exactly one of the two modes resolves to the default. */
export function resolveCustomToolMode(value: unknown): CustomToolMode {
  return VALID_MODES.includes(value as CustomToolMode)
    ? (value as CustomToolMode)
    : DEFAULT_CUSTOM_TOOL_MODE;
}

function isCustomTool(tool: any): boolean {
  return !!tool && tool.type === 'custom' && typeof tool.name === 'string' && tool.name.length > 0;
}

/**
 * The description the model actually sees.
 *
 * The original text is RETAINED rather than edited: it is the tool's real
 * documentation and string-surgery on a vendor's prose is fragile. But
 * apply_patch's description ends with "This is a FREEFORM tool, so do not wrap the
 * patch in JSON", which after translation is precisely wrong — a model obeying it
 * emits bare patch text as the arguments and produces invalid JSON. So the override
 * is appended, explicit, and last.
 */
function rewriteDescription(original: unknown, format: any): string {
  const parts: string[] = [];
  if (typeof original === 'string' && original.length > 0) parts.push(original);

  parts.push(
    `IMPORTANT — this tool is now an ordinary function tool. Ignore any instruction above `
    + `describing it as FREEFORM or telling you not to wrap the payload in JSON: that applied `
    + `to an earlier form of this tool. Call it with a JSON object whose "${FREEFORM_PARAM}" `
    + `property holds the ENTIRE payload text ITSELF, verbatim, as a plain string value — do `
    + `NOT encode that payload as its own JSON document or nest another JSON object inside `
    + `"${FREEFORM_PARAM}". There is only one layer of JSON here: this function call.`
  );

  const definition = format?.type === 'grammar' && typeof format.definition === 'string'
    ? format.definition
    : '';
  if (definition) {
    parts.push(`The "${FREEFORM_PARAM}" string must match this Lark grammar exactly:\n${definition}`);
  }

  return parts.join('\n\n');
}

/**
 * Rewrite `body.tools` in place. Returns the names translated, which the response
 * side needs in order to restore only the calls it is responsible for.
 */
export function translateCustomTools(
  body: any,
  mode: CustomToolMode
): { changed: boolean; names: string[]; dropped: string[] } {
  const names: string[] = [];
  const dropped: string[] = [];

  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) {
    return { changed: false, names, dropped };
  }
  if (!body.tools.some(isCustomTool)) {
    return { changed: false, names, dropped };
  }

  const rebuilt: any[] = [];
  for (const tool of body.tools) {
    if (!isCustomTool(tool)) { rebuilt.push(tool); continue; }

    if (mode === 'strip') { dropped.push(tool.name); continue; }

    names.push(tool.name);
    rebuilt.push({
      type: 'function',
      name: tool.name,
      description: rewriteDescription(tool.description, tool.format),
      parameters: {
        type: 'object',
        properties: {
          [FREEFORM_PARAM]: { type: 'string', description: 'The complete tool payload as a single string.' },
        },
        required: [FREEFORM_PARAM],
        additionalProperties: false,
      },
    });
  }

  body.tools = rebuilt;
  // Some deployments reject `"tools": []`, so an emptied list is removed entirely —
  // the same rule flattenNamespaceTools and transformResponsesWebSearchTool follow.
  if (body.tools.length === 0) delete body.tools;

  return { changed: true, names, dropped };
}

/** Content-part types that carry text in a custom_tool_call_output. */
const OUTPUT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);

/**
 * A `custom_tool_call_output`'s `output` is an ARRAY of content parts, while a
 * `function_call_output`'s is a plain string. Confirmed against real OpenAI traffic
 * (test/fixtures/codex-custom-tools/README.md) — it is the detail most likely to be
 * got wrong from intuition.
 */
function flattenOutput(output: any): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return output === undefined ? '' : JSON.stringify(output);
  const texts: string[] = [];
  for (const part of output) {
    if (part && OUTPUT_PART_TYPES.has(part.type) && typeof part.text === 'string') texts.push(part.text);
    else if (typeof part === 'string') texts.push(part);
  }
  return texts.join('\n');
}

/**
 * Convert replayed custom-tool history in `body.input` into the function-tool
 * equivalents, in place. Returns the number of items converted.
 *
 * EVERY such item is converted, with no gate on the tool name. The alternative —
 * matching against the names translated in this same request — buys nothing: a
 * `custom_tool_call_output` carries only a `call_id`, so its name would have to be
 * recovered from a sibling item, and an unconverted item is a hard 400 on
 * orchestration (`Unsupported Responses input item type: custom_tool_call`,
 * requestTranslator.ts:125). Converting unconditionally is strictly safer.
 */
export function translateCustomCallItems(body: any): number {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return 0;

  let converted = 0;
  for (let i = 0; i < body.input.length; i += 1) {
    const item = body.input[i];
    if (!item || typeof item !== 'object') continue;

    // The item's `id` is DROPPED on both conversions below, deliberately, not carried
    // over even when present. Codex's ids carry a type-specific prefix (`ctc_` /
    // `ctco_`), and once `type` is rewritten to the function-tool equivalent the
    // upstream validates that prefix against the NEW type and rejects it — measured
    // live (deployed gpt-5.3-codex, 2026-08-11): "Invalid 'input[8].id':
    // 'ctco_019ff2c9-c862-77f1-8ccd-21401a4e93fa'. Expected an ID that begins with
    // 'fc'." `call_id` is what pairs a call to its output, and it IS preserved
    // unchanged below, so dropping `id` does not touch that pairing. The item `id` is
    // just the item's own identifier, optional on an input item — an upstream that
    // wants one assigns it. Synthesising a `fc_`-prefixed id instead would fabricate
    // an identifier the client never issued and cannot correlate, which is worse than
    // omitting an optional field.

    if (item.type === 'custom_tool_call') {
      const next: any = {
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: JSON.stringify({ [FREEFORM_PARAM]: typeof item.input === 'string' ? item.input : '' }),
      };
      if (item.status !== undefined) next.status = item.status;
      body.input[i] = next;
      converted += 1;
      continue;
    }

    if (item.type === 'custom_tool_call_output') {
      const next: any = {
        type: 'function_call_output',
        call_id: item.call_id,
        output: flattenOutput(item.output),
      };
      if (item.status !== undefined) next.status = item.status;
      body.input[i] = next;
      converted += 1;
    }
  }
  return converted;
}

/** How many EXTRA unwraps beyond the base extraction are attempted. Bounded so a
 *  pathologically nested wrapper cannot loop; two is ample for the observed defect,
 *  which double-wraps, not triple-wraps. */
const MAX_EXTRA_UNWRAPS = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Some models DOUBLE-WRAP: instead of putting the raw payload in `input`, they put a
 * whole second `{"input": ...}` envelope INSIDE that string — measured on live
 * traffic from anthropic--claude-4.8-opus via the orchestration route (2 of 4 runs),
 * with gpt-5.5, anthropic--claude-4.6-sonnet and gpt-5.3-codex unaffected in the same
 * sampling. Left alone, the client receives a JSON envelope where raw payload text
 * (e.g. a patch) was expected, and the payload fails to apply.
 *
 * Unwrap ONLY when the string parses as a plain object with EXACTLY ONE own key,
 * that key is FREEFORM_PARAM, and its value is itself a string. This is deliberately
 * narrow rather than "starts with `{`" or "is valid JSON": this adapter is generic
 * over custom tools, so in principle some OTHER custom tool could legitimately want
 * a payload that is itself a JSON object with a single "input" key, and unwrapping
 * that would corrupt a legitimate call. Requiring the shape to match our OWN wrapper
 * exactly — not just look like JSON — keeps that risk negligible: a real payload
 * with extra keys, a differently-named key, or a non-string value survives untouched.
 */
function unwrapDoubleWrappedFreeform(value: string): string {
  let current = value;
  for (let i = 0; i < MAX_EXTRA_UNWRAPS; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return current;
    }
    if (!isPlainObject(parsed)) return current;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== FREEFORM_PARAM) return current;
    const inner = parsed[FREEFORM_PARAM];
    if (typeof inner !== 'string') return current;
    current = inner;
  }
  return current;
}

/**
 * Extract the freeform payload from a translated call's `arguments`.
 *
 * Falls back to the raw arguments string whenever it is not JSON carrying a string
 * `input`. That is deliberate rather than defensive: apply_patch's own description
 * tells the model NOT to wrap the payload in JSON (Task 1 appends an override, but
 * a model may still follow the original), and a bare patch passed straight through
 * is a working call, while a thrown error is a dead turn.
 */
function extractFreeformInput(args: unknown): string {
  if (typeof args !== 'string') return '';
  try {
    const parsed = JSON.parse(args);
    const value = parsed?.[FREEFORM_PARAM];
    return typeof value === 'string' ? unwrapDoubleWrappedFreeform(value) : args;
  } catch {
    return args;
  }
}

/**
 * Put back the `custom_tool_call` shape Codex declared, so its router dispatches the
 * call. Mutates; returns whether it changed anything.
 */
export function restoreCustomToolCall(item: any, names: Set<string>): boolean {
  if (!item || item.type !== 'function_call') return false;
  if (typeof item.name !== 'string' || !names.has(item.name)) return false;

  item.input = extractFreeformInput(item.arguments);
  item.type = 'custom_tool_call';
  delete item.arguments;
  return true;
}

/** Apply restoreCustomToolCall across a response `output` array. Returns the count changed. */
export function restoreOutputItems(output: any, names: Set<string>): number {
  if (!Array.isArray(output)) return 0;
  let n = 0;
  for (const item of output) if (restoreCustomToolCall(item, names)) n += 1;
  return n;
}
