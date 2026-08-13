/**
 * FINAL WHOLE-BRANCH REVIEW, CRITICAL #1, second half — what `fileSearchDescriptor.execute`
 * is allowed to log when the search throws.
 *
 * The catch block used to interpolate `error.message` unconditionally, behind a comment
 * asserting it was safe because "every error reachable from `searchVectorStores` was
 * audited". The audit enumerated five SELF-AUTHORED classes and omitted the one class
 * nobody on this project wrote: `pg`'s `DatabaseError`, which `recallCandidates` rethrows
 * and which lands in this very catch. Reproduced live:
 *
 *     pg code    = 22P02
 *     pg message = invalid input syntax for type numeric: "Jane Doe, MRN 4471"
 *     err.status = undefined
 *
 * where the quoted string is the caller's own attribute-filter value. `body.filters` is
 * unvalidated and pseudonymization never walks `tools[]`, so it is unmasked.
 *
 * `filterCompiler` now rejects the filter that produced that particular error (see
 * test/fileSearch/ordinalFilterValue.test.ts), but THIS suite covers the other half of the
 * fix, and it is the half that survives the next unaudited thrower: the message is logged
 * only when the error is an instance of a class this stack authored. Everything else logs
 * the code and the class name alone.
 *
 * WHY BOTH HALVES. Half 1 (reject the filter) fixes the one input we know about. Half 2
 * (gate the log) is what stops the NEXT one. Deleting either leaves a named test red.
 *
 * @see ../src/plugins/fileSearch/descriptor.ts - safeErrorMessage
 * @see responses-filesearch-execute.test.ts - the same harness, the success paths
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const searchSpy = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  // The REAL module with only the entry point replaced, so the error classes `execute`
  // tests with `instanceof` are the real ones. A hand-rolled stand-in would keep passing
  // after a rename.
  const actual = jest.requireActual<any>('../src/fileSearch/search');
  return { ...actual, __esModule: true, searchVectorStores: (...args: any[]) => searchSpy(...args) };
});

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
  MIN_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MIN_RESULTS_DEFAULT,
  MAX_RESULTS_DEFAULT: jest.requireActual<any>('../src/services/configService').MAX_RESULTS_DEFAULT,
}));

import { fileSearchDescriptor } from '../src/plugins/fileSearch/descriptor';
import { SearchStoreNotFoundError, SearchQueryTooLongError } from '../src/fileSearch/search';
import {
  RecallInputError, StoreExpiredError, StoreDimensionMismatchError, recallCandidates,
} from '../src/fileSearch/repository';
import { ParsedCall } from '../src/plugins/hostedTool/descriptor';

const logger: any = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

const PREPARED = { storeIds: ['vs_1'], maxNumResults: 10, filters: undefined, rankingOptions: undefined };

function ctx(over: Record<string, any> = {}): any {
  return {
    ownerEmail: 'owner@example.com',
    replacementMap: undefined,
    isStreaming: false,
    prepared: { ...PREPARED },
    remask: (text: string) => text,
    logger,
    ...over,
  };
}

const call = (query = 'what is the expense deadline'): ParsedCall =>
  ({ callId: 'call_1', rawArguments: JSON.stringify({ query }), args: { query } }) as ParsedCall;

/** Every string this run passed to any level of the logger, concatenated. */
function allLogged(): string {
  return [logger.error, logger.warn, logger.info, logger.debug, logger.trace]
    .flatMap((m: any) => m.mock.calls)
    .map((args: any[]) => args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' '))
    .join('\n');
}

/**
 * The `pg` DatabaseError shape, built exactly as the live reproduction produced it: a
 * bare Error carrying `code`, `name: 'error'` and NO `status`. `pg` does not export
 * DatabaseError in a way this suite can construct cheaply, and what matters to the code
 * under test is precisely that it is NOT an instance of any class this stack authored —
 * which this fixture satisfies for the same reason the real one does.
 */
const CALLER_VALUE = 'Jane Doe, MRN 4471';
function driverError(): any {
  const err: any = new Error(`invalid input syntax for type numeric: "${CALLER_VALUE}"`);
  err.name = 'error';
  err.code = '22P02';
  return err;
}

beforeEach(() => {
  searchSpy.mockReset();
  poolQuery.mockReset();
  for (const m of [logger.error, logger.warn, logger.info, logger.debug, logger.trace]) m.mockClear();
});

describe('execute never logs the message of an error this stack did not author', () => {
  it('drops a pg DatabaseError\'s message — the caller\'s filter value reaches no log line', async () => {
    searchSpy.mockRejectedValue(driverError());

    const result = await fileSearchDescriptor.execute(call(), ctx());

    const logged = allLogged();
    expect(logged).not.toContain(CALLER_VALUE);
    expect(logged).not.toContain('Jane');
    expect(logged).not.toContain('invalid input syntax');
    // Still diagnosable: the class name and this stack's own failure code survive.
    expect(logged).toContain('file_search_unavailable');
    expect(logged).toContain('call_1');
    expect(result.status).toBe('failed');
  });

  it('keeps the caller value off the RESULT too, not only out of the logs', async () => {
    // `failedSearch` stashes a message on `result.error`. `renderOutput` emits only
    // `error.code`, so this was contained — but it is a second live copy of the string,
    // travelling on an object the engine carries into `history`, and the fix removes it
    // rather than relying on every future consumer continuing to read `code` alone.
    searchSpy.mockRejectedValue(driverError());

    const result: any = await fileSearchDescriptor.execute(call(), ctx());

    expect(result.error.code).toBe('file_search_unavailable');
    expect(result.error.message).toBe('file_search failed');
    expect(JSON.stringify(result)).not.toContain(CALLER_VALUE);
  });

  it('is not fooled by a look-alike: a plain Error with a message is still not ours', async () => {
    // `instanceof Error` would match a DatabaseError too, so the gate has to be an
    // explicit class list. Replacing it with `error instanceof Error` fails here.
    searchSpy.mockRejectedValue(new Error(`something about ${CALLER_VALUE}`));

    await fileSearchDescriptor.execute(call(), ctx());

    expect(allLogged()).not.toContain(CALLER_VALUE);
  });

  it('is not fooled by an object merely NAMED like one of ours', async () => {
    // Classification is `instanceof`, never a name string — an attacker-influenced
    // `err.name` must not open the gate.
    searchSpy.mockRejectedValue(Object.assign(new Error(CALLER_VALUE), { name: 'RecallInputError' }));

    await fileSearchDescriptor.execute(call(), ctx());

    expect(allLogged()).not.toContain(CALLER_VALUE);
  });

  it('logs the same way mid-stream — the streaming path is not a second gate', async () => {
    searchSpy.mockRejectedValue(driverError());

    await fileSearchDescriptor.execute(call(), ctx({ isStreaming: true }));

    const logged = allLogged();
    expect(logged).toContain('mid-stream');
    expect(logged).not.toContain(CALLER_VALUE);
  });
});

/**
 * RE-REVIEW BLOCKER 2, end to end.
 *
 * The suite above pins that a message from a NON-allow-listed class is dropped. This one
 * pins the complementary hole: an allow-listed class whose message was built from caller
 * input. `RecallInputError` is on the list, and `recallCandidates` builds its message from
 * `compileFilter`, which used to quote the caller's `type` verbatim.
 *
 * The error here is NOT hand-built — it comes out of the real `recallCandidates` compiling
 * a real filter, so this fails if the leak is reintroduced at either end: at the throw
 * site in `filterCompiler`, or at the wrap site in `repository`.
 */
describe('caller text in the filter `type` field never reaches the log', () => {
  const PII = 'Jane Doe, MRN 4471';

  /** The genuine RecallInputError this filter produces, via the real compile path. */
  async function realRecallErrorFor(filter: unknown): Promise<any> {
    poolQuery.mockResolvedValue({ rows: [] });
    try {
      await recallCandidates({
        storeIds: ['vs_1'], ownerEmail: 'owner@example.com',
        queryText: 'q', queryEmbedding: [1, 0, 0], filter,
      } as any);
    } catch (err) {
      return err;
    }
    throw new Error('expected recallCandidates to reject');
  }

  it('the RecallInputError it builds does not carry the caller\'s operator string', async () => {
    const err = await realRecallErrorFor({ type: PII, key: 'hired', value: 1 });

    expect(err).toBeInstanceOf(RecallInputError);
    expect(err.status).toBe(400);                       // still the 400 it always was
    expect(err.message).toContain('Invalid attribute filter');
    expect(err.message).not.toContain(PII);
  });

  it('and nothing at warn or above carries it once the descriptor logs that error', async () => {
    // The reviewer's probe, as a test. Before the fix this line read:
    //   file_search call call_2 failed: file_search_unavailable (RecallInputError:
    //   Invalid attribute filter: Unsupported filter type: "Jane Doe, MRN 4471")
    const err = await realRecallErrorFor({ type: PII, key: 'hired', value: 1 });
    for (const m of [logger.error, logger.warn, logger.info, logger.debug, logger.trace]) m.mockClear();
    searchSpy.mockRejectedValue(err);

    await fileSearchDescriptor.execute(call(), ctx());

    const logged = allLogged();
    expect(logged).not.toContain(PII);
    expect(logged).not.toContain('Jane');
    // The message IS still logged — it is an allow-listed class and the diagnosis is
    // wanted. What changed is that the message no longer contains the caller's text.
    expect(logged).toContain('Invalid attribute filter');
    expect(logged).toContain('RecallInputError');
  });

  it('holds for a nested filter and for a non-string `type`', async () => {
    for (const filter of [
      { type: 'and', filters: [{ type: PII, key: 'k', value: 1 }] },
      { type: { secret: PII }, key: 'k', value: 1 },
    ]) {
      const err = await realRecallErrorFor(filter);
      expect(err.message).not.toContain(PII);
    }
  });
});

describe('execute still logs the message of this stack\'s OWN errors', () => {
  // The gate must not have cost the diagnosability the original comment was defending.
  // Each of these classes reports a bounded, non-user-content fact: a length, a store id,
  // a field name, a dimension.
  const ours: Array<[string, () => Error]> = [
    ['SearchStoreNotFoundError', () => new SearchStoreNotFoundError('vs_missing')],
    ['SearchQueryTooLongError', () => new SearchQueryTooLongError(9001)],
    ['RecallInputError', () => new RecallInputError('ownerEmail must be a non-empty string')],
    ['StoreExpiredError', () => new StoreExpiredError('vs_old')],
    ['StoreDimensionMismatchError',
      () => new StoreDimensionMismatchError('Vector store vs_drift is pinned to 1536 dimensions')],
  ];

  it.each(ours)('%s: its message is preserved in the log line', async (_name, make) => {
    const err = make();
    searchSpy.mockRejectedValue(err);

    await fileSearchDescriptor.execute(call(), ctx());

    expect(allLogged()).toContain(err.message);
  });

  it('preserves the classified codes, so the gate did not disturb classification', async () => {
    searchSpy.mockRejectedValue(new SearchStoreNotFoundError('vs_missing'));
    expect((await fileSearchDescriptor.execute(call(), ctx()) as any).error.code).toBe('store_not_found');

    searchSpy.mockRejectedValue(new SearchQueryTooLongError(9001));
    expect((await fileSearchDescriptor.execute(call(), ctx()) as any).error.code).toBe('query_too_long');
  });
});
