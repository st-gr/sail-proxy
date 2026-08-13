/**
 * Task 7: the `file_search` descriptor's call side — `parseCall`, `execute`, and the two
 * OPPOSITE renderings of every result.
 *
 * The whole suite exists for one boundary. The gateway's own retrieval stack sees RAW
 * text; the generative deployment never does:
 *
 *   renderOutput   -> function_call_output -> the deployment  ->  MASKED
 *   renderCallItem -> file_search_call.results -> the client   ->  RAW
 *
 * Conflating those leaks a document to the model, or shows a document's owner
 * placeholders for their own file. Neither failure is loud.
 *
 * Nor is the query asymmetry, which is INVERTED from web_search's: the non-streaming path
 * receives an already-unmasked query (pseudonymizationPlugin's after handler runs first),
 * the streaming path receives a masked one (the interceptor reads bytes still in flight).
 * Implemented backwards this searches a raw corpus for `MASKED_PERSON_06034362` and gets
 * ZERO HITS rather than an error — indistinguishable from an empty store. So the query
 * tests below assert the exact string that reaches `searchVectorStores`, never merely that
 * the search ran; and the non-streaming fixture deliberately uses a query whose as-is and
 * unmasked forms DIFFER, so "never unmask" and "always unmask" fail different tests.
 *
 * `searchVectorStores` is the only thing stubbed. Its real error classes are kept
 * (`requireActual`), because `execute`'s failure classification is `instanceof`-based and a
 * hand-rolled stand-in class would keep passing after the real one was renamed. The
 * masking path is NOT stubbed at all: it runs the gateway's real detectors against a real
 * ReplacementMap, so a test asserting `MASKED_` in the output is asserting that masking
 * genuinely happened rather than that a mock was wired up.
 *
 * @see ../src/plugins/fileSearch/descriptor.ts
 * @see ../src/plugins/fileSearch/chunkMasking.ts
 * @see responses-filesearch-prepare.test.ts - Task 6's half (rewriteTool / prepare)
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const searchSpy = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../src/fileSearch/search', () => {
  // The REAL module, with only the network/database entry point replaced: SearchStoreNotFoundError
  // and SearchQueryTooLongError stay the classes `execute` actually tests with `instanceof`.
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
import { maskThroughRequestMap } from '../src/plugins/fileSearch/chunkMasking';
import { SearchHit, SearchStoreNotFoundError, SearchQueryTooLongError } from '../src/fileSearch/search';
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';
import { unmaskText } from '../src/plugins/pseudonymization/unmasker';
import { ParsedCall, ToolExecResult } from '../src/plugins/hostedTool/descriptor';

const logger: any = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

/** A retrieval hit in `SearchHit`'s real shape — `content` is a parts array, not a bare
 *  `text` field. A fixture that invented `{ text }` would pass against a descriptor that
 *  read `hit.text` and produced `undefined` against the real search module. */
function hit(text: string, over: Partial<SearchHit> = {}): SearchHit {
  return {
    fileId: 'file_1', filename: 'q3-report.pdf', score: 0.912, attributes: { dept: 'finance' },
    content: [{ type: 'text', text }],
    ...over,
  };
}

/** The `vector_store.search_results.page` searchVectorStores resolves with. */
function page(hits: SearchHit[]): any {
  return {
    object: 'vector_store.search_results.page',
    searchQuery: 'q', data: hits, hasMore: false, nextPage: null, mode: 'reranked',
  };
}

function resolvesWith(hits: SearchHit[]): void {
  searchSpy.mockResolvedValue(page(hits));
}

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

function call(query: string, over: Record<string, any> = {}): ParsedCall {
  return { callId: 'call_1', rawArguments: JSON.stringify({ query }), args: { query }, ...over } as ParsedCall;
}

/** A live map holding one person, with the placeholder it actually minted. Content-derived,
 *  so it cannot be hand-written — which is the point: the test unmasks with the same
 *  machinery production does. */
function mapWithPerson(name: string): { map: ReplacementMap; placeholder: string } {
  const map = new ReplacementMap('pseudonymization');
  return { map, placeholder: map.getPlaceholder('profile-person', name) };
}

const exec = (c: ParsedCall, x: any): Promise<ToolExecResult> => fileSearchDescriptor.execute(c, x);

beforeEach(() => {
  searchSpy.mockReset();
  poolQuery.mockReset();
  resolvesWith([]);
});

describe('fileSearchDescriptor.parseCall', () => {
  it('parses the query out of the model\'s arguments', () => {
    expect(fileSearchDescriptor.parseCall('call_1', '{"query":"quarterly revenue"}'))
      .toEqual({ callId: 'call_1', rawArguments: '{"query":"quarterly revenue"}', args: { query: 'quarterly revenue' } });
  });

  it('never throws on malformed arguments — the turn still owes this call an output', () => {
    for (const bad of ['', 'not json', '{"query":42}', '{}', null as any]) {
      expect(() => fileSearchDescriptor.parseCall('call_1', bad)).not.toThrow();
      expect(fileSearchDescriptor.parseCall('call_1', bad).args.query).toBe('');
    }
  });
});

describe('fileSearchDescriptor.execute: what reaches searchVectorStores', () => {
  it('calls searchVectorStores with rewriteQuery false and the prepared store ids', async () => {
    resolvesWith([hit('doc a')]);
    await exec(call('quarterly revenue'), ctx({ prepared: { ...PREPARED, storeIds: ['vs_1'] } }));
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({
      storeIds: ['vs_1'], query: 'quarterly revenue', rewriteQuery: false, ownerEmail: 'owner@example.com',
    }));
  });

  it('converts ranking_options.score_threshold into the scoreThreshold shape searchVectorStores reads', async () => {
    // The seam: prepare() freezes the caller's snake_case `{ score_threshold: 0.4 }` (pinned
    // by Task 6's suite), while SearchOptions.rankingOptions is `{ scoreThreshold?: number }`.
    // PreparedFileSearch.rankingOptions is `any`, so passing it through compiles, runs, and
    // silently drops the threshold — search.ts reads `rankingOptions?.scoreThreshold`, finds
    // undefined, and returns every result the caller asked to have filtered out.
    await exec(call('x'), ctx({ prepared: { ...PREPARED, rankingOptions: { score_threshold: 0.4 } } }));
    const opts: any = searchSpy.mock.calls[0][0];
    expect(opts.rankingOptions).toEqual({ scoreThreshold: 0.4 });
    expect(opts.rankingOptions.score_threshold).toBeUndefined();
  });

  it('sends no rankingOptions at all when the caller gave no usable threshold', async () => {
    await exec(call('x'), ctx({ prepared: { ...PREPARED, rankingOptions: { ranker: 'auto' } } }));
    expect((searchSpy.mock.calls[0][0] as any).rankingOptions).toBeUndefined();
  });

  it('carries the prepared max_num_results and filters through untouched', async () => {
    const filters = { type: 'eq', key: 'dept', value: 'legal' };
    await exec(call('x'), ctx({ prepared: { ...PREPARED, maxNumResults: 25, filters } }));
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ maxNumResults: 25, filters }));
  });

  it('refuses to search when prepare() left no configuration, and never falls back to store ids off the call', async () => {
    // The engine SWALLOWS a throw from prepare() and carries on with ctx.prepared undefined.
    // prepare() is the only thing that validates a store id against the caller's ownership,
    // so a fallback here — to the request body, or to ids the model restated in its own
    // arguments — would upgrade that swallow from a silent no-op into a search against an
    // unvalidated store id. That is a tenant-isolation break, not a degraded feature.
    const r = await exec(
      call('x', { args: { query: 'x', vector_store_ids: ['vs_someone_elses'] } }),
      ctx({ prepared: undefined }),
    );
    expect(searchSpy).not.toHaveBeenCalled();
    expect(r.status).toBe('failed');
    expect(r.error!.code).toBe('file_search_not_prepared');
  });

  it('refuses to search when prepared carries no store ids', async () => {
    const r = await exec(call('x'), ctx({ prepared: { ...PREPARED, storeIds: [] } }));
    expect(searchSpy).not.toHaveBeenCalled();
    expect(r.status).toBe('failed');
  });

  it('refuses to search without a caller identity rather than querying with a NULL owner', async () => {
    // ToolExecCtx.ownerEmail is `string | undefined` (an AWS SigV4 request carries no
    // email); SearchOptions.ownerEmail is `string`. Letting undefined through would issue
    // the ownership query with a NULL owner and rely on `owner_email = NULL` never being
    // true — safe today, and a boundary that depends on SQL's NULL semantics staying
    // convenient rather than on an explicit decision.
    const r = await exec(call('x'), ctx({ ownerEmail: undefined }));
    expect(searchSpy).not.toHaveBeenCalled();
    expect(r.status).toBe('failed');
    expect(r.error!.code).toBe('file_search_no_owner');
  });
});

describe('fileSearchDescriptor.execute: the query asymmetry', () => {
  it('unmasks the query before searching on the STREAMING path', async () => {
    // Searching a raw corpus for a placeholder returns ZERO HITS rather than throwing, so
    // asserting "it ran" proves nothing. Assert the real query.
    const { map, placeholder } = mapWithPerson('Jane Roe');
    await exec(call(`what did ${placeholder} say`),
      ctx({ isStreaming: true, replacementMap: map }));
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ query: 'what did Jane Roe say' }));
  });

  it('uses the query AS-IS on the non-streaming path, even when it looks like a placeholder', async () => {
    // pseudonymizationPlugin's after handler (index 0) has already unmasked this path's
    // arguments in place, so unmasking again is wrong. The fixture is deliberately a query
    // whose as-is and unmasked forms DIFFER — a realistic raw query would make "never
    // unmask" and "always unmask" indistinguishable, and only one of them is correct.
    const { map, placeholder } = mapWithPerson('Jane Roe');
    await exec(call(`what did ${placeholder} say`),
      ctx({ isStreaming: false, replacementMap: map }));
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ query: `what did ${placeholder} say` }));
  });

  it('leaves a streaming query alone when masking is off for this request', async () => {
    await exec(call('quarterly revenue'), ctx({ isStreaming: true, replacementMap: undefined }));
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ query: 'quarterly revenue' }));
  });
});

describe('fileSearchDescriptor.execute: failures', () => {
  it('returns an error result rather than throwing when the store vanished mid-turn', async () => {
    // prepare() checked every id before the turn opened; a store can still be deleted or
    // expire between then and this call.
    searchSpy.mockRejectedValue(new SearchStoreNotFoundError('vs_1'));
    const r = await exec(call('x'), ctx());
    expect(r.status).toBe('failed');
    expect(r.error).toBeDefined();
    expect(r.error!.code).toBe('store_not_found');
  });

  it('reports an oversized query as its own code', async () => {
    searchSpy.mockRejectedValue(new SearchQueryTooLongError(99999));
    const r = await exec(call('x'), ctx());
    expect(r.error!.code).toBe('query_too_long');
  });

  it('returns an error result when the database is unavailable', async () => {
    searchSpy.mockRejectedValue(new Error('searchVectorStores: file_search database is not configured'));
    const r = await exec(call('x'), ctx());
    expect(r.error).toBeDefined();
    expect(r.error!.code).toBe('file_search_unavailable');
    expect(r.payload.hits).toEqual([]);
  });

  it('never logs the query, at any level — it is user content', async () => {
    for (const m of [logger.error, logger.warn, logger.info, logger.debug, logger.trace]) m.mockClear();
    searchSpy.mockRejectedValue(new Error('boom'));
    await exec(call('what is Jane Roe\'s diagnosis'), ctx());
    const logged = [logger.error, logger.warn, logger.info, logger.debug, logger.trace]
      .flatMap((m: any) => m.mock.calls as any[][]).map((c) => JSON.stringify(c)).join(' ');
    expect(logged).not.toContain('Jane Roe');
    expect(logged).not.toContain('diagnosis');
  });
});

describe('fileSearchDescriptor.renderOutput: MASKED, because this leaves the gateway toward SAP', () => {
  const PII = 'Contact Jane Roe at jane@x.com';

  async function completedResult(): Promise<{ r: ToolExecResult; map: ReplacementMap }> {
    const map = new ReplacementMap('pseudonymization');
    resolvesWith([hit(PII)]);
    const r = await exec(call('who signed off'), ctx({ replacementMap: map }));
    return { r, map };
  }

  it('renderOutput sends MASKED chunk text to the deployment', async () => {
    const { r } = await completedResult();
    const text = JSON.stringify(fileSearchDescriptor.renderOutput(r));
    expect(text).not.toContain('jane@x.com');
    expect(text).not.toContain('Jane Roe');
    expect(text).toMatch(/MASKED_/);
  });

  it('registers what it masked in the LIVE request map, so the client-facing unmask can reverse it', async () => {
    // Without this the model quotes a placeholder back and the client is shown a token for
    // a document it owns.
    const { r, map } = await completedResult();
    const masked = JSON.parse(fileSearchDescriptor.renderOutput(r).output).results[0].text;
    expect(unmaskText(masked, map)).toBe(PII);
  });

  it('carries the file id, filename and score alongside the masked text', async () => {
    const { r } = await completedResult();
    const result = JSON.parse(fileSearchDescriptor.renderOutput(r).output).results[0];
    expect(result).toMatchObject({ file_id: 'file_1', filename: 'q3-report.pdf', score: 0.912 });
  });

  it('pairs the output to its call by call_id', async () => {
    const { r } = await completedResult();
    const out = fileSearchDescriptor.renderOutput(r);
    expect(out.type).toBe('function_call_output');
    expect(out.call_id).toBe('call_1');
  });

  it('renderOutput on an error result tells the model the search failed', async () => {
    searchSpy.mockRejectedValue(new SearchStoreNotFoundError('vs_1'));
    const r = await exec(call('x'), ctx());
    expect(JSON.stringify(fileSearchDescriptor.renderOutput(r))).toMatch(/could not|unavailable|failed/i);
  });

  it('survives the null payload the engine builds for a call that never ran', () => {
    // hostedTool/engine.ts's failedResult() — a call the per-request cap refused, or one
    // whose descriptor threw. Every render hook is handed one of these.
    const r: any = { call: call('x'), status: 'failed', payload: null };
    expect(() => fileSearchDescriptor.renderOutput(r)).not.toThrow();
    expect(JSON.stringify(fileSearchDescriptor.renderOutput(r))).toMatch(/could not/i);
  });
});

describe('fileSearchDescriptor.renderCallItem: RAW, because the client owns these documents', () => {
  const PII = 'Contact Jane Roe at jane@x.com';

  async function completedResult(): Promise<ToolExecResult> {
    resolvesWith([hit(PII)]);
    return exec(call('who signed off'), ctx({ replacementMap: new ReplacementMap('pseudonymization') }));
  }

  it('renderCallItem exposes RAW chunk text — the client owns these documents', async () => {
    const r = await completedResult();
    const item = fileSearchDescriptor.renderCallItem(r, { includeResults: true });
    const text = JSON.stringify(item.results);
    expect(text).toContain('jane@x.com');
    expect(text).toContain('Jane Roe');
    expect(text).not.toMatch(/MASKED_/);
  });

  it('carries queries and status, and omits results when not included', async () => {
    resolvesWith([hit('x')]);
    const r = await exec(call('quarterly revenue'), ctx());
    const item = fileSearchDescriptor.renderCallItem(r, { includeResults: false });
    expect(item.type).toBe('file_search_call');
    expect(item.queries).toEqual(['quarterly revenue']);
    expect(item.status).toBe('completed');
    expect(item.results).toBeUndefined();
    expect(item.id).toMatch(/^fs_/);
  });

  it('reads failed for a call that could not be served', async () => {
    searchSpy.mockRejectedValue(new SearchStoreNotFoundError('vs_1'));
    const r = await exec(call('x'), ctx());
    expect(fileSearchDescriptor.renderCallItem(r, { includeResults: true }).status).toBe('failed');
  });

  it('still names the query for a call that never ran', () => {
    const r: any = { call: call('quarterly revenue'), status: 'failed', payload: null };
    const item = fileSearchDescriptor.renderCallItem(r, { includeResults: true });
    expect(item.queries).toEqual(['quarterly revenue']);
    expect(item.results).toEqual([]);
  });
});

describe('fileSearchDescriptor.renderResultMessage', () => {
  it('dumps the passages RAW, for the paths where no continuation delivers an answer', async () => {
    resolvesWith([hit('Contact Jane Roe at jane@x.com')]);
    const r = await exec(call('who signed off'), ctx({ replacementMap: new ReplacementMap('pseudonymization') }));
    const message = fileSearchDescriptor.renderResultMessage(r);
    expect(message.role).toBe('assistant');
    expect(message.content[0].text).toContain('jane@x.com');
    expect(message.content[0].text).toContain('q3-report.pdf');
  });

  it('says so when nothing matched, rather than rendering an empty message', async () => {
    resolvesWith([]);
    const r = await exec(call('quarterly revenue'), ctx());
    expect(fileSearchDescriptor.renderResultMessage(r).content[0].text).toMatch(/No passages/i);
  });

  it('survives the null payload the engine builds for a call that never ran', () => {
    const r: any = { call: call('x'), status: 'failed', payload: null };
    expect(() => fileSearchDescriptor.renderResultMessage(r)).not.toThrow();
    expect(fileSearchDescriptor.renderResultMessage(r).content[0].text).toMatch(/could not/i);
  });

  /**
   * Task 2 fix round 2: checked for the same "reads as an empty search" hole `web_search`
   * had. `formatResultsText` already branches on `r.status === 'failed'` BEFORE it ever
   * looks at `hits.length`, so a capped call (still `status: 'failed'`, same as any other
   * failure here) never falls through to the `hits.length === 0` / "No passages" branch —
   * no hole to fix. It does not yet carry `cap_reached`-specific budget wording the way
   * `renderOutput` does; that asymmetry is out of this round's scope (the brief's own
   * go/no-go was "if its failed path already reads correctly, say so and fix only
   * web_search") and is called out in the task report as a candidate for separate follow-up.
   */
  it('never reads a cap-blocked call as though it simply found nothing', () => {
    const r: any = {
      call: call('x'), status: 'failed', payload: null, error: { code: 'cap_reached', message: '' },
    };
    const text = fileSearchDescriptor.renderResultMessage(r).content[0].text;
    expect(text).toMatch(/could not/i);
    expect(text).not.toMatch(/No passages/i);
  });

  /**
   * Task 2 fix round 4: the live acceptance run showed `web_search`'s USER-facing dump
   * carrying a MODEL-facing instruction ("Do not tell the user…") verbatim into the user's
   * transcript, because fix round 2 pointed `renderResultMessage` at the same string as
   * `renderOutput`. `fileSearchDescriptor` never made that mistake — `formatResultsText`
   * (`fileSearch/descriptor.ts`) was never wired to `renderOutput`'s message and has no
   * imperative in any branch, cap-blocked or otherwise — so there is no split to make here.
   * Pinned as a real assertion rather than left as prose in the task report.
   */
  it('carries no instruction addressed to the model — this dump is read by the user, not the model, and never was', () => {
    for (const r of [
      { call: call('x'), status: 'completed', payload: { hits: [], queries: ['x'] } },
      { call: call('x'), status: 'failed', payload: null },
      { call: call('x'), status: 'failed', payload: null, error: { code: 'cap_reached', message: '' } },
    ] as any[]) {
      const text = fileSearchDescriptor.renderResultMessage(r).content[0].text;
      expect(text).not.toMatch(/do not tell the user/i);
      expect(text).not.toMatch(/tell the user/i);
    }
  });
});

describe('maskThroughRequestMap', () => {
  it('masks entities the request map has never seen, which is the whole reason it exists', () => {
    // ctx.remask only replays pairs the REQUEST body minted. A retrieved chunk was never in
    // the request body, so replaying those pairs over it masks nothing at all.
    const map = new ReplacementMap('pseudonymization');
    const masked = maskThroughRequestMap('Contact Jane Roe at jane@x.com', map);
    expect(masked).not.toContain('Jane Roe');
    expect(masked).not.toContain('jane@x.com');
    expect(masked).toMatch(/MASKED_PERSON_/);
    expect(masked).toMatch(/MASKED_EMAIL_/);
  });

  it('reuses the placeholder the request map already holds for a value', () => {
    // A name from the user's prompt must keep the same token when it turns up in a
    // retrieved passage, or the model cannot connect the two.
    const { map, placeholder } = mapWithPerson('Jane Roe');
    expect(maskThroughRequestMap('Jane Roe signed the filing.', map)).toContain(placeholder);
    expect(map.forward.get('Jane Roe')).toBe(placeholder);
  });

  it('keeps a URL\'s scheme-less alias, so a masked URL still unmasks without its scheme', () => {
    // ReplacementMap registers the bare masked host -> bare original origin in `reverse`
    // ONLY, which makes `reverse` a strict superset of the inverse of `forward`. Writing
    // both sides by hand instead of going through getPlaceholder type-checks, runs, masks
    // URLs correctly — and silently drops the alias, so a model that reproduces the host
    // without `https://` never unmasks.
    const map = new ReplacementMap('pseudonymization');
    const masked = maskThroughRequestMap('Escalate via https://reports.acme-corp.com/q3 today.', map);

    const placeholder = masked.match(/https:\/\/masked-url-\d+\.invalid/)![0];
    const bare = placeholder.replace(/^https:\/\//, '');

    expect(unmaskText(placeholder, map)).toBe('https://reports.acme-corp.com');
    expect(unmaskText(bare, map)).toBe('reports.acme-corp.com');
    expect(map.reverse.size).toBeGreaterThan(map.forward.size);
  });

  it('returns the text untouched when masking is off for this request', () => {
    expect(maskThroughRequestMap('Contact Jane Roe at jane@x.com', undefined))
      .toBe('Contact Jane Roe at jane@x.com');
  });

  it('never re-masks a placeholder into a second layer', () => {
    const { map, placeholder } = mapWithPerson('Jane Roe');
    expect(maskThroughRequestMap(`${placeholder} signed the filing.`, map)).toContain(placeholder);
    expect(unmaskText(maskThroughRequestMap(`${placeholder} signed.`, map), map)).toContain('Jane Roe');
  });
});

/**
 * THE UNDER-MASKING LEAK, closed.
 *
 * `custom_entities` is the caller-supplied regex tier (`detectCustomEntities`, priority 0).
 * It exists ONLY in the request's resolved `MaskingConfig` — never in
 * `DEFAULT_MASKING_CONFIG` — so while `chunkMasking` was pinned to that base set, a caller
 * who declared `EMP-\d{6}` sensitive got it masked in their prompt and shipped RAW to the
 * deployment inside every retrieved passage. Reproduced before the fix as
 * `badge MASKED_BADGE_17078648` request-side, `badge EMP-004417` chunk-side.
 *
 * The fix routes the request's own config onto `ToolExecCtx.maskingConfig`; these are the
 * tests that fail the moment `chunkMasking` goes back to a constant.
 */
describe('chunk masking honours the REQUEST\'s config, not the plugin\'s base set', () => {
  /** A caller-supplied config in the shape pseudonymizationPlugin resolves and stashes on
   *  `req.__pseudonymization.config` — one custom tier plus one ordinary category, so a
   *  config that were ignored wholesale and one whose custom tier alone were dropped fail
   *  different assertions. */
  const CALLER_CONFIG: any = {
    method: 'pseudonymization',
    entities: [{ type: 'profile-person' }, { type: 'profile-email' }],
    custom_entities: [{ pattern: 'EMP-\\d{6}', placeholder: 'MASKED_BADGE' }],
  };

  it('masks a custom_entities match in a chunk', () => {
    const map = new ReplacementMap('pseudonymization');
    const masked = maskThroughRequestMap('badge EMP-004417 signed off', map, CALLER_CONFIG);

    expect(masked).not.toContain('EMP-004417');
    expect(masked).toMatch(/MASKED_BADGE/);
    // Registered in the LIVE map, like every other chunk placeholder, so the client is
    // still shown its own document when the model quotes the passage back.
    expect(unmaskText(masked, map)).toBe('badge EMP-004417 signed off');
  });

  it('leaves the same badge RAW when no config is routed through — the exact bug, pinned', () => {
    const map = new ReplacementMap('pseudonymization');
    expect(maskThroughRequestMap('badge EMP-004417 signed off', map)).toContain('EMP-004417');
  });

  it('still masks the base categories when the request config carries them', () => {
    const map = new ReplacementMap('pseudonymization');
    const masked = maskThroughRequestMap('Contact Jane Roe at jane@x.com', map, CALLER_CONFIG);
    expect(masked).not.toContain('jane@x.com');
    expect(masked).toMatch(/MASKED_EMAIL_/);
  });

  it('falls back to the base set for a config with no category list, rather than masking nothing', () => {
    // "No config" must never mean "ship the document raw": an empty `entities` would
    // detect nothing at all, which on this path is a leak, not a no-op.
    const map = new ReplacementMap('pseudonymization');
    for (const empty of [undefined, { method: 'pseudonymization', entities: [] } as any]) {
      expect(maskThroughRequestMap('Contact Jane Roe at jane@x.com', map, empty))
        .toMatch(/MASKED_EMAIL_/);
    }
  });

  it('carries the caller\'s custom tier all the way into renderOutput — the item the deployment receives', async () => {
    // The end-to-end proof: ctx.maskingConfig -> execute -> payload.maskedResults ->
    // renderOutput. Anything that drops the config on the way leaves the badge in the JSON
    // that is POSTed back to SAP.
    const map = new ReplacementMap('pseudonymization');
    resolvesWith([hit('Approved by badge EMP-004417 on 3 March.')]);
    const r = await exec(call('who approved'), ctx({ replacementMap: map, maskingConfig: CALLER_CONFIG }));

    const toDeployment = JSON.stringify(fileSearchDescriptor.renderOutput(r));
    expect(toDeployment).not.toContain('EMP-004417');
    expect(toDeployment).toMatch(/MASKED_BADGE/);

    // ...and the CLIENT still sees its own document, unchanged. The two renderings must
    // not collapse into one just because a new tier was added.
    const item = fileSearchDescriptor.renderCallItem(r, { includeResults: true });
    expect(JSON.stringify(item.results)).toContain('EMP-004417');
  });
});

describe('fileSearchDescriptor.renderOutput distinguishes a cap from a breakage', () => {
  const call = { callId: 'c1', rawArguments: '{}', args: { query: 'q' } };

  it('says the budget is used up when that is the reason', () => {
    const out = fileSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null, error: { code: 'cap_reached', message: '' },
    } as any);
    const parsed = JSON.parse(out.output);
    expect(parsed.error.code).toBe('cap_reached');
    expect(parsed.error.message).toMatch(/budget/i);
    expect(parsed.error.message).toMatch(/passages you already have/i);
  });

  it('still reports an unexplained failure as unavailable', () => {
    const out = fileSearchDescriptor.renderOutput({ call, status: 'failed', payload: null } as any);
    const parsed = JSON.parse(out.output);
    expect(parsed.error.code).toBe('file_search_unavailable');
    expect(parsed.error.message).toMatch(/could not be completed/i);
  });
});

describe('file_search: results we no longer hold', () => {
  const call = { callId: 'c1', rawArguments: '{}', args: { query: 'q' } };

  it('renders a not_retained failure that never implies the corpus was empty', () => {
    const out = fileSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null, error: { code: 'not_retained', message: '' },
    } as any);
    const parsed = JSON.parse(out.output);
    expect(parsed.results).toBeUndefined();
    expect(parsed.error.code).toBe('not_retained');
    expect(parsed.error.message).toMatch(/no longer/i);
    expect(parsed.error.message).toMatch(/search again/i);
    expect(parsed.error.message).not.toMatch(/no passages (were )?found|found nothing/i);
  });

  it('gives the user a plain statement with no instruction addressed to the model', () => {
    const msg = fileSearchDescriptor.renderResultMessage({
      call, status: 'failed', payload: null, error: { code: 'not_retained', message: '' },
    } as any);
    const text = msg.content[0].text;
    expect(text).toMatch(/earlier/i);
    expect(text).not.toMatch(/do not tell the user/i);
    expect(text).not.toMatch(/tell the user/i);
  });

  it('leaves cap_reached and the generic failure unchanged', () => {
    const cap = JSON.parse(fileSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null, error: { code: 'cap_reached', message: '' },
    } as any).output);
    expect(cap.error.code).toBe('cap_reached');
    expect(cap.error.message).toMatch(/budget/i);
    const generic = JSON.parse(fileSearchDescriptor.renderOutput({
      call, status: 'failed', payload: null,
    } as any).output);
    expect(generic.error.code).toBe('file_search_unavailable');
  });
});
