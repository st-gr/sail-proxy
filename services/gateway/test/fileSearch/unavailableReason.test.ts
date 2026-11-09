// W4 Task 5: why file_search is unavailable. The migration records the cause where it fails closed (an
// out-of-range embedding_dimensions, a schema never provisioned, a schema too old to upgrade, a failed
// migration); the cockpit's /status names it, and every 503 file_search_unavailable says it in words that
// name no host, credential or database error.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const state = { enabled: true, pool: true, available: false };
jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  isFileSearchAvailable: () => state.available,
  getPool: () => (state.pool ? {} : null),
}));
jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getFileSearchConfig: () => ({ enabled: state.enabled }),
}));

import { fileSearchUnavailableReason, unavailableBody } from '../../src/fileSearch/unavailable';
import { setUnavailableCause } from '../../src/fileSearch/unavailableCause';

beforeEach(() => {
  Object.assign(state, { enabled: true, pool: true, available: false });
  setUnavailableCause(null);
});

describe('fileSearchUnavailableReason', () => {
  it('is null while file_search is available, whatever cause an earlier boot left', () => {
    setUnavailableCause('migration_failed');
    state.available = true;
    expect(fileSearchUnavailableReason()).toBeNull();
  });

  it('names the cause in the order an operator fixes it: switched off, no database, then the migration\'s cause', () => {
    setUnavailableCause('embedding_dimensions');
    state.enabled = false;
    expect(fileSearchUnavailableReason()).toBe('disabled');
    state.enabled = true;
    state.pool = false;
    expect(fileSearchUnavailableReason()).toBe('no_database');
    state.pool = true;
    expect(fileSearchUnavailableReason()).toBe('embedding_dimensions');
    for (const cause of ['schema_not_provisioned', 'schema_outdated', 'migration_failed'] as const) {
      setUnavailableCause(cause);
      expect(fileSearchUnavailableReason()).toBe(cause);
    }
  });

  it('is not_migrated before a migration recorded anything (the boot has not run it yet)', () => {
    expect(fileSearchUnavailableReason()).toBe('not_migrated');
  });
});

describe('unavailableBody', () => {
  it('keeps the OpenAI-shaped envelope and says the real reason', () => {
    const texts: Record<string, RegExp> = {
      disabled: /switched off/,
      no_database: /no vector database is configured for this deployment/,
      embedding_dimensions: /embedding dimensions .*1 to 4000/,
      schema_not_provisioned: /has not been set up.*migration/,
      schema_outdated: /older than this gateway.*migration/,
      migration_failed: /could not be set up.*gateway log/,
      not_migrated: /not set up yet/,
    };
    for (const [reason, text] of Object.entries(texts)) {
      const body = unavailableBody(reason as any);
      expect(body).toEqual({ error: { message: expect.stringMatching(text), type: 'file_search_unavailable', code: 'file_search_unavailable' } });
      expect(body.error.message).toMatch(/^file_search is unavailable: /);
    }
  });

  it('a failed migration reveals nothing of the error the log carries', () => {
    setUnavailableCause('migration_failed');
    const message = unavailableBody(fileSearchUnavailableReason()).error.message;
    expect(message).not.toMatch(/postgres|password|127\.0\.0\.1|ECONN|42\d\d\d/i);
  });

  it('names no deploy-tool path, environment variable or configuration key', () => {
    for (const reason of ['disabled', 'no_database', 'embedding_dimensions', 'schema_not_provisioned', 'schema_outdated', 'migration_failed', 'not_migrated']) {
      expect(unavailableBody(reason as any).error.message).not.toMatch(/cli-tools|\.js\b|[A-Z]{3,}_[A-Z_]+|file_search\.[a-z_]+/);
    }
  });

  it('answers with the current reason when given none', () => {
    setUnavailableCause('schema_outdated');
    expect(unavailableBody().error.message).toMatch(/older than this gateway/);
  });
});
