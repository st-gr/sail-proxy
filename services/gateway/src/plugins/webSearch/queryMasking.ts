/**
 * Re-mask text — a web-search query, or a whole continuation `input` array — before it
 * leaves the gateway.
 *
 * Both web-search plugins run as `after` plugins, and both sit BEHIND
 * pseudonymizationPlugin in the single per-subpath hook array. `executeAfterPlugins`
 * walks that array in order, so on the response side pseudonymization runs FIRST and
 * has already unmasked the model's `function_call` arguments (Responses) /
 * `tool_use.input` (Anthropic) in place by the time a web-search after handler reads
 * the query out of them. Sending that query to Perplexity — a third-party model —
 * would ship the user's raw PII off-box, which is exactly what masking exists to
 * prevent.
 *
 * The request-scoped ReplacementMap that produced the placeholders is still attached
 * to the request (`req.__pseudonymizationMap`, see plugins/pseudonymization/index.ts).
 * So the query can simply be re-masked with the very tokens this request already
 * minted: the search provider sees the same masked string the deployment saw, while
 * the client still gets the unmasked query and results (the plugins keep using the
 * unmasked string for the items they hand back).
 *
 * Deliberately its OWN module rather than part of searchExecutor: every web-search test
 * suite mocks `webSearch/searchExecutor` wholesale to keep Perplexity out of the loop,
 * which would silently neuter this function — the masking guarantee must not be
 * mockable by a test that only meant to stub the network.
 *
 * INTENTIONAL CROSS-PATH ASYMMETRY (do not "fix" it into symmetry without reading this).
 * Only the NON-STREAMING Responses continuation re-masks: `remaskResponsesItems` covers the
 * whole `input` it POSTs back, search results included, because pseudonymizationPlugin has
 * already unmasked the model's prior output in place and it must not go back out raw. The
 * streaming interceptor re-masks nothing at all, and correctly so — it is installed BEHIND
 * pseudonymization's own res.write interceptor, so every value it reads is still masked and
 * re-masking there would rewrite masked-looking substrings inside the search results
 * themselves.
 *
 * The visible consequence: a Perplexity result containing the literal text of a masked
 * original — the short entity types are the realistic case, e.g. `male` from
 * profile-gender — reaches the deployment as a placeholder for a non-streaming caller and
 * verbatim for a streaming one, so the model reads slightly different text depending on
 * transport. Accepted deliberately. Both directions are safe (nothing raw leaves the
 * process either way; the client's view is unmasked either way), and the alternatives are
 * worse: re-masking on the streaming path corrupts results that were never unmasked, and
 * skipping it on the non-streaming path would ship the model's own unmasked prior turn to
 * the deployment.
 *
 * @see plugins/pseudonymization/index.ts - where __pseudonymizationMap is assigned
 * @see responsesWebSearchPlugin.ts / webSearchPlugin.ts - the two callers
 */

/**
 * Replace every value the pseudonymization plugin masked in this request with the
 * placeholder it minted for it.
 *
 * No map on the request (masking off, or an endpoint with no masking hook) means the
 * query is returned untouched — absent config must mean unchanged behavior.
 *
 * BOTH directions of the map are used, and `reverse` is the load-bearing one. It is a
 * strict SUPERSET of the inverse of `forward`: ReplacementMap also stores a scheme-less
 * alias for URL placeholders (see its "Scheme-less alias" branch), mapping the bare
 * masked host to the bare original origin so that a model which drops the `https://`
 * still unmasks. That bare origin is a value `unmaskText` can emit but `forward` cannot
 * invert, so sourcing pairs from `forward` alone left exactly one class of raw value —
 * an internal hostname — reaching the search provider. The invariant is: anything
 * unmasking can produce, re-masking must be able to consume.
 *
 * `reverse` is empty under the `anonymization` method, where nothing is unmasked in the
 * first place; `forward` alone covers that case.
 *
 * Longest value first: entities routinely overlap ("John Smith" contains "John", an
 * email contains its own domain), and replacing the short one first would leave the
 * long one unmatched with a raw fragment surviving alongside it.
 *
 * `remaskText` is the general primitive — any string that may carry unmasked PII and is
 * about to leave the process. `remaskSearchQuery` is a thin, name-preserving alias kept
 * for callers that specifically mean "the search query." `remaskResponsesItems` applies
 * it across a whole Responses conversation item array (the web-search continuation's
 * `input`, most notably), without mutating what it was given — a fresh structure is
 * returned so the caller's own copy (which may still be needed unmasked, e.g. for the
 * client-facing output) is untouched.
 */
export function remaskText(req: any, text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  const map: any = req?.__pseudonymizationMap;
  const byOriginal = new Map<string, string>();

  const add = (original: unknown, placeholder: unknown): void => {
    if (typeof original === 'string' && original.length > 0 &&
        typeof placeholder === 'string' && placeholder.length > 0 &&
        !byOriginal.has(original)) {
      byOriginal.set(original, placeholder);
    }
  };
  const isMap = (m: unknown): m is Map<string, string> =>
    !!m && typeof (m as Map<string, string>).entries === 'function';

  if (isMap(map?.forward)) {
    for (const [original, placeholder] of map.forward.entries()) add(original, placeholder);
  }
  // reverse is Map<placeholder, originalValue> — inverted here.
  if (isMap(map?.reverse)) {
    for (const [placeholder, original] of map.reverse.entries()) add(original, placeholder);
  }

  const pairs: Array<[string, string]> = [...byOriginal.entries()];
  if (pairs.length === 0) return text;
  pairs.sort((a, b) => b[0].length - a[0].length);

  let masked = text;
  for (const [original, placeholder] of pairs) {
    if (masked.includes(original)) {
      masked = masked.split(original).join(placeholder);   // literal, no regex escaping
    }
  }
  return masked;
}

export function remaskSearchQuery(req: any, query: string): string {
  return remaskText(req, query);
}

/**
 * Remask the text-bearing fields of a Responses conversation item array — the whole
 * `input` a web-search continuation is about to POST back to the deployment — before it
 * leaves the process. The model's prior turn in it has already been unmasked (by
 * pseudonymizationPlugin for the original response, or by this plugin's own
 * continuation-unmasking step for a later one), so more than just the search query needs
 * remasking here.
 *
 * Deliberately NOT a blind deep walk of every string in the structure: a `reasoning`
 * item's `encrypted_content` is an opaque, deployment-signed blob (not text), and
 * `id` / `call_id` pair a `function_call` to its `function_call_output`. A short masked
 * original — a 3-letter name, or an entity type like `profile-gender`'s "male" — has a
 * real chance of turning up as a substring inside either one by coincidence (base64
 * blobs and generated ids are long enough, and "male" short enough, that this is not a
 * theoretical concern). Corrupting `encrypted_content` gets the whole continuation
 * rejected by the deployment; corrupting an `id`/`call_id` breaks the pairing and
 * produces exactly the malformed-turn shape the parallel-call fix exists to prevent.
 * Either way the failure mode is a silent, intermittent loss of the continuation
 * feature — not a leak, but not what "remask before it leaves the process" is supposed
 * to cost.
 *
 * So this instead mirrors the EXACT field set `unmaskResponsesOutput`
 * (utils/responsesBodyAdapter.ts) unmasks on the way in, and `extractResponsesInputTexts`
 * (same file) treats as maskable on the way out: `content[].text`, `content[].refusal`,
 * a bare string `content`, `arguments`, `output`, and `summary[].text`. Everything else
 * on an item — `id`, `call_id`, `encrypted_content`, `type`, `status`, and any field this
 * function doesn't know about — passes through by reference, untouched. Non-mutating:
 * returns new item/part objects only where a field was actually remasked.
 */
export function remaskResponsesItems(items: any[], req: any): any[] {
  if (!Array.isArray(items)) return items;

  return items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const out: Record<string, any> = { ...item };

    if (Array.isArray(item.content)) {
      out.content = item.content.map((part: any) => {
        if (!part || typeof part !== 'object') return part;
        if (typeof part.text !== 'string' && typeof part.refusal !== 'string') return part;
        const newPart = { ...part };
        if (typeof part.text === 'string') newPart.text = remaskText(req, part.text);
        if (typeof part.refusal === 'string') newPart.refusal = remaskText(req, part.refusal);
        return newPart;
      });
    } else if (typeof item.content === 'string') {
      out.content = remaskText(req, item.content);
    }

    if (typeof item.arguments === 'string') out.arguments = remaskText(req, item.arguments);
    if (typeof item.output === 'string') out.output = remaskText(req, item.output);

    if (Array.isArray(item.summary)) {
      out.summary = item.summary.map((s: any) => {
        if (!s || typeof s !== 'object' || typeof s.text !== 'string') return s;
        return { ...s, text: remaskText(req, s.text) };
      });
    }

    return out;
  });
}
