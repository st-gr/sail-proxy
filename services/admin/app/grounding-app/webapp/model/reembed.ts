/**
 * A store's embedding state (its model against the configured one) and the re-embed estimates, in
 * the cockpit's words. No UI5 imports: these run under jest. The controllers inject the resource
 * bundle and pass the cockpit language as `locale`; jest passes neither.
 */
import type { Translator } from './jobs';
import type { ValueState } from './status';

/** English defaults: each value is byte-identical to the bundle text of its key. */
const EN_TEXTS: Record<string, string> = {
  embeddingState_current: 'Current',
  embeddingState_outdated: 'Outdated',
  embeddingState_dimension_mismatch: 'Dimension mismatch',
  embeddingReason_current: 'The vector store uses the configured embedding model.',
  embeddingReason_outdated: 'The configured embedding model is {0}. Search keeps using {1} until the vector store is re-embedded.',
  embeddingReason_outdatedUnknown: 'The configured embedding model has changed. Search keeps using {0} until the vector store is re-embedded.',
  embeddingReason_dimension_mismatch: 'The configured embedding model uses another dimension. This vector store cannot be re-embedded in place; an operator has to migrate it.',
  reembedSkip_dimension_mismatch: 'Another dimension: an operator has to migrate it',
  reembedSkip_expired: 'Expired',
  reembedSkip_reembed_running: 'A re-embed is already running'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

const STATES = ['current', 'outdated', 'dimension_mismatch'];
const COLOR: Record<string, ValueState> = { current: 'Success', outdated: 'Warning', dimension_mismatch: 'Error' };
const SKIP_REASONS = ['dimension_mismatch', 'expired', 'reembed_running'];

const known = (list: string[], value: unknown): value is string => typeof value === 'string' && list.includes(value);

/** "Current", "Outdated" or "Dimension mismatch"; an unknown state as is, a missing one as ''. */
export function embeddingStateText(state: string | null | undefined, t: Translator = defaultTranslate): string {
  if (!state) return '';
  return known(STATES, state) ? t(`embeddingState_${state}`) : state;
}

export function embeddingStateColor(state: string | null | undefined): ValueState {
  return known(STATES, state) ? COLOR[state] : 'None';
}

/**
 * Why the store is in its state. An outdated store names the configured model and the one search
 * keeps using; when the configured model could not be read, the text says only that it changed.
 */
export function embeddingReasonText(state: string | null | undefined, storeModel: string, configuredModel: string, t: Translator = defaultTranslate): string {
  if (state === 'current') return t('embeddingReason_current');
  if (state === 'dimension_mismatch') return t('embeddingReason_dimension_mismatch');
  if (state !== 'outdated') return '';
  return configuredModel
    ? t('embeddingReason_outdated', [configuredModel, storeModel])
    : t('embeddingReason_outdatedUnknown', [storeModel]);
}

export interface EstimateFigures { stores: string; files: string; chunks: string; tokens: string }

const count = (value: unknown, locale: string): string => {
  const number = Number(value);
  return (Number.isFinite(number) && number > 0 ? Math.round(number) : 0).toLocaleString(locale);
};

/** A store estimate ({files, chunks, estimated_tokens}) or the bulk one (plus stores), grouped for the locale. */
export function estimateFigures(estimate: any, locale = 'en-US'): EstimateFigures {
  const e = estimate || {};
  return { stores: count(e.stores, locale), files: count(e.files, locale), chunks: count(e.chunks, locale), tokens: count(e.estimated_tokens, locale) };
}

export interface SkippedRow { storeId: string; ownerEmail: string; reason: string; reasonText: string }

/** The stores a bulk re-embed leaves out, each with why; an unknown reason is shown as sent. */
export function toSkippedRows(skipped: any[], t: Translator = defaultTranslate): SkippedRow[] {
  return (Array.isArray(skipped) ? skipped : []).map((entry) => {
    const reason = String(entry?.reason || '');
    return {
      storeId: String(entry?.store_id || ''),
      ownerEmail: String(entry?.owner_email || ''),
      reason,
      reasonText: known(SKIP_REASONS, reason) ? t(`reembedSkip_${reason}`) : reason
    };
  });
}

/**
 * The id of the store's newest re-embed job when that job failed, else ''. A failed re-embed leaves
 * the store without `reembed_job_id`, so the store page finds it among the caller's newest jobs.
 */
export function lastFailedReembed(jobs: any[], storeId: string): string {
  const newest = (Array.isArray(jobs) ? jobs : []).find((job) => job && job.kind === 'reembed_store' && job.store_id === storeId);
  return newest && newest.state === 'failed' ? String(newest.id) : '';
}

/**
 * Whether a store page's timed poll reads only the store: while just a re-embed runs (no file ingesting),
 * the files and the state's reason do not change until the switch, which the store object alone shows.
 * Any other load (opening the page, a reload after an action) reads everything.
 */
export function pollsStoreOnly(poll: boolean, row: { reembedding: boolean; inProgressFiles: number }): boolean {
  return poll && row.reembedding && row.inProgressFiles === 0;
}
