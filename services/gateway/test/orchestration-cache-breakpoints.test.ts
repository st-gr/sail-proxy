/**
 * Where cache_control goes, and how cached tokens come back.
 *
 * Anthropic caches on a prefix basis over tools -> system -> messages and
 * permits up to four breakpoints. codex sends no cache_control of its own and
 * expects caching to happen anyway, so the bridge inserts the breakpoints.
 *
 * Field names in mapCachedTokens come from the live probe recorded at
 * test/fixtures/orchestration/cache-probe-result.md — they are not guessed.
 * That capture actually recorded four fields under usage.prompt_tokens_details
 * (cached_tokens, cache_creation_tokens, and the two
 * cache_creation_token_details.ephemeral_*_input_tokens splits), but only
 * cached_tokens is the "read from cache" counter mapCachedTokens exists to
 * report — see the header of cacheBreakpoints.ts for why the other three stay
 * out of this function's return shape.
 *
 * Message fixtures are FACTORY FUNCTIONS, not shared consts. A fix-round
 * review caught that shared const objects, reused across it() blocks and
 * across repeated positions within one messages_history array, let an
 * enabled:true call in one test permanently stamp cache_control onto an
 * object a later test also reads — masking a missing-clone mutation (it was
 * caught by the wrong test, for the wrong reason) and letting duplicate
 * array entries silently share a single mutation. Building fresh objects per
 * call closes both holes: every test starts from an unmarked object, and
 * "the same message" appearing twice in one history is two independent
 * objects, exactly as it would be from a real caller.
 */
import { describe, it, expect } from '@jest/globals';
import { applyCacheBreakpoints, mapCachedTokens } from '../src/responses/orchestrationBridge/cacheBreakpoints';

/**
 * A payload in the shape requestTranslator.ts actually builds: template and
 * messages_history DISJOINT, the system message living in the template alone.
 * `messages` is the logical conversation; the system entry is lifted out of the
 * history into the template, exactly as buildOrchestrationPayload does.
 *
 * This helper used to put messages[0] in the template AND leave it in the
 * history — the duplicated shape that made the wire carry one marked and one
 * unmarked copy of the system block. `duplicatedPayloadWith` below still builds
 * that shape on purpose, for the one test that asserts it is never marked.
 */
function payloadWith(messages: any[], tools?: any[]): any {
  const system = messages.find((m) => m.role === 'system');
  return {
    config: { modules: { prompt_templating: {
      prompt: { template: system ? [system] : [], ...(tools ? { tools } : {}) },
      model: { name: 'm', version: 'latest', params: {} },
    } } },
    placeholder_values: {},
    messages_history: messages.filter((m) => m !== system),
  };
}

/** The pre-de-duplication shape: the system message in the template AND in the history. */
function duplicatedPayloadWith(messages: any[]): any {
  const system = messages.find((m) => m.role === 'system');
  return {
    config: { modules: { prompt_templating: {
      prompt: { template: system ? [system] : [] },
      model: { name: 'm', version: 'latest', params: {} },
    } } },
    placeholder_values: {},
    messages_history: messages,
  };
}

const sys = () => ({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
const u1 = () => ({ role: 'user', content: [{ type: 'text', text: 'one' }] });
const a1 = () => ({ role: 'assistant', content: [{ type: 'text', text: 'two' }] });
const u2 = () => ({ role: 'user', content: [{ type: 'text', text: 'three' }] });
/** A message with more than one content block, e.g. from textBlocks() in requestTranslator.ts. */
const multiBlockSys = () => ({
  role: 'system',
  content: [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ],
});
/**
 * A message whose only content block is an image_url block -- the shape
 * textBlocks() in requestTranslator.ts now emits for a data: URL
 * `input_image` part (see that file). Before that change, no code path could
 * put a non-text block here at all.
 */
const imageMsg = () => ({
  role: 'user',
  content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
});

describe('applyCacheBreakpoints', () => {
  it('returns the payload UNCHANGED when disabled', () => {
    // "Contains no cache_control" is satisfied by returning `{}`, or by dropping
    // messages_history, or by returning the template alone — every one of which would
    // send a request with no conversation in it. The guarantee is that the payload comes
    // back intact, so assert that, not merely the absence of a marker.
    const p = payloadWith([sys(), u1()]);
    const before = JSON.parse(JSON.stringify(p));
    const out: any = applyCacheBreakpoints(p, { enabled: false });
    expect(out).toEqual(before);
    expect(out.messages_history).toHaveLength(1);
    expect(out.config.modules.prompt_templating.prompt.template).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });

  it('marks the last block of the TEMPLATE\'s system message', () => {
    const out: any = applyCacheBreakpoints(payloadWith([sys(), u1()]), { enabled: true });
    const system = out.config.modules.prompt_templating.prompt.template[0];
    expect(system.role).toBe('system');
    expect(system.content[system.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT hunt messages_history for a system message to mark', () => {
    // The de-duplication's other half. requestTranslator.ts now keeps template and
    // messages_history disjoint, so the template copy is the only copy — and this
    // function marks it there. Fed the OLD duplicated payload anyway, it must mark
    // the template copy and leave the history copy strictly alone: marking the
    // history one is precisely what produced the one-marked/one-unmarked wire that
    // made SAP report inclusive-looking usage (arm A0 of
    // test/fixtures/orchestration/bridge-cache-probe-result.md, 15903 = 15892 + 11),
    // and marking BOTH is arm A1 — exclusive, but paying to cache the text twice
    // (0 -> 34181 against A2's 0 -> 17692 for a comparable prefix).
    const out: any = applyCacheBreakpoints(duplicatedPayloadWith([sys(), u1()]), { enabled: true });

    const templateSystem = out.config.modules.prompt_templating.prompt.template[0];
    expect(templateSystem.content[0].cache_control).toEqual({ type: 'ephemeral' });

    const historySystem = out.messages_history.find((m: any) => m.role === 'system');
    expect(historySystem).toBeDefined();
    expect(JSON.stringify(historySystem)).not.toContain('cache_control');
  });

  it('marks the last block of a multi-block message, not the first', () => {
    // markLastBlock marks content[length-1] specifically because Anthropic's
    // cache boundary is the end of a content block. Every other fixture in
    // this suite has exactly one content block, so content[0] and
    // content[length-1] are the same object there and can't tell a
    // last-block implementation apart from a first-block one. This fixture
    // has two blocks — requestTranslator.ts's textBlocks() can legitimately
    // emit several for one message — so it actually exercises the distinction.
    const out: any = applyCacheBreakpoints(payloadWith([multiBlockSys(), u1()]), { enabled: true });
    const system = out.config.modules.prompt_templating.prompt.template[0];
    expect(system.content[0].cache_control).toBeUndefined();
    expect(system.content[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks the conversation prefix but never the most recent turn', () => {
    const out: any = applyCacheBreakpoints(payloadWith([sys(), u1(), a1(), u2()]), { enabled: true });
    const hist = out.messages_history;
    const last = hist[hist.length - 1];
    expect(JSON.stringify(last)).not.toContain('cache_control');
    // The turn before it is the prefix boundary and IS marked.
    const prev = hist[hist.length - 2];
    expect(prev.content[prev.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('stays inside Anthropic\'s four-breakpoint limit — which it cannot currently reach', () => {
    // HONEST SCOPE. This test cannot fail for the reason its old name implied. The
    // placement rule marks at most TWO breakpoints by construction (the system message,
    // then the first prefix message that can hold one, then `break`), so the
    // `used < MAX_BREAKPOINTS` loop guard is vestigial today and no input can drive the
    // count above two — a "never exceeds four" assertion is unfalsifiable against this
    // implementation.
    //
    // What it does pin is the property that matters and IS falsifiable: whatever the
    // conversation's length, the count neither reaches zero (caching silently off) nor
    // grows with it. `many` is long enough that a rule marking every eligible message
    // would blow the limit, so a future change that removes the `break` fails here as
    // well as on the "only the prefix boundary" test below. A tools array is present so
    // the walk has one more thing it could wrongly mark.
    const many = [sys(), u1(), a1(), u2(), a1(), u2(), a1(), u2()];
    const out: any = applyCacheBreakpoints(payloadWith(many, [{ type: 'function', function: { name: 'x' } }]), { enabled: true });
    const count = (JSON.stringify(out).match(/"cache_control"/g) || []).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);

    // The same rule over a SHORTER conversation marks the same number: the count is a
    // property of the placement rule, not of how much history there is.
    const few: any = applyCacheBreakpoints(payloadWith([sys(), u1(), a1()]), { enabled: true });
    expect((JSON.stringify(few).match(/"cache_control"/g) || []).length).toBe(count);
  });

  it('marks only the prefix boundary turn, not every eligible earlier turn', () => {
    // Guards the "mark the first one that can hold a breakpoint" design choice
    // (see cacheBreakpoints.ts step 2 comment) against a mutant that walks the
    // whole prefix up to the four-breakpoint cap instead of stopping at one:
    // that mutant still stays within the cap, so it slips past the
    // four-breakpoint-limit assertion above undetected. Found via mutation
    // testing — the brief's own suite did not distinguish the two behaviours.
    const many = [sys(), u1(), a1(), u2(), a1(), u2(), a1(), u2()];
    const out: any = applyCacheBreakpoints(payloadWith(many), { enabled: true });
    const count = (JSON.stringify(out).match(/"cache_control"/g) || []).length;
    expect(count).toBe(2);
  });

  it('does not mutate the caller\'s payload', () => {
    const p = payloadWith([sys(), u1()]);
    const before = JSON.stringify(p);
    applyCacheBreakpoints(p, { enabled: true });
    expect(JSON.stringify(p)).toBe(before);
  });

  it('CHARACTERIZATION: marks cache_control onto an image_url block when it lands on the prefix boundary', () => {
    // Pins what markLastBlock does TODAY -- not what it ought to do. It marks
    // whatever object is last in message.content with no check on `.type`,
    // so now that a real conversation can put an image_url block there
    // (requestTranslator.ts's textBlocks(), added for input_image support),
    // that block gets marked exactly like a text block would.
    //
    // This is NOT an endorsement of that behaviour. Whether SAP's
    // Anthropic-harmonization step accepts (or silently ignores, or 400s on)
    // a cache_control field on an image_url block is unverified -- that gets
    // settled live, with a pre-declared fallback, in Task 3 of
    // docs/superpowers/plans/2026-08-12-input-image-support.md. If a later
    // change makes breakpoints skip non-text blocks on purpose, THIS TEST
    // should fail and be updated deliberately -- that is the point of
    // pinning it rather than leaving the gap silent.
    const out: any = applyCacheBreakpoints(payloadWith([sys(), imageMsg(), u2()]), { enabled: true });
    const marked = out.messages_history[0];
    expect(marked.content[0].type).toBe('image_url');
    expect(marked.content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('leaves a message with no content blocks alone rather than throwing', () => {
    const out: any = applyCacheBreakpoints(payloadWith([sys(), { role: 'assistant', content: [] }, u2()]), { enabled: true });
    // Index 0, not 1: the system message is in the template now, so the empty
    // assistant turn is the first entry in messages_history.
    expect(out.messages_history[0].content).toEqual([]);
  });
});

describe('mapCachedTokens', () => {
  it('reads the field names the live probe recorded', () => {
    // If the probe recorded different names, THIS TEST is what changes — not
    // the implementation's guess.
    expect(mapCachedTokens({ prompt_tokens_details: { cached_tokens: 42 } })).toEqual({ cachedTokens: 42 });
  });

  it('reports zero when the provider sent no cache details', () => {
    expect(mapCachedTokens({ prompt_tokens: 10 })).toEqual({ cachedTokens: 0 });
    expect(mapCachedTokens(undefined)).toEqual({ cachedTokens: 0 });
  });
});
