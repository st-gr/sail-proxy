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
 * @see ../pseudonymization.md - Usage, activation methods, and category configuration
 * @see ../../../../../docs/security/pseudonymization-security-assessment.md - Security assessment
 */

import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { MaskingConfig, MaskingInfo, PseudonymizationState, EntityMatch, EntityConfig } from './types';
import { ReplacementMap } from './replacementMap';
import { detectEntities } from './detectors';
import { replaceEntities, maskJsonValue, propagateMaskedValues } from './replacer';
import { applyEntityToggles, buildKnownEntityTypes } from './entityToggles';
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
  // Anthropic native streaming: content_block_delta with text_delta
  if (response?.type === 'content_block_delta'
      && response?.delta?.type === 'text_delta'
      && typeof response.delta.text === 'string') {
    return response.delta.text;
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
  } else if (response?.type === 'content_block_delta'
      && response?.delta?.type === 'text_delta'
      && response.delta.text !== undefined) {
    response.delta.text = newText;
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
    { type: 'profile-nationalid' },
    { type: 'profile-passport' },
    { type: 'profile-driverlicense' },
    { type: 'profile-pronouns-gender' },
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

// All category types the pseudonymizationPlugin understands, for toggle validation.
const KNOWN_ENTITY_TYPES = buildKnownEntityTypes(DEFAULT_MASKING_CONFIG.entities);

/**
 * Resolve the DEFAULT entity set for this request by layering api_config.json
 * toggles over DEFAULT_MASKING_CONFIG: global (api_config.pseudonymization.entities)
 * → per-endpoint (defaultHooks[endpoint].pseudonymization.entities) → per-model
 * (model_list_changes[model].pseudonymization.entities); later layers win.
 * Reads dynamic config per request (hot in distributed mode; standalone requires
 * a restart, as for all plugin config). Falls back to the code defaults on any error.
 */
function resolveDefaultEntities(req: any): EntityConfig[] {
  try {
    const configService = require('../../services/configService').default || require('../../services/configService');
    const apiConfig = configService.getConfig()?.api_config;
    if (!apiConfig) return DEFAULT_MASKING_CONFIG.entities;

    let entities = applyEntityToggles(DEFAULT_MASKING_CONFIG.entities, apiConfig.pseudonymization?.entities, KNOWN_ENTITY_TYPES);

    const endpoint = req?.__endpoint;
    if (endpoint) {
      entities = applyEntityToggles(entities, apiConfig.defaultHooks?.[endpoint]?.pseudonymization?.entities, KNOWN_ENTITY_TYPES);
    }

    const modelName = req?.body?.model;
    if (modelName) {
      const substituted = configService.getSubstitutedModel('anthropic', modelName) || modelName;
      entities = applyEntityToggles(entities, apiConfig.model_list_changes?.[substituted]?.pseudonymization?.entities, KNOWN_ENTITY_TYPES);
    }

    return entities;
  } catch {
    return DEFAULT_MASKING_CONFIG.entities;
  }
}

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

  return { ...DEFAULT_MASKING_CONFIG, entities: resolveDefaultEntities(req), method: found };
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
        return { config: { ...DEFAULT_MASKING_CONFIG, entities: resolveDefaultEntities(req), method }, allowBypass, source: 'model' };
      }
    }

    // Per-endpoint force flag (defaultHooks[endpoint].pseudonymization.enabled)
    const endpoint = req.__endpoint;
    if (endpoint) {
      const endpointConfig = config?.api_config?.defaultHooks?.[endpoint];
      if (endpointConfig?.pseudonymization?.enabled) {
        const method = endpointConfig.pseudonymization.method || 'pseudonymization';
        const allowBypass = endpointConfig.pseudonymization.allow_user_bypass === true;
        return { config: { ...DEFAULT_MASKING_CONFIG, entities: resolveDefaultEntities(req), method }, allowBypass, source: 'endpoint' };
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

    // Residue guard: the incoming request may contain literal MASKED_* tokens from
    // earlier turns/sessions. With content-derived (hash) placeholders these resolve
    // on their own whenever the underlying value is present in this request (the same
    // value re-mints the identical token). Legacy NUMERIC residue (from the old
    // counter scheme) can never be re-minted; reserve those numbers so anonymization
    // counters cannot collide with them, and log the residue for visibility.
    try {
      const rawBody = JSON.stringify(req.body);
      const residue = new Set<string>(rawBody.match(/MASKED_[A-Z_]+_[0-9a-f]+|(?:https?:\/\/)?masked-url-\d+\.invalid/g) || []);
      if (residue.size > 0) {
        for (const token of residue) {
          const m = token.match(/^(MASKED_[A-Z_]+)_(\d+)$/);
          // Cap the reservation so a digits-only hash id cannot blow up the counters.
          if (m && m[2].length <= 6) map.reserveMinCount(m[1], parseInt(m[2], 10));
        }
        const sample = Array.from(residue).slice(0, 10).join(', ');
        logger.info(`Request contains ${residue.size} masked token(s) carried in from earlier turns (hash-stable tokens resolve automatically when their value is present): ${sample}${residue.size > 10 ? ', …' : ''}`);
      }
    } catch { /* non-fatal: residue guard is best-effort */ }

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

    // Value-consistency propagation: mask every remaining exact occurrence of each
    // detected value across the request, including nodes where no detector fired
    // (e.g. the same secret riding through in an `Authorization: Bearer` header).
    // Prevents the model from seeing the raw value alongside its mask.
    const propagated = propagateMaskedValues(req.body, map);

    // Tell the model to treat placeholder tokens as opaque and copy them verbatim.
    // A garbled id cannot be unmasked (the value is unrecoverable), so copy fidelity
    // is part of the design; observed in practice: models occasionally rewrite ids
    // when reproducing them in generated files unless explicitly instructed not to.
    if (maskingConfig.method === 'pseudonymization' && map.size > 0) {
      const copyNote = 'Some values in this conversation are pseudonymized as placeholder tokens of the form '
        + 'MASKED_<TYPE>_<id>. Treat each token as an opaque identifier: when you refer to a masked value, '
        + 'copy its token EXACTLY, character for character. Never invent, alter, shorten, or merge token ids. '
        + 'Only use MASKED_* tokens that appear verbatim in this conversation — NEVER invent, guess, or '
        + 'construct a new MASKED_* token or id under any circumstances; a token you did not see in the input '
        + 'is meaningless and will break the user\'s workflow. If a value you need appears unmasked in the '
        + 'conversation, use that unmasked value as-is; do not create a token for it. '
        + 'Masked URLs appear as hosts like https://masked-url-<id>.invalid — you MAY append paths and query '
        + 'parameters to such a host to form new URLs, but never invent a masked-url host that is not present '
        + 'in the conversation.';
      if (Array.isArray(req.body.system)) {
        req.body.system.push({ type: 'text', text: copyNote });
      } else if (typeof req.body.system === 'string') {
        req.body.system = `${req.body.system}\n\n${copyNote}`;
      } else if (req.body.system === undefined || req.body.system === null) {
        req.body.system = copyNote;
      }
    }

    // Capture the masking_info debug opt-in before the config is stripped. The
    // full masked-input diagnostic is off by default for pseudonymization (it
    // bloats every client response); attach it only when explicitly requested via
    // `masking.debug: true` or the out-of-band `x-sail-proxy-masking-debug: on`
    // header (same channel pattern as the bypass header).
    const maskingDebug = (req.body?.masking as any)?.debug === true
      || (typeof req.headers?.['x-sail-proxy-masking-debug'] === 'string'
        && (req.headers['x-sail-proxy-masking-debug'] as string).toLowerCase() === 'on');
    (req as any).__pseudonymizationDebug = maskingDebug;

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

    logger.info(`Masked ${allEntities.length} entities (${map.size} unique) across ${messages.length} messages; propagated ${propagated} additional occurrence(s)`);

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

    // Residue audit (the non-streaming path had none — this is the incident path).
    // Scan the fully-unmasked client-facing body for surviving MASKED_* tokens and
    // log per-token detail plus one aggregated, grep-stable counter line.
    auditResponseResidue(upstreamResponse, map, (req as any)?.debugRequestId || 'unknown', logger);

    return maybeAttachMaskingInfo(upstreamResponse, state, req);
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
 * The patched write re-frames arbitrary write boundaries into complete SSE blocks
 * (`[event: <name>\n]data: <json>\n\n`), holding a partial tail across writes, so it
 * also covers pipelines that pipe multiple or partial events per write (e.g. the
 * converse-stream direct passthrough). Assistant text (text_delta), tool input
 * (input_json_delta), and OpenAI tool_calls argument deltas are unmasked through
 * per-content-block StreamUnmaskBuffer instances; retained fragments are flushed on
 * content_block_stop / message_stop / finish_reason / res.end.
 *
 * Diagnostics: when a completed block still contains MASKED_* placeholders, an error
 * (token was in the map — a genuine unmask miss) or warning (token unknown — residue
 * leaked into the conversation by an earlier session) is logged, so leaks are never
 * silent again.
 */
function installSseUnmaskInterceptor(req: Request, res: Response, map: ReplacementMap): void {
  if ((res as any).__pseudoSseInterceptorInstalled) return;
  if (typeof (res as any).write !== 'function' || typeof (res as any).end !== 'function') return;
  (res as any).__pseudoSseInterceptorInstalled = true;


  // Patch res.json so NON-streaming responses that bypass res.write are still unmasked.
  // The awsBedrockResponseCache plugin serves non-streaming cache hits via res.status().json()
  // and returns { stop: true }, which short-circuits the after-handler AND never touches
  // res.write — so without this, cached placeholders reach the client masked. The cache stores
  // the masked upstream response (pseudonymization unmasks at the wire, after caching); for an
  // identical request the placeholder numbers are deterministic, so this request's map resolves
  // them. Tokens not in the map (residue) are left untouched by unmaskText.
  const logger = getDefaultLogger();
  if (typeof (res as any).json === 'function') {
    const originalJson = (res as any).json.bind(res);
    (res as any).json = function patchedJson(body: any): Response {
      try {
        if (body && typeof body === 'object' && map.reverse.size > 0) {
          const serialized = JSON.stringify(body);
          if (serialized.includes('MASKED_')) {
            const unmasked = unmaskText(serialized, map);
            if (unmasked !== serialized) {
              body = JSON.parse(unmasked);
              logger.debug('Pseudonymization', `Unmasked non-streaming JSON response body (requestId=${(req as any)?.debugRequestId || 'unknown'})`);
            }
          }
        }
      } catch { /* fall through with original body */ }
      return originalJson(body);
    };
  }

  const requestId = (req as any)?.debugRequestId || 'unknown';

  const buffers = new Map<string, StreamUnmaskBuffer>();
  const getBuf = (key: string): StreamUnmaskBuffer => {
    let b = buffers.get(key);
    if (!b) { b = new StreamUnmaskBuffer(map); buffers.set(key, b); }
    return b;
  };

  // Per-block emitted content, used only for the leak audit below.
  const emitted = new Map<string, string>();
  const track = (key: string, s: string): void => {
    if (s) emitted.set(key, (emitted.get(key) || '') + s);
  };
  const auditBlock = (key: string): void => {
    const content = emitted.get(key);
    emitted.delete(key);
    if (!content) return;
    for (const token of new Set(content.match(/MASKED_[A-Z_]+_[0-9a-f]+|(?:https?:\/\/)?masked-url-\d+\.invalid/g) || [])) {
      if (map.reverse.has(token)) {
        logger.error('Pseudonymization', `Unmask miss on streaming block ${key}: ${token} was in the replacement map but reached the client masked (requestId=${requestId})`);
      } else {
        logger.warn('Pseudonymization', `Unresolvable masked residue in streaming block ${key}: ${token} is not in this request's map — its value is absent from this request (leaked by an earlier session) (requestId=${requestId})`);
      }
    }
  };

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  // Partial SSE block carried across write() calls (re-framing buffer).
  let pending = '';

  // Process one complete SSE block; returns the (possibly rewritten) block.
  const processBlock = (block: string): string => {
    // Two SSE formats are emitted by this gateway:
    //   1) "event: <name>\ndata: <json>\n\n" (writeEventStream)
    //   2) "data: <json>\n\n" (writeChunk — used by BedrockStreamParser)
    let eventName: string | null = null;
    let jsonStr: string | null = null;
    const m1 = block.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/s);
    if (m1) {
      eventName = m1[1];
      jsonStr = m1[2];
    } else {
      const m2 = block.match(/^data: (.+)\n\n$/s);
      if (m2) {
        jsonStr = m2[1];
      }
    }
    if (!jsonStr) return block;

    let event: any;
    try { event = JSON.parse(jsonStr); } catch { return block; }

    let modified = false;
    let syntheticPrefix = '';

    // Serialize a synthetic delta in the same format as the surrounding stream,
    // emitted BEFORE the current event for correct ordering.
    const synth = (idx: number, delta: any): string => {
      const ev = { type: 'content_block_delta', index: idx, delta };
      const prefix = eventName ? 'event: content_block_delta\n' : '';
      return `${prefix}data: ${JSON.stringify(ev)}\n\n`;
    };

    // Anthropic content_block_delta with text_delta (assistant prose)
    if (event.type === 'content_block_delta'
        && event.delta?.type === 'text_delta'
        && typeof event.delta.text === 'string') {
      const idx = event.index ?? 0;
      const buf = getBuf(`text:${idx}`);
      event.delta.text = buf.append(event.delta.text);
      track(`text:${idx}`, event.delta.text);
      modified = true;
    }

    // Anthropic content_block_delta with input_json_delta (tool call input)
    if (event.type === 'content_block_delta'
        && event.delta?.type === 'input_json_delta'
        && typeof event.delta.partial_json === 'string') {
      const idx = event.index ?? 0;
      const buf = getBuf(`tool_use:${idx}`);
      event.delta.partial_json = buf.append(event.delta.partial_json);
      track(`tool_use:${idx}`, event.delta.partial_json);
      modified = true;
    }

    // Anthropic content_block_stop — flush retained suffixes of this block's buffers
    // as synthetic deltas emitted before the stop, then audit the block for leaks.
    if (event.type === 'content_block_stop') {
      const idx = event.index ?? 0;
      const textBuf = buffers.get(`text:${idx}`);
      if (textBuf) {
        const remainder = textBuf.flush();
        if (remainder) {
          syntheticPrefix += synth(idx, { type: 'text_delta', text: remainder });
          track(`text:${idx}`, remainder);
        }
        buffers.delete(`text:${idx}`);
      }
      const toolBuf = buffers.get(`tool_use:${idx}`);
      if (toolBuf) {
        const remainder = toolBuf.flush();
        if (remainder) {
          syntheticPrefix += synth(idx, { type: 'input_json_delta', partial_json: remainder });
          track(`tool_use:${idx}`, remainder);
        }
        buffers.delete(`tool_use:${idx}`);
      }
      auditBlock(`text:${idx}`);
      auditBlock(`tool_use:${idx}`);
    }

    // Anthropic message_stop — safety flush of ALL remaining buffers (Anthropic streams
    // have no choices[].finish_reason, so anything not flushed by a stop lands here).
    if (event.type === 'message_stop') {
      for (const [key, buf] of Array.from(buffers.entries())) {
        const remainder = buf.flush();
        if (remainder) {
          const idx = parseInt(key.split(':')[1], 10) || 0;
          const deltaType = key.startsWith('text:') ? 'text_delta' : 'input_json_delta';
          syntheticPrefix += synth(idx, deltaType === 'text_delta'
            ? { type: 'text_delta', text: remainder }
            : { type: 'input_json_delta', partial_json: remainder });
          track(key, remainder);
        }
        buffers.delete(key);
      }
      for (const key of Array.from(emitted.keys())) auditBlock(key);
    }

    // OpenAI streaming via SSE (less common with this controller, but handle just in case)
    if (Array.isArray(event?.choices?.[0]?.delta?.tool_calls)) {
      const finishReason = event?.choices?.[0]?.finish_reason;
      for (const call of event.choices[0].delta.tool_calls) {
        if (typeof call?.function?.arguments === 'string') {
          const idx = call.index ?? 0;
          const key = `oai_tool_call:${idx}`;
          const buf = getBuf(key);
          if (finishReason) {
            call.function.arguments = buf.append(call.function.arguments) + buf.flush();
            track(key, call.function.arguments);
            buffers.delete(key);
            auditBlock(key);
          } else {
            call.function.arguments = buf.append(call.function.arguments);
            track(key, call.function.arguments);
          }
          modified = true;
        }
      }
    }

    if (modified) {
      const newStr = eventName
        ? `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`
        : `data: ${JSON.stringify(event)}\n\n`;
      return syntheticPrefix + newStr;
    }
    return syntheticPrefix + block;
  };

  // Final safety net: unmask any COMPLETE placeholder still present in outgoing bytes.
  // The structured per-block handling above only unmasks events it recognizes as
  // content_block_delta text_delta / input_json_delta; text emitted through other
  // shapes (notably the BedrockStreamParser raw-text fallback, which writes bare
  // `data: <text>` on a parse miss) would otherwise reach the client masked. This is
  // idempotent on already-unmasked output (no reverse-map keys remain to match) and
  // only touches whole tokens, so it never disturbs the buffer's partial-retention.
  const safetyNetUnmask = (s: string): string => {
    if (map.reverse.size === 0) return s;
    if (!s.includes('MASKED_') && !s.includes('masked-url-')) return s;
    return unmaskText(s, map);
  };

  // Split accumulated data into complete SSE blocks, keep the partial tail pending.
  const processIncoming = (str: string): string => {
    pending += str;
    let out = '';
    let sep: number;
    while ((sep = pending.indexOf('\n\n')) !== -1) {
      const block = pending.slice(0, sep + 2);
      pending = pending.slice(sep + 2);
      out += processBlock(block);
    }
    return safetyNetUnmask(out);
  };

  // Patch res.write. The Express Response.write signature has overloads; we accept any.
  (res as any).write = function patchedWrite(chunk: any, ...args: any[]): boolean {
    try {
      const str = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null);
      if (str === null) return originalWrite(chunk, ...args);

      const out = processIncoming(str);
      // Strip a callback argument if present — it must fire even when we buffer.
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      if (out) {
        const result = originalWrite(out, ...args);
        if (cb) cb();
        return result;
      }
      // Entire chunk retained as a partial block — report success, emit on next write/end.
      if (cb) cb();
      return true;
    } catch {
      return originalWrite(chunk, ...args);
    }
  };

  // Patch res.end so a trailing partial block (and any retained buffer content) is not lost.
  (res as any).end = function patchedEnd(chunk?: any, ...args: any[]): Response {
    try {
      if (chunk && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
        const out = processIncoming(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        if (out) originalWrite(out);
        chunk = undefined;
      }
      if (pending) {
        // Incomplete final block — pass through (best effort), still safety-net unmasked.
        originalWrite(safetyNetUnmask(pending));
        pending = '';
      }
      // Streams that ended without content_block_stop/message_stop: audit what remains.
      for (const [key, buf] of Array.from(buffers.entries())) {
        const remainder = buf.flush();
        if (remainder) track(key, remainder);
        buffers.delete(key);
      }
      for (const key of Array.from(emitted.keys())) auditBlock(key);
    } catch { /* fall through to originalEnd */ }
    return chunk !== undefined ? originalEnd(chunk, ...args) : originalEnd(...args);
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
    let toolFlushed = false;
    if (buf) {
      const remainder = buf.flush();
      if (remainder) {
        if (!chunk.delta) chunk.delta = { type: 'input_json_delta', partial_json: '' };
        chunk.delta.partial_json = (chunk.delta.partial_json || '') + remainder;
        toolFlushed = true;
      }
      toolBuffers.delete(key);
    }
    // Text blocks: Anthropic streams never set choices[].finish_reason, so the shared
    // text buffer's retained tail would otherwise be stranded. Flush it here, unless
    // this stop already carries a tool remainder (don't mix delta types).
    if (!toolFlushed) {
      const textRemainder = buffer.flush();
      if (textRemainder) {
        if (!chunk.delta) chunk.delta = { type: 'text_delta', text: '' };
        if (chunk.delta.type === 'text_delta') {
          chunk.delta.text = (chunk.delta.text || '') + textRemainder;
        }
      }
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

/**
 * Attach masking_info, but for pseudonymization only when the request opted into the
 * debug diagnostic (`masking.debug: true` or `x-sail-proxy-masking-debug: on`).
 * Anonymization keeps its documented behavior of always attaching it.
 */
function maybeAttachMaskingInfo(response: any, state: PseudonymizationState, req: any): any {
  if (state.config.method === 'pseudonymization' && !(req as any)?.__pseudonymizationDebug) {
    return response;
  }
  return attachMaskingInfo(response, state);
}

// Placeholder-residue pattern (hash-hex ids and masked-url hosts), shared by the
// streaming and non-streaming leak audits.
const RESIDUE_REGEX = /MASKED_[A-Z_]+_[0-9a-f]+|(?:https?:\/\/)?masked-url-\d+\.invalid/g;

/**
 * Scan a fully-unmasked non-streaming response for surviving MASKED_* tokens.
 * Logs per-token detail (ERROR if the token was in the map — a genuine unmask miss;
 * WARN if it is unknown residue from an earlier session) plus one aggregated,
 * grep-stable counter line so leak rates can be monitored.
 */
function auditResponseResidue(response: any, map: ReplacementMap, requestId: string, logger: any): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(response) || '';
  } catch { return; }
  if (!serialized.includes('MASKED_') && !serialized.includes('masked-url-')) return;

  const tokens = new Set(serialized.match(RESIDUE_REGEX) || []);
  if (tokens.size === 0) return;

  const byType: Record<string, number> = {};
  for (const token of tokens) {
    const type = token.match(/^(MASKED_[A-Z_]+)_/)?.[1] || 'MASKED_URL';
    byType[type] = (byType[type] || 0) + 1;
    if (map.reverse.has(token)) {
      logger.error('Pseudonymization', `Unmask miss on response: ${token} was in the replacement map but reached the client masked (requestId=${requestId})`);
    } else {
      logger.warn('Pseudonymization', `Unresolvable masked residue in response: ${token} is not in this request's map — its value is absent from this request (leaked by an earlier session) (requestId=${requestId})`);
    }
  }
  const byTypeStr = Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(',');
  logger.warn('Pseudonymization', `pseudonymization_residue_unresolved_total=${tokens.size} by_type=${byTypeStr} requestId=${requestId}`);
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
