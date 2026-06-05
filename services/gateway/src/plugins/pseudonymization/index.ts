/**
 * PII Pseudonymization Plugin
 *
 * Intercepts LLM API calls, detects PII in message content, replaces it with
 * pseudonymized placeholders, forwards the masked text to the LLM, and unmasks
 * placeholders in the response before returning to the caller.
 *
 * Supports:
 * - Pseudonymization (unmasks response) and anonymization (no unmasking)
 * - Constant placeholder and fabricated data replacement strategies
 * - Streaming and non-streaming responses
 * - Self-improving entity cache (Valkey/in-memory)
 * - Allow-list to skip certain matches
 * - Custom regex entities for domain-specific PII
 *
 * Strategies: before + after + stream
 *
 * @see pseudonymization-proxy-prompt.md - Full specification
 */

import { Request, Response } from 'express';
import { MaskingConfig, MaskingInfo, PseudonymizationState, EntityMatch } from './types';
import { ReplacementMap } from './replacementMap';
import { detectEntities } from './detectors';
import { replaceEntities, maskJsonValue } from './replacer';
import { unmaskText, unmaskJsonValue } from './unmasker';
import { StreamUnmaskBuffer } from './streamBuffer';
import { entityCache } from './entityCache';

interface PluginContext {
  req: Request;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: any;
  chunk?: Buffer;
}

interface PluginUtils {
  logger: Logger;
  sseWriter?: (res: Response, events: any) => Promise<void>;
}

interface Logger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

/**
 * Extract text content from a message (handles both string and content-block formats)
 */
function extractTextFromMessage(message: any): Array<{ text: string; path: string }> {
  const results: Array<{ text: string; path: string }> = [];

  if (!message || !message.content) return results;

  if (typeof message.content === 'string') {
    results.push({ text: message.content, path: 'content' });
  } else if (Array.isArray(message.content)) {
    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      if (block.type === 'text' && typeof block.text === 'string') {
        results.push({ text: block.text, path: `content.${i}.text` });
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const inner = block.content[j];
          if (inner.type === 'text' && typeof inner.text === 'string') {
            results.push({ text: inner.text, path: `content.${i}.content.${j}.text` });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Set text content back into a message at the given path
 */
function setTextInMessage(message: any, path: string, newText: string): void {
  const parts = path.split('.');
  let obj = message;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = newText;
}

/**
 * Extract text from response (SAP orchestration V2 format)
 */
function extractResponseText(response: any): string | null {
  // Non-streaming: SAP orchestration V2 (final_result)
  if (response?.final_result?.choices?.[0]?.message?.content) {
    return response.final_result.choices[0].message.content;
  }
  // Streaming chunk: delta content
  if (response?.final_result?.choices?.[0]?.delta?.content) {
    return response.final_result.choices[0].delta.content;
  }
  // Anthropic format
  if (response?.content && Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block.type === 'text') return block.text;
    }
  }
  // OpenAI format
  if (response?.choices?.[0]?.message?.content) {
    return response.choices[0].message.content;
  }
  if (response?.choices?.[0]?.delta?.content) {
    return response.choices[0].delta.content;
  }
  return null;
}

/**
 * Set text back into the response at the appropriate path
 */
function setResponseText(response: any, newText: string): void {
  if (response?.final_result?.choices?.[0]?.message?.content !== undefined) {
    response.final_result.choices[0].message.content = newText;
  } else if (response?.final_result?.choices?.[0]?.delta?.content !== undefined) {
    response.final_result.choices[0].delta.content = newText;
  } else if (response?.content && Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block.type === 'text') {
        block.text = newText;
        return;
      }
    }
  } else if (response?.choices?.[0]?.message?.content !== undefined) {
    response.choices[0].message.content = newText;
  } else if (response?.choices?.[0]?.delta?.content !== undefined) {
    response.choices[0].delta.content = newText;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BEFORE HANDLER: Mask request content
// ─────────────────────────────────────────────────────────────────────────────

// Triggerword that activates pseudonymization when found in message content
const TRIGGERWORD = '<sail-proxy:pseudonymization:on>';
const TRIGGERWORD_ANON = '<sail-proxy:anonymization:on>';

// Default masking config when activated via triggerword
const DEFAULT_MASKING_CONFIG: MaskingConfig = {
  method: 'pseudonymization',
  entities: [
    { type: 'profile-person' },
    { type: 'profile-email' },
    { type: 'profile-phone' },
    { type: 'profile-ssn' },
    { type: 'profile-credit-card-number' },
    { type: 'profile-iban' },
    { type: 'profile-url' },
    { type: 'profile-address' },
    { type: 'profile-username-password' },
    { type: 'profile-nationality' },
    { type: 'profile-ethnicity' },
    { type: 'profile-gender' },
    { type: 'profile-religious-group' },
    { type: 'profile-political-group' },
    { type: 'profile-sexual-orientation' },
    { type: 'profile-trade-union' },
    { type: 'profile-org' },
    { type: 'profile-location' },
  ],
};

/**
 * Scan messages for triggerword, strip it, and return masking config if found
 */
function scanAndStripTriggerword(req: any): MaskingConfig | null {
  const messages = req.body?.messages;
  if (!Array.isArray(messages)) return null;

  let found: 'pseudonymization' | 'anonymization' | null = null;

  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.content.includes(TRIGGERWORD)) {
        message.content = message.content.replace(TRIGGERWORD, '').trim();
        found = 'pseudonymization';
      } else if (message.content.includes(TRIGGERWORD_ANON)) {
        message.content = message.content.replace(TRIGGERWORD_ANON, '').trim();
        found = 'anonymization';
      }
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.includes(TRIGGERWORD)) {
            block.text = block.text.replace(TRIGGERWORD, '').trim();
            found = 'pseudonymization';
          } else if (block.text.includes(TRIGGERWORD_ANON)) {
            block.text = block.text.replace(TRIGGERWORD_ANON, '').trim();
            found = 'anonymization';
          }
        }
      }
    }
  }

  // Also check system messages (Anthropic format)
  if (!found && Array.isArray(req.body?.system)) {
    for (const block of req.body.system) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.includes(TRIGGERWORD)) {
          block.text = block.text.replace(TRIGGERWORD, '').trim();
          found = 'pseudonymization';
        } else if (block.text.includes(TRIGGERWORD_ANON)) {
          block.text = block.text.replace(TRIGGERWORD_ANON, '').trim();
          found = 'anonymization';
        }
      }
    }
  }

  if (!found) return null;

  return { ...DEFAULT_MASKING_CONFIG, method: found };
}

interface ForcedConfigResolution {
  config: MaskingConfig;
  allowBypass: boolean;
  source: 'model' | 'endpoint';
}

/**
 * Check if the model has pseudonymization forced on via api_config.json.
 * Returns the resolved masking config plus the allow_user_bypass flag from
 * the matching block (per-model takes precedence over per-endpoint).
 */
function getModelForcedConfig(req: any): ForcedConfigResolution | null {
  try {
    const configService = require('../../services/configService').default || require('../../services/configService');
    const config = configService.getConfig();

    // Per-model force flag
    const modelName = req.body?.model;
    if (modelName) {
      const substituted = configService.getSubstitutedModel('anthropic', modelName) || modelName;
      const modelListChanges = config?.api_config?.model_list_changes;
      const modelConfig = modelListChanges?.[substituted];
      if (modelConfig?.pseudonymization?.enabled) {
        const method = modelConfig.pseudonymization.method || 'pseudonymization';
        const allowBypass = modelConfig.pseudonymization.allow_user_bypass === true;
        return { config: { ...DEFAULT_MASKING_CONFIG, method }, allowBypass, source: 'model' };
      }
    }

    // Per-endpoint force flag (defaultHooks[endpoint].pseudonymization.enabled)
    const endpoint = req.__endpoint;
    if (endpoint) {
      const endpointConfig = config?.api_config?.defaultHooks?.[endpoint];
      if (endpointConfig?.pseudonymization?.enabled) {
        const method = endpointConfig.pseudonymization.method || 'pseudonymization';
        const allowBypass = endpointConfig.pseudonymization.allow_user_bypass === true;
        return { config: { ...DEFAULT_MASKING_CONFIG, method }, allowBypass, source: 'endpoint' };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the caller has requested a pseudonymization bypass via either:
 *   - HTTP header `x-sail-proxy-pseudonymization: off` (case-insensitive value), or
 *   - Body field `pseudonymization_off: true` (stripped from body before forwarding).
 *
 * Both signals are out-of-band from prompt content so prompt injection via tool
 * results, web search results, or pasted text cannot trigger bypass.
 */
function isBypassRequested(req: any): { source: 'header' | 'body' } | null {
  const hdr = req.headers?.['x-sail-proxy-pseudonymization'];
  if (typeof hdr === 'string' && hdr.toLowerCase() === 'off') {
    return { source: 'header' };
  }
  if (req.body?.pseudonymization_off === true) {
    delete req.body.pseudonymization_off;
    return { source: 'body' };
  }
  return null;
}

async function beforeHandler({ req, res, utils }: PluginContext): Promise<{ stop: boolean }> {
  const logger = utils.logger;

  try {
    // Check for explicit masking config in body first
    let maskingConfig = req.body?.masking as MaskingConfig | undefined;

    // If no explicit config, check for triggerword in message content
    if (!maskingConfig) {
      maskingConfig = scanAndStripTriggerword(req) || undefined;
    }

    // If still no config, check per-model / per-endpoint force flags. Bypass
    // (header / body field) is honored only against forced config — explicit
    // masking and ON triggerwords above represent caller intent and are not
    // overridable.
    if (!maskingConfig) {
      const forced = getModelForcedConfig(req);
      if (forced) {
        const bypass = isBypassRequested(req);
        if (bypass) {
          if (forced.allowBypass) {
            logger.info(
              `Pseudonymization bypass applied: source=${bypass.source} forcedFrom=${forced.source} ` +
              `endpoint=${(req as any).__endpoint || 'n/a'} model=${req.body?.model || 'n/a'} ` +
              `apiKeyId=${(req as any).apiKey?.id || 'n/a'}`
            );
            return { stop: false };
          }
          logger.warn(
            `Pseudonymization bypass rejected (allow_user_bypass=false): source=${bypass.source} ` +
            `forcedFrom=${forced.source} endpoint=${(req as any).__endpoint || 'n/a'} ` +
            `model=${req.body?.model || 'n/a'} apiKeyId=${(req as any).apiKey?.id || 'n/a'}`
          );
        }
        maskingConfig = forced.config;
      }
    }

    // No-op if no activation method triggered
    if (!maskingConfig) {
      return { stop: false };
    }

    if (!maskingConfig.method || !maskingConfig.entities || maskingConfig.entities.length === 0) {
      logger.warn('Missing or invalid masking config, skipping pseudonymization');
      return { stop: false };
    }

    logger.info(`Pseudonymization active: method=${maskingConfig.method}, entities=${maskingConfig.entities.length}`);

    const map = new ReplacementMap(maskingConfig.method);
    const allEntities: EntityMatch[] = [];
    const maskedInputs: string[] = [];
    const messages = req.body.messages || [];

    // Process system messages (Anthropic format)
    if (Array.isArray(req.body.system)) {
      for (let i = 0; i < req.body.system.length; i++) {
        const sysBlock = req.body.system[i];
        if (sysBlock.type === 'text' && typeof sysBlock.text === 'string') {
          const detected = detectEntities(sysBlock.text, maskingConfig);
          allEntities.push(...detected);
          const masked = replaceEntities(sysBlock.text, detected, map, maskingConfig);
          req.body.system[i].text = masked;
        }
      }
    }

    // Process all messages
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      const message = messages[msgIdx];
      const textParts = extractTextFromMessage(message);

      for (const { text, path } of textParts) {
        const detected = detectEntities(text, maskingConfig);
        allEntities.push(...detected);
        const masked = replaceEntities(text, detected, map, maskingConfig);
        maskedInputs.push(masked);
        setTextInMessage(message, path, masked);
      }

      // Walk tool_use.input objects (assistant turns from prior conversation rounds)
      // and tool_result blocks where content arrived as a plain string (some clients
      // and the webSearchPlugin inject string content rather than a content-block array).
      if (Array.isArray(message?.content)) {
        for (let i = 0; i < message.content.length; i++) {
          const block = message.content[i];
          if (block?.type === 'tool_use' && block.input && typeof block.input === 'object') {
            const r = maskJsonValue(block.input, map, maskingConfig);
            if (r.entities.length > 0) {
              allEntities.push(...r.entities);
            }
          } else if (block?.type === 'tool_result' && typeof block.content === 'string') {
            const detected = detectEntities(block.content, maskingConfig);
            if (detected.length > 0) {
              allEntities.push(...detected);
              block.content = replaceEntities(block.content, detected, map, maskingConfig);
            }
          }
        }
      }
    }

    // Remove the masking config from the body before forwarding upstream
    delete req.body.masking;

    // Store state on request for after/stream handlers
    const state: PseudonymizationState = {
      map: { forward: map.forward, reverse: map.reverse },
      config: maskingConfig,
      maskedInputs,
      entities: allEntities,
    };
    (req as any).__pseudonymization = state;
    (req as any).__pseudonymizationMap = map;

    // Install res.write interceptor for streaming pipelines that emit SSE events directly
    // (e.g., AWS Bedrock stream parser). The after-handler doesn't fire per chunk in those
    // pipelines, so we patch the wire-level write to unmask placeholders in input_json_delta
    // events as they are emitted.
    if (maskingConfig.method === 'pseudonymization' && res) {
      installSseUnmaskInterceptor(req, res, map);
    }

    logger.info(`Masked ${allEntities.length} entities (${map.size} unique) across ${messages.length} messages`);

    // Async: store detected entities in learned cache (non-blocking)
    if (allEntities.length > 0) {
      const toCache = allEntities
        .filter(e => e.type.startsWith('profile-person') || e.type.startsWith('profile-org') || e.type.startsWith('profile-location'))
        .map(e => ({ text: e.original, type: e.type }));
      if (toCache.length > 0) {
        entityCache.store(toCache).catch(() => {});
      }
    }

    return { stop: false };
  } catch (error: any) {
    logger.error(`Error in pseudonymization before handler: ${error.message}`, { stack: error.stack });
    return { stop: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AFTER HANDLER: Unmask response content
// ─────────────────────────────────────────────────────────────────────────────

async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const logger = utils.logger;

  try {
    const state = (req as any).__pseudonymization as PseudonymizationState | undefined;
    if (!state) {
      return upstreamResponse;
    }
    logger.info(`After handler: state found, method=${state.config.method}, entities=${state.entities.length}`);

    const map = (req as any).__pseudonymizationMap as ReplacementMap | undefined;
    if (!map) return upstreamResponse;

    // In pseudonymization mode, skip if no entities were detected
    if (state.config.method === 'pseudonymization' && map.size === 0) return upstreamResponse;

    // For streaming: handle delta content via stream buffer
    const isStreamingChunk = upstreamResponse?.final_result?.choices?.[0]?.delta !== undefined
      || upstreamResponse?.choices?.[0]?.delta !== undefined
      || upstreamResponse?.type === 'content_block_delta'
      || upstreamResponse?.type === 'content_block_start'
      || upstreamResponse?.type === 'content_block_stop';

    if (isStreamingChunk) {
      return handleStreamingChunk(req, upstreamResponse, map, state, logger);
    }

    // Non-streaming: unmask the full response
    if (state.config.method === 'anonymization') {
      // Anonymization: don't unmask, but attach masking_info
      return attachMaskingInfo(upstreamResponse, state);
    }

    const responseText = extractResponseText(upstreamResponse);
    if (responseText) {
      const unmasked = unmaskText(responseText, map);
      setResponseText(upstreamResponse, unmasked);
      logger.debug(`Unmasked response text (${responseText.length} → ${unmasked.length} chars)`);
    }

    unmaskToolBlocks(upstreamResponse, map);

    return attachMaskingInfo(upstreamResponse, state);
  } catch (error: any) {
    logger.error(`Error in pseudonymization after handler: ${error.message}`, { stack: error.stack });
    return upstreamResponse;
  }
}

/**
 * Install a res.write interceptor that unmasks placeholders in SSE events as they are
 * written to the client. Required for pipelines that emit Anthropic-native SSE events
 * directly without going through the after-plugin chain per chunk (e.g., AWS Bedrock
 * native streaming via BedrockStreamParser).
 *
 * Each event is an `event: <name>\ndata: <json>\n\n` block written via a single res.write.
 * We parse, mutate input_json_delta.partial_json and tool_calls.function.arguments deltas
 * through per-block StreamUnmaskBuffer instances, and re-serialize.
 */
function installSseUnmaskInterceptor(req: Request, res: Response, map: ReplacementMap): void {
  if ((res as any).__pseudoSseInterceptorInstalled) return;
  (res as any).__pseudoSseInterceptorInstalled = true;

  const toolBuffers = new Map<string, StreamUnmaskBuffer>();
  const getBuf = (key: string): StreamUnmaskBuffer => {
    let b = toolBuffers.get(key);
    if (!b) { b = new StreamUnmaskBuffer(map); toolBuffers.set(key, b); }
    return b;
  };

  const originalWrite = res.write.bind(res);

  // Patch res.write. The Express Response.write signature has overloads; we accept any.
  (res as any).write = function patchedWrite(chunk: any, ...args: any[]): boolean {
    try {
      const str = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null);
      if (!str) return originalWrite(chunk, ...args);

      // Two SSE formats are emitted by this gateway:
      //   1) "event: <name>\ndata: <json>\n\n" (writeEventStream)
      //   2) "data: <json>\n\n" (writeChunk — used by BedrockStreamParser)
      let eventName: string | null = null;
      let jsonStr: string | null = null;
      const m1 = str.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/s);
      if (m1) {
        eventName = m1[1];
        jsonStr = m1[2];
      } else {
        const m2 = str.match(/^data: (.+)\n\n$/s);
        if (m2) {
          jsonStr = m2[1];
        }
      }
      if (!jsonStr) return originalWrite(chunk, ...args);

      let event: any;
      try { event = JSON.parse(jsonStr); } catch { return originalWrite(chunk, ...args); }

      let modified = false;
      const extraWrites: string[] = [];

      // Anthropic content_block_delta with input_json_delta
      if (event.type === 'content_block_delta'
          && event.delta?.type === 'input_json_delta'
          && typeof event.delta.partial_json === 'string') {
        const idx = event.index ?? 0;
        const buf = getBuf(`tool_use:${idx}`);
        event.delta.partial_json = buf.append(event.delta.partial_json);
        modified = true;
      }

      // Anthropic content_block_stop — flush any retained suffix as a synthetic delta
      // emitted before the stop.
      if (event.type === 'content_block_stop') {
        const idx = event.index ?? 0;
        const buf = toolBuffers.get(`tool_use:${idx}`);
        if (buf) {
          const remainder = buf.flush();
          if (remainder) {
            const synthetic = {
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'input_json_delta', partial_json: remainder },
            };
            // Match the source format (event: prefix only when present in the original write)
            const prefix = eventName ? `event: content_block_delta\n` : '';
            extraWrites.push(`${prefix}data: ${JSON.stringify(synthetic)}\n\n`);
          }
          toolBuffers.delete(`tool_use:${idx}`);
        }
      }

      // OpenAI streaming via SSE (less common with this controller, but handle just in case)
      if (Array.isArray(event?.choices?.[0]?.delta?.tool_calls)) {
        const finishReason = event?.choices?.[0]?.finish_reason;
        for (const call of event.choices[0].delta.tool_calls) {
          if (typeof call?.function?.arguments === 'string') {
            const idx = call.index ?? 0;
            const buf = getBuf(`oai_tool_call:${idx}`);
            if (finishReason) {
              call.function.arguments = buf.append(call.function.arguments) + buf.flush();
              toolBuffers.delete(`oai_tool_call:${idx}`);
            } else {
              call.function.arguments = buf.append(call.function.arguments);
            }
            modified = true;
          }
        }
      }

      // Emit any synthetic events first (they come before the original event for correct ordering)
      for (const extra of extraWrites) originalWrite(extra);

      if (modified) {
        const newStr = eventName
          ? `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`
          : `data: ${JSON.stringify(event)}\n\n`;
        return originalWrite(newStr, ...args);
      }
      return originalWrite(chunk, ...args);
    } catch {
      return originalWrite(chunk, ...args);
    }
  };
}

/**
 * Walk a non-streaming response and unmask placeholders inside tool_use / tool_calls blocks.
 * Covers Anthropic native (content[].type==='tool_use'), OpenAI (choices[].message.tool_calls[]),
 * and SAP orchestration V2 wrapper (final_result.choices[].message.tool_calls[]).
 */
function unmaskToolBlocks(response: any, map: ReplacementMap): void {
  if (!response || typeof response !== 'object') return;

  // Anthropic native: content[].type === 'tool_use', input is arbitrary JSON
  if (Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block?.type === 'tool_use' && block.input) {
        unmaskJsonValue(block.input, map);
      }
    }
  }

  // OpenAI: choices[].message.tool_calls[].function.arguments (JSON string)
  const openaiCalls = response?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(openaiCalls)) {
    for (const call of openaiCalls) {
      if (typeof call?.function?.arguments === 'string') {
        call.function.arguments = unmaskText(call.function.arguments, map);
      }
    }
  }

  // SAP orchestration V2 wrapper
  const sapCalls = response?.final_result?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(sapCalls)) {
    for (const call of sapCalls) {
      if (typeof call?.function?.arguments === 'string') {
        call.function.arguments = unmaskText(call.function.arguments, map);
      }
    }
  }
}

/**
 * Handle a streaming chunk: use StreamUnmaskBuffer for safe partial unmask
 */
function handleStreamingChunk(
  req: Request,
  chunk: any,
  map: ReplacementMap,
  state: PseudonymizationState,
  logger: Logger
): any {
  // Skip unmasking for anonymization
  if (state.config.method === 'anonymization') return chunk;

  // Initialize text stream buffer on first chunk
  if (!(req as any).__streamBuffer) {
    (req as any).__streamBuffer = new StreamUnmaskBuffer(map);
  }
  const buffer: StreamUnmaskBuffer = (req as any).__streamBuffer;

  // Per-tool-block buffers keyed by `${kind}:${index}` so each tool stream
  // gets its own placeholder-boundary buffer.
  if (!(req as any).__streamToolBuffers) {
    (req as any).__streamToolBuffers = new Map<string, StreamUnmaskBuffer>();
  }
  const toolBuffers: Map<string, StreamUnmaskBuffer> = (req as any).__streamToolBuffers;
  const getToolBuf = (key: string): StreamUnmaskBuffer => {
    let b = toolBuffers.get(key);
    if (!b) { b = new StreamUnmaskBuffer(map); toolBuffers.set(key, b); }
    return b;
  };

  // ─── Text deltas (existing behavior) ────────────────────────────────────
  const deltaText = extractResponseText(chunk);
  if (deltaText) {
    const finishReason = chunk?.final_result?.choices?.[0]?.finish_reason
      || chunk?.choices?.[0]?.finish_reason;

    let outputText: string;
    if (finishReason) {
      outputText = buffer.append(deltaText);
      outputText += buffer.flush();
    } else {
      outputText = buffer.append(deltaText);
    }

    if (outputText !== deltaText) {
      setResponseText(chunk, outputText);
    }
  }

  // ─── Anthropic SSE: content_block_delta with input_json_delta ───────────
  if (chunk?.type === 'content_block_delta'
      && chunk?.delta?.type === 'input_json_delta'
      && typeof chunk.delta.partial_json === 'string') {
    const idx = chunk.index ?? 0;
    const key = `tool_use:${idx}`;
    const buf = getToolBuf(key);
    chunk.delta.partial_json = buf.append(chunk.delta.partial_json);
  }

  // ─── Anthropic SSE: content_block_stop — flush per-block remainder ──────
  // Append flushed text to delta.partial_json on the stop event so any retained
  // suffix is still emitted. Most clients tolerate extra partial_json on stop.
  if (chunk?.type === 'content_block_stop') {
    const idx = chunk.index ?? 0;
    const key = `tool_use:${idx}`;
    const buf = toolBuffers.get(key);
    if (buf) {
      const remainder = buf.flush();
      if (remainder) {
        if (!chunk.delta) chunk.delta = { type: 'input_json_delta', partial_json: '' };
        chunk.delta.partial_json = (chunk.delta.partial_json || '') + remainder;
      }
      toolBuffers.delete(key);
    }
  }

  // ─── OpenAI streaming: choices[0].delta.tool_calls[].function.arguments ─
  const oaiToolCalls = chunk?.choices?.[0]?.delta?.tool_calls;
  if (Array.isArray(oaiToolCalls)) {
    const finishReason = chunk?.choices?.[0]?.finish_reason;
    for (const call of oaiToolCalls) {
      const argFragment = call?.function?.arguments;
      if (typeof argFragment === 'string') {
        const idx = call.index ?? 0;
        const key = `oai_tool_call:${idx}`;
        const buf = getToolBuf(key);
        if (finishReason) {
          call.function.arguments = buf.append(argFragment) + buf.flush();
          toolBuffers.delete(key);
        } else {
          call.function.arguments = buf.append(argFragment);
        }
      }
    }
  }

  // ─── SAP V2 wrapper streaming ──────────────────────────────────────────
  const sapToolCalls = chunk?.final_result?.choices?.[0]?.delta?.tool_calls;
  if (Array.isArray(sapToolCalls)) {
    const finishReason = chunk?.final_result?.choices?.[0]?.finish_reason;
    for (const call of sapToolCalls) {
      const argFragment = call?.function?.arguments;
      if (typeof argFragment === 'string') {
        const idx = call.index ?? 0;
        const key = `sap_tool_call:${idx}`;
        const buf = getToolBuf(key);
        if (finishReason) {
          call.function.arguments = buf.append(argFragment) + buf.flush();
          toolBuffers.delete(key);
        } else {
          call.function.arguments = buf.append(argFragment);
        }
      }
    }
  }

  return chunk;
}

/**
 * Attach masking_info diagnostic to the response
 */
function attachMaskingInfo(response: any, state: PseudonymizationState): any {
  const maskingInfo: MaskingInfo = {
    masked_input: state.maskedInputs.join('\n'),
    entities_detected: state.entities.map(e => ({
      placeholder: e.placeholder || '',
      type: e.type,
      start: e.start,
      end: e.end,
    })),
    method: state.config.method,
  };

  if (response && typeof response === 'object') {
    response.masking_info = maskingInfo;
  }

  return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAM HANDLER: Raw buffer processing (operates before SSE parsing)
// ─────────────────────────────────────────────────────────────────────────────

async function streamHandler({ req, chunk, utils }: PluginContext): Promise<Buffer> {
  // The stream strategy operates on raw Buffers before SSE parsing.
  // For pseudonymization, we primarily use the 'after' strategy which fires per-parsed-chunk.
  // This stream handler is a pass-through but ensures state is initialized.
  const state = (req as any).__pseudonymization as PseudonymizationState | undefined;
  if (!state) return chunk!;

  // Pass through — actual unmasking happens in the after handler for parsed chunks
  return chunk!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Rules Export
// ─────────────────────────────────────────────────────────────────────────────

const pluginRules = [
  {
    id: 'pseudonymizationPlugin',
    match: [],
    strategy: 'before',
    handler: beforeHandler,
  },
  {
    id: 'pseudonymizationPlugin',
    match: [],
    strategy: 'after',
    handler: afterHandler,
  },
  {
    id: 'pseudonymizationPlugin',
    match: [],
    strategy: 'stream',
    handler: streamHandler,
  },
];

export = pluginRules;
