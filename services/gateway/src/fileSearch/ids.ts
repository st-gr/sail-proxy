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

/** A job id. Same `<prefix>` + 24 lowercase hex shape as the schema backfill's
 *  `'job_' || substr(md5(batch_id), 1, 24)`, so a backfilled job and a new one
 *  are indistinguishable to every consumer of the id. */
export function newJobId(): string {
  return `job_${randomHex24()}`;
}

/** An Uploads API upload id. `upload_` is OpenAI's own prefix for this resource. */
export function newUploadId(): string {
  return `upload_${randomHex24()}`;
}

/** An Uploads API part id. `part_` is OpenAI's own prefix for this resource. */
export function newUploadPartId(): string {
  return `part_${randomHex24()}`;
}
