import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { availabilityOf, statusText, statusState, fileErrorText, UNAVAILABLE_REASONS } from '../webapp/model/status';

describe('availabilityOf', () => {
  it('is available with the upload limit when the gateway says so', () => {
    expect(availabilityOf({ ok: true, status: 200, body: { available: true, reason: null, limits: { maxFileBytes: 33554432 } } }))
      .toEqual({ available: true, reason: '', maxFileBytes: 33554432 });
  });
  it.each(['disabled', 'no_database', 'not_migrated', 'embedding_dimensions', 'schema_not_provisioned', 'schema_outdated', 'migration_failed'])('carries the gateway\'s reason %s', (reason) => {
    expect(availabilityOf({ ok: true, status: 200, body: { available: false, reason } }))
      .toEqual({ available: false, reason, maxFileBytes: 0 });
  });
  it('words a reason it does not know as not set up, never as a raw key', () => {
    expect(availabilityOf({ ok: true, status: 200, body: { available: false, reason: 'something_new' } }).reason).toBe('not_migrated');
  });
  it('has a text for every reason in every bundle', () => {
    const dir = join(__dirname, '..', 'webapp', 'i18n');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.properties'))) {
      const bundle = readFileSync(join(dir, file), 'utf8');
      for (const reason of [...UNAVAILABLE_REASONS, 'signed_out', 'unsupported_identity', 'unreachable']) {
        expect([file, new RegExp(`\\nunavailable_${reason}=\\S`).test(bundle)]).toEqual([file, true]);
      }
    }
  });
  it('is signed_out for a 401', () => {
    expect(availabilityOf({ ok: false, status: 401, body: { error: 'authentication_required' } }).reason).toBe('signed_out');
  });
  it('is unsupported_identity for the 400 the admin layer answers for an unusable sign-in e-mail', () => {
    expect(availabilityOf({ ok: false, status: 400, body: { error: 'unsupported_identity', message: 'x' } }))
      .toEqual({ available: false, reason: 'unsupported_identity', maxFileBytes: 0 });
  });
  it.each([[502], [503], [500], [404], [0]])('is unreachable for status %i, so the page explains instead of staying blank', (status) => {
    expect(availabilityOf({ ok: false, status, body: null })).toEqual({ available: false, reason: 'unreachable', maxFileBytes: 0 });
  });
  it('is unreachable for a 200 without a usable body', () => {
    expect(availabilityOf({ ok: true, status: 200, body: null }).reason).toBe('unreachable');
  });
});

describe('status wording', () => {
  it('names every ingestion and store status', () => {
    expect(['in_progress', 'completed', 'failed', 'cancelled', 'expired'].map(statusText))
      .toEqual(['In progress', 'Completed', 'Failed', 'Cancelled', 'Expired']);
    expect(['in_progress', 'completed', 'failed', 'cancelled', 'expired'].map(statusState))
      .toEqual(['Information', 'Success', 'Error', 'Warning', 'Warning']);
  });
  it('shows an unknown status as it is, with no colour', () => {
    expect(statusText('queued')).toBe('queued');
    expect(statusState('queued')).toBe('None');
    expect(statusText(null)).toBe('');
  });
  it('takes the message out of last_error', () => {
    expect(fileErrorText({ message: 'Unsupported file type', name: 'UnsupportedFileTypeError' })).toBe('Unsupported file type');
    expect(fileErrorText(null)).toBe('');
    expect(fileErrorText({})).toBe('');
  });
});
