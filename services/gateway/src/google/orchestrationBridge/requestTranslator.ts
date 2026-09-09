/**
 * Gemini `generateContent` request → SAP orchestration `/v2/completion` payload.
 *
 * The Gemini half of what src/responses/orchestrationBridge/requestTranslator.ts
 * does for the Responses API, and it shares that file's envelope
 * (`assembleOrchestrationPayload`) rather than rebuilding it: only the parts
 * that are genuinely Gemini-specific live here.
 *
 * The one thing this translation has that the Responses one does not: Gemini
 * carries NO tool-call ids. A `functionCall` part and the `functionResponse`
 * that answers it are linked by POSITION alone, so this file mints an id per
 * call (`mintToolCallId`) and matches the next turn's responses to those ids
 * IN ORDER. Both sides of a round trip therefore have to be translated by the
 * same pass — which is why turns are walked with their indices instead of
 * mapped one by one.
 *
 * Pure: no I/O, no Express, no config. Everything the caller must decide —
 * model name, streaming — arrives in `opts`.
 */
import { assembleOrchestrationPayload } from '../../responses/orchestrationBridge/requestTranslator';
import { SapV2CompletionRequest, SapV2Message } from '../../services/sapOrchestrationTypes';
import { resolveReasoningEffort } from '../../utils/reasoningSupport';
import { dropUnsupportedSampling } from '../../utils/samplingSupport';
import { UnsupportedGeminiInputError, geminiPartToBlock, joinPartTexts } from './geminiParts';

export { UnsupportedGeminiInputError };

/**
 * `c<turn:5><part:3>` — nine alphanumerics, e.g. `c00001000` for turn 1, part 0.
 * Mistral's LLM module refuses any other shape: `call_1_1` earned a bare
 * "400 - LLM Module: An error occurred while processing your request" on the
 * turn after a tool call (measured live 2026-09-08 on mistralai--mistral-medium
 * via /v2/completion; the same round trip with a nine-character id succeeded),
 * while Claude, GPT and Gemini accept either shape.
 */
export function mintToolCallId(turn: number, part: number): string {
  return `c${String(turn % 100000).padStart(5, '0')}${String(part % 1000).padStart(3, '0')}`;
}

export interface GeminiBuildOptions {
  /** The orchestration model name, e.g. `gemini-2.5-pro` or `anthropic--claude-4.8-opus`. */
  modelName: string;
  stream: boolean;
}

/**
 * `systemInstruction` + `contents[]` → chat messages.
 *
 * Content is emitted as BLOCKS, like the Responses bridge, so a cache
 * breakpoint has somewhere to hang — with the one exception orchestration
 * forces: a `tool` message's content must be a plain string (SAP's Anthropic
 * harmonization step 400s on a list), and an assistant message carrying only
 * `tool_calls` must send `content: ''`, never `[]`.
 */
export function geminiContentsToMessages(body: any): SapV2Message[] {
  const messages: SapV2Message[] = [];

  const system = joinPartTexts(body?.systemInstruction?.parts ?? body?.systemInstruction);
  if (system.length > 0) {
    messages.push({ role: 'system', content: [{ type: 'text', text: system }] });
  }

  // `contents` is the request. Missing, not an array (the single-Content form
  // some SDKs accept), or empty would otherwise produce a payload carrying
  // nothing but the system message — a turn the model answers out of thin air
  // — so it is refused here rather than sent.
  if (!Array.isArray(body?.contents) || body.contents.length === 0) {
    throw new UnsupportedGeminiInputError('contents', 'contents must be a non-empty array of turns');
  }
  const contents: any[] = body.contents;

  // The ids minted for the preceding model turn's calls, and how many of them
  // have been answered. Both survive consecutive user turns that carry ONLY
  // `functionResponse` parts — a client is free to answer a two-call turn with
  // two user Contents of one response each, and the cursor is what keeps the
  // second one matched to the second call rather than starting over. Anything
  // else the user says ends the round trip and clears them: a `functionResponse`
  // may only answer the calls immediately preceding it.
  let pendingCallIds: string[] = [];
  let answeredCalls = 0;

  for (let turn = 0; turn < contents.length; turn++) {
    const content = contents[turn];
    // Gemini has exactly two roles, and omits the role on a single-turn
    // request — anything that is not `model` is the user speaking.
    const isModel = content?.role === 'model';
    const parts: any[] = Array.isArray(content?.parts) ? content.parts : [];

    const blocks: any[] = [];
    const toolCalls: any[] = [];
    const toolMessages: SapV2Message[] = [];

    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const path = `contents[${turn}].parts[${p}]`;

      if (part?.functionCall) {
        if (!isModel) {
          throw new UnsupportedGeminiInputError(`${path}.functionCall`, 'a functionCall belongs to a model turn');
        }
        toolCalls.push({
          id: mintToolCallId(turn, p),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
        continue;
      }

      if (part?.functionResponse) {
        if (isModel) {
          throw new UnsupportedGeminiInputError(`${path}.functionResponse`, 'a functionResponse belongs to a user turn');
        }
        const id = pendingCallIds[answeredCalls++];
        if (id === undefined) {
          throw new UnsupportedGeminiInputError(
            `${path}.functionResponse`,
            'no functionCall in the preceding turn to match this response to',
          );
        }
        toolMessages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
        continue;
      }

      blocks.push(geminiPartToBlock(part, path));
    }

    if (isModel) {
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: blocks.length > 0 ? blocks : '',
          tool_calls: toolCalls,
        } as SapV2Message);
      } else if (blocks.length > 0) {
        messages.push({ role: 'assistant', content: blocks });
      }
      pendingCallIds = toolCalls.map((c) => c.id);
      answeredCalls = 0;
      continue;
    }

    // Tool results first, then whatever the user said in the same turn: a
    // `tool` message must follow the assistant call it answers with nothing
    // in between, which is the ordering chat clients also produce.
    messages.push(...toolMessages);
    if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
    // A turn that is nothing but tool results leaves the round trip open for
    // the next one; anything the user actually says closes it.
    if (!parts.every((part) => part?.functionResponse)) {
      pendingCallIds = [];
      answeredCalls = 0;
    }
  }

  return messages;
}

/**
 * `toolConfig.functionCallingConfig` → chat `tool_choice`.
 *
 * ANY means "call some function", which is chat's `'required'`; ANY narrowed
 * to a SINGLE allowed name is exactly chat's forced-function object. A longer
 * `allowedFunctionNames` has no chat equivalent — chat can force one function
 * or any function, not a subset — so it degrades to `'required'` rather than
 * dropping the constraint entirely. An unknown or unspecified mode yields
 * nothing, leaving orchestration its own default.
 */
function geminiToolChoice(body: any): any | undefined {
  const cfg = body?.toolConfig?.functionCallingConfig;
  if (!cfg) return undefined;
  const mode = typeof cfg.mode === 'string' ? cfg.mode.toUpperCase() : '';
  if (mode === 'AUTO') return 'auto';
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const names: any[] = Array.isArray(cfg.allowedFunctionNames) ? cfg.allowedFunctionNames : [];
    return names.length === 1 ? { type: 'function', function: { name: names[0] } } : 'required';
  }
  return undefined;
}

/**
 * `tools[]` → chat tools, and `toolConfig` → `tool_choice`.
 *
 * Gemini groups declarations inside tool entries and puts hosted tools
 * (`googleSearch`, `codeExecution`, `urlContext`, …) in the same array. Those
 * run inside Google's own serving stack; orchestration has nothing to run them
 * with, and answering as if a search had happened is worse than refusing — so
 * ANY key other than `functionDeclarations` throws, named.
 */
export function geminiToolsToOrchestration(body: any): { tools?: any[]; tool_choice?: any } {
  const out: { tools?: any[]; tool_choice?: any } = {};
  const entries: any[] = Array.isArray(body?.tools) ? body.tools : [];
  const tools: any[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? {};
    for (const [key, value] of Object.entries(entry)) {
      // A key present but null/undefined declares nothing — SDKs that build the
      // entry from a fixed shape leave the hosted-tool slots empty like that,
      // and refusing them would refuse an ordinary function-calling request.
      if (key === 'functionDeclarations' || value === null || value === undefined) continue;
      throw new UnsupportedGeminiInputError(`tools[${i}].${key}`, 'hosted tools are not available on this gateway');
    }
    const decls: any[] = Array.isArray(entry.functionDeclarations) ? entry.functionDeclarations : [];
    for (const decl of decls) {
      const fn: any = { name: decl?.name };
      if (decl?.description !== undefined) fn.description = decl.description;
      // `parametersJsonSchema` is the newer name for the same JSON Schema
      // (Gemini added it for schemas its own trimmed dialect cannot express);
      // orchestration takes the schema either way.
      const parameters = decl?.parameters ?? decl?.parametersJsonSchema;
      if (parameters !== undefined) fn.parameters = parameters;
      tools.push({ type: 'function', function: fn });
    }
  }

  if (tools.length > 0) out.tools = tools;
  const toolChoice = geminiToolChoice(body);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

/**
 * `thinkingConfig.thinkingBudget` → a `reasoning.effort` value.
 *
 * A token budget and an effort enum are not the same currency, so this is a
 * banding, not a conversion: the numbers come from the spec's table (0 off,
 * ≤1024 low, ≤8192 medium, above that high) and −1, Gemini's "let the model
 * decide", lands in the middle. `resolveReasoningEffort` then decides whether
 * the model in question can carry ANY thinking at all, and in which of SAP's
 * two shapes — that table is measured per model and this one is not a second
 * copy of it.
 */
function thinkingBudgetToEffort(budget: unknown): string | undefined {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return undefined;
  if (budget < 0) return 'medium';        // −1: dynamic thinking
  if (budget === 0) return 'minimal';     // thinking off; `minimal` is the nearest thing SAP takes
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

/**
 * `generationConfig` → `model.params` (+ `response_format`, which lives on the
 * PROMPT, not on params — see openaiController's V2 branch).
 *
 * `tool_choice` is resolved here rather than in `geminiToolsToOrchestration`
 * even though it comes from `toolConfig`, because it belongs in `params` and
 * because `resolveReasoningEffort` reads it: forcing tool use suppresses
 * thinking, as do an incompatible temperature/top_p and too small a
 * `max_tokens`. Everything it reads must therefore already be in `params`
 * when it runs — which is why the reasoning call is last.
 *
 * `topK`, `seed`, `presencePenalty`, `frequencyPenalty` and `safetySettings`
 * have no orchestration equivalent and are dropped (documented in the user
 * chapter's limits list), not approximated.
 */
export function geminiGenerationConfigToParams(
  body: any,
  modelName: string,
): { params: Record<string, any>; response_format?: any } {
  const cfg = body?.generationConfig ?? {};
  const params: Record<string, any> = {};

  if (typeof cfg.temperature === 'number') params.temperature = cfg.temperature;
  if (typeof cfg.topP === 'number') params.top_p = cfg.topP;
  // Gemini CLI sends temperature AND topP on every request; SAP refuses the pair for Claude and
  // top_p (and any temperature but 1) for the gpt-5 family — see samplingSupport.ts for the
  // measured errors. Dropped here, before resolveReasoningEffort reads the survivors.
  dropUnsupportedSampling(modelName, params);
  if (typeof cfg.maxOutputTokens === 'number') params.max_tokens = cfg.maxOutputTokens;
  if (Array.isArray(cfg.stopSequences) && cfg.stopSequences.length > 0) params.stop = cfg.stopSequences;

  if (typeof cfg.candidateCount === 'number' && cfg.candidateCount > 1) {
    // Orchestration returns a single choice. Answering with one candidate when
    // two were asked for is a wrong answer, not a degraded one.
    throw new UnsupportedGeminiInputError(
      'generationConfig.candidateCount',
      'orchestration returns a single candidate; candidateCount must be 1',
    );
  }

  const toolChoice = geminiToolChoice(body);
  if (toolChoice !== undefined) params.tool_choice = toolChoice;

  Object.assign(params, resolveReasoningEffort({
    modelName,
    effort: thinkingBudgetToEffort(cfg.thinkingConfig?.thinkingBudget),
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    toolChoice: params.tool_choice,
  }));

  // A schema wins over the bare mime type: both say "JSON", and the schema
  // says more.
  const schema = cfg.responseJsonSchema ?? cfg.responseSchema;
  if (schema !== undefined) {
    return { params, response_format: { type: 'json_schema', json_schema: { name: 'response', schema } } };
  }
  if (cfg.responseMimeType === 'application/json') {
    return { params, response_format: { type: 'json_object' } };
  }
  return { params };
}

/**
 * Refuse a Gemini request this gateway does not serve, WITHOUT building a payload.
 *
 * The documented limits — `candidateCount > 1`, hosted tools, `fileData`, non-image
 * `inlineData`, a missing or empty `contents` — were enforced only where the body was
 * translated, i.e. on the orchestration bridge. A native Gemini deployment received them
 * unchanged and answered however SAP happened to answer, so the same request was refused
 * or served depending on which model the router picked. The controller calls this before
 * a native chat post; the bridge does NOT call it, because translating already applies
 * every one of these checks and running them twice would double the work to reach the
 * same throw.
 *
 * "Exactly the existing checks" is literal: this runs the three real translation steps
 * and discards their output rather than re-deriving a second copy of the rules that could
 * drift from them. The model name is irrelevant here — no refusal consults it; it reaches
 * only `resolveReasoningEffort`, whose result is part of the discarded payload.
 */
export function validateGeminiRequest(body: any): void {
  geminiContentsToMessages(body);
  geminiToolsToOrchestration(body);
  geminiGenerationConfigToParams(body, '');
}

/** A Gemini request body → the orchestration payload the bridge POSTs. */
export function geminiToOrchestrationPayload(
  body: any,
  opts: GeminiBuildOptions,
): SapV2CompletionRequest {
  const messages = geminiContentsToMessages(body);
  const { params, response_format } = geminiGenerationConfigToParams(body, opts.modelName);
  const { tools } = geminiToolsToOrchestration(body);

  const payload = assembleOrchestrationPayload({
    messages,
    modelName: opts.modelName,
    params,
    stream: opts.stream,
    tools,
    responseFormat: response_format,
  });
  // Orchestration streams in character chunks and sapAIService defaults chunk_size to 800 when the
  // payload sets none — a whole short answer then arrives as one frame, which is exactly what a
  // Gemini CLI user experiences as "no streaming". The chat-completions path asks for 200
  // (openaiController's V2 stream block); the Gemini bridge asks for the same.
  if (opts.stream && payload.config.stream) payload.config.stream.chunk_size = 200;
  return payload;
}
