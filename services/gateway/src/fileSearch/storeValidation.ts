// The checks a store and a file's attributes must pass, and the errors they throw (split out of
// repository.ts, which re-exports them).
import { getFileSearchConfig } from '../services/configService';

// ---------------------------------------------------------------------------
// Vector stores and vector-store files (Task 10)
//
// `embedding_model`/`embedding_dim` are pinned on `vector_stores` at creation
// time (see `createStore` in stores.ts) because `vector_store_chunks.embedding` is a
// fixed-width `vector(N)` column set once at schema migration — if the
// configured embedding model changes later without a matching migration,
// every existing store's pinned dimension stops matching the live config,
// and any code path that would create NEW vectors for that store (attaching
// a file, or Task 12's search) must refuse with `assertStoreDimension`
// rather than let a dimension-mismatched INSERT reach pgvector as a raw,
// unexplained 500.
// ---------------------------------------------------------------------------

/** Thrown by `assertStoreDimension` when a store's pinned `embedding_dim`
 *  no longer matches the currently configured embedding model. Callers
 *  should map this to an HTTP 409 — the store is not gone or forbidden,
 *  it is stuck until an operator re-embeds it into a new store. */
export class StoreDimensionMismatchError extends Error {
  readonly status = 409;
  /** The wire `code` every HTTP surface emits for this error. Declared here so the
   *  file_search TOOL's rejection (`hostedTool/engine.ts` reads `error.code` generically,
   *  knowing nothing about this module) and `vectorStoresController`'s
   *  `sendDimensionConflict` cannot drift apart. */
  readonly code = 'embedding_dimension_mismatch';
  constructor(message: string) {
    super(message);
    this.name = 'StoreDimensionMismatchError';
  }
}

/** Thrown by `validateAttributes` for a client-supplied `attributes` (or
 *  `metadata`, which follows the identical OpenAI constraint) object that
 *  violates the shape rules. Callers should map this to an HTTP 400. */
export class AttributeValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AttributeValidationError';
  }
}

const MAX_ATTRIBUTE_KEYS = 16;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 512;

// Same constant, same construction and same reason as filterCompiler.ts's and
// vectorStoresController.ts's: built via fromCharCode so no raw NUL byte lives
// in this source file.
const ATTR_NUL_BYTE = String.fromCharCode(0);

/**
 * OpenAI's metadata/attributes constraint, applied exact-value: at most 16
 * keys, each key at most 64 characters, each value at most 512 characters
 * (the length bound only applies to string values), and only string, number
 * or boolean values — no nested objects or arrays, which is what keeps the
 * attribute filter compiler's job (and its injection-hardening) bounded.
 * `null`/`undefined` is treated as "no attributes", matching an omitted
 * field in the request body — never a validation error.
 *
 * NUL BYTES ARE REJECTED, in keys and in string values alike. Being
 * `JSON.stringify`'d before binding does NOT make them safe, which is what
 * `parseOptionalName`'s comment used to claim: `stringify` does turn a NUL into
 * the six-character escape `\u0000`, and Postgres's `jsonb` then rejects that
 * escape SPECIFICALLY, because `jsonb` stores decoded text and has no way to
 * hold a NUL:
 *   [22P05] unsupported Unicode escape sequence
 * — confirmed live, an unhandled 500 (the driver error carries no `status`) on
 * every one of the four entry points that reach here: create-store `metadata`,
 * modify-store `metadata`, attach-file `attributes` and update-file-attributes
 * `attributes`. `nulByteGuard` does not cover it; that middleware scans only
 * `file_ids` / `file_id` / `vector_store_ids`. Same bug class, and the same
 * fix, as `parseOptionalName`, `filterCompiler`'s key/value guards and
 * `assertQueryTextIsSafe`.
 *
 * The offending key is deliberately NOT interpolated into the message: it is
 * the thing carrying the NUL, and this message is logged.
 */
export function validateAttributes(attributes: unknown): Record<string, string | number | boolean> {
  if (attributes === null || attributes === undefined) return {};
  if (typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new AttributeValidationError('attributes must be an object mapping keys to string, number or boolean values');
  }
  const entries = Object.entries(attributes as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTE_KEYS) {
    throw new AttributeValidationError(`attributes must have at most ${MAX_ATTRIBUTE_KEYS} keys, got ${entries.length}`);
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
      throw new AttributeValidationError(
        `attribute keys must be at most ${MAX_ATTRIBUTE_KEY_LENGTH} characters, got a ${key.length}-character key`);
    }
    if (key.includes(ATTR_NUL_BYTE)) {
      throw new AttributeValidationError('attribute keys must not contain a NUL byte');
    }
    const valueType = typeof value;
    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
      throw new AttributeValidationError(`attribute "${key}" must be a string, number or boolean value`);
    }
    if (valueType === 'string' && (value as string).length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw new AttributeValidationError(
        `attribute "${key}" must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`);
    }
    if (valueType === 'number' && !Number.isFinite(value as number)) {
      throw new AttributeValidationError(`attribute "${key}" must be a finite number`);
    }
    if (valueType === 'string' && (value as string).includes(ATTR_NUL_BYTE)) {
      throw new AttributeValidationError(`attribute "${key}" must not contain a NUL byte`);
    }
    result[key] = value as string | number | boolean;
  }
  return result;
}

/**
 * Refuses to proceed on a store whose pinned `embedding_dim` disagrees with
 * the currently configured embedding model. Only called from code paths
 * that would create NEW vectors for the store (attaching a file here;
 * search in Task 12) — read-only paths (get/list/modify-metadata/delete)
 * don't touch the `vector` column and stay available so a stuck store can
 * still be inspected and removed.
 */
export async function assertStoreDimension(store: { embedding_dim: number }): Promise<void> {
  const currentDim = getFileSearchConfig().embeddingDimensions;
  if (store.embedding_dim !== currentDim) {
    throw new StoreDimensionMismatchError(
      `This vector store was created with a ${store.embedding_dim}-dimensional embedding model, but this ` +
      `deployment is now configured for ${currentDim} dimensions. Embedding columns are fixed-width once ` +
      'created, so this store cannot accept new files until it is recreated under the current configuration.',
    );
  }
}

/**
 * Thrown by `assertStoreNotExpired` for a store whose `status` is
 * `'expired'`. Callers should map this to HTTP 409 — the store still
 * exists, and remains listable/retrievable/deletable (OpenAI's own
 * semantics: an expired store keeps its row and reports `status:
 * "expired"` rather than 404-ing), but per this deployment's chosen
 * semantics `'expired'` is TERMINAL for use: it can no longer accept new
 * files or be searched.
 *
 * This was a deliberate choice between two options (Task 12 review, I4),
 * not the only possible one: the alternative — treating a search or attach
 * as "activity" that revives an expired store back into a live, sweepable
 * one — was rejected because `status` is never cleared off `'expired'` by
 * anything in this codebase, so a revived store would never become
 * sweepable again, and `touchStoreActivity` sliding `expires_at` forward
 * on every subsequent search would make its storage unbounded. Terminal
 * status with no revival keeps the sweeper's reclamation permanent.
 */
export class StoreExpiredError extends Error {
  readonly status = 409;
  /** The wire `code` every HTTP surface emits for this error — same single-definition
   *  reason as `StoreDimensionMismatchError.code`; the peer is
   *  `vectorStoresController`'s `sendStoreExpired`. */
  readonly code = 'vector_store_expired';
  constructor(readonly storeId: string) {
    super(
      `Vector store ${storeId} has expired and no longer accepts new files or searches. ` +
      'It can still be retrieved, listed or deleted.',
    );
    this.name = 'StoreExpiredError';
  }
}

/**
 * Refuses to proceed on a store whose `status` is `'expired'`. Called from
 * the same two code paths as `assertStoreDimension` — attaching a file
 * (`vectorStoresController.createVectorStoreFile`) and search
 * (`search.ts`) — for the same reason: both would otherwise create new
 * activity (new chunks, or a `touchStoreActivity` call sliding `expires_at`
 * forward) on a store the expiry sweeper already reclaimed.
 */
export function assertStoreNotExpired(store: { id: string; status: string }): void {
  if (store.status === 'expired') {
    throw new StoreExpiredError(store.id);
  }
}
