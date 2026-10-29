/**
 * "Re-read files" in the cockpit's words: whether a store has files to read again, the gateway's re-extract estimate
 * as figures, and the refusals of a start. No UI5 imports: these run under jest. The controllers inject the resource
 * bundle and pass the cockpit language as `locale`; jest passes neither.
 */
import type { ApiError, Translator } from './api';
import { errorMessage } from './errors';
import { chunkingText, visionOf } from './chunking';

/** English defaults: each value is byte-identical to the bundle text of its key (a test holds them to it). */
export const REEXTRACT_EN_TEXTS: Record<string, string> = {
  reextractNothing: 'Every file of this vector store was read by the current version; there is nothing to read again.',
  reextractErrSettingInvalid: 'The chunking setting of this vector store is not valid, so its files cannot be chunked again with it. Change the chunking instead.',
  reextractErrVisionModelUnavailable: 'Vision transcription is not available: it is switched off on this gateway, or the vision model is not available or cannot read images. Change the chunking to vision Off, or ask an administrator to configure an available vision model.',
  reextractRetryOnly: '{0} PowerPoint, Excel or Word .doc files that could not be read before are queued again. No other file needs to be read again.',
  chunkingErrRunning: 'A re-embed or re-chunk of this vector store is already running. Wait for it to finish or cancel it first.',
  chunkingErrModelUnavailable: 'The embedding model of this vector store is no longer available, so its files cannot be embedded again. Re-embed the vector store first.',
  chunkingErrContextModelUnavailable: 'The model that writes chunk contexts is not available, so contexts cannot be written. Ask an administrator to configure an available context model.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = REEXTRACT_EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

const positive = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};
const count = (value: unknown, locale: string): string => positive(value).toLocaleString(locale);

/** The store page offers "Re-read files" when the estimate names a file to read again or a failed file to queue again. */
export function reextractOffered(body: any): boolean {
  return positive(body?.files) > 0 || positive(body?.retry_files) > 0;
}

/** The estimate's figures for the dialog, grouped for the locale. */
export interface ReextractEstimate {
  /** The store's chunking setting the files are chunked with again. */
  setting: string;
  files: string;
  keptFiles: string;
  /** PDFs without text that OCR or vision may read now (the dialog says they count at the most pages read). */
  filesWithoutText: string;
  hasFilesWithoutText: boolean;
  ocrAvailable: boolean;
  /** Failed PowerPoint, Excel or Word .doc files the start queues again. */
  retryFiles: string;
  hasRetryFiles: boolean;
  /** Completed files are read again: the cost rows are shown. */
  reads: boolean;
  currentChunks: string;
  chunks: string;
  embeddingTokens: string;
  contextual: boolean;
  contextModel: string;
  contextInputTokens: string;
  contextOutputTokens: string;
  vision: boolean;
  visionModel: string;
  visionFiles: string;
  visionPages: string;
  visionInputTokens: string;
  visionOutputTokens: string;
  /** Filled by the dialog after a price lookup (chunking.ts visionCostText). */
  visionCost: string;
  visionUnmasked: boolean;
  modelUnavailable: boolean;
  /** A re-embed or re-chunk of the store is running: nothing can be read again until it has finished. */
  running: boolean;
  canStart: boolean;
}

export function toReextractEstimate(body: any, locale = 'en-US', t?: Translator): ReextractEstimate {
  const e = body || {};
  const reads = positive(e.files) > 0;
  const retry = positive(e.retry_files) > 0;
  const running = typeof e.running_job_id === 'string' && e.running_job_id !== '';
  const contextual = reads && e.setting?.contextual === true;
  const vision = reads && visionOf(e.setting) !== 'off';
  const settingValid = e.setting !== null && typeof e.setting === 'object';
  return {
    setting: settingValid ? chunkingText(e.setting, t) : '',
    files: count(e.files, locale),
    keptFiles: count(e.kept_files, locale),
    filesWithoutText: count(e.files_without_text, locale),
    hasFilesWithoutText: positive(e.files_without_text) > 0,
    ocrAvailable: e.ocr_available === true,
    retryFiles: count(e.retry_files, locale),
    hasRetryFiles: retry,
    reads,
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
    modelUnavailable: reads && e.embedding_model_unavailable === true,
    running: reads && running,
    // Failed files alone are queued whatever runs; files to read again wait for a running job, and need a valid setting.
    canStart: (reads && !running && settingValid) || (!reads && retry)
  };
}

/** What a start did, as a message: its key, the key's {0}/{1} counts, and whether failed files were left out. */
export interface ReextractOutcome { key: string; args?: number[]; refused: boolean }

/**
 * The message after a start, from the gateway's answer `{ job, retried_files, refused_files }`: the job started,
 * failed files queued, or — nothing started — the file retry refused every failed file. The retry refuses a failed
 * file while a batch of it is still being read (or was cancelled); the message then names how many were left out, so
 * a started job or queued files never hide them (they are not queued for later: the user retries them).
 */
export function reextractOutcome(answer: any): ReextractOutcome {
  const refused = Array.isArray(answer?.refused_files) ? answer.refused_files.length : 0;
  const retried = positive(answer?.retried_files);
  if (answer?.job) return refused > 0 ? { key: 'reextractStartedRetryRefused', args: [refused], refused: true } : { key: 'reextractStarted', refused: false };
  if (retried > 0) return refused > 0 ? { key: 'reextractQueuedRetryRefused', args: [retried, refused], refused: true } : { key: 'reextractQueued', refused: false };
  return { key: 'reextractRetryRefused', refused: true };
}

const REEXTRACT_TEXT_OF_CODE: Record<string, string> = {
  nothing_to_reextract: 'reextractNothing',
  store_chunking_invalid: 'reextractErrSettingInvalid',
  reembed_running: 'chunkingErrRunning',
  store_model_unavailable: 'chunkingErrModelUnavailable',
  context_model_unavailable: 'chunkingErrContextModelUnavailable',
  vision_model_unavailable: 'reextractErrVisionModelUnavailable'
};

/** Refusals of a re-extract in the cockpit's words; any other refusal as errorMessage words it. */
export function reextractErrorText(error: ApiError, t?: Translator, locale?: string): string {
  const key = Object.prototype.hasOwnProperty.call(REEXTRACT_TEXT_OF_CODE, error.code) ? REEXTRACT_TEXT_OF_CODE[error.code] : null;
  return key ? (t ?? defaultTranslate)(key) : errorMessage(error, t, locale);
}
