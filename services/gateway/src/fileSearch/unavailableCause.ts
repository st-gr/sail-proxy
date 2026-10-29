/**
 * Why the last file_search migration left the feature unavailable: db.ts's runMigration sets it wherever it
 * fails closed, and a successful migration clears it. A module of its own, without imports, so unavailable.ts
 * reads it without depending on db.ts's state, and suites that replace db.ts still get the real one.
 */
export type UnavailableCause =
  /** file_search.embedding_dimensions is out of the range pgvector can index (schema.sql.ts). */
  | 'embedding_dimensions'
  /** The schema is absent and the runtime role cannot create it: the migration step never ran. */
  | 'schema_not_provisioned'
  /** The schema predates this gateway and lacks a required column, key or table this role cannot add. */
  | 'schema_outdated'
  /** The migration threw (connection, DDL or grant failure); the gateway log names the error. */
  | 'migration_failed';

let cause: UnavailableCause | null = null;

export function setUnavailableCause(next: UnavailableCause | null): void {
  cause = next;
}

export function unavailableCause(): UnavailableCause | null {
  return cause;
}
