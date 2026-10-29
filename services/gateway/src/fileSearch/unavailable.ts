/**
 * Why file_search cannot be used, for the cockpit's /status (`reason`) and for every
 * `503 file_search_unavailable` body. The messages are operator-facing and fixed: they name the
 * configuration or the deploy step to fix, never a host, a credential or a database error (those stay
 * in the gateway log).
 */
import { getPool, isFileSearchAvailable } from './db';
import { getFileSearchConfig } from '../services/configService';
import { MAX_EMBEDDING_DIMENSIONS } from './vectorIndex';
import { unavailableCause, type UnavailableCause } from './unavailableCause';

/** `not_migrated`: no migration has recorded a cause yet (the boot has not run it). */
export type UnavailableReason = 'disabled' | 'no_database' | UnavailableCause | 'not_migrated';

/** Why file_search cannot be used, or null when it can. The order is the order an operator fixes it in. */
export function fileSearchUnavailableReason(): UnavailableReason | null {
  if (isFileSearchAvailable()) return null;
  if (!getFileSearchConfig().enabled) return 'disabled';
  if (getPool() === null) return 'no_database';
  return unavailableCause() ?? 'not_migrated';
}

const MIGRATE = 'run the file search migration step for your deployment';

const MESSAGES: Record<UnavailableReason, string> = {
  disabled: 'it is switched off in the configuration.',
  no_database: 'no vector database is configured for this deployment.',
  embedding_dimensions: `the configured embedding dimensions must be a whole number from 1 to ${MAX_EMBEDDING_DIMENSIONS}.`,
  schema_not_provisioned: `its database has not been set up; ${MIGRATE}.`,
  schema_outdated: `its database schema is older than this gateway and could not be upgraded; ${MIGRATE}.`,
  migration_failed: 'its database could not be set up; the gateway log names the cause.',
  not_migrated: 'its database is not set up yet.',
};

/** The 503 body: the OpenAI-shaped error envelope with the reason in words. */
export function unavailableBody(reason: UnavailableReason | null = fileSearchUnavailableReason()): {
  error: { message: string; type: 'file_search_unavailable'; code: 'file_search_unavailable' };
} {
  return {
    error: {
      message: `file_search is unavailable: ${MESSAGES[reason ?? 'not_migrated']}`,
      type: 'file_search_unavailable',
      code: 'file_search_unavailable',
    },
  };
}
