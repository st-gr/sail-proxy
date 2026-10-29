/**
 * A vector store's chunking setting in the cockpit's words: its summary, the dialog's input rules, the
 * installation default, the re-chunk estimate as figures and the refusals of a re-chunk. No UI5 imports:
 * these run under jest. The controllers inject the resource bundle and pass the cockpit language as
 * `locale`; jest passes neither.
 */
import type { ApiError, Translator, ChunkingSetting, VisionMode } from './api';
import { errorMessage } from './errors';

export type { ChunkingSetting, VisionMode };

/** The vision modes, in the order the dialog offers them. */
export const VISION_MODES: readonly VisionMode[] = Object.freeze(['off', 'no_text', 'auto', 'all']);

/** What a store without a setting (created before it existed) uses, and the default when none can be read. */
export const LEGACY_CHUNKING: Readonly<ChunkingSetting> = Object.freeze({ type: 'static', max_tokens: 800, overlap_tokens: 400, contextual: false });
export const MIN_MAX_TOKENS = 100;
export const MAX_MAX_TOKENS = 4096;

/** English defaults: each value is byte-identical to the bundle text of its key (a test holds them to it). */
export const CHUNKING_EN_TEXTS: Record<string, string> = {
  chunkingType_static: 'Static',
  chunkingType_structure: 'Structure',
  chunkingSummary: '{0} ({1}/{2})',
  chunkingSummaryContextual: '{0} ({1}/{2}), contextual',
  chunkingSummaryVision: '{0}; vision: {1}',
  chunkingVision_off: 'Off',
  chunkingVision_no_text: 'Pages without text',
  chunkingVision_auto: 'Pages without or with little text, and table pages',
  chunkingVision_all: 'All pages',
  chunkingEstimateVisionCostValue: 'up to {0}',
  chunkingEstimateVisionCostUnits: 'up to {0} capacity units',
  chunkingEstimateVisionCostUnknown: 'Unknown: the vision model {0} has no price. Add a price for {0} in the Model Library.',
  chunkingProblem_max: 'Max tokens must be a whole number from 100 to 4096.',
  chunkingProblem_overlap: 'Overlap tokens must be a whole number from 0 to half of the max tokens ({0}).',
  chunkingProblem_contextual: 'Contextual chunks need the Structure strategy.',
  chunkingUnchanged: 'The vector store already uses this chunking setting.',
  chunkingErrRunning: 'A re-embed or re-chunk of this vector store is already running. Wait for it to finish or cancel it first.',
  chunkingErrModelUnavailable: 'The embedding model of this vector store is no longer available, so its files cannot be embedded again. Re-embed the vector store first.',
  chunkingErrContextModelUnavailable: 'The model that writes chunk contexts is not available, so contexts cannot be written. Ask an administrator to configure an available context model.',
  chunkingErrVisionModelUnavailable: 'Vision transcription is not available: it is switched off on this gateway, or the vision model is not available or cannot read images. Choose Off, or ask an administrator to configure an available vision model.',
  chunkingFillContexts: '{0} chunks of this vector store have no context. Start the re-chunk to write them.',
  chunkingModelUnavailableWarning: 'The embedding model of this vector store was reported as no longer available. The re-chunk will probably be refused; re-embed the vector store first.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = CHUNKING_EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isVisionMode = (value: unknown): value is VisionMode => (VISION_MODES as readonly unknown[]).includes(value);

/** The gateway's own rules: max 100-4096, 0 <= overlap <= max / 2, contextual only with structure, vision absent or a mode. */
export function isChunkingSetting(value: unknown): value is ChunkingSetting {
  if (!isObject(value)) return false;
  const { type, max_tokens: max, overlap_tokens: overlap, contextual, vision } = value;
  if (type !== 'static' && type !== 'structure') return false;
  if (!isWhole(max) || max < MIN_MAX_TOKENS || max > MAX_MAX_TOKENS) return false;
  if (!isWhole(overlap) || overlap < 0 || overlap > max / 2) return false;
  if (typeof contextual !== 'boolean') return false;
  if (vision !== undefined && !isVisionMode(vision)) return false;
  return !contextual || type === 'structure';
}

/** A setting's vision mode: absent is off. */
export function visionOf(setting: ChunkingSetting | null | undefined): VisionMode {
  return setting && isVisionMode(setting.vision) ? setting.vision : 'off';
}

/** `setting` as the gateway answers it: `vision` only when it is not off. */
function normalised(setting: ChunkingSetting): ChunkingSetting {
  const { vision, ...rest } = setting;
  return vision && vision !== 'off' ? { ...rest, vision } : rest;
}

/** A store's setting as stored: null (a store from before the setting) and anything unreadable mean static 800/400. */
export function effectiveChunking(value: unknown): ChunkingSetting {
  return isChunkingSetting(value) ? normalised(value) : { ...LEGACY_CHUNKING };
}

/** The installation default from the /status answer (`chunking`); static 800/400 when the gateway names none. */
export function defaultChunking(status: any): ChunkingSetting {
  return effectiveChunking(status?.chunking);
}

export function sameChunking(a: ChunkingSetting, b: ChunkingSetting): boolean {
  return a.type === b.type && a.max_tokens === b.max_tokens && a.overlap_tokens === b.overlap_tokens && a.contextual === b.contextual
    && visionOf(a) === visionOf(b);
}

/**
 * "Static (800/400)", "Structure (800/0), contextual", "Structure (800/0); vision: Pages without text": max and
 * overlap tokens, and the vision mode when it is not off. Null is static 800/400.
 */
export function chunkingText(value: unknown, t: Translator = defaultTranslate): string {
  const setting = effectiveChunking(value);
  const sizes = t(setting.contextual ? 'chunkingSummaryContextual' : 'chunkingSummary', [t(`chunkingType_${setting.type}`), setting.max_tokens, setting.overlap_tokens]);
  const vision = visionOf(setting);
  return vision === 'off' ? sizes : t('chunkingSummaryVision', [sizes, t(`chunkingVision_${vision}`)]);
}

/** The dialog's fields, bound under /chunking/form: the numbers stay what the user typed until they are checked. */
export interface ChunkingForm {
  type: string;
  maxTokens: number | string;
  overlapTokens: number | string;
  contextual: boolean;
  /** One of VISION_MODES. */
  vision: string;
}

export function toChunkingForm(value: unknown): ChunkingForm {
  const setting = effectiveChunking(value);
  return { type: setting.type, maxTokens: setting.max_tokens, overlapTokens: setting.overlap_tokens, contextual: setting.contextual, vision: visionOf(setting) };
}

const wholeNumber = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
};

/** The overlap field's upper bound for the max tokens typed: half of them, or half of the largest max while max is invalid. */
export function overlapLimit(maxTokens: unknown): number {
  const max = wholeNumber(maxTokens);
  return Math.floor((max !== null && max >= MIN_MAX_TOKENS && max <= MAX_MAX_TOKENS ? max : MAX_MAX_TOKENS) / 2);
}

export type ChunkingProblem = 'max' | 'overlap' | 'contextual';
export type FormResult = { ok: true; setting: ChunkingSetting } | { ok: false; problem: ChunkingProblem; message: string };

/**
 * Checks the fields as the gateway would. A Static strategy never sends contextual (the switch is off and
 * disabled for it), so only a contextual Structure setting can reach the contextual problem.
 */
export function formToSetting(form: ChunkingForm, t: Translator = defaultTranslate): FormResult {
  const type = form.type === 'structure' ? 'structure' : 'static';
  const max = wholeNumber(form.maxTokens);
  if (max === null || max < MIN_MAX_TOKENS || max > MAX_MAX_TOKENS) return { ok: false, problem: 'max', message: t('chunkingProblem_max') };
  const overlap = wholeNumber(form.overlapTokens);
  if (overlap === null || overlap > max / 2) return { ok: false, problem: 'overlap', message: t('chunkingProblem_overlap', [Math.floor(max / 2)]) };
  const contextual = form.contextual === true;
  if (contextual && type !== 'structure') return { ok: false, problem: 'contextual', message: t('chunkingProblem_contextual') };
  // The mode is chosen from a list; anything else (an older form) is off. Kept with both strategies.
  const vision = isVisionMode(form.vision) ? form.vision : 'off';
  return { ok: true, setting: normalised({ type, max_tokens: max, overlap_tokens: overlap, contextual, vision }) };
}

/** The estimate's figures for the dialog, grouped for the locale. Every number is an estimate; the dialog says so. */
export interface ChunkingEstimate {
  files: string;
  currentChunks: string;
  chunks: string;
  embeddingTokens: string;
  /** The target is contextual: the context rows are shown. */
  contextual: boolean;
  contextModel: string;
  contextInputTokens: string;
  contextOutputTokens: string;
  /** The target has a vision mode: the vision rows are shown. */
  vision: boolean;
  visionModel: string;
  visionFiles: string;
  /** "up to" figures: every page of the store's PDFs up to the per-file cap. */
  visionPages: string;
  visionInputTokens: string;
  visionOutputTokens: string;
  /** The vision rows' cost, "up to …" or why it is unknown; filled by the dialog after a price lookup. */
  visionCost: string;
  /** Page images would reach the vision model unmasked while pseudonymization applies: the dialog warns. */
  visionUnmasked: boolean;
  /** The store's embedding model was already found not served: the dialog warns. */
  modelUnavailable: boolean;
  /** The target is the store's setting: nothing to start, unless it fills missing contexts. */
  unchanged: boolean;
  /** Chunks of the store's (contextual) setting without a context, grouped for the locale. */
  missingContexts: string;
  /** The target is the store's own contextual setting and chunks lack their context: a start fills them. */
  fillsContexts: boolean;
  /** A re-embed or re-chunk of the store is running: nothing to start. */
  running: boolean;
  canStart: boolean;
}

const count = (value: unknown, locale: string): string => {
  const number = Number(value);
  return (Number.isFinite(number) && number > 0 ? Math.round(number) : 0).toLocaleString(locale);
};

export function toChunkingEstimate(body: any, locale = 'en-US'): ChunkingEstimate {
  const e = body || {};
  const contextual = e.target?.contextual === true;
  const unchanged = e.unchanged === true;
  const running = typeof e.running_job_id === 'string' && e.running_job_id !== '';
  const missing = Number(e.chunks_without_context);
  const fillsContexts = unchanged && contextual && Number.isFinite(missing) && missing > 0;
  const vision = visionOf(e.target) !== 'off';
  return {
    files: count(e.files, locale),
    currentChunks: count(e.current_chunks, locale),
    chunks: count(e.estimated_chunks, locale),
    embeddingTokens: count(e.estimated_embedding_tokens, locale),
    contextual,
    contextModel: contextual && typeof e.context_model === 'string' ? e.context_model : '',
    contextInputTokens: count(e.estimated_context_input_tokens, locale),
    contextOutputTokens: count(e.estimated_context_output_tokens, locale),
    vision,
    visionModel: vision && typeof e.vision_model === 'string' ? e.vision_model : '',
    visionFiles: count(e.vision_files, locale),
    visionPages: count(e.estimated_vision_pages, locale),
    visionInputTokens: count(e.estimated_vision_input_tokens, locale),
    visionOutputTokens: count(e.estimated_vision_output_tokens, locale),
    visionCost: '',
    visionUnmasked: vision && e.vision_unmasked_warning === true,
    modelUnavailable: e.embedding_model_unavailable === true,
    unchanged,
    missingContexts: count(e.chunks_without_context, locale),
    fillsContexts,
    running,
    canStart: (!unchanged || fillsContexts) && !running
  };
}

/**
 * The vision rows' cost from the admin's price answer (`{ priced, capacity_units, cost, currency }`): "up to" the
 * money figure, else "up to" the capacity units when no capacity-unit price is maintained, else unknown (naming `model`).
 */
export function visionCostText(answer: any, locale = 'en-US', t: Translator = defaultTranslate, model = ''): string {
  const cost = Number(answer?.cost);
  if (answer?.priced === true && answer?.cost !== null && answer?.cost !== undefined && Number.isFinite(cost)) {
    const currency = typeof answer.currency === 'string' && /^[A-Z]{3}$/.test(answer.currency) ? answer.currency : 'USD';
    return t('chunkingEstimateVisionCostValue', [cost.toLocaleString(locale, { style: 'currency', currency, maximumFractionDigits: 4, minimumFractionDigits: 2 })]);
  }
  const units = Number(answer?.capacity_units);
  if (answer?.priced === true && answer?.capacity_units !== null && answer?.capacity_units !== undefined && Number.isFinite(units)) {
    return t('chunkingEstimateVisionCostUnits', [units.toLocaleString(locale, { maximumFractionDigits: 2 })]);
  }
  return t('chunkingEstimateVisionCostUnknown', [model]);
}

/**
 * The vision cost when no call is needed (no vision tokens): zero in the installation's currency when a price
 * answer named it, else a bare "0" (no currency is guessed).
 */
export function zeroVisionCostText(currency: unknown, locale = 'en-US', t: Translator = defaultTranslate): string {
  if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) {
    return visionCostText({ priced: true, cost: 0, currency }, locale, t);
  }
  return t('chunkingEstimateVisionCostValue', ['0']);
}

/** Refusals of a re-chunk in the cockpit's words; any other refusal as errorMessage words it. */
const CHUNKING_TEXT_OF_CODE: Record<string, string> = {
  reembed_running: 'chunkingErrRunning',
  store_model_unavailable: 'chunkingErrModelUnavailable',
  context_model_unavailable: 'chunkingErrContextModelUnavailable',
  vision_model_unavailable: 'chunkingErrVisionModelUnavailable',
  chunking_current: 'chunkingUnchanged'
};

export function chunkingErrorText(error: ApiError, t?: Translator, locale?: string): string {
  const key = Object.prototype.hasOwnProperty.call(CHUNKING_TEXT_OF_CODE, error.code) ? CHUNKING_TEXT_OF_CODE[error.code] : null;
  return key ? (t ?? defaultTranslate)(key) : errorMessage(error, t, locale);
}
