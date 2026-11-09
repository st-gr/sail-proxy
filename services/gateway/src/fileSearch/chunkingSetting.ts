// How a file is chunked: the one resolver every path uses (routes, ingestion, re-chunk),
// the store setting's validation, and the OpenAI-shaped strategy a file object reports.
//
// Order: a file's explicit OpenAI `static` strategy (attach / batch / store create)
// > the store's setting (`vector_stores.chunking`) > the installation default
// (`file_search.chunking`, consulted only while a store is being created) > static 800/400.
// The store setting is written when the store is created, so a store never drifts when the
// configuration changes; a store created before the column existed holds NULL, which means
// today's static 800/400.
//
// `vision` (W3) is part of the setting because it decides how a PDF's text is read before it is
// cut: changing it is a re-chunk like any other change. A file's explicit static strategy fixes
// only the sizes (OpenAI semantics), so such a file keeps the store's vision mode.

import { getDefaultLogger } from '@libs/logger';
import {
  ChunkingStrategy,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_MAX_CHUNK_SIZE_TOKENS,
  MAX_CHUNK_SIZE_TOKENS,
  MIN_CHUNK_SIZE_TOKENS,
} from './chunker';
import { FileSearchConfig, getFileSearchConfig } from '../services/configService';
import { VISION_MODES, VisionMode, parseVisionMode, visionModeOf, visionSwitchedOff } from './visionTranscriber';

const logger = getDefaultLogger();

export type ChunkingType = 'static' | 'structure';

/** A store's chunking setting, as stored in `vector_stores.chunking` (jsonb). Sizes follow
 *  OpenAI's static ranges: max_tokens 100–4096, 0 <= overlap_tokens <= max_tokens / 2.
 *  `contextual` (an LLM-written context per chunk) only with `structure`. `vision`: which PDF
 *  pages a vision model transcribes (visionTranscriber.ts), with either type; absent means 'off'
 *  (every setting before W3), and a validated setting carries it only when it is not 'off'. */
export interface ChunkingSetting {
  type: ChunkingType;
  max_tokens: number;
  overlap_tokens: number;
  contextual: boolean;
  vision?: VisionMode;
}

/** `setting` with the vision mode `mode` ('off' leaves the field out). */
function withVision(setting: ChunkingSetting, mode: VisionMode): ChunkingSetting {
  const { vision: _ignored, ...rest } = setting;
  return mode === 'off' ? rest : { ...rest, vision: mode };
}

/** What a NULL store setting means, and the built-in default: today's static 800/400. */
export const LEGACY_CHUNKING: Readonly<ChunkingSetting> = Object.freeze({
  type: 'static',
  max_tokens: DEFAULT_MAX_CHUNK_SIZE_TOKENS,
  overlap_tokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
  contextual: false,
});

/** The `chunking_strategy` request field of OpenAI's attach, batch and store-create calls. */
export type FileChunkingStrategy =
  | { type: 'auto' }
  | { type: 'static'; static: { max_chunk_size_tokens: number; chunk_overlap_tokens: number } };

/** An invalid chunking strategy or setting; routes answer 400 with OpenAI's error shape
 *  (`message`, `type: invalid_request_error`, `param`, `code`). */
export class ChunkingStrategyError extends Error {
  readonly status = 400;
  constructor(message: string, readonly param: string, readonly code: 'invalid_value' | 'invalid_type' | 'missing_required_parameter') {
    super(message);
    this.name = 'ChunkingStrategyError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function requireInteger(value: unknown, param: string): number {
  if (value === undefined) throw new ChunkingStrategyError(`Missing required parameter: '${param}'.`, param, 'missing_required_parameter');
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ChunkingStrategyError(
      `Invalid type for '${param}': expected an integer, but got ${typeName(value)} instead.`, param, 'invalid_type',
    );
  }
  return value;
}

/** Checks the size pair against OpenAI's static ranges; `names` are the two parameter paths. */
function checkSizes(max: number, overlap: number, names: [string, string]): void {
  if (max < MIN_CHUNK_SIZE_TOKENS || max > MAX_CHUNK_SIZE_TOKENS) {
    throw new ChunkingStrategyError(
      `Invalid '${names[0]}': must be between ${MIN_CHUNK_SIZE_TOKENS} and ${MAX_CHUNK_SIZE_TOKENS}, got ${max}.`,
      names[0], 'invalid_value',
    );
  }
  if (overlap < 0 || overlap > max / 2) {
    throw new ChunkingStrategyError(
      `Invalid '${names[1]}': must be between 0 and half of ${names[0].split('.').pop()} (${max / 2}), got ${overlap}.`,
      names[1], 'invalid_value',
    );
  }
}

/** Validates a store chunking setting (`param` prefixes the error paths); returns a clean copy. */
export function validateChunkingSetting(raw: unknown, param = 'chunking'): ChunkingSetting {
  if (!isObject(raw)) {
    throw new ChunkingStrategyError(
      `Invalid type for '${param}': expected an object, but got ${typeName(raw)} instead.`, param, 'invalid_type',
    );
  }
  if (raw.type === undefined) {
    throw new ChunkingStrategyError(`Missing required parameter: '${param}.type'.`, `${param}.type`, 'missing_required_parameter');
  }
  if (raw.type !== 'static' && raw.type !== 'structure') {
    throw new ChunkingStrategyError(
      `Invalid value: '${String(raw.type)}'. Supported values are: 'static' and 'structure'.`, `${param}.type`, 'invalid_value',
    );
  }
  const max = requireInteger(raw.max_tokens, `${param}.max_tokens`);
  const overlap = requireInteger(raw.overlap_tokens, `${param}.overlap_tokens`);
  checkSizes(max, overlap, [`${param}.max_tokens`, `${param}.overlap_tokens`]);
  const contextual = raw.contextual ?? false;
  if (typeof contextual !== 'boolean') {
    throw new ChunkingStrategyError(
      `Invalid type for '${param}.contextual': expected a boolean, but got ${typeName(contextual)} instead.`,
      `${param}.contextual`, 'invalid_type',
    );
  }
  if (contextual && raw.type !== 'structure') {
    throw new ChunkingStrategyError(
      `Invalid '${param}.contextual': contextual chunks need type 'structure'.`, `${param}.contextual`, 'invalid_value',
    );
  }
  const vision = raw.vision ?? 'off';
  if (typeof vision !== 'string') {
    throw new ChunkingStrategyError(
      `Invalid type for '${param}.vision': expected a string, but got ${typeName(vision)} instead.`,
      `${param}.vision`, 'invalid_type',
    );
  }
  if (!(VISION_MODES as readonly string[]).includes(vision)) {
    throw new ChunkingStrategyError(
      `Invalid value: '${vision.slice(0, 40)}'. Supported values are: 'off', 'no_text', 'auto' and 'all'.`,
      `${param}.vision`, 'invalid_value',
    );
  }
  return withVision({ type: raw.type, max_tokens: max, overlap_tokens: overlap, contextual }, vision as VisionMode);
}

/**
 * Validates OpenAI's `chunking_strategy` request field: absent → null, `auto`, or `static` with
 * both size fields in OpenAI's ranges. Any other type is refused (OpenAI has no other request
 * type; `other` is response-only). Returns the normalised value stored on the file row.
 */
export function parseFileChunkingStrategy(raw: unknown): FileChunkingStrategy | null {
  const param = 'chunking_strategy';
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    throw new ChunkingStrategyError(
      `Invalid type for '${param}': expected an object, but got ${typeName(raw)} instead.`, param, 'invalid_type',
    );
  }
  if (raw.type === undefined) {
    throw new ChunkingStrategyError(`Missing required parameter: '${param}.type'.`, `${param}.type`, 'missing_required_parameter');
  }
  if (raw.type === 'auto') return { type: 'auto' };
  if (raw.type !== 'static') {
    throw new ChunkingStrategyError(
      `Invalid value: '${String(raw.type)}'. Supported values are: 'auto' and 'static'.`, `${param}.type`, 'invalid_value',
    );
  }
  if (raw.static === undefined) {
    throw new ChunkingStrategyError(`Missing required parameter: '${param}.static'.`, `${param}.static`, 'missing_required_parameter');
  }
  if (!isObject(raw.static)) {
    throw new ChunkingStrategyError(
      `Invalid type for '${param}.static': expected an object, but got ${typeName(raw.static)} instead.`,
      `${param}.static`, 'invalid_type',
    );
  }
  const names: [string, string] = [`${param}.static.max_chunk_size_tokens`, `${param}.static.chunk_overlap_tokens`];
  const max = requireInteger(raw.static.max_chunk_size_tokens, names[0]);
  const overlap = requireInteger(raw.static.chunk_overlap_tokens, names[1]);
  checkSizes(max, overlap, names);
  return { type: 'static', static: { max_chunk_size_tokens: max, chunk_overlap_tokens: overlap } };
}

/** The invalid `file_search.chunking` values already warned about (bounded: a config is edited rarely). */
const warnedInvalidConfigs = new Set<string>();
const MAX_WARNED_CONFIGS = 32;

/** `file_search.parsing.vision.default_mode`; absent (a configuration before W3) is 'off'. */
function configuredVisionDefault(): unknown {
  try {
    return getFileSearchConfig().parsing?.vision?.defaultMode;
  } catch {
    return 'off';
  }
}

/**
 * The installation default for a new store, from `file_search.chunking` and the vision default
 * `file_search.parsing.vision.default_mode` ('off' unless configured: an upgrade starts no vision
 * calls; an invalid mode is 'off'; always 'off' where FILE_SEARCH_VISION switches vision off, as
 * the npm standalone CLI does). The configuration is not refused for a bad value (a hand-edited
 * file reaches the gateway unvalidated): it falls back to static 800/400 and says so in the log,
 * once per distinct invalid value.
 */
export function installationChunking(
  config: FileSearchConfig['chunking'] = getFileSearchConfig().chunking,
  visionDefault: unknown = configuredVisionDefault(),
): ChunkingSetting {
  const vision = visionSwitchedOff() ? 'off' : parseVisionMode(visionDefault);
  try {
    return validateChunkingSetting({
      type: config.strategy,
      max_tokens: config.maxChunkSizeTokens,
      overlap_tokens: config.chunkOverlapTokens,
      contextual: config.contextual,
      vision,
    }, 'file_search.chunking');
  } catch (error) {
    // Read on every store create and every cockpit status call: one warning per distinct invalid value.
    const key = JSON.stringify(config ?? null);
    if (!warnedInvalidConfigs.has(key)) {
      if (warnedInvalidConfigs.size >= MAX_WARNED_CONFIGS) warnedInvalidConfigs.clear();
      warnedInvalidConfigs.add(key);
      logger.warn('FileSearchChunking', `Ignoring file_search.chunking, using static 800/400: ${(error as Error).message}`);
    }
    return withVision({ ...LEGACY_CHUNKING }, vision);
  }
}

export interface ChunkingLayers {
  /** The file's stored `chunking_strategy` (raw jsonb or a parsed request value). */
  file?: unknown;
  /** The store's `vector_stores.chunking`: NULL = static 800/400; leave out (undefined) only
   *  while the store is being created, so the installation default applies. */
  store?: unknown;
  /** The installation default; consulted only when `store` is undefined. */
  installation?: ChunkingSetting;
}

/**
 * A stored file `static` strategy, read as the pre-W2 worker (chunker.ts `resolveChunkingStrategy`)
 * chunked it: sizes that are numbers within the static ranges are used exactly as stored (a
 * fractional size included — the request boundary refuses those now, old rows may hold them).
 * Anything else — no `static` object, a missing or non-numeric size, a size out of range — is
 * static 800/400, so a stored row always resolves (retries and re-chunks never fail on it).
 */
function storedFileStatic(file: Record<string, unknown>): ChunkingSetting {
  const params = file.static;
  if (isObject(params)) {
    const max = params.max_chunk_size_tokens;
    const overlap = params.chunk_overlap_tokens;
    if (typeof max === 'number' && typeof overlap === 'number'
      && max >= MIN_CHUNK_SIZE_TOKENS && max <= MAX_CHUNK_SIZE_TOKENS && overlap >= 0 && overlap <= max / 2) {
      return { type: 'static', max_tokens: max, overlap_tokens: overlap, contextual: false };
    }
  }
  return { ...LEGACY_CHUNKING };
}

/** The vision mode of the setting a file would get without its own static strategy, read
 *  leniently (an invalid store setting gives its mode only when that mode is valid; never throws). */
function layerVision(layers: ChunkingLayers): VisionMode {
  if (layers.store === null) return 'off';
  if (layers.store !== undefined) return visionModeOf(layers.store);
  return visionModeOf(layers.installation);
}

/**
 * THE effective chunking strategy. A file's stored `static` wins (OpenAI semantics: static,
 * never contextual), read leniently as the pre-W2 worker did (`storedFileStatic`; strict parsing
 * is the request boundary's job, `parseFileChunkingStrategy`), with the store's vision mode (it
 * decides how the file is read, which OpenAI's strategy does not cover); `auto`, none, or a legacy
 * row of another type falls to the store. Only an invalid STORE setting throws
 * (ChunkingStrategyError), and never for a file with its own static strategy.
 */
export function resolveChunking(layers: ChunkingLayers): ChunkingSetting {
  const file = layers.file;
  if (isObject(file) && file.type === 'static') return withVision(storedFileStatic(file), layerVision(layers));
  if (layers.store === null) return { ...LEGACY_CHUNKING };
  if (layers.store !== undefined) return validateChunkingSetting(layers.store);
  return layers.installation ? { ...layers.installation } : { ...LEGACY_CHUNKING };
}

/** The setting a store gets at creation (Q5): the installation default, resolved now. */
export function chunkingForNewStore(): ChunkingSetting {
  return resolveChunking({ installation: installationChunking() });
}

/** A setting's identity: two settings with the same key read, chunk (and contextualise) a file
 *  alike. Ingestion and the re-chunk tell their per-generation chunk sets apart by it. A setting
 *  without vision keeps its pre-W3 key. */
export function chunkingKey(setting: ChunkingSetting): string {
  const base = `${setting.type}:${setting.max_tokens}:${setting.overlap_tokens}:${setting.contextual ? 'contextual' : 'plain'}`;
  const vision = visionModeOf(setting);
  return vision === 'off' ? base : `${base}:vision-${vision}`;
}

/** The static chunker's (chunker.ts `chunkText`) strategy for a `static` setting. */
export function toStaticChunkingStrategy(setting: ChunkingSetting): ChunkingStrategy {
  if (setting.type !== 'static') throw new Error(`a ${setting.type} setting has no static chunking strategy`);
  return { type: 'static', static: { max_chunk_size_tokens: setting.max_tokens, chunk_overlap_tokens: setting.overlap_tokens } };
}

/** The `chunking_strategy` a `vector_store.file` object reports: the resolved static
 *  parameters (as OpenAI reports them), or OpenAI's `{type: 'other'}` for `structure`. */
export function fileChunkingStrategyObject(setting: ChunkingSetting): Record<string, unknown> {
  if (setting.type !== 'static') return { type: 'other' };
  return toStaticChunkingStrategy(setting);
}
