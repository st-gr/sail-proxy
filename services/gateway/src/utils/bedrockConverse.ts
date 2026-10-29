/**
 * Converse ↔ Anthropic Messages for /aws-bedrock requests on models without a deployment.
 *
 * Such models are served through SAP orchestration, which the /anthropic route already speaks; the
 * Bedrock controller hands them to that flow. A Converse request is translated to an Anthropic
 * Messages request here, and a non-streamed Anthropic answer back to a Converse answer (streams are
 * converted frame by frame in bedrockEventStream.ts). Errors take Bedrock's shape, `{ message }` with
 * an `x-amzn-ErrorType` header, which is what the AWS SDKs read.
 */

/** A Converse request body → an Anthropic Messages request for `model`. */
export function converseToAnthropicRequest(body: any, model: string, stream: boolean): any {
  const out: any = { model, stream, max_tokens: body?.inferenceConfig?.maxTokens ?? 4096 };
  const inference = body?.inferenceConfig || {};
  if (inference.temperature !== undefined) out.temperature = inference.temperature;
  if (inference.topP !== undefined) out.top_p = inference.topP;
  if (Array.isArray(inference.stopSequences) && inference.stopSequences.length > 0) out.stop_sequences = inference.stopSequences;

  const system = (Array.isArray(body?.system) ? body.system : [])
    .filter((block: any) => typeof block?.text === 'string').map((block: any) => block.text).join('\n');
  if (system) out.system = system;

  out.messages = (Array.isArray(body?.messages) ? body.messages : []).map((message: any) => ({
    role: message?.role,
    content: (Array.isArray(message?.content) ? message.content : []).flatMap(converseBlockToAnthropic),
  }));

  const tools = body?.toolConfig?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    out.tools = tools.filter((tool: any) => tool?.toolSpec).map((tool: any) => ({
      name: tool.toolSpec.name,
      ...(tool.toolSpec.description !== undefined ? { description: tool.toolSpec.description } : {}),
      input_schema: tool.toolSpec.inputSchema?.json ?? { type: 'object', properties: {} },
    }));
  }
  const choice = body?.toolConfig?.toolChoice;
  if (choice?.auto) out.tool_choice = { type: 'auto' };
  else if (choice?.any) out.tool_choice = { type: 'any' };
  else if (choice?.tool?.name) out.tool_choice = { type: 'tool', name: choice.tool.name };
  return out;
}

/** One Converse content block → Anthropic blocks (cache points, documents and reasoning are dropped). */
function converseBlockToAnthropic(block: any): any[] {
  if (typeof block?.text === 'string') return [{ type: 'text', text: block.text }];
  if (block?.image?.source?.bytes) {
    return [{ type: 'image', source: { type: 'base64', media_type: `image/${block.image.format || 'png'}`, data: block.image.source.bytes } }];
  }
  if (block?.toolUse) {
    return [{ type: 'tool_use', id: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input ?? {} }];
  }
  if (block?.toolResult) {
    const content = (Array.isArray(block.toolResult.content) ? block.toolResult.content : []).flatMap((part: any) => {
      if (typeof part?.text === 'string') return [{ type: 'text', text: part.text }];
      if (part?.json !== undefined) return [{ type: 'text', text: JSON.stringify(part.json) }];
      if (part?.image?.source?.bytes) {
        return [{ type: 'image', source: { type: 'base64', media_type: `image/${part.image.format || 'png'}`, data: part.image.source.bytes } }];
      }
      return [];
    });
    return [{ type: 'tool_result', tool_use_id: block.toolResult.toolUseId, content, is_error: block.toolResult.status === 'error' }];
  }
  return [];
}

/** A non-streamed Anthropic answer → a Converse answer. */
export function anthropicToConverseResponse(message: any, latencyMs: number): any {
  const content = (Array.isArray(message?.content) ? message.content : []).flatMap((block: any) => {
    if (block?.type === 'text') return [{ text: block.text }];
    if (block?.type === 'tool_use') return [{ toolUse: { toolUseId: block.id, name: block.name, input: block.input ?? {} } }];
    if (block?.type === 'thinking') {
      return [{ reasoningContent: { reasoningText: { text: block.thinking, ...(block.signature ? { signature: block.signature } : {}) } } }];
    }
    return [];
  });
  const u = message?.usage || {};
  // Every token once, as the admin's usage row counts it: input + output + cache read + cache write.
  const usage: Record<string, number> = {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
  };
  if (u.cache_read_input_tokens) usage.cacheReadInputTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens) usage.cacheWriteInputTokens = u.cache_creation_input_tokens;
  return {
    output: { message: { role: 'assistant', content } },
    stopReason: message?.stop_reason || 'end_turn',
    usage,
    metrics: { latencyMs },
  };
}

/**
 * A non-streamed Anthropic answer as the stream events it would have been, for a stream request
 * the /anthropic flow answered without streaming (a model with neither native nor emulated
 * streaming). The event-stream encoder frames them like any other stream.
 */
export function anthropicMessageToStreamEvents(message: any): [string, any][] {
  const u = message?.usage || {};
  const events: [string, any][] = [['message_start', { type: 'message_start', message: {
    id: message?.id, type: 'message', role: 'assistant', model: message?.model, content: [], stop_reason: null,
    usage: { ...u, output_tokens: 0 },
  } }]];
  (Array.isArray(message?.content) ? message.content : []).forEach((block: any, index: number) => {
    if (block?.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else if (block?.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }]);
    } else {
      return;
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message?.stop_reason || 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output_tokens || 0 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

/** Bedrock's error type and body for an HTTP status and an Anthropic or gateway error body. */
export function bedrockErrorOf(status: number, body: any): { type: string; body: { message: string } } {
  const type = status === 400 || status === 413 || status === 422 ? 'ValidationException'
    : status === 401 || status === 403 ? 'AccessDeniedException'
    : status === 404 ? 'ResourceNotFoundException'
    : status === 408 || status === 504 ? 'ModelTimeoutException'
    : status === 429 ? 'ThrottlingException'
    : status === 503 || status === 529 ? 'ServiceUnavailableException'
    : 'InternalServerException';
  const message = body?.error?.message || body?.message || 'Internal server error';
  return { type, body: { message } };
}
