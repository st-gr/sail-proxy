/**
 * Task 6: the `file_search` descriptor's `rewriteTool` and `prepare`.
 *
 * Hermetic half. Everything here that does not need a database lives in this file;
 * the ownership predicate's actual BEHAVIOUR (cross-tenant rejected, shared accepted,
 * unknown and unowned indistinguishable) is pinned against a real Postgres in
 * test/fileSearch/integration/storeAccessGuard.test.ts, because a jest-mocked pool
 * returns whatever rows the test stages regardless of what the SQL says — it cannot
 * fail when the `owner_email` condition is dropped, and a test that cannot fail for
 * the mutation it claims to cover is worse than no test.
 *
 * What this file CAN pin about the predicate is that `assertStoresAccessible` builds
 * its WHERE clause from the same shared `STORE_ACCESS_PREDICATE_SQL` constant
 * `recallCandidates` uses, with `$1`/`$2` bound to the same things — i.e. that there is
 * exactly one ownership rule, not two that agree today.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const poolQuery = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => ({ query: (...a: any[]) => poolQuery(...a) }),
}));

const toolConfig = { enabled: true, maxSearchesPerRequest: 5, maxNumResultsDefault: 10 };
jest.mock('../src/services/configService', () => ({
  __esModule: true,
  default: { getFileSearchToolConfig: () => toolConfig },
  getFileSearchToolConfig: () => toolConfig,
  getFileSearchConfig: () => ({ embeddingDimensions: 3, hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50 } }),
  // The REAL bounds, not test-local stand-ins. The whole point of the descriptor
  // importing them is that there is one definition, so the mock must not invent a
  // second one that could agree with the descriptor while both disagree with config.
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MAX_RESULTS_DEFAULT,
}));

import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';
import { STORE_ACCESS_PREDICATE_SQL } from '../src/fileSearch/repository';
import { MIN_RESULTS_DEFAULT, MAX_RESULTS_DEFAULT } from '../src/services/configService';

const logger: any = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

/** The dimension the mocked `getFileSearchConfig` reports, so a staged row that carries
 *  it is a store whose pin still MATCHES the live configuration. */
const LIVE_DIM = 3;

/** Stage the rows the access query returns: exactly the ids the caller may read, all of
 *  them usable. `status` and `embedding_dim` both matter — the guard mirrors every
 *  pre-condition searchVectorStores enforces, so an expired or dimension-drifted store
 *  is refused as well as an unreadable one. */
function storesReadableBy(ids: string[]): void {
  poolQuery.mockResolvedValue({
    rows: ids.map((id) => ({ id, status: 'completed', embedding_dim: LIVE_DIM })),
  });
}

const ctx = (ownerEmail: string | undefined = 'a@b.com') => ({ ownerEmail, logger });

describe('fileSearchDescriptor.rewriteTool', () => {
  it('rewrites the hosted file_search tool into a function tool with a query parameter', () => {
    const fn: any = fileSearchDescriptor.rewriteTool({ type: 'file_search', vector_store_ids: ['vs_1'] });
    expect(fn.type).toBe('function');
    expect(fn.name).toBe('file_search');
    expect(fn.parameters.properties.query.type).toBe('string');
    expect(fn.parameters.required).toContain('query');
  });

  it('is the shape verified live against the deployment (2026-08-04, gpt-5.3-codex and gpt-5.4)', () => {
    // Pinned as an exact object, not field-by-field: the live probe returned HTTP 200
    // and a `function_call` named file_search for THIS payload. Any field added or
    // removed here is a change the deployment has not been asked about, and this
    // codebase has twice shipped such a change with every mocked test green and the
    // first real request returning 400.
    expect(fileSearchDescriptor.rewriteTool({ type: 'file_search' })).toEqual({
      type: 'function',
      name: 'file_search',
      description: "Search the user's uploaded documents for passages relevant to a query.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for.' } },
        required: ['query'],
      },
    });
  });

  it('does not expose the caller-owned search scope to the model', () => {
    // vector_store_ids / max_num_results / filters / ranking_options are the CALLER's
    // configuration, captured once by prepare(). If they leaked into the function
    // schema the model could widen its own retrieval scope per call.
    const fn: any = fileSearchDescriptor.rewriteTool({
      type: 'file_search',
      vector_store_ids: ['vs_1'],
      max_num_results: 25,
      filters: { type: 'eq', key: 'dept', value: 'legal' },
      ranking_options: { score_threshold: 0.4 },
    });
    expect(Object.keys(fn.parameters.properties)).toEqual(['query']);
    expect(JSON.stringify(fn)).not.toContain('vs_1');
  });

  it('returns a fresh object per call, so a downstream plugin mutating body.tools cannot poison the next request', () => {
    const a: any = fileSearchDescriptor.rewriteTool({ type: 'file_search' });
    const b: any = fileSearchDescriptor.rewriteTool({ type: 'file_search' });
    expect(a).not.toBe(b);
    a.parameters.properties.query.description = 'mutated';
    expect(b.parameters.properties.query.description).toBe('What to search for.');
  });
});

describe('fileSearchDescriptor.prepare', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    toolConfig.maxNumResultsDefault = 10;
  });

  it('rejects an unknown store id with 400 before the turn opens', async () => {
    storesReadableBy([]);                       // 'vs_typo' matches nothing
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_typo'] }, ctx(),
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
  });

  it('rejects an empty vector_store_ids array without even reaching the database', async () => {
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: [] }, ctx(),
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects a missing vector_store_ids the same way as an empty one', async () => {
    await expect(fileSearchDescriptor.prepare({ type: 'file_search' }, ctx()))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: 'vs_1' as any }, ctx(),
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects a request with no caller identity before the turn opens', async () => {
    // An AWS SigV4 request carries no email. `recallCandidates` rejects an empty ownerEmail
    // outright and `execute` refuses to search without one, so admitting this here opens a
    // turn in which EVERY call fails — with a reason the streaming path has no way to
    // surface. Same opens-then-fails-mid-stream shape as the expired-store and
    // dimension-drift cases below, one column over.
    //
    // Deliberately a guard in prepare(), NOT a change to assertStoresAccessible: the
    // primitive admits an undefined owner on purpose (the predicate then matches shared
    // stores only, which is fail-safe) and keeps doing so for every other caller — see its
    // own doc comment, and storeAccessGuard.test.ts, which pins that behaviour against a
    // real database. This is a policy the file_search TOOL makes about its own turn.
    // The context is built INLINE, not via ctx(undefined): that helper takes a DEFAULT
    // parameter, and passing undefined explicitly triggers it, so `ctx(undefined)` quietly
    // yields ownerEmail 'a@b.com' and this test passes against a descriptor with no guard
    // at all. It did exactly that on the first run here.
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_1'] }, { ownerEmail: undefined, logger },
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('rejects an empty-string caller identity the same way as a missing one', async () => {
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_1'] }, ctx(''),
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('checks accessibility with the one shared ownership predicate, binding $1=storeIds and $2=ownerEmail', async () => {
    storesReadableBy(['vs_1']);
    await fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_1'] }, ctx('a@b.com'));

    const [sql, params] = poolQuery.mock.calls[0] as [string, any[]];
    expect(sql).toContain(STORE_ACCESS_PREDICATE_SQL);
    expect(params).toEqual([['vs_1'], 'a@b.com']);
    // The constant itself is the tenant boundary; recallCandidates ANDs the identical
    // string into both of its CTEs. Dropping `owner_email` from it makes every
    // cross-tenant assertion in storeAccessGuard.test.ts fail.
    expect(STORE_ACCESS_PREDICATE_SQL).toBe('(vs.owner_email = $2 OR vs.is_shared = true)');
  });

  it('carries max_num_results, filters and ranking_options through to the prepared config', async () => {
    storesReadableBy(['vs_1']);
    const prepared: any = await fileSearchDescriptor.prepare({
      type: 'file_search',
      vector_store_ids: ['vs_1'],
      max_num_results: 25,
      filters: { type: 'eq', key: 'dept', value: 'legal' },
      ranking_options: { score_threshold: 0.4 },
    }, ctx());
    expect(prepared.storeIds).toEqual(['vs_1']);
    expect(prepared.maxNumResults).toBe(25);
    expect(prepared.filters).toEqual({ type: 'eq', key: 'dept', value: 'legal' });
    expect(prepared.rankingOptions).toEqual({ score_threshold: 0.4 });
  });

  it('defaults max_num_results from config when the caller omits it', async () => {
    storesReadableBy(['vs_1']);
    const prepared: any = await fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_1'] }, ctx());
    expect(prepared.maxNumResults).toBe(10);
  });

  it('reads the default from config per request rather than baking it in', async () => {
    // Kills a "default" implemented as a hardcoded 10: this passes only if the value
    // actually comes from getFileSearchToolConfig() at prepare() time.
    storesReadableBy(['vs_1']);
    toolConfig.maxNumResultsDefault = 7;
    const prepared: any = await fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_1'] }, ctx());
    expect(prepared.maxNumResults).toBe(7);
  });

  it('rejects a max_num_results that would silently return nothing or an unbounded page', async () => {
    // A clamp would serve a request the caller never made; prepare() is the last place
    // the caller can still be told.
    for (const bad of [MIN_RESULTS_DEFAULT - 1, -1, MAX_RESULTS_DEFAULT + 1, 2.5, '10']) {
      storesReadableBy(['vs_1']);
      await expect(fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: ['vs_1'], max_num_results: bad }, ctx(),
      )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
    }
  });

  it('bounds max_num_results by configService\'s own range, not a second copy of it', async () => {
    // Both ends of the range configService clamps `tool.max_num_results_default` into
    // are accepted here. If the descriptor ever reverts to its own literals, this fails
    // the moment the two disagree — which is the entire reason the bound is imported.
    for (const ok of [MIN_RESULTS_DEFAULT, MAX_RESULTS_DEFAULT]) {
      storesReadableBy(['vs_1']);
      const prepared: any = await fileSearchDescriptor.prepare(
        { type: 'file_search', vector_store_ids: ['vs_1'], max_num_results: ok }, ctx());
      expect(prepared.maxNumResults).toBe(ok);
    }
    expect([MIN_RESULTS_DEFAULT, MAX_RESULTS_DEFAULT]).toEqual([1, 50]);
  });

  it('rejects an expired store with 409 before the turn opens, not a 400', async () => {
    // An expired store is a real state of a store the caller demonstrably may read —
    // searchVectorStores throws StoreExpiredError (409) for it, so every call would
    // fail mid-stream with nothing the caller can see if prepare() let it through.
    // Not folded into the 400: it is actionable, and it leaks nothing, since it is
    // only reachable after the ownership check has already passed.
    poolQuery.mockResolvedValue({ rows: [{ id: 'vs_old', status: 'expired', embedding_dim: LIVE_DIM }] });
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_old'] }, ctx(),
    )).rejects.toMatchObject({ status: 409, name: 'StoreExpiredError' });
  });

  it('rejects a dimension-drifted store with 409 before the turn opens, not a 400', async () => {
    // Same argument as the expired case, one column over: searchVectorStores refuses a
    // store whose pinned embedding_dim no longer matches the configured model, in the
    // same per-store loop, so admitting it here would open a turn in which every call
    // fails invisibly.
    poolQuery.mockResolvedValue({ rows: [{ id: 'vs_drifted', status: 'completed', embedding_dim: LIVE_DIM + 1533 }] });
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_drifted'] }, ctx(),
    )).rejects.toMatchObject({ status: 409, name: 'StoreDimensionMismatchError' });
  });

  it('applies the expiry check before the dimension check, exactly as search.ts does', async () => {
    // A store that is BOTH expired and drifted must fail identically here and in
    // searchVectorStores. That only holds if the two assertions run in the same order
    // in both places.
    poolQuery.mockResolvedValue({ rows: [{ id: 'vs_both', status: 'expired', embedding_dim: LIVE_DIM + 1533 }] });
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_both'] }, ctx(),
    )).rejects.toMatchObject({ name: 'StoreExpiredError' });
  });

  it('reports an inaccessible id before an expired one, so the 409 can never become an oracle', async () => {
    // 'vs_gone' is not in the returned rows (unknown or another tenant's); 'vs_old' is
    // readable but expired. The caller must learn about the id it may not read FIRST —
    // a 409 raised before that check would confirm 'vs_old' exists to someone who had
    // not yet proved they may read every id in the request.
    poolQuery.mockResolvedValue({ rows: [{ id: 'vs_old', status: 'expired', embedding_dim: LIVE_DIM }] });
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_gone', 'vs_old'] }, ctx(),
    )).rejects.toMatchObject({ status: 400, code: 'invalid_request_error' });
  });

  it('treats a null max_num_results as omitted', async () => {
    storesReadableBy(['vs_1']);
    const prepared: any = await fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_1'], max_num_results: null }, ctx());
    expect(prepared.maxNumResults).toBe(10);
  });

  it('names the first inaccessible id when only some of the ids are readable', async () => {
    storesReadableBy(['vs_ok']);
    await expect(fileSearchDescriptor.prepare(
      { type: 'file_search', vector_store_ids: ['vs_ok', 'vs_bad'] }, ctx(),
    )).rejects.toThrow('Unknown vector store: vs_bad');
  });

  it('never logs the tool configuration at info level in a form that could carry user content', async () => {
    // prepare() runs before any query exists, so there is nothing user-authored to
    // leak here — this pins that it stays that way if fields are added later.
    storesReadableBy(['vs_1']);
    logger.info.mockClear();
    await fileSearchDescriptor.prepare({
      type: 'file_search',
      vector_store_ids: ['vs_1'],
      filters: { type: 'eq', key: 'patient_name', value: 'Jane Doe' },
    }, ctx());
    const logged = (logger.info.mock.calls as any[][]).map((c) => JSON.stringify(c)).join(' ');
    expect(logged).not.toContain('Jane Doe');
    expect(logged).not.toContain('patient_name');
  });
});

describe('fileSearchDescriptor.maxCallsPerRequest', () => {
  it('exposes the per-request call cap from config', () => {
    toolConfig.maxSearchesPerRequest = 5;
    expect(fileSearchDescriptor.maxCallsPerRequest()).toBe(5);
    toolConfig.maxSearchesPerRequest = 2;
    expect(fileSearchDescriptor.maxCallsPerRequest()).toBe(2);
  });
});

// The call side — parseCall / execute / renderOutput / renderCallItem /
// renderResultMessage — was Task 7 and is pinned by responses-filesearch-execute.test.ts.
// The stubs this file used to assert threw `not implemented` are gone.
