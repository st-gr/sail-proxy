import * as crypto from 'crypto';

/** 24 lowercase hex characters — enough entropy (96 bits) to treat collisions as impossible. */
function randomHex24(): string {
  return crypto.randomBytes(12).toString('hex');
}

export function newFileId(): string {
  return `file-${randomHex24()}`;
}

export function newVectorStoreId(): string {
  return `vs_${randomHex24()}`;
}

/** A vector-store *file batch* id. `vsfb_` is OpenAI's own prefix for this
 *  resource, so an id minted here is shape-compatible with an SDK client that
 *  round-trips it. Unguessable, but never treated AS authorization: every
 *  batch query in `batches.ts` is scoped by `store_id` as well as by id. */
export function newBatchId(): string {
  return `vsfb_${randomHex24()}`;
}
