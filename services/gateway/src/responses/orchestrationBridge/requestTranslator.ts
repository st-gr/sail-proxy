/**
 * Responses request → SAP orchestration `/v2/completion` payload.
 *
 * Orchestration speaks OpenAI chat shape, so the job is semantic: Responses
 * `input` items become chat messages, `tools` move onto `prompt.tools`.
 *
 * CONTENT IS EMITTED AS BLOCKS for system/user/assistant messages. A string
 * has nowhere to hang a `cache_control` breakpoint, and prompt caching on
 * this path depends on one. `prompt_templating` accepts block content —
 * `messages_history` has always carried it (see openaiController's Anthropic
 * branch), and the flattening that used to sit alongside it was dead code.
 *
 * The one exception, confirmed live: a `role: 'tool'` message's `content`
 * MUST be a plain string. SAP's Anthropic-harmonization step 400s with
 * "Tool message content must be a string for Anthropic harmonization.
 * Received: list." if it is not — block content is never marked for a cache
 * breakpoint anyway (see cacheBreakpoints.ts), so this costs nothing.
 * An assistant message carrying ONLY `tool_calls` (no text) must send
 * `content: ''`, not `content: []` — orchestration's schema validates
 * content as `string`-or-array-of-blocks and an empty array satisfies
 * neither branch, 400ing with "Request Body: [] is not of type 'string'".
 *
 * Pure: no I/O, no Express, no config. Everything the caller must decide —
 * model name, streaming — arrives in `opts`.
 */
import { SapV2CompletionRequest, SapV2Message } from '../../services/sapOrchestrationTypes';
import { resolveReasoningEffort } from '../../utils/reasoningSupport';

/** An input item this translator does not understand. */
export class UnsupportedInputItemError extends Error {
  readonly itemType: string;
  constructor(itemType: string) {
    super(`Unsupported Responses input item type: ${itemType}`);
    this.name = 'UnsupportedInputItemError';
    this.itemType = itemType;
  }
}

/** Responses text part types that carry model-visible text. */
const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);

/**
 * A message item's `content` → text/image blocks.
 *
 * A part this translator cannot express THROWS, for exactly the reason an
 * unknown top-level item type does: silently dropping it makes the model answer
 * a question the user did not ask. Keeping only the text parts meant an
 * `input_image` vanished without trace — and a message whose parts were ALL
 * non-text produced `content: []`, the one shape this file's header documents
 * orchestration rejecting outright ("Request Body: [] is not of type
 * 'string'"), so the request failed anyway with a 400 that named none of this.
 * The error carries the PART type, which is what a caller has to change.
 *
 * `input_image` is accepted, but ONLY when its url is already a `data:` URL —
 * measured live, not guessed: sent via the chat path to
 * anthropic--claude-4.8-opus, a request carrying
 * `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}` made the
 * model correctly answer "pink" about a 1x1 pink PNG, and the upstream
 * payload carried `image_url` — never Anthropic's `{type:"image",
 * source:{…}}` shape, which this file therefore does not emit.
 *
 * A REMOTE url still throws. This file is pure — no I/O, no downloads (see
 * the file header) — so it cannot inline one itself. A separate plugin
 * normalises remote image URLs to data URLs in its `before` handler, before
 * the request ever reaches this translator; a remote url landing here means
 * that guarantee broke, and the loud throw is the correct failure, not a
 * silent pass-through of a url orchestration would 400 on anyway.
 */
function textBlocks(content: any): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: any[] = [];
  for (const part of content) {
    if (TEXT_PART_TYPES.has(part?.type) && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
      continue;
    }
    if (part?.type === 'input_image') {
      // Codex's exact `input_image` part shape is in NO capture in this repo
      // (`input_image` appears 0 times across 330 payload-log captures, as of
      // 2026-08-12). The Responses API documents `image_url` both as a plain
      // string and as an object `{url}`, so both are accepted here —
      // deliberate tolerance, not a shape copied from an observed client.
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      // `data:image/…` specifically, not just `data:` — this is an image
      // part, and a `data:text/plain;…` URL slipping in as an "image_url"
      // block is a different bug than the one this translator exists to
      // catch, better refused here than forwarded.
      if (typeof url === 'string' && /^data:image\//i.test(url)) {
        out.push({ type: 'image_url', image_url: { url } });
        continue;
      }
      // Not a data:image URL (remote, non-image data:, missing, or
      // malformed) — fall through to the throw below rather than emitting a
      // block orchestration would reject anyway.
    }
    throw new UnsupportedInputItemError(String(part?.type));
  }
  return out;
}

/**
 * A `function_call_output` whose `output` is an array may carry an image.
 *
 * Measured live, not guessed: codex's `view_image` tool returns the image
 * this way — a real codex 0.147.0 turn captured a `data:image/...` URL at
 * `output[0].image_url` (`input_image` inside a `message`, the shape
 * `textBlocks` already handles above, is never what codex actually sends).
 * The array element's own `type` field was not part of what was measured —
 * the capture's key listing named the function_call_output ITEM's keys
 * (`call_id, id, output, type`), not the array element's — so this looks for
 * `image_url` on any element rather than assuming an unconfirmed `type`
 * value. Text parts (same TEXT_PART_TYPES set as textBlocks) are collected
 * too, so they survive alongside the image rather than being dropped.
 *
 * Returns null when the array carries no `data:image/...` url — the caller
 * then keeps today's behaviour (JSON.stringify the whole array) unchanged,
 * which is the contract for a text-only array and for a non-image url in
 * this position alike.
 */
function extractOutputImages(output: any[]): { text: string; imageUrls: string[] } | null {
  const imageUrls: string[] = [];
  const textParts: string[] = [];
  for (const part of output) {
    if (part && typeof part === 'object') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && /^data:image\//i.test(url)) {
        imageUrls.push(url);
        continue;
      }
    }
    if (TEXT_PART_TYPES.has(part?.type) && typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }
  if (imageUrls.length === 0) return null;
  return { text: textParts.join('\n'), imageUrls };
}

/**
 * Item types this translator accepts and then DROPS rather than translating.
 *
 * `reasoning` — Anthropic models have no equivalent, no golden exists for one
 * served through orchestration, and fabricating a shape is worse than omitting it.
 *
 * `compaction` / `compaction_trigger` — SAP orchestration has no compaction
 * mechanism, so there is nothing to translate these into. Dropping them is not
 * merely the tidier option, it is the difference between a degraded session and
 * a dead one: codex replays its ENTIRE history every turn (`store: false`, no
 * `previous_response_id`), so one `/compact` puts a `compaction` item in that
 * history and every subsequent turn carries it. Throwing therefore does not cost
 * one turn, it costs the rest of the session — unrecoverably, because the item
 * never leaves the client's history.
 *
 * Measured 2026-08-11 against both routes with the same body: the deployed route
 * accepted `compaction_trigger` (200, and answered with a `compaction` output
 * item) and accepted a replayed `compaction`, while this bridge rejected both
 * with `Unsupported Responses input item type`. That divergence is the whole
 * reason this set exists. Dropping costs the model its compaction; throwing cost
 * the user their session.
 *
 * Real shapes, from test/fixtures/codex-custom-tools/responses-api-compliance-capture.json:
 *   {"type": "compaction_trigger"}                       — the entire item
 *   {"id": "cmp_…", "type": "compaction", "encrypted_content": "…",
 *    "internal_chat_message_metadata_passthrough": {"turn_id": "…"}}
 */
const DROPPED_ITEM_TYPES: ReadonlySet<string> = new Set([
  'reasoning',
  'compaction',
  'compaction_trigger',
]);

/**
 * Responses `input` (+ optional `instructions`) → chat messages.
 *
 * The types in DROPPED_ITEM_TYPES are skipped; see that constant for why each one
 * is there. Every OTHER unknown item type throws, because silently dropping
 * content makes the model answer a question the user did not ask — this set is a
 * short list of deliberate exceptions, not a licence to swallow anything unknown.
 */
export function responsesInputToMessages(input: any, instructions?: string): SapV2Message[] {
  const messages: SapV2Message[] = [];

  if (typeof instructions === 'string' && instructions.length > 0) {
    messages.push({ role: 'system', content: [{ type: 'text', text: instructions }] });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: input }] });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    const type = item?.type;

    if (DROPPED_ITEM_TYPES.has(type)) continue;

    if (type === 'message' || (type === undefined && item?.role)) {
      // OpenAI's `developer` role is the Responses-era spelling of `system`; orchestration
      // knows only system/user/assistant/tool ("Invalid role 'developer' in message" from
      // SAP's LLM module for gemini-3.5-flash, measured live 2026-09-08 — pi sends the
      // system prompt as `developer` to any model it marks as reasoning-capable).
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: textBlocks(item.content) });
      continue;
    }

    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        }],
      } as SapV2Message);
      continue;
    }

    if (type === 'function_call_output') {
      // Unlike every other role, a `tool` message's content must be a plain
      // string, not a content-block array — SAP's Anthropic harmonization
      // step rejects `list` here with a 400 ("Tool message content must be
      // a string for Anthropic harmonization"), confirmed live against the
      // orchestration deployment. That rules out putting an image straight
      // into this message — see extractOutputImages above for where it goes
      // instead when `output` is an array carrying one.
      const imageOutput = Array.isArray(item.output) ? extractOutputImages(item.output) : null;
      if (imageOutput) {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          // Text parts from the same output, if any; otherwise a short note
          // that the image itself is in the very next message.
          content: imageOutput.text.length > 0
            ? imageOutput.text
            : 'Returned an image; see the next message.',
        } as SapV2Message);
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Image content from the previous tool call:' },
            ...imageOutput.imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        });
        continue;
      }
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      } as SapV2Message);
      continue;
    }

    throw new UnsupportedInputItemError(String(type));
  }

  return messages;
}

/**
 * Responses tools → orchestration tools.
 *
 * Responses declares a function tool flat (`{type:'function', name, parameters}`);
 * chat nests it under `function`. Hosted tools (`web_search`, `file_search`,
 * `namespace`) are NOT translated here — the hosted-tool plugins rewrite them
 * into ordinary function tools before this runs, so by the time a tool reaches
 * this function it is already a function tool.
 */
function translateTools(tools: any[]): any[] {
  return tools.map((t) => {
    if (t?.type === 'function' && t.function) return t;          // already chat-shaped
    if (t?.type === 'function') {
      const { type: _t, name, parameters, description, strict } = t;
      const fn: any = { name, parameters };
      if (description !== undefined) fn.description = description;
      if (strict !== undefined) fn.strict = strict;
      return { type: 'function', function: fn };
    }
    return t;
  });
}

export interface BuildOptions {
  /** The orchestration model name, e.g. `anthropic--claude-4.8-opus`. */
  modelName: string;
  stream: boolean;
}

export function buildOrchestrationPayload(body: any, opts: BuildOptions): SapV2CompletionRequest {
  const messages = responsesInputToMessages(body?.input, body?.instructions);

  const params: Record<string, any> = {};
  if (typeof body?.max_output_tokens === 'number') params.max_tokens = body.max_output_tokens;
  if (typeof body?.temperature === 'number') params.temperature = body.temperature;
  if (typeof body?.top_p === 'number') params.top_p = body.top_p;
  if (body?.tool_choice !== undefined) params.tool_choice = body.tool_choice;

  // reasoning.effort has no single equivalent across models — see
  // reasoningSupport.ts for the measured per-model map and why it is an
  // explicit table, not a version rule. max_tokens/temperature/top_p/tool_choice
  // must be read AFTER the block above sets them (nothing later in this
  // function changes them): the budget-shape branch clamps budget_tokens
  // against max_tokens, and thinking is suppressed outright when
  // temperature/top_p are incompatible with it, or tool_choice forces tool
  // use (see hasIncompatibleSampling / isForcedToolChoice in reasoningSupport.ts).
  Object.assign(params, resolveReasoningEffort({
    modelName: opts.modelName,
    effort: body?.reasoning?.effort,
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    toolChoice: params.tool_choice,
  }));

  return assembleOrchestrationPayload({
    messages,
    modelName: opts.modelName,
    params,
    stream: opts.stream,
    tools: Array.isArray(body?.tools) && body.tools.length > 0 ? translateTools(body.tools) : undefined,
  });
}

/** Models whose SAP LLM module refuses a system message after a tool result. */
const REFUSES_TRAILING_SYSTEM = /^mistralai--/i;

/**
 * SAP's placeholder grammar, as its templating module states it: `{{?name}}` or
 * `{{ ?name }}`, the name starting with a letter, ending with a letter or digit,
 * `_` and `-` the only other characters and never doubled. A template message
 * containing one is SUBSTITUTED, and a name with no value is a 400 ("Input
 * Parameters: ... Unused parameters: ['name']") — measured live 2026-09-08 via
 * /v2/completion; `{{bar}}`, `{{ x }}`, `{{#if}}` and `{{}}` pass untouched.
 * Mapping each name to the text it was written as puts the message back on the
 * wire verbatim (measured: `{{?foo}} end` round-tripped unchanged). A malformed
 * name (`{{? foo }}`, `{{?foo.bar}}`) is a hard templating error no value fixes.
 */
const PLACEHOLDER = /\{\{\s*\?([A-Za-z](?:[_-]?[A-Za-z0-9])*)\s*\}\}/g;

export function literalPlaceholderValues(message: SapV2Message): Record<string, string> {
  const texts: string[] = typeof message.content === 'string'
    ? [message.content]
    : (Array.isArray(message.content) ? message.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')) : []);
  const values: Record<string, string> = {};
  for (const text of texts) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      if (values[m[1]] === undefined) values[m[1]] = m[0];
    }
  }
  return values;
}

/** The payload envelope, shared with the Gemini bridge (src/google/orchestrationBridge) — extracted from buildOrchestrationPayload unchanged. */
export function assembleOrchestrationPayload(input: {
  messages: SapV2Message[];
  modelName: string;
  params: Record<string, any>;
  stream: boolean;
  /** Already chat-shaped (`{type:'function', function:{...}}`); omitted when empty. */
  tools?: any[];
  /** Goes on the PROMPT, not on model.params — where openaiController puts it. */
  responseFormat?: any;
}): SapV2CompletionRequest {
  // The system message goes in the template and NOWHERE ELSE. template and
  // messages_history are DISJOINT — the same shape openaiController's Anthropic
  // branch builds (openaiController.ts:1072-1073: the template message is the
  // one message `previousMessages` does not contain).
  //
  // This used to leave the very same object in messages_history as well, so the
  // wire carried the system block TWICE. That was not merely wasteful: because
  // `applyCacheBreakpoints` marked only the messages_history copy, the payload
  // went out with one marked and one unmarked copy of the same text, and SAP
  // then reported usage in an INCLUSIVE shape (`prompt_tokens` = cache field +
  // a small constant) that nothing else about this endpoint explains. Removing
  // the duplicate flips the reported accounting to the same EXCLUSIVE shape
  // `/openai/v1/chat/completions` has always had — measured, arm A2 of
  // test/fixtures/orchestration/bridge-cache-probe-result.md: `prompt_tokens`
  // flat at 14 across a write and a read turn while the cache field went
  // 0 -> 17692, against arm A0's (duplicated) 15903 = 15892 + 11.
  //
  // The copy removed from history is the exact object placed in the template,
  // by identity — not every system-role message. A second system message, if a
  // client ever sends one, is content, and dropping content silently is what
  // the rest of this module refuses to do.
  const systemMessage = input.messages.find((m) => m.role === 'system');
  const conversation = systemMessage ? input.messages.filter((m) => m !== systemMessage) : input.messages;
  const newest = conversation[conversation.length - 1];
  let template: SapV2Message[];
  let history: SapV2Message[];
  let placeholderValues: Record<string, string> = {};
  if (newest?.role === 'tool' && REFUSES_TRAILING_SYSTEM.test(input.modelName)) {
    // SAP appends the template AFTER messages_history, so the shape above ends every turn
    // with the system message. Mistral's LLM module refuses a system message that follows a
    // tool result (a bare "400 - LLM Module: An error occurred while processing your request",
    // measured live 2026-09-08 on mistralai--mistral-medium; the same messages with the
    // system first succeed, and user→system is accepted, so only tool turns swap). Here the
    // newest message is the template and the system message leads the history — the shape
    // openaiController's chat branch has always sent. The template is the one place SAP's
    // placeholder parser reads, hence literalPlaceholderValues; the swap stays confined to
    // this provider so no other model's newest message is ever exposed to that parser.
    template = [newest];
    history = systemMessage ? [systemMessage, ...conversation.slice(0, -1)] : conversation.slice(0, -1);
    placeholderValues = literalPlaceholderValues(newest);
  } else {
    template = systemMessage
      ? [systemMessage]
      : [{ role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] }];
    // With no system message at all, the default template entry above is the only
    // copy on the wire and history is untouched — still exactly one, still disjoint.
    history = conversation;
  }

  const payload: SapV2CompletionRequest = {
    config: {
      modules: {
        prompt_templating: {
          prompt: { template },
          model: { name: input.modelName, version: 'latest', params: input.params },
        },
      },
    },
    placeholder_values: placeholderValues,
    messages_history: history,
  };

  if (Array.isArray(input.tools) && input.tools.length > 0) {
    payload.config.modules.prompt_templating.prompt.tools = input.tools;
  }
  if (input.responseFormat !== undefined) {
    payload.config.modules.prompt_templating.prompt.response_format = input.responseFormat;
  }
  if (input.stream) {
    payload.config.stream = { enabled: true };
  }

  return payload;
}
