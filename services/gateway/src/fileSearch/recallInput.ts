// Recall's checks of its own input: the query text, the query vectors and the vector arms
// (split out of repository.ts).
import { RecallInputError } from './recallErrors';
import type { VectorArm } from './recallTypes';

// Same rationale and construction as filterCompiler.ts's own NUL_BYTE guard:
// a NUL byte is valid JSON/JS inside a string but Postgres's text encoding
// cannot represent it (`[22021] invalid byte sequence for encoding "UTF8":
// 0x00`). `opts.queryText` is bound straight into the full-text query
// (recall.ts) with no other validation between the HTTP body and this parameter —
// unlike the attribute filter (compiled, and NUL-checked, by
// filterCompiler.ts), nothing upstream of this module ever rejected it.
// Left unchecked this reaches Postgres as a raw, unhandled exception —
// verified live: `POST /vector_stores/{id}/search {"query":"a<NUL>b"}`
// against the default configuration (hybrid.lexicalEnabled: true) 500s with
// the driver's own message in the response body. Checked here, up front,
// so it becomes a clean 400 regardless of whether hybrid.lexicalEnabled
// ends up including queryText in the query at all.
const NUL_BYTE = String.fromCharCode(0);

export function assertQueryTextIsSafe(queryText: string): void {
  if (queryText.includes(NUL_BYTE)) {
    throw new RecallInputError('queryText must not contain a NUL byte');
  }
}

export function toVectorLiteral(embedding: number[], expectedDim: number): string {
  if (!Array.isArray(embedding) || embedding.length !== expectedDim) {
    throw new RecallInputError(
      `queryEmbedding must have length ${expectedDim} (the configured embeddingDimensions), got ${
        Array.isArray(embedding) ? embedding.length : typeof embedding
      }`
    );
  }
  for (const value of embedding) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RecallInputError('queryEmbedding must contain only finite numbers');
    }
  }
  // pgvector's text input format: '[v1,v2,...]', bound as a plain string
  // parameter and cast with `::vector` in the SQL — never string-templated
  // into the query itself.
  return `[${embedding.join(',')}]`;
}

/** The vector arms must partition the requested stores: every requested store in
 *  exactly one arm and no store that was not requested. Anything else is a caller bug
 *  that would search a store with another model's vector, or not at all. */
export function assertArmsCoverStores(storeIds: string[], arms: VectorArm[]): void {
  const requested = new Set(storeIds);
  const seen = new Set<string>();
  for (const arm of arms) {
    for (const id of arm.storeIds) {
      if (!requested.has(id) || seen.has(id)) {
        throw new Error('recallCandidates: each requested store must be in exactly one vector arm');
      }
      seen.add(id);
    }
  }
  if (seen.size !== requested.size) {
    throw new Error('recallCandidates: each requested store must be in exactly one vector arm');
  }
}
