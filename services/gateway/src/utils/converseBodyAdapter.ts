/**
 * Body-shape adapter for the AWS Bedrock Converse API (`/aws-bedrock/.../converse`,
 * `converse-stream`) and the Amazon Nova invoke body, which uses the same message shape.
 *
 * The pseudonymization plugin was written for chat-shaped bodies whose content blocks carry a
 * `type` (`{ type: 'text', text }`). Converse blocks carry none: a text block is `{ text }`, a
 * tool call `{ toolUse: { toolUseId, name, input } }`, a tool result
 * `{ toolResult: { toolUseId, content: [{ text } | { json }] } }`, and the system prompt is
 * `system: [{ text }]`. Without this adapter such a body passed the plugin unmasked.
 */

/** A Converse system or content block: an object with no `type`. */
const isUntypedBlock = (block: any): boolean =>
  !!block && typeof block === 'object' && !Array.isArray(block) && block.type === undefined;

/**
 * True when the body is Converse-shaped: a `messages` array, and a system entry or message
 * content block without a `type` (an Anthropic or OpenAI body types every block).
 */
export function isConverseBody(body: any): boolean {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return false;
  if (Array.isArray(body.system) && body.system.some(isUntypedBlock)) return true;
  return body.messages.some((m: any) => Array.isArray(m?.content) && m.content.some(isUntypedBlock));
}

/** A maskable text, with a dot path usable by setConverseInputText. */
export interface ConverseText { text: string; path: string }

/** A JSON value masked leaf by leaf (`toolUse.input`, a tool result's `json`), with its holder. */
export interface ConverseJson { holder: any; key: string }

/**
 * Every maskable node of a Converse body: system and message `text`, the text and JSON of
 * tool results, and tool-call inputs. Images, documents and reasoning blocks are not text the
 * plugin masks (a reasoning block is signed; changing it invalidates the signature).
 */
export function extractConverseInputs(body: any): { texts: ConverseText[]; json: ConverseJson[] } {
  const texts: ConverseText[] = [];
  const json: ConverseJson[] = [];
  if (!body || typeof body !== 'object') return { texts, json };

  if (Array.isArray(body.system)) {
    body.system.forEach((block: any, i: number) => {
      if (typeof block?.text === 'string' && block.text.length > 0) texts.push({ text: block.text, path: `system.${i}.text` });
    });
  }

  if (!Array.isArray(body.messages)) return { texts, json };
  body.messages.forEach((message: any, i: number) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block: any, j: number) => {
      if (!block || typeof block !== 'object') return;
      if (typeof block.text === 'string' && block.text.length > 0) {
        texts.push({ text: block.text, path: `messages.${i}.content.${j}.text` });
      }
      if (block.toolUse && block.toolUse.input !== undefined && block.toolUse.input !== null) {
        json.push({ holder: block.toolUse, key: 'input' });
      }
      const results = block.toolResult?.content;
      if (Array.isArray(results)) {
        results.forEach((item: any, k: number) => {
          if (typeof item?.text === 'string' && item.text.length > 0) {
            texts.push({ text: item.text, path: `messages.${i}.content.${j}.toolResult.content.${k}.text` });
          }
          if (item && item.json !== undefined && item.json !== null) json.push({ holder: item, key: 'json' });
        });
      }
    });
  });
  return { texts, json };
}

/** Write a masked string back to the path extractConverseInputs produced. */
export function setConverseInputText(body: any, path: string, newText: string): void {
  const parts = path.split('.');
  let obj: any = body;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj === undefined || obj === null) return;
    obj = obj[parts[i]];
  }
  if (obj && typeof obj === 'object') obj[parts[parts.length - 1]] = newText;
}

/** Append the copy-note as a Converse system block (`{ text }`, no `type`), creating `system`. */
export function appendConverseInstructions(body: any, note: string): void {
  if (!body || typeof body !== 'object') return;
  if (!Array.isArray(body.system)) body.system = [];
  body.system.push({ text: note });
}

/** Recursively unmask every string of a JSON value, in place; returns the (possibly new) value. */
function unmaskStrings(value: any, unmask: (s: string) => string): any {
  if (typeof value === 'string') return unmask(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = unmaskStrings(value[i], unmask);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = unmaskStrings(value[key], unmask);
  }
  return value;
}

/**
 * Unmask a Converse (or Nova invoke) response in place: `output.message.content[]` text,
 * tool-call inputs and reasoning text.
 */
export function unmaskConverseOutput(response: any, unmask: (s: string) => string): void {
  const content = response?.output?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') block.text = unmask(block.text);
    if (block.toolUse && block.toolUse.input !== undefined) block.toolUse.input = unmaskStrings(block.toolUse.input, unmask);
    const reasoning = block.reasoningContent?.reasoningText;
    if (reasoning && typeof reasoning.text === 'string') reasoning.text = unmask(reasoning.text);
  }
}
