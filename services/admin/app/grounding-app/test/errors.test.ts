import { readFileSync } from 'fs';
import { join } from 'path';
import { errorMessage } from '../webapp/model/errors';
import { errorOf } from '../webapp/model/api';

const error = (code: string, message = 'Gateway text.') => ({ status: 400, code, message });

describe('errorMessage', () => {
  it.each([
    ['grounding_admin_required', 'Only administrators can do this.'],
    ['not_found', 'The item no longer exists. It may have been deleted or changed in the meantime.'],
    ['vector_store_not_found', 'The vector store no longer exists or is no longer shared with you.'],
    ['file_not_found', 'The file no longer exists. It may have been deleted in the meantime.'],
    ['concurrent_modification', 'Another change to the same data was in progress. Please try again.'],
    ['retry_conflict', 'The files are being processed right now. Please try again shortly.'],
    ['job_running', 'The job is still running. Retry once it has finished.'],
    ['file_in_use', 'The file is used by a vector store you do not own, so it cannot be deleted.'],
    ['store_expired', 'The vector store has expired; it can no longer be retried or re-embedded.'],
    ['store_dimension_mismatch', 'The configured embedding model uses another dimension. This vector store cannot be re-embedded in place; an operator has to migrate it.'],
    ['store_current', 'The vector store already uses the configured embedding model.'],
    ['reembed_running', 'A re-embed of this vector store is already running.'],
    ['nothing_to_reembed', 'No outdated vector store can be re-embedded right now.'],
    ['store_model_unavailable', 'The vector store uses an embedding model that is no longer available. Re-embed it to restore search.'],
    ['nothing_to_retry', 'No failed file is left to retry.'],
    ['file_search_unavailable', 'Grounding is not available right now.'],
    ['authentication_required', 'Your sign-in could not be confirmed. Reload the page and try again.'],
    ['migration_running', 'A blob migration is already running. Wait for it to finish or cancel it first.'],
    ['target_unavailable', 'The target storage is not configured or not reachable. Run the S3 connection test.'],
    ['superseded', 'A newer blob migration was started since. Start a new migration instead of retrying this one.'],
    ['invalid_target', 'The server did not accept a value of the request, such as a filter. Check it and try again.'],
    ['quota_exceeded', 'Your usage quota is used up. New processing and searches can start again once the quota period resets; work already started continues.'],
  ])('maps the gateway code %s to the cockpit text', (code, text) => {
    expect(errorMessage(error(code))).toBe(text);
  });

  it.each(['invalid_parameter', 'invalid_limit', 'invalid_status', 'invalid_shared', 'invalid_embedding_state', 'invalid_state', 'invalid_file_ids', 'unsupported_parameter'])(
    'maps the input refusal %s to one text', (code) => {
      expect(errorMessage(error(code))).toBe('The server did not accept a value of the request, such as a filter. Check it and try again.');
    });

  it('reads the code of the gateway\'s quota refusal (a 429 with type and code) through errorOf', () => {
    const refusal = errorOf(429, { error: { type: 'quota_exceeded', code: 'quota_exceeded', message: 'Gateway text.', window: 'day', resets_at: '2026-10-13T00:00:00.000Z' } });
    expect(refusal).toEqual({ status: 429, code: 'quota_exceeded', message: 'Gateway text.', resetsAt: '2026-10-13T00:00:00.000Z' });
    expect(errorMessage(refusal)).toMatch(/^Your usage quota is used up\./);
  });

  it('names when the quota resets, as a UTC date and time in the cockpit language', () => {
    const refusal = errorOf(429, { error: { code: 'quota_exceeded', message: 'Gateway text.', resets_at: '2026-10-14T00:00:00.000Z' } });
    expect(errorMessage(refusal)).toBe('Your usage quota is used up. New processing and searches can start again once the quota period resets on Oct 14, 2026, 12:00 AM (UTC); work already started continues.');
    const t = jest.fn((key: string, args?: (string | number)[]) => `[${key}|${(args || []).join(',')}]`);
    expect(errorMessage(refusal, t, 'de-DE')).toBe('[errQuotaExceededResetsAt|14.10.2026, 00:00]');
  });

  it('falls back to the wording without a time when resets_at is absent or not a date', () => {
    const plain = 'Your usage quota is used up. New processing and searches can start again once the quota period resets; work already started continues.';
    expect(errorOf(429, { error: { code: 'quota_exceeded', message: 'm' } })).not.toHaveProperty('resetsAt');
    expect(errorMessage(errorOf(429, { error: { code: 'quota_exceeded', message: 'm' } }))).toBe(plain);
    expect(errorMessage(errorOf(429, { error: { code: 'quota_exceeded', message: 'm', resets_at: 'soon' } }))).toBe(plain);
    expect(errorMessage(errorOf(429, { error: { code: 'quota_exceeded', message: 'm', resets_at: 42 } }))).toBe(plain);
  });

  it('keeps the English default of the reset text byte-identical to the bundle', () => {
    const bundle = readFileSync(join(__dirname, '..', 'webapp', 'i18n', 'i18n.properties'), 'utf8');
    expect(bundle).toContain('\nerrQuotaExceededResetsAt=Your usage quota is used up. New processing and searches can start again once the quota period resets on {0} (UTC); work already started continues.\n');
  });

  it('keeps the server\'s message for a code it does not know', () => {
    expect(errorMessage(error('embedding_dimension_mismatch', 'The dimensions differ.'))).toBe('The dimensions differ.');
    expect(errorMessage(error('toString', 'Inherited names are not codes.'))).toBe('Inherited names are not codes.');
  });

  it('resolves the text through the injected translator', () => {
    const t = jest.fn((key: string) => `[${key}]`);
    expect(errorMessage(error('retry_conflict'), t)).toBe('[errRetryConflict]');
    expect(t).toHaveBeenCalledWith('errRetryConflict');
  });
});
