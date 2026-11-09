/**
 * Chat Completions ⇄ Responses for one non-streaming call: some deployed models refuse function
 * tools on /chat/completions but take them on /responses (gpt-6.1-sol in the 0.11.0 rollout). The
 * deployed chat path retries such a request through the deployment's /responses endpoint and hands
 * the answer back as a chat.completion, so plugins, usage and the emulated stream run unchanged.
 *
 * The mapping mirrors the opposite direction in ../orchestrationBridge (requestTranslator,
 * responseTranslator). What this bridge cannot express is refused (ChatBridgeUnsupported); the
 * caller then reports the deployment's original error.
 */

/** A chat request this bridge cannot express as a Responses request. */
export class ChatBridgeUnsupported extends Error {
  constructor(what: string) {
    super(`chat to Responses bridge: ${what} is not supported`);
    this.name = 'ChatBridgeUnsupported';
  }
}

/** Text of a chat message's content (a string or text parts). */
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text'))
      .map((part: any) => part.text ?? '')
      .join('');
  }
  return '';
}

/** Input parts of a user/system/developer message. */
function inputParts(content: any): any[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: any): any[] => {
    if (!part) return [];
    if (part.type === 'text') return [{ type: 'input_text', text: part.text ?? '' }];
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const detail = typeof part.image_url === 'object' ? part.image_url?.detail : undefined;
      return [{ type: 'input_image', image_url: url, ...(detail ? { detail } : {}) }];
    }
    throw new ChatBridgeUnsupported(`content part "${part.type}"`);
  });
}

function messagesToInput(messages: any[]): any[] {
  const input: any[] = [];
  for (const message of messages || []) {
    const role = message?.role;
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textOf(message.content) });
    } else if (role === 'assistant') {
      const text = textOf(message.content);
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of message.tool_calls || []) {
        if (call?.type && call.type !== 'function') throw new ChatBridgeUnsupported(`assistant tool call of type "${call.type}"`);
        input.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? '' });
      }
    } else if (role === 'user' || role === 'system' || role === 'developer') {
      input.push({ type: 'message', role, content: inputParts(message.content) });
    } else {
      throw new ChatBridgeUnsupported(`message role "${role}"`);
    }
  }
  return input;
}

/** The Responses request for a chat request (already masked and renamed by the caller). */
export function chatToResponsesRequest(body: any): any {
  if (typeof body.n === 'number' && body.n > 1) throw new ChatBridgeUnsupported('n > 1');
  const out: any = { model: body.model, input: messagesToInput(body.messages) };
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool: any) => {
      if (tool?.type !== 'function' || !tool.function) throw new ChatBridgeUnsupported(`tool of type "${tool?.type}"`);
      const { name, description, parameters, strict } = tool.function;
      return {
        type: 'function', name,
        ...(description !== undefined ? { description } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
        // Chat Completions treats a function as non-strict unless told otherwise; Responses
        // treats it as strict. Keep chat's meaning: optional parameters stay optional.
        strict: strict ?? false,
      };
    });
  }
  if (body.tool_choice !== undefined) {
    out.tool_choice = typeof body.tool_choice === 'object' && body.tool_choice?.type === 'function'
      ? { type: 'function', name: body.tool_choice.function?.name }
      : body.tool_choice;
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) out.max_output_tokens = maxTokens;
  if (body.reasoning_effort !== undefined) out.reasoning = { effort: body.reasoning_effort };
  const format = body.response_format;
  if (format?.type === 'json_schema' && format.json_schema) {
    const { name, schema, strict, description } = format.json_schema;
    out.text = { format: { type: 'json_schema', name, schema, ...(strict !== undefined ? { strict } : {}), ...(description ? { description } : {}) } };
  } else if (format?.type === 'json_object') {
    out.text = { format: { type: 'json_object' } };
  }
  for (const key of ['parallel_tool_calls', 'temperature', 'top_p', 'user', 'metadata']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  out.store = false;
  return out;
}

/** The chat.completion for a Responses answer. */
export function responsesToChatCompletion(resp: any, model: string): any {
  const output: any[] = Array.isArray(resp?.output) ? resp.output : [];
  const text = output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part: any) => part?.type === 'output_text')
    .map((part: any) => part.text ?? '')
    .join('');
  const toolCalls = output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } }));
  let finishReason = 'stop';
  if (toolCalls.length > 0) finishReason = 'tool_calls';
  else if (resp?.status === 'incomplete') {
    const reason = resp.incomplete_details?.reason;
    finishReason = reason === 'content_filter' ? 'content_filter' : 'length';
  }
  const message: any = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const completion: any = {
    id: resp?.id, object: 'chat.completion', created: resp?.created_at, model,
    choices: [{ index: 0, finish_reason: finishReason, message }],
  };
  const usage = resp?.usage;
  if (usage) {
    completion.usage = {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      ...(usage.input_tokens_details?.cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens } } : {}),
      ...(usage.output_tokens_details?.reasoning_tokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens } } : {}),
    };
  }
  return completion;
}

/** The error message of an upstream (axios) error, or ''. */
function upstreamMessage(err: any): string {
  const data = err?.response?.data;
  const candidate = data?.error?.message ?? data?.message ?? (typeof data === 'string' ? data : undefined);
  return typeof candidate === 'string' ? candidate : '';
}

/**
 * Whether a deployment refused function tools on /chat/completions in a way /responses accepts:
 * a 400 that names tools together with the Responses API or the reasoning effort (OpenAI words it
 * "Function tools with reasoning_effort are not supported for <model> in /v1/chat/completions.
 * Please use /v1/responses instead.").
 */
export function isChatToolsRefusal(err: any): boolean {
  if (err?.response?.status !== 400) return false;
  const message = upstreamMessage(err);
  return /\btools?\b/i.test(message) && /\/v1\/responses|responses api|reasoning[_ ]effort/i.test(message);
}
