/**
 * The text a refused request shows. The gateway's grounding routes answer English messages; the
 * codes they send are mapped to the cockpit's own texts here, and an unknown code keeps the
 * gateway's message. No UI5 imports: the controllers inject the resource bundle, jest passes none.
 */
import type { ApiError, Translator } from './api';
import { formatUnixSeconds } from './format';

/** English defaults: each value is byte-identical to the bundle text of its key. */
const EN_TEXTS: Record<string, string> = {
  errAdminRequired: 'Only administrators can do this.',
  errNotFound: 'The item no longer exists. It may have been deleted or changed in the meantime.',
  errStoreNotFound: 'The vector store no longer exists or is no longer shared with you.',
  errFileNotFound: 'The file no longer exists. It may have been deleted in the meantime.',
  errConcurrentModification: 'Another change to the same data was in progress. Please try again.',
  errRetryConflict: 'The files are being processed right now. Please try again shortly.',
  errJobRunning: 'The job is still running. Retry once it has finished.',
  errFileInUse: 'The file is used by a vector store you do not own, so it cannot be deleted.',
  errStoreExpired: 'The vector store has expired; it can no longer be retried or re-embedded.',
  embeddingReason_dimension_mismatch: 'The configured embedding model uses another dimension. This vector store cannot be re-embedded in place; an operator has to migrate it.',
  errStoreCurrent: 'The vector store already uses the configured embedding model.',
  errReembedRunning: 'A re-embed of this vector store is already running.',
  errNothingToReembed: 'No outdated vector store can be re-embedded right now.',
  errStoreModelUnavailable: 'The vector store uses an embedding model that is no longer available. Re-embed it to restore search.',
  errNothingToRetry: 'No failed file is left to retry.',
  errInvalidRequest: 'The server did not accept a value of the request, such as a filter. Check it and try again.',
  errTeamAdminRequired: 'Only an administrator of that team can change its shares.',
  errTeamNotFound: 'The team no longer exists.',
  errUnavailable: 'Grounding is not available right now.',
  errSignInRequired: 'Your sign-in could not be confirmed. Reload the page and try again.',
  errMigrationRunning: 'A blob migration is already running. Wait for it to finish or cancel it first.',
  errTargetUnavailable: 'The target storage is not configured or not reachable. Run the S3 connection test.',
  errSuperseded: 'A newer blob migration was started since. Start a new migration instead of retrying this one.',
  errQuotaExceeded: 'Your usage quota is used up. New processing and searches can start again once the quota period resets; work already started continues.',
  errQuotaExceededResetsAt: 'Your usage quota is used up. New processing and searches can start again once the quota period resets on {0} (UTC); work already started continues.'
};
const defaultTranslate: Translator = (key, args) => {
  const pattern = EN_TEXTS[key] ?? key;
  return args ? pattern.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : pattern;
};

/** Every code the gateway's grounding controllers and admin guard answer, by its text's key. */
const TEXT_OF_CODE: Record<string, string> = {
  grounding_admin_required: 'errAdminRequired',
  not_found: 'errNotFound',
  vector_store_not_found: 'errStoreNotFound',
  file_not_found: 'errFileNotFound',
  concurrent_modification: 'errConcurrentModification',
  retry_conflict: 'errRetryConflict',
  job_running: 'errJobRunning',
  file_in_use: 'errFileInUse',
  store_expired: 'errStoreExpired',
  store_dimension_mismatch: 'embeddingReason_dimension_mismatch',
  store_current: 'errStoreCurrent',
  reembed_running: 'errReembedRunning',
  nothing_to_reembed: 'errNothingToReembed',
  store_model_unavailable: 'errStoreModelUnavailable',
  context_model_unavailable: 'chunkingErrContextModelUnavailable',
  nothing_to_retry: 'errNothingToRetry',
  invalid_parameter: 'errInvalidRequest',
  invalid_limit: 'errInvalidRequest',
  invalid_status: 'errInvalidRequest',
  invalid_shared: 'errInvalidRequest',
  invalid_embedding_state: 'errInvalidRequest',
  invalid_state: 'errInvalidRequest',
  invalid_file_ids: 'errInvalidRequest',
  unsupported_parameter: 'errInvalidRequest',
  team_admin_required: 'errTeamAdminRequired',
  invalid_team_id: 'errInvalidRequest',
  team_not_found: 'errTeamNotFound',
  file_search_unavailable: 'errUnavailable',
  authentication_required: 'errSignInRequired',
  invalid_target: 'errInvalidRequest',
  migration_running: 'errMigrationRunning',
  target_unavailable: 'errTargetUnavailable',
  superseded: 'errSuperseded',
  // The payer's quota refused paid work (gateway middlewares/groundingQuota.ts): in every cockpit flow
  // the acting user — the owner of the store they work on, or the searcher.
  quota_exceeded: 'errQuotaExceeded'
};

/** A quota refusal names when the quota resets (UTC, like every cockpit time); without a usable time it does not. */
function quotaText(error: ApiError, t: Translator, locale: string): string {
  const time = error.resetsAt ? Date.parse(error.resetsAt) : NaN;
  const resetsAt = Number.isFinite(time) ? formatUnixSeconds(time / 1000, locale) : '';
  return resetsAt ? t('errQuotaExceededResetsAt', [resetsAt]) : t('errQuotaExceeded');
}

/**
 * The cockpit's text for a refusal's code, or the message the server sent for any other code.
 * `locale` is the cockpit language for a time in the text; jest passes none and gets 'en-US'.
 */
export function errorMessage(error: ApiError, t: Translator = defaultTranslate, locale = 'en-US'): string {
  const textKey = Object.prototype.hasOwnProperty.call(TEXT_OF_CODE, error.code) ? TEXT_OF_CODE[error.code] : null;
  if (textKey === 'errQuotaExceeded') return quotaText(error, t, locale);
  return textKey ? t(textKey) : error.message;
}

/**
 * A refused team share or unshare: the gateway's English text is never shown, so a code without a
 * cockpit text of its own falls back to `genericKey`'s translated text.
 */
export function teamErrorMessage(error: ApiError, genericKey: string, t: Translator = defaultTranslate, locale = 'en-US'): string {
  return Object.prototype.hasOwnProperty.call(TEXT_OF_CODE, error.code) ? errorMessage(error, t, locale) : t(genericKey);
}
