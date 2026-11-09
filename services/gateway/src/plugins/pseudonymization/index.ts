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
 * @see ./pseudonymization.md - Usage, activation methods, and category configuration
 * @see ../../../../../docs/developer/pseudonymization-assessment.md - Security assessment
 */

import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { redactUrl } from '../../utils/redactUrl';
import configService, { PseudonymizationConfig, DefaultHookEntry } from '../../services/configService';
import { MaskingConfig, MaskingInfo, PseudonymizationState, EntityMatch, EntityConfig, AllowlistConfig, CustomEntity } from '../../pluginSupport/pseudonymization/types';
import { ReplacementMap } from '../../pluginSupport/pseudonymization/replacementMap';
import { detectEntities, DetectionConfig, STRICT_DETECTORS } from '../../pluginSupport/pseudonymization/detectors';
import { replaceEntities, maskJsonValue, propagateMaskedValues } from '../../pluginSupport/pseudonymization/replacer';
import { propagatableNames } from '../../pluginSupport/pseudonymization/detectors/speakerLabelDetector';
import { applyEntityToggles, buildKnownEntityTypes } from '../../pluginSupport/pseudonymization/entityToggles';
import { DEFAULT_MASKING_CONFIG } from '../../pluginSupport/pseudonymization/defaultMaskingConfig';
import { readForceSource, servedModelOf } from '../../pluginSupport/pseudonymization/forcedRun';
import { unmaskText, unmaskJsonValue, unmaskJsonArguments, unmaskResponseBody } from '../../pluginSupport/pseudonymization/unmasker';
import { mapJsonStringLeaves } from '../../utils/jsonStringLeaves';
import { StreamUnmaskBuffer } from './streamBuffer';
import { entityCache } from './entityCache';
import {
  buildSaturationReport,
  formatSaturationWarning,
  resolveSaturationWarn,
  topShapes,
} from './saturationReport';
import {
  isResponsesBody,
  extractResponsesInputTexts,
  setResponsesInputText,
  appendResponsesInstructions,
  unmaskResponsesOutput,
} from '../../utils/responsesBodyAdapter';
import {
  isGeminiBody,
  extractGeminiInputTexts,
  setGeminiInputText,
  extractGeminiJsonValues,
  appendGeminiInstructions,
  unmaskGeminiOutput,
} from '../../utils/geminiBodyAdapter';
import {
  isConverseBody,
  extractConverseInputs,
  setConverseInputText,
  appendConverseInstructions,
  unmaskConverseOutput,
} from '../../utils/converseBodyAdapter';
import { unsupportedBodyShape } from './bodyShape';
import { beginStreamContentCapture } from '../../services/siemUsageEvent';
import securityEventEmitter from '../../services/securityEventEmitter';
import { containmentOf, registerContainment } from '../../pluginSupport/pseudonymization/containmentRegistry';
import { placeholdersIn, resolveUnknownPlaceholderMode } from '../../pluginSupport/pseudonymization/unknownPlaceholders';
import type { UnknownPlaceholderMode } from '../../pluginSupport/pseudonymization/unknownPlaceholders';
import { appendStreamContent } from '../../services/siemStreamCapture';
import { FORCED_FLAG, refuseUnmasked, describeErrorWithoutContent } from '../../pluginSupport/pseudonymization/failClosed';
import { parseConverseEventData } from '../../utils/converseEventData';

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
 * Mask a tool call's JSON-text arguments (OpenAI `function.arguments`, Responses
 * `function_call.arguments`) structurally: each string leaf is masked and the JSON
 * re-serialized, so the map holds the real value rather than its JSON-escaped form and the
 * arguments stay valid JSON. Arguments that are not JSON are masked as plain text.
 */
function maskJsonArguments(
  text: string,
  map: ReplacementMap,
  detectConfig: DetectionConfig,
  maskingConfig: MaskingConfig
): { text: string; entities: EntityMatch[] } {
  const entities: EntityMatch[] = [];
  const maskText = (s: string): string => {
    const detected = detectEntities(s, detectConfig);
    if (detected.length === 0) return s;
    entities.push(...detected);
    return replaceEntities(s, detected, map, maskingConfig);
  };
  return { text: mapJsonStringLeaves(text, maskText) ?? maskText(text), entities };
}

/**
 * Add a note to an OpenAI Chat `messages` array: appended to the first `system`
 * message, or as a new system message at index 0. Index 0 keeps the last message the
 * client's own and never places a system message after a tool message.
 *
 * The system message is REPLACED by a copy, never edited in place: the orchestration
 * chat path has already built its SAP payload from these same message objects, and
 * that payload must stay as it is.
 */
function appendOpenAIChatSystemNote(messages: any[], note: string): void {
  const index = messages.findIndex((m: any) => m?.role === 'system');
  if (index === -1) {
    messages.unshift({ role: 'system', content: note });
    return;
  }
  const system = messages[index];
  let content: any;
  if (Array.isArray(system.content)) {
    content = [...system.content, { type: 'text', text: note }];
  } else if (typeof system.content === 'string' && system.content.length > 0) {
    content = `${system.content}\n\n${note}`;
  } else {
    content = note;
  }
  messages[index] = { ...system, content };
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

// DEFAULT_MASKING_CONFIG — the entity set triggerword/force activation starts from — now
// lives in ./defaultMaskingConfig.ts, imported above. This file is `export = pluginRules`,
// so a named value declared here is unreachable from anywhere else; fileSearch's chunk
// masking is the second consumer that needs the same list. See that module for why a
// second copy of the list was not acceptable.

// All category types the pseudonymizationPlugin understands, for toggle validation.
const KNOWN_ENTITY_TYPES = buildKnownEntityTypes(DEFAULT_MASKING_CONFIG.entities);

/**
 * Resolve the DEFAULT entity set for this request by layering api_config.json
 * toggles over DEFAULT_MASKING_CONFIG: global (api_config.observability.pseudonymization.entities)
 * → per-endpoint (hooks.defaults[endpoint].pseudonymization.entities) → per-model
 * (models.overrides[model].pseudonymization.entities); later layers win.
 * Reads dynamic config per request (hot in distributed mode; standalone requires
 * a restart, as for all plugin config). Falls back to the code defaults on any error.
 */
function resolveDefaultEntities(req: any): EntityConfig[] {
  try {
    const apiConfig = configService.getConfig()?.api_config;
    if (!apiConfig) return DEFAULT_MASKING_CONFIG.entities;

    // observability.pseudonymization / hooks.defaults stay Record<string, unknown>
    // on ApiConfig itself (section internals stay untyped except where a reader
    // needs one); cast into configService's own real shapes here rather than
    // threading `unknown` through every field access.
    const globalPseudo = apiConfig.observability?.pseudonymization as PseudonymizationConfig | undefined;
    let entities = applyEntityToggles(DEFAULT_MASKING_CONFIG.entities, globalPseudo?.entities, KNOWN_ENTITY_TYPES);

    const endpoint = req?.__endpoint;
    if (endpoint) {
      const endpointHooks = apiConfig.hooks?.defaults as Record<string, DefaultHookEntry> | undefined;
      entities = applyEntityToggles(entities, endpointHooks?.[endpoint]?.pseudonymization?.entities, KNOWN_ENTITY_TYPES);
    }

    const modelName = servedModelOf(req);
    if (modelName) {
      const substituted = configService.getSubstitutedModel('anthropic', modelName) || modelName;
      entities = applyEntityToggles(entities, apiConfig.models?.overrides?.[substituted]?.pseudonymization?.entities, KNOWN_ENTITY_TYPES);
    }

    return entities;
  } catch {
    return DEFAULT_MASKING_CONFIG.entities;
  }
}

// Categories already warned about (one WARN per category per process, not per request),
// mirroring `warnedUnknownToggles` in entityToggles.ts.
const warnedEmptyProducer = new Set<string>();

/**
 * Resolve the org/location detector inputs from api_config, layered the same way as
 * entity toggles: global → per-endpoint → per-model, later layers winning.
 *
 * Also warns when a category is enabled with nothing for it to match. An operator who
 * enables location masking and populates no gazetteer gets ZERO masking; without this
 * warning they would only discover that by auditing masked output, which is how these
 * two categories stayed broken in the first place.
 */
/**
 * The three configuration layers for this request, in application order:
 * global (`observability.pseudonymization`) → per-endpoint
 * (`hooks.defaults.<endpoint>.pseudonymization`) → per-model
 * (`models.overrides.<model>.pseudonymization`). Later layers win.
 *
 * One walker for every layered pseudonymization setting: `resolveDefaultEntities` predates
 * it and applies its own toggle merge per layer, but the list-valued and scalar settings
 * below all read the SAME three pointers, and a second hand-written walk would be a second
 * place for the order to drift.
 */
function pseudonymizationLayers(req: any): (PseudonymizationConfig | undefined)[] {
  const apiConfig = configService.getConfig()?.api_config;
  const endpointHooks = apiConfig?.hooks?.defaults as Record<string, DefaultHookEntry> | undefined;
  return [
    apiConfig?.observability?.pseudonymization as PseudonymizationConfig | undefined,
    req?.__endpoint ? endpointHooks?.[req.__endpoint]?.pseudonymization : undefined,
    servedModelOf(req)
      ? apiConfig?.models?.overrides?.[
          configService.getSubstitutedModel('anthropic', servedModelOf(req)!) || servedModelOf(req)!
        ]?.pseudonymization
      : undefined,
  ];
}

/**
 * Resolve the confidence gate for this request — `min_confidence` and the per-category
 * `thresholds` map — from the same three layers.
 *
 * `min_confidence` is a scalar: the last layer that sets one wins outright. `thresholds` is
 * merged PER CATEGORY, the way `entities` is: a per-model block that pins
 * `profile-person` does not silently discard a global `profile-org` threshold. Absent
 * everywhere, both are omitted and the detector defaults apply (0.5 for every category).
 *
 * Values are not validated here — `resolveThresholds` in detectors/confidence.ts drops
 * anything outside [0,1], so one function decides what a valid threshold is.
 */
function resolveConfidenceConfig(req: any): { min_confidence?: number; thresholds?: Record<string, number> } {
  const resolved: { min_confidence?: number; thresholds?: Record<string, number> } = {};
  try {
    for (const layer of pseudonymizationLayers(req)) {
      if (typeof layer?.min_confidence === 'number') resolved.min_confidence = layer.min_confidence;
      if (layer?.thresholds && typeof layer.thresholds === 'object') {
        resolved.thresholds = { ...resolved.thresholds, ...layer.thresholds };
      }
    }
  } catch {
    // Fall through to the code defaults, as resolveDefaultEntities does.
  }
  return resolved;
}

/**
 * The two task-3 keys, from the same three layers.
 *
 * `allowlist` is layered by CONCATENATION rather than by replacement, and that is the whole
 * decision: an allow-list is a list of things a deployment has judged safe, so a per-model
 * block adding one entry must not silently discard the global list of twenty. A lower layer
 * can therefore only ever ADD an exemption, never remove one — the same direction
 * `thresholds`' per-category merge goes, and the opposite of `org_suffixes` /
 * `location_gazetteer`, where the last layer replaces outright because those lists define a
 * detector's whole vocabulary.
 *
 * `saturation_warn` is a scalar: the last layer that sets one wins. Not validated here —
 * `resolveSaturationWarn` in saturationReport.ts drops anything that is not an integer of at
 * least 1, so one function decides what a valid bar is.
 */
function resolveReportingConfig(req: any): { allowlist?: AllowlistConfig; saturation_warn?: number; unknown_placeholders?: string } {
  const patterns: string[] = [];
  const terms: string[] = [];
  let saturationWarn: number | undefined;
  // A scalar like saturation_warn: the last layer that sets one wins. Not validated here -
  // resolveUnknownPlaceholderMode turns anything unreadable into `withhold`, never into `off`.
  let unknownPlaceholders: string | undefined;

  try {
    for (const layer of pseudonymizationLayers(req)) {
      const allowlist = layer?.allowlist;
      if (Array.isArray(allowlist?.patterns)) patterns.push(...allowlist.patterns);
      if (Array.isArray(allowlist?.terms)) terms.push(...allowlist.terms);
      if (typeof layer?.saturation_warn === 'number') saturationWarn = layer.saturation_warn;
      if (typeof layer?.unknown_placeholders === 'string') unknownPlaceholders = layer.unknown_placeholders;
    }
  } catch {
    // Fall through to the code defaults, as resolveDefaultEntities does.
  }

  const resolved: { allowlist?: AllowlistConfig; saturation_warn?: number; unknown_placeholders?: string } = {};
  if (patterns.length > 0 || terms.length > 0) resolved.allowlist = { patterns, terms };
  if (saturationWarn !== undefined) resolved.saturation_warn = saturationWarn;
  if (unknownPlaceholders !== undefined) resolved.unknown_placeholders = unknownPlaceholders;
  return resolved;
}

function resolveMaskingLists(req: any, entities: EntityConfig[]): { org_suffixes: string[]; location_gazetteer: string[] } {
  let orgSuffixes = DEFAULT_MASKING_CONFIG.org_suffixes ?? [];
  let gazetteer = DEFAULT_MASKING_CONFIG.location_gazetteer ?? [];

  try {
    for (const layer of pseudonymizationLayers(req)) {
      if (Array.isArray(layer?.org_suffixes)) orgSuffixes = layer.org_suffixes;
      if (Array.isArray(layer?.location_gazetteer)) gazetteer = layer.location_gazetteer;
    }
  } catch {
    // Fall through to the code defaults, as resolveDefaultEntities does.
  }

  const enabled = new Set(entities.filter(e => e.enabled !== false).map(e => e.type));
  if (enabled.has('profile-org') && orgSuffixes.length === 0 && !warnedEmptyProducer.has('profile-org')) {
    warnedEmptyProducer.add('profile-org');
    getDefaultLogger().warn('Pseudonymization',
      "profile-org is enabled but org_suffixes is empty — NOTHING will be masked as an organisation. Populate pseudonymization.org_suffixes in api_config.json.");
  }
  if (enabled.has('profile-location') && gazetteer.length === 0 && !warnedEmptyProducer.has('profile-location')) {
    warnedEmptyProducer.add('profile-location');
    getDefaultLogger().warn('Pseudonymization',
      "profile-location is enabled but location_gazetteer is empty — NOTHING will be masked as a location. Populate pseudonymization.location_gazetteer in api_config.json.");
  }

  return { org_suffixes: orgSuffixes, location_gazetteer: gazetteer };
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

  const entities = resolveDefaultEntities(req);
  return { ...DEFAULT_MASKING_CONFIG, entities, ...resolveMaskingLists(req, entities), ...resolveConfidenceConfig(req), ...resolveReportingConfig(req), method: found };
}

interface ForcedConfigResolution {
  config: MaskingConfig;
  allowBypass: boolean;
  source: 'model' | 'endpoint';
}

/** getModelForcedConfig could not read the configuration, so whether masking is forced is unknown. */
const FORCE_UNDETERMINED = 'undetermined' as const;

/**
 * Check if the model has pseudonymization forced on via api_config.json.
 * Returns the resolved masking config plus the allow_user_bypass flag from
 * the matching block (per-model takes precedence over per-endpoint). Which block forces it is
 * forcedRun.readForceSource, the same answer the controllers use to refuse a forced request the
 * plugin would not run for.
 */
function getModelForcedConfig(req: any): ForcedConfigResolution | typeof FORCE_UNDETERMINED | null {
  try {
    const forcing = readForceSource(req);
    if (!forcing) return null;
    const method = forcing.block.method || 'pseudonymization';
    const allowBypass = forcing.block.allow_user_bypass === true;
    const entities = resolveDefaultEntities(req);
    return { config: { ...DEFAULT_MASKING_CONFIG, entities, ...resolveMaskingLists(req, entities), ...resolveConfidenceConfig(req), ...resolveReportingConfig(req), method }, allowBypass, source: forcing.source };
  } catch {
    // Not "not forced": the plugin only runs because a hook for it is configured on this route,
    // and a configuration that cannot be read cannot vouch that masking is optional here.
    return FORCE_UNDETERMINED;
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

/** Caller-supplied `custom_entities` limits (see C3 in the review findings): a caller
 *  entry reaches the regex engine (customDetector.ts) with no schema validation, so a
 *  malformed one (e.g. `null`, a non-string `pattern`) throws past that detector's own
 *  try/catch. beforeHandler's own outer try/catch keeps that from 500ing the request,
 *  but it aborts the whole masking pass first — so today one bad entry silently disables
 *  pseudonymization for the ENTIRE request (PII goes out unmasked), which is worse than a
 *  clean error. An unbounded count or pattern length is also an unbounded-cost surface. */
const MAX_CUSTOM_ENTITY_PATTERN_LENGTH = 500;
const MAX_CUSTOM_ENTITIES = 50;

/**
 * Validate `masking.custom_entities` at the request boundary: each entry must be a
 * non-null object with a string `pattern` (length <= MAX_CUSTOM_ENTITY_PATTERN_LENGTH)
 * and a `flags` that is either absent or a string; at most MAX_CUSTOM_ENTITIES entries
 * are considered. Invalid entries are dropped and logged, the same way the plugin
 * already handles bad detector/config input elsewhere in this file — never thrown.
 */
function sanitizeCustomEntities(raw: unknown, logger: { warn: (msg: string) => void }): CustomEntity[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  if (raw.length > MAX_CUSTOM_ENTITIES) {
    logger.warn(`[pseudonymization] custom_entities has ${raw.length} entries; only the first ${MAX_CUSTOM_ENTITIES} are considered`);
  }
  const candidates = raw.slice(0, MAX_CUSTOM_ENTITIES);

  const valid: CustomEntity[] = [];
  candidates.forEach((entry, i) => {
    const flags = (entry as any)?.flags;
    const ok =
      entry !== null && typeof entry === 'object' &&
      typeof (entry as any).pattern === 'string' &&
      (entry as any).pattern.length <= MAX_CUSTOM_ENTITY_PATTERN_LENGTH &&
      (flags === undefined || typeof flags === 'string');

    if (ok) {
      valid.push(entry as CustomEntity);
    } else {
      const kind = entry === null ? 'null' : typeof entry;
      logger.warn(`[pseudonymization] Dropping invalid custom_entities[${i}] (expected {pattern: string<=${MAX_CUSTOM_ENTITY_PATTERN_LENGTH}, flags?: string}, got ${kind})`);
    }
  });

  return valid.length > 0 ? valid : undefined;
}

/**
 * The masking config for a forced request whose caller sent its own `masking` config: the forced
 * config, widened by what the caller adds. The caller can add entity categories (its entries with
 * `enabled: false` are ignored, a forced category stays as forced), custom patterns, legal-form
 * suffixes and gazetteer terms. Everything else stays as the configuration forces it: method,
 * allow lists, confidence thresholds and reporting (each could exempt a value from masking), and
 * the placeholder settings (`placeholder`, `replacement_value`, `replacement_strategy`), so a
 * caller can neither pick what a masked value looks like nor ask for a fixed, unrestorable one.
 * A caller that sends no entity list (or an empty one) gets the forced categories.
 * Null when the caller lists entities and disables every one: an attempt to switch masking off.
 */
function widenForcedConfig(forcedConfig: MaskingConfig, caller: any): MaskingConfig | null {
  const listed: any[] = Array.isArray(caller?.entities) ? caller.entities : [];
  const added: EntityConfig[] = listed
    .filter((e: any) => e && typeof e === 'object' && typeof e.type === 'string' && e.enabled !== false)
    .map((e: any) => ({ type: e.type }));
  if (listed.length > 0 && added.length === 0) return null;

  const entities = [...forcedConfig.entities];
  for (const e of added) {
    if (!entities.some((f) => f.type === e.type)) entities.push(e);
  }
  const union = (base: string[] | undefined, extra: unknown): string[] => Array.from(new Set([
    ...(base || []),
    ...(Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string') : []),
  ]));
  // Pattern and flags only; sanitizeCustomEntities validates them as for any caller pattern.
  const customEntities = Array.isArray(caller?.custom_entities)
    ? caller.custom_entities.map((c: any) => (c && typeof c === 'object' ? { pattern: c.pattern, flags: c.flags } : c))
    : caller?.custom_entities;
  return {
    ...forcedConfig,
    entities,
    custom_entities: customEntities,
    org_suffixes: union(forcedConfig.org_suffixes, caller.org_suffixes),
    location_gazetteer: union(forcedConfig.location_gazetteer, caller.location_gazetteer),
  };
}

async function beforeHandler({ req, res, utils }: PluginContext): Promise<{ stop: boolean }> {
  const logger = utils.logger;

  // Forced = the configuration forces masking for this route or model. A request it is forced
  // for is refused when masking cannot be applied, never sent unmasked (failClosed.ts). The flag
  // on the request tells the plugin executor the same should an error escape this handler.
  const resolution = getModelForcedConfig(req);
  if (resolution === FORCE_UNDETERMINED) {
    logger.error('Pseudonymization force flags could not be read from the configuration; request refused');
    refuseUnmasked(res);
    return { stop: true };
  }
  const forced = resolution;
  if (forced) (req as any)[FORCED_FLAG] = true;

  try {
    // Check for explicit masking config in body first
    let maskingConfig = req.body?.masking as MaskingConfig | undefined;

    // Forced, the caller's own config can only widen the forced one, never narrow or disable it.
    if (maskingConfig && forced) {
      const widened = widenForcedConfig(forced.config, maskingConfig);
      if (!widened) {
        logger.error(`Pseudonymization is forced (${forced.source}) but the request's masking config disables every entity it lists; request refused`);
        refuseUnmasked(res);
        return { stop: true };
      }
      maskingConfig = widened;
    }

    // If no explicit config, check for triggerword in message content
    if (!maskingConfig) {
      maskingConfig = scanAndStripTriggerword(req) || undefined;
    }

    // If still no config, check per-model / per-endpoint force flags. Bypass
    // (header / body field) is honored only against forced config — explicit
    // masking and ON triggerwords above represent caller intent and are not
    // overridable.
    if (!maskingConfig) {
      if (forced) {
        const bypass = isBypassRequested(req);
        if (bypass) {
          if (forced.allowBypass) {
            delete (req as any)[FORCED_FLAG];
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
      if (forced) {
        logger.error(`Pseudonymization is forced (${forced.source}) but the masking config has no method or no entities; request refused`);
        refuseUnmasked(res);
        return { stop: true };
      }
      logger.warn('Missing or invalid masking config, skipping pseudonymization');
      return { stop: false };
    }

    // custom_entities is the only field here that reaches a regex engine with no schema
    // validation of its own (customDetector.ts trusts it completely); sanitize it at this
    // request boundary so a malformed entry is dropped and logged, never thrown (C3).
    maskingConfig.custom_entities = sanitizeCustomEntities(maskingConfig.custom_entities, logger);

    logger.info(`Pseudonymization active: method=${maskingConfig.method}, entities=${maskingConfig.entities.length}`);

    // Detection reads a copy: forced, a detector tier that cannot run throws (and the request is
    // refused below) instead of being skipped. The stored config never carries the marker.
    const detectConfig: DetectionConfig = forced ? { ...maskingConfig, [STRICT_DETECTORS]: true } : maskingConfig;

    // Body shapes beyond chat `messages`: Responses (`instructions` + `input`), Gemini
    // (`systemInstruction` + `contents`) and Bedrock Converse / Nova (untyped `{ text }` blocks).
    const responsesBody = isResponsesBody(req.body);
    const geminiBody = isGeminiBody(req.body);
    const converseBody = isConverseBody(req.body);

    // A body the plugin has no extractor for (a Llama/Mistral `prompt`, a Titan `inputText`, …)
    // would pass through unmasked: forced, it is refused instead.
    const unsupported = unsupportedBodyShape(req.body, responsesBody || geminiBody);
    if (unsupported) {
      if (forced) {
        logger.error(`Pseudonymization is forced (${forced.source}) but the ${unsupported}; request refused`);
        refuseUnmasked(res);
        return { stop: true };
      }
      logger.warn(`Pseudonymization cannot mask this request: the ${unsupported}; it continues unmasked`);
    }

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
    // Placeholders the CLIENT sent, read before masking touches the body. The model echoing one of
    // these is not an invention (see unknownPlaceholders.ts), so they are exempt from containment.
    let inboundPlaceholders = new Set<string>();
    try {
      const rawBody = JSON.stringify(req.body);
      inboundPlaceholders = new Set(placeholdersIn(rawBody));
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

    // A model invents placeholders it was never sent - measured at 0.8% of pseudonymized responses
    // and 2.4% of saturated ones, WITH the instruction below that forbids it. Registered on the map
    // so every unmask site (these handlers, the SSE interceptor, the hosted-tool engine's
    // continuation rounds) withholds and reports them the same way.
    const unknownMode = resolveUnknownPlaceholderMode(maskingConfig.unknown_placeholders);
    if (maskingConfig.method === 'pseudonymization' && unknownMode !== 'off') {
      registerContainment(map, {
        inbound: inboundPlaceholders,
        withhold: unknownMode === 'withhold',
        onUnknown: (found) => reportInventedPlaceholders(req, found, unknownMode, logger)
      });
    }

    // Responses API bodies use `instructions` + `input` instead of `system` +
    // `messages`. Without this the /openai/v1/responses route would bypass
    // masking entirely, even though it is force-enabled for this endpoint.
    if (responsesBody) {
      for (const { text, path } of extractResponsesInputTexts(req.body)) {
        if (/^input\.\d+\.arguments$/.test(path)) {
          const r = maskJsonArguments(text, map, detectConfig, maskingConfig);
          allEntities.push(...r.entities);
          maskedInputs.push(r.text);
          setResponsesInputText(req.body, path, r.text);
          continue;
        }
        const detected = detectEntities(text, detectConfig);
        allEntities.push(...detected);
        const masked = replaceEntities(text, detected, map, maskingConfig);
        maskedInputs.push(masked);
        setResponsesInputText(req.body, path, masked);
      }
    }

    // Gemini bodies use `systemInstruction` + `contents` instead of `system` +
    // `messages`. Without this the /google route would bypass masking entirely.
    if (geminiBody) {
      for (const { text, path } of extractGeminiInputTexts(req.body)) {
        const detected = detectEntities(text, detectConfig);
        allEntities.push(...detected);
        const masked = replaceEntities(text, detected, map, maskingConfig);
        maskedInputs.push(masked);
        setGeminiInputText(req.body, path, masked);
      }
      for (const { holder, key } of extractGeminiJsonValues(req.body)) {
        const r = maskJsonValue(holder[key], map, detectConfig);
        allEntities.push(...r.entities);
        holder[key] = r.value;
      }
    }

    // Bedrock Converse (and Nova invoke) bodies: untyped `{ text }` system and content blocks,
    // `toolUse.input` and tool-result `json` masked leaf by leaf.
    if (converseBody) {
      const { texts, json } = extractConverseInputs(req.body);
      for (const { text, path } of texts) {
        const detected = detectEntities(text, detectConfig);
        allEntities.push(...detected);
        const masked = replaceEntities(text, detected, map, maskingConfig);
        maskedInputs.push(masked);
        setConverseInputText(req.body, path, masked);
      }
      for (const { holder, key } of json) {
        const r = maskJsonValue(holder[key], map, detectConfig);
        allEntities.push(...r.entities);
        holder[key] = r.value;
      }
    }

    // Process system messages (Anthropic format)
    if (Array.isArray(req.body.system)) {
      for (let i = 0; i < req.body.system.length; i++) {
        const sysBlock = req.body.system[i];
        if (sysBlock.type === 'text' && typeof sysBlock.text === 'string') {
          const detected = detectEntities(sysBlock.text, detectConfig);
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
        const detected = detectEntities(text, detectConfig);
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
            const r = maskJsonValue(block.input, map, detectConfig);
            if (r.entities.length > 0) {
              allEntities.push(...r.entities);
            }
          } else if (block?.type === 'tool_result' && typeof block.content === 'string') {
            const detected = detectEntities(block.content, detectConfig);
            if (detected.length > 0) {
              allEntities.push(...detected);
              block.content = replaceEntities(block.content, detected, map, maskingConfig);
            }
          }
        }
      }

      // OpenAI Chat assistant turns from earlier rounds carry their tool calls outside
      // `content`, as JSON text in `tool_calls[].function.arguments` (or, in the legacy
      // functions shape, in `function_call.arguments`).
      const calls = [
        ...(Array.isArray(message?.tool_calls) ? message.tool_calls.map((c: any) => c?.function) : []),
        message?.function_call,
      ];
      for (const fn of calls) {
        if (typeof fn?.arguments !== 'string') continue;
        const r = maskJsonArguments(fn.arguments, map, detectConfig, maskingConfig);
        allEntities.push(...r.entities);
        fn.arguments = r.text;
      }
    }

    // Value-consistency propagation: mask every remaining exact occurrence of each
    // detected value across the request, including nodes where no detector fired
    // (e.g. the same secret riding through in an `Authorization: Bearer` header).
    // Prevents the model from seeing the raw value alongside its mask.
    const propagated = propagateMaskedValues(req.body, map);

    // A name a transcript's speaker labels vouched for is masked wherever it stands alone, in every
    // node: "I know Lena, you were going to say", and the model's own later "Lena chaired the
    // meeting". The 12-character floor above does not apply to these - something else has already
    // established that the word is a person's name in THIS request - but everyday words that happen
    // to be names never travel (speakerLabelDetector.ts). Case-sensitive, whole words only.
    const vouchedNames = propagatableNames(allEntities);
    const propagatedNames = vouchedNames.size === 0
      ? 0
      : propagateMaskedValues(req.body, map, { minLength: 1, only: vouchedNames });

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
      if (responsesBody) {
        appendResponsesInstructions(req.body, copyNote);
      } else if (geminiBody) {
        appendGeminiInstructions(req.body, copyNote);
      } else if (converseBody) {
        // A Converse system block is `{ text }`; a `type` field fails Bedrock's validation.
        appendConverseInstructions(req.body, copyNote);
      } else if ((req as any).__endpoint === 'openai' && Array.isArray(req.body.messages)) {
        // OpenAI Chat has no top-level `system` field (a deployment may reject an unknown
        // one), so the note goes into a system message.
        appendOpenAIChatSystemNote(req.body.messages, copyNote);
      } else if (Array.isArray(req.body.system)) {
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

      // Streamed responses only, and only when an enabled sink is opted into content: start
      // accumulating the masked deltas in memory so the usage SIEM event can carry the
      // response half. The after handler below stashes it directly for a non-streaming
      // response; a streamed one is assembled at end of stream instead. Costs nothing when
      // no sink asked for content - see services/siemStreamCapture.ts.
      beginStreamContentCapture(req, res);
    }

    logger.info(`Masked ${allEntities.length} entities (${map.size} unique) across ${messages.length} messages; propagated ${propagated} additional occurrence(s), ${propagatedNames} stand-alone name(s) vouched for by speaker labels`);

    // Saturation REPORT. Runs here, after every text has been masked, and reads only the
    // result: it cannot reach a score, a threshold or a detector, and the entities counted
    // are exactly the ones that were masked. The block is attached whether or not the bar
    // was passed — the counts are cheap and a `saturated: false` event is what makes a rising
    // trend visible — while the WARN line fires only above it, once per request.
    const saturationWarn = resolveSaturationWarn(maskingConfig.saturation_warn);
    const saturation = buildSaturationReport(allEntities, saturationWarn);
    (req as any).__pseudonymizationSaturation = saturation;
    if (saturation.saturated) {
      logger.warn(formatSaturationWarning(saturation, topShapes(allEntities), saturationWarn));
    }

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
    // The message is not logged: a detector error can quote the request text.
    if (forced) {
      logger.error(`Pseudonymization failed while forced (${forced.source}); request refused: ${describeErrorWithoutContent(error)}`);
      refuseUnmasked(res);
      return { stop: true };
    }
    logger.error(`Error in pseudonymization before handler; request continues unmasked: ${describeErrorWithoutContent(error)}`);
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
    logger.debug(`After handler: state found, method=${state.config.method}, entities=${state.entities.length}`);

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
      // Stashed BEFORE unmasking, which is the only moment the response exists in its
      // masked form: one line below it is replaced with the real values for the client.
      // Read by services/siemUsageEvent.ts, and only ever shipped to a sink that opted into
      // content. Deliberately not done on the streaming path above — a streamed response is
      // never one string in this handler, and reassembling one here purely to export it
      // would mean buffering every response in memory whether or not any sink wants it.
      // Every choice of an `n` > 1 response, not only the first.
      (req as any).__siemMaskedResponse = Array.isArray(upstreamResponse?.choices) && upstreamResponse.choices.length > 1
        ? upstreamResponse.choices.map((c: any) => c?.message?.content).filter((t: any) => typeof t === 'string' && t.length > 0).join('\n')
        : responseText;

      const unmasked = unmaskText(responseText, map, containmentOf(map));
      setResponseText(upstreamResponse, unmasked);
      logger.debug(`Unmasked response text (${responseText.length} → ${unmasked.length} chars)`);
    }

    // OpenAI Chat with `n` > 1: the choices after the first (choices[0] is restored above).
    unmaskLaterOpenAIChoices(upstreamResponse, map);

    unmaskToolBlocks(upstreamResponse, map);

    // Responses API output items (message/function_call/reasoning).
    unmaskResponsesOutput(upstreamResponse, (s: string) => unmaskText(s, map, containmentOf(map)));

    // Gemini candidates[].content.parts (text + functionCall.args). Stream frames on
    // /google share this exact shape (no `delta`/`type` field `isStreamingChunk` above
    // recognizes), so a streamed Gemini chunk lands here too — this one site unmasks
    // both the final response and every streamed frame.
    unmaskGeminiOutput(upstreamResponse, (s: string) => unmaskText(s, map, containmentOf(map)));

    // Bedrock Converse / Nova invoke: output.message.content[] (text, toolUse.input, reasoning).
    unmaskConverseOutput(upstreamResponse, (s: string) => unmaskText(s, map, containmentOf(map)));

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
 * Buffer-key prefix → the Responses delta event a flushed remainder is re-emitted
 * as, so a synthetic flush keeps the frame type the client is already parsing.
 */
const RESPONSES_DELTA_TYPE_BY_KEY_PREFIX: Record<string, string> = {
  'responses_text:': 'response.output_text.delta',
  'responses_args:': 'response.function_call_arguments.delta',
  'responses_custom_input:': 'response.custom_tool_call_input.delta',
  'responses_summary:': 'response.reasoning_summary_text.delta',
  'responses_refusal:': 'response.refusal.delta',
};

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
      const id = (req as any)?.debugRequestId || 'unknown';
      try {
        if (body && typeof body === 'object' && map.reverse.size > 0) {
          const serialized = JSON.stringify(body);
          if (serialized.includes('MASKED_')) {
            // Restored on a parsed copy, never in place (a cache hit may hand over the stored
            // object) and never on the serialized bytes: a restored value containing `"` or `\`
            // would break the JSON. Tool-call arguments are JSON text and restored leaf by leaf.
            const restored = unmaskResponseBody(JSON.parse(serialized), map, containmentOf(map));
            const out = JSON.stringify(restored);
            const left = Array.from(map.reverse.keys()).filter((p) => out.includes(p)).length;
            if (left > 0) {
              // Only a count: the values are what must not be logged.
              logger.error('Pseudonymization', `Non-streaming JSON response body still carries ${left} placeholder(s) of this request after unmasking (an object key?); sent as is (requestId=${id})`);
            }
            body = restored;
            logger.debug('Pseudonymization', `Unmasked non-streaming JSON response body (requestId=${id})`);
          }
        }
      } catch (error: any) {
        logger.error('Pseudonymization', `Could not unmask the non-streaming JSON response body; sent masked (requestId=${id}): ${error?.name || 'Error'}`);
      }
      return originalJson(body);
    };
  }

  const requestId = (req as any)?.debugRequestId || 'unknown';

  const buffers = new Map<string, StreamUnmaskBuffer>();
  // `jsonText` for tool-call argument streams, whose deltas are JSON-text fragments.
  const getBuf = (key: string, jsonText = false): StreamUnmaskBuffer => {
    let b = buffers.get(key);
    if (!b) { b = new StreamUnmaskBuffer(map, containmentOf(map), { jsonText }); buffers.set(key, b); }
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
    try {
      event = JSON.parse(jsonStr);
    } catch {
      // SAP streams a deployed model's native Converse events as single-quoted dicts. Parsed
      // (never evaluated); a rewritten frame goes out as JSON, which the event-stream framing
      // reads as well.
      try { event = parseConverseEventData(jsonStr); } catch { return block; }
      if (!event || typeof event !== 'object') return block;
    }

    // Does this frame carry any placeholder at all? One substring scan on a string
    // already in hand, no regex — the same test `safetyNetUnmask` makes per write, so
    // the per-chunk cost is unchanged. False for the overwhelming majority of frames.
    const carriesPlaceholder = map.reverse.size > 0
      && (jsonStr.includes('MASKED_') || jsonStr.includes('masked-url-'));

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
      // One array push, on the text as it stands BEFORE unmasking - the masked form, which
      // is the only form a SIEM sink may be shipped. Nothing is parsed for this: the JSON is
      // already decoded here for the unmask that follows.
      appendStreamContent(req, 'sse-wire', event.delta.text);
      event.delta.text = buf.append(event.delta.text);
      track(`text:${idx}`, event.delta.text);
      modified = true;
    }

    // Anthropic content_block_delta with input_json_delta (tool call input)
    if (event.type === 'content_block_delta'
        && event.delta?.type === 'input_json_delta'
        && typeof event.delta.partial_json === 'string') {
      const idx = event.index ?? 0;
      const buf = getBuf(`tool_use:${idx}`, true);
      event.delta.partial_json = buf.append(event.delta.partial_json);
      track(`tool_use:${idx}`, event.delta.partial_json);
      modified = true;
    }

    // Bedrock Converse stream (the converse-stream passthrough): assistant text and tool-call
    // input fragments in `contentBlockDelta.delta`, flushed on `contentBlockStop` / `messageStop`.
    const converseDelta = event?.contentBlockDelta;
    if (converseDelta && typeof converseDelta === 'object') {
      const idx = converseDelta.contentBlockIndex ?? event.contentBlockIndex ?? 0;
      if (typeof converseDelta.delta?.text === 'string') {
        const key = `converse_text:${idx}`;
        appendStreamContent(req, 'sse-wire', converseDelta.delta.text);
        converseDelta.delta.text = getBuf(key).append(converseDelta.delta.text);
        track(key, converseDelta.delta.text);
        modified = true;
      }
      if (typeof converseDelta.delta?.toolUse?.input === 'string') {
        const key = `converse_tool:${idx}`;
        converseDelta.delta.toolUse.input = getBuf(key, true).append(converseDelta.delta.toolUse.input);
        track(key, converseDelta.delta.toolUse.input);
        modified = true;
      }
    }
    // Emit a Converse block's retained remainder as a synthetic contentBlockDelta before the
    // current frame, then audit the block.
    const flushConverseBlock = (idx: number): void => {
      for (const [prefix, toDelta] of [
        ['converse_text:', (r: string) => ({ text: r })],
        ['converse_tool:', (r: string) => ({ toolUse: { input: r } })],
      ] as Array<[string, (r: string) => any]>) {
        const key = `${prefix}${idx}`;
        const buf = buffers.get(key);
        if (!buf) continue;
        const remainder = buf.flush();
        if (remainder) {
          const frame = { contentBlockDelta: { contentBlockIndex: idx, delta: toDelta(remainder) } };
          syntheticPrefix += `${eventName ? 'event: contentBlockDelta\n' : ''}data: ${JSON.stringify(frame)}\n\n`;
          track(key, remainder);
        }
        buffers.delete(key);
        auditBlock(key);
      }
    };
    if (event?.contentBlockStop && typeof event.contentBlockStop === 'object') {
      flushConverseBlock(event.contentBlockStop.contentBlockIndex ?? event.contentBlockIndex ?? 0);
    }
    if (event?.messageStop !== undefined) {
      const open = new Set<number>();
      for (const key of Array.from(buffers.keys())) {
        if (key.startsWith('converse_')) open.add(parseInt(key.split(':')[1], 10) || 0);
      }
      for (const idx of open) flushConverseBlock(idx);
    }

    // OpenAI Responses API deltas. Frames are bare `data: {json}` with the type
    // inside the JSON; both delta events carry a `delta` string. Tool-argument
    // deltas are JSON fragments, so a placeholder can split mid-token.
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      const key = `responses_text:${event.output_index ?? 0}`;
      // Same capture as the Anthropic text_delta above: assistant prose, still masked.
      appendStreamContent(req, 'sse-wire', event.delta);
      event.delta = getBuf(key).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      const key = `responses_args:${event.output_index ?? 0}`;
      event.delta = getBuf(key, true).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    // Codex's freeform custom-tool mechanism. After responsesCustomToolsPlugin
    // converts the function-call frames, THIS is the event carrying the model's
    // generated payload — without buffering it a placeholder split across two
    // frames reaches the client masked.
    if (event.type === 'response.custom_tool_call_input.delta' && typeof event.delta === 'string') {
      const key = `responses_custom_input:${event.output_index ?? 0}`;
      event.delta = getBuf(key).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    // Reasoning summaries and refusals stream through the same `delta` string
    // shape. Without buffering them a placeholder split across two frames reaches
    // the client masked (visibly, in Codex's reasoning pane).
    if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      const key = `responses_summary:${event.output_index ?? 0}`;
      event.delta = getBuf(key).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    if (event.type === 'response.refusal.delta' && typeof event.delta === 'string') {
      const key = `responses_refusal:${event.output_index ?? 0}`;
      event.delta = getBuf(key).append(event.delta);
      track(key, event.delta);
      modified = true;
    }
    // Flush a single Responses buffer by key: emit its retained remainder as a
    // synthetic delta, track it for the leak audit, then delete and audit the key.
    const flushResponsesKey = (key: string): void => {
      const buf = buffers.get(key);
      if (!buf) return;
      const remainder = buf.flush();
      if (remainder) {
        const deltaType = RESPONSES_DELTA_TYPE_BY_KEY_PREFIX[key.slice(0, key.indexOf(':') + 1)]
          || 'response.output_text.delta';
        const idx = parseInt(key.split(':')[1], 10) || 0;
        syntheticPrefix += `data: ${JSON.stringify({ type: deltaType, output_index: idx, delta: remainder })}\n\n`;
        track(key, remainder);
      }
      buffers.delete(key);
      auditBlock(key);
    };

    // response.output_text.done / response.function_call_arguments.done and
    // response.output_item.done are PER-ITEM terminal events — only the finishing
    // item's own buffer(s) may be flushed. Sweeping every `responses_` buffer here
    // (as opposed to scoping by output_index) would flush a DIFFERENT, still-open
    // item's buffer mid-placeholder, leaking an unresolved masked fragment to the
    // client. Only response.completed is stream-terminal and may sweep everything.
    if (event.type === 'response.output_text.done') {
      flushResponsesKey(`responses_text:${event.output_index ?? 0}`);
    }
    if (event.type === 'response.function_call_arguments.done') {
      flushResponsesKey(`responses_args:${event.output_index ?? 0}`);
    }
    if (event.type === 'response.custom_tool_call_input.done') {
      flushResponsesKey(`responses_custom_input:${event.output_index ?? 0}`);
    }
    if (event.type === 'response.reasoning_summary_text.done') {
      flushResponsesKey(`responses_summary:${event.output_index ?? 0}`);
    }
    if (event.type === 'response.refusal.done') {
      flushResponsesKey(`responses_refusal:${event.output_index ?? 0}`);
    }
    if (event.type === 'response.output_item.done') {
      // Any item kind (message text, function_call, reasoning, refusal) may be
      // the one finishing; only this output_index's own buffers are flushed.
      const idx = event.output_index ?? 0;
      flushResponsesKey(`responses_text:${idx}`);
      flushResponsesKey(`responses_args:${idx}`);
      // A custom_tool_call is one of the item kinds that can finish here, and on a
      // stream that terminates the item with output_item.done alone (no
      // custom_tool_call_input.done) this is the only flush point before the
      // stream-terminal sweep — without it the retained tail is withheld from the
      // delta stream the client accumulates while it finalises the item.
      flushResponsesKey(`responses_custom_input:${idx}`);
      flushResponsesKey(`responses_summary:${idx}`);
      flushResponsesKey(`responses_refusal:${idx}`);
    }
    if (event.type === 'response.completed') {
      for (const key of Array.from(buffers.keys())) {
        if (key.startsWith('responses_')) flushResponsesKey(key);
      }
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
          const buf = getBuf(key, true);
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

    // Gemini stream frames (/google). Text rides on `candidates[i].content.parts[j].text`
    // with no delta wrapper of its own, so a MASKED_* token can straddle two frames
    // exactly as an Anthropic text_delta can — and the catch-all below only ever
    // resolves WHOLE tokens, which is why retention has to happen here, before it.
    // Retention is per candidate index and flushed when that candidate's `finishReason`
    // arrives; a Gemini stream always ends with one (the bridge translator's `finish()`
    // emits a terminal frame even when SAP sent no finish_reason).
    //
    // What this is FOR is the NATIVE pass-through, which has no per-frame plugin chain.
    // On the BRIDGE path frames reach res.write already unmasked, so there is nothing
    // left here to resolve — but the buffer still runs, and it is not inert: an append
    // may retain a prefix-shaped tail (a trailing "M" of "5 PM" could begin MASKED_) and
    // shift it into the NEXT frame. The terminal frame flushes whatever is held, so the
    // text a client reconstructs by concatenating frames is unchanged; only the frame
    // boundaries within it move.
    if (Array.isArray(event?.candidates)) {
      for (const candidate of event.candidates) {
        const key = `gemini_text:${candidate?.index ?? 0}`;
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : null;
        if (parts) {
          for (const part of parts) {
            if (typeof part?.text !== 'string') continue;
            part.text = getBuf(key).append(part.text);
            track(key, part.text);
            modified = true;
          }
        }
        if (!candidate?.finishReason) continue;
        const buf = buffers.get(key);
        if (buf) {
          const remainder = buf.flush();
          // The terminal frame is the LAST one the client parses, so a retained tail has
          // no later frame to ride on and no synthetic Gemini frame to be emitted as —
          // it is appended to this candidate's own text instead.
          //
          // A terminal frame routinely carries NO text of its own: `parts` may be empty,
          // and SAP's native shape omits `content` entirely
          // (`{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{…}}`). Both cases
          // still have to deliver the tail — a retained fragment is real answer text (a
          // trailing "M" from "5 PM" is prefix-shaped enough to be held back) — so the
          // container is materialised rather than treated as "nothing to append to".
          // Dropping it here would truncate the answer silently and hide it from
          // `auditBlock` as well.
          if (remainder) {
            if (parts) {
              const lastText = [...parts].reverse().find((p: any) => typeof p?.text === 'string');
              if (lastText) lastText.text += remainder; else parts.push({ text: remainder });
            } else {
              candidate.content = { role: 'model', parts: [{ text: remainder }] };
            }
            track(key, remainder);
            modified = true;
          }
          buffers.delete(key);
        }
        auditBlock(key);
      }
    }

    // Whatever the handlers above did not reach — most importantly the TERMINAL
    // SNAPSHOT frames, which repeat an item's whole text rather than a delta of it
    // (`response.custom_tool_call_input.done`.input, `response.output_item.done`
    // .item.input, `response.completed`.response.output[]) — is unmasked here, inside
    // the PARSED event, so JSON.stringify re-escapes the substituted value. The
    // byte-level safety net below cannot: rewriting already-serialized bytes drops a
    // value that contains `"`, `\` or a newline (a masked credential, a Windows path)
    // straight into a JSON string literal, and the client cannot parse the frame that
    // carries the tool arguments. That net now only covers blocks that are not JSON
    // at all (the BedrockStreamParser raw-text fallback it was written for).
    //
    // Runs AFTER the delta handlers on purpose: a delta's placeholder must go through
    // its StreamUnmaskBuffer, which owns partial-token retention across frames. By the
    // time this runs, a delta holds only complete-and-already-unmasked text plus any
    // token this request's map cannot resolve, which unmaskResponseBody leaves alone.
    // An `arguments` string (the done / snapshot frames of a function call) is JSON text
    // and is restored leaf by leaf, so it stays valid JSON too.
    if (carriesPlaceholder) {
      // Assigned, not just mutated: a frame whose JSON is a bare string or number is
      // returned by value, and unmaskResponseBody has nothing to mutate in place.
      event = unmaskResponseBody(event, map, containmentOf(map));
      modified = true;
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
  //
  // It still runs over the WHOLE outgoing string, parsed blocks included — the parsed-event
  // unmask in processBlock narrows what is left for it to find, it does not exclude anything
  // from it. Two things genuinely reach the client only through this net: a block that is
  // not JSON at all, and an object KEY carrying a placeholder, which unmaskResponseBody walks
  // past by design (it rewrites values only). For those the byte-level substitution and its
  // JSON-escaping hazard still apply.
  const safetyNetUnmask = (s: string): string => {
    if (map.reverse.size === 0) return s;
    if (!s.includes('MASKED_') && !s.includes('masked-url-')) return s;
    return unmaskText(s, map, containmentOf(map));
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
 * Covers Anthropic native (content[].type==='tool_use'), OpenAI (choices[].message.tool_calls[]
 * and the legacy function_call), and SAP orchestration V2 wrapper (final_result.choices[]).
 */
function unmaskToolBlocks(response: any, map: ReplacementMap): void {
  if (!response || typeof response !== 'object') return;

  // Anthropic native: content[].type === 'tool_use', input is arbitrary JSON
  if (Array.isArray(response.content)) {
    for (const block of response.content) {
      if (block?.type === 'tool_use' && block.input) {
        unmaskJsonValue(block.input, map, containmentOf(map));
      }
    }
  }

  // OpenAI: choices[].message.tool_calls[].function.arguments (JSON string) and the legacy
  // choices[].message.function_call.arguments, in every choice (a request with `n` > 1 has
  // several); the same for the SAP orchestration V2 wrapper (final_result.choices[]).
  const choices = [
    ...(Array.isArray(response?.choices) ? response.choices : []),
    ...(Array.isArray(response?.final_result?.choices) ? response.final_result.choices : []),
  ];
  for (const choice of choices) {
    const message = choice?.message;
    const calls = [
      ...(Array.isArray(message?.tool_calls) ? message.tool_calls.map((c: any) => c?.function) : []),
      message?.function_call,
    ];
    for (const fn of calls) {
      if (typeof fn?.arguments === 'string') {
        fn.arguments = unmaskJsonArguments(fn.arguments, map, containmentOf(map));
      }
    }
  }
}

/**
 * Unmask `message.content` of choices[1..] of an OpenAI chat.completion. choices[0] goes
 * through extractResponseText/setResponseText like every other shape; only a request with
 * `n` > 1 has more.
 */
function unmaskLaterOpenAIChoices(response: any, map: ReplacementMap): void {
  if (!Array.isArray(response?.choices)) return;
  for (let i = 1; i < response.choices.length; i++) {
    const message = response.choices[i]?.message;
    if (typeof message?.content === 'string' && message.content.length > 0) {
      message.content = unmaskText(message.content, map, containmentOf(map));
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
    (req as any).__streamBuffer = new StreamUnmaskBuffer(map, containmentOf(map));
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
    if (!b) { b = new StreamUnmaskBuffer(map, containmentOf(map), { jsonText: true }); toolBuffers.set(key, b); }
    return b;
  };

  // ─── Text deltas (existing behavior) ────────────────────────────────────
  const deltaText = extractResponseText(chunk);
  if (deltaText) {
    // The masked delta, captured before the unmask buffer sees it. This site runs upstream of
    // the res.write interceptor and therefore wins the capture's source lock, which is what
    // keeps the same text from also being appended in its unmasked form at the wire.
    appendStreamContent(req, 'after-chain', deltaText);

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

  // ─── OpenAI finish chunk without text ───────────────────────────────────
  // Azure OpenAI deployments send the finish reason in a chunk of its own with an empty delta
  // (captured live 2026-11-08). Release what the buffers still hold there: text that only looked
  // like the start of a placeholder ("… 10 AM") and argument tails, or they were never written.
  const oaiChoice = chunk?.choices?.[0];
  // A finish chunk carrying tool calls already flushed those calls above; the others and the text
  // are released here as well.
  if (oaiChoice?.finish_reason) {
    const textRest = deltaText ? '' : buffer.flush();
    if (textRest) oaiChoice.delta = { ...(oaiChoice.delta || {}), content: (oaiChoice.delta?.content || '') + textRest };
    for (const [key, buf] of [...toolBuffers.entries()]) {
      if (!key.startsWith('oai_tool_call:')) continue;
      const argsRest = buf.flush();
      toolBuffers.delete(key);
      if (!argsRest) continue;
      oaiChoice.delta = oaiChoice.delta || {};
      oaiChoice.delta.tool_calls = [...(oaiChoice.delta.tool_calls || []), { index: Number(key.slice('oai_tool_call:'.length)), function: { arguments: argsRest } }];
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

/**
 * Detection for a placeholder the model invented: one grep-stable counter line and one security
 * event per distinct placeholder per request. The ids are random and name nobody, so logging them
 * is safe and is what lets an operator find the artifact they ended up in.
 */
function reportInventedPlaceholders(req: any, found: string[], mode: UnknownPlaceholderMode, logger: any): void {
  try {
    const seen: Set<string> = (req.__pseudoInventedPlaceholders ??= new Set<string>());
    const fresh = found.filter((p) => !seen.has(p));
    if (fresh.length === 0) return;
    for (const p of fresh) seen.add(p);

    const byType: Record<string, number> = {};
    for (const p of fresh) {
      const type = p.match(/^(MASKED_[A-Z_]+?)_[0-9a-f]+$/)?.[1] || 'MASKED_URL';
      byType[type] = (byType[type] || 0) + 1;
    }
    const action = mode === 'withhold' ? 'withheld' : 'reported';
    const requestId = req?.debugRequestId || 'unknown';
    const byTypeStr = Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(',');
    logger.warn(`pseudonymization_invented_placeholder_total=${fresh.length} by_type=${byTypeStr} action=${action} placeholders=${fresh.join(',')} requestId=${requestId}`);

    const data = req?.unifiedAuth?.data ?? {};
    Promise.resolve(securityEventEmitter.emitInventedPlaceholder({
      credentialId: data.keyId ?? data.credentialId ?? 'unknown',
      authType: req?.unifiedAuth?.authType ?? 'api_key',
      placeholders: fresh,
      action,
      model: typeof req?.body?.model === 'string' ? req.body.model : undefined,
      userAgent: typeof req?.get === 'function' ? req.get('user-agent') : undefined,
      endpoint: redactUrl(req?.originalUrl),
      method: req?.method,
      requestId
    })).catch(() => undefined);
  } catch { /* detection must never break a response */ }
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
      // Reached only with `unknown_placeholders: off|report`, or for a token the client itself sent:
      // an invented one is otherwise withheld before this audit runs. The old wording blamed "an
      // earlier session"; measured, most of these are invented by the model in THIS response.
      logger.warn('Pseudonymization', `Unresolvable masked token in response: ${token} is not in this request's map — either the client sent it, or the model invented it (requestId=${requestId})`);
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
