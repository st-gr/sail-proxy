/**
 * Streaming emulation on the Responses bridge.
 *
 * A model listed in `providers.openai.emulate_streaming_for_models` is called WITHOUT
 * streaming, and its whole answer is handed to the stream translator as if orchestration
 * had streamed it in one chunk. The client still gets a Responses stream; it just arrives
 * when the model has finished.
 *
 * Why a model is listed: orchestration's stream is not always faithful. For a Gemini model
 * that writes text and then calls two or more tools in one step, the stream carries ONE call
 * with the arguments of all of them in a row and without the thought signature, while the
 * same turn without streaming returns the calls apart (measured live 2026-11-12, five Gemini
 * models). Nothing can repair that from the stream, so the stream is not asked for.
 *
 * Pure: no I/O, no config access. responsesController decides WHEN.
 */
import { Readable } from 'stream';

/**
 * The answer of a non-streaming orchestration call as the one chunk the stream translator
 * reads. Each tool call gets its own `index`, which is what keeps the calls apart.
 */
export function envelopeToStreamChunk(envelope: any): any {
  const body = envelope?.final_result ?? envelope ?? {};
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = choice?.message || {};

  const delta: Record<string, any> = {};
  if (Array.isArray(message.reasoning_content)) delta.reasoning_content = message.reasoning_content;
  if (typeof message.content === 'string' && message.content.length > 0) delta.content = message.content;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    delta.tool_calls = message.tool_calls.map((call: any, index: number) => ({ ...call, index }));
  }

  const finalResult: Record<string, any> = {
    choices: [{ index: 0, delta, finish_reason: choice?.finish_reason ?? null }],
  };
  if (body.usage) finalResult.usage = body.usage;

  const chunk: Record<string, any> = { final_result: finalResult };
  if (envelope?.request_id) chunk.request_id = envelope.request_id;
  return chunk;
}

/**
 * The same answer in orchestration's wire format (`data: {json}` blocks closed by
 * `data: [DONE]`), for a reader that holds raw bytes: the hosted-tool engine reads its
 * continuation calls that way.
 */
export function envelopeAsSseStream(envelope: any): Readable {
  return Readable.from([
    `data: ${JSON.stringify(envelopeToStreamChunk(envelope))}\n\n`,
    'data: [DONE]\n\n',
  ]);
}
