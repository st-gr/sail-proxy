/**
 * `file_citation` annotations for a `file_search` turn, anchored so their character
 * offsets are still correct after unmasking.
 *
 * THE ONE THING THIS MODULE IS FOR. An OpenAI annotation locates itself with character
 * offsets into the assistant's message text (`index`, and the `start_index`/`end_index`
 * pair — see `FileCitationAnnotation` for what is documented and what is UNVERIFIED).
 * The model writes that text containing PLACEHOLDERS, and unmasking CHANGES
 * STRING LENGTHS — `MASKED_PERSON_1` is 15 characters, the `Jo` it unmasks to is 2. So an
 * offset computed against the masked text is wrong the instant a single placeholder in
 * front of it differs in length from its replacement, and it is wrong by a different
 * amount for every message.
 *
 * NOTHING CRASHES WHEN THAT HAPPENS. The response is well-formed, the client renders it,
 * and the citation underlines the wrong words. That is why the order below is not an
 * implementation detail: unmask FIRST, locate AFTERWARDS. There is no arithmetic to
 * "adjust" offsets across an unmasking pass and none should be introduced — a single
 * delta cannot describe a message where one substitution shrinks the text and the next
 * grows it, and `unmaskText` does not report where it substituted.
 *
 * WHY THE NEEDLE COMES FROM THE RAW HIT, NOT THE MASKED ONE. `execute()` materialises two
 * renderings of every result (see `descriptor.ts`): `payload.hits` is RAW, and
 * `payload.maskedResults` is what the deployment saw. The model quotes the MASKED passage
 * back, so before unmasking the message agrees with `maskedResults`; after unmasking it
 * agrees with `hits`. Since we locate in the UNMASKED text, the needle must come from the
 * RAW hits — which is why this function takes `SearchHit[]` and not the wire-shaped
 * `FileSearchResult[]`. Passing the masked results instead is a type error rather than a
 * silent zero-citation turn, deliberately.
 *
 * THE STRICT SIGNATURE PROTECTS LESS THAN IT LOOKS, AND A FUTURE CONSUMER MUST KNOW WHY.
 * `ToolExecResult.payload` is declared `any` (`hostedTool/descriptor.ts`), so while
 *
 *     buildCitations(text, results, map)              // results: FileSearchResult[]  -> TS2345
 *
 * is the compile error it should be, this one is NOT:
 *
 *     buildCitations(text, r.payload.maskedResults, map)   // r: ToolExecResult -> COMPILES
 *
 * `any` erases the check at exactly the call site where the mistake would be made. So the
 * type is a backstop, not the guarantee: **reach hits through a narrowing accessor** —
 * `descriptor.ts`'s `payloadOf(r)`, which returns a typed `FileSearchPayload | undefined`
 * — and never off `payload` directly. Handed `maskedResults`, this function throws
 * nothing, logs nothing and returns zero citations for precisely the documents that
 * contained an entity.
 *
 * Pure: no I/O, no logging (a chunk and a query are both user content and are never
 * logged at info level or above anywhere in file_search), and no mutation of the map.
 *
 * THE ONE CONSUMER is `descriptor.ts`'s `annotateMessage`, which the engine calls at SIX
 * sites, all in `hostedTool/engine.ts`. The design named the first three and this comment
 * used to stop there; the other three are the PENDING-DRAIN family — the shape where the
 * tools already ran in the before handler out of a replayed conversation, so the model's
 * FIRST response is already the citing message and there is no continuation stream for
 * sites 2/3 to read. That is the shape Task 9b existed to add, and omitting it here made
 * this header read as if the drain were unannotated:
 *
 *   1   the non-streaming merged `output`
 *   1b  the non-streaming early return, when the response has no hosted-tool call  (drain)
 *   2   the streaming continuation's `response.output_item.done`
 *   2b  the streaming FIRST response's `response.output_item.done`                 (drain)
 *   3   the streaming terminal frame a continuation took over
 *   3b  every terminal frame no continuation took over                             (drain)
 *
 * All six take
 * ONLY the `annotations` this function returns and never its `text`, because the two
 * transports disagree about who unmasks: on the NON-STREAMING path pseudonymizationPlugin's
 * after handler has already unmasked the model's text before the engine sees it (so `map`
 * is undefined, `unmaskText` never runs and the offsets are simply correct), while on the
 * STREAMING path the interceptor reads bytes that are still masked and pseudonymization
 * unmasks them afterwards, in `res.write`. A streaming caller must therefore compute
 * offsets here but MUST NOT emit this function's `text` in place of the frame it holds, or
 * it would hand unmasked bytes to a pipeline whose remaining stages assume masked ones —
 * and, on that path, POST them back to the deployment in the next continuation's `input`.
 *
 * @see ../pseudonymization/unmasker.ts - unmaskText, the length change this module exists for
 * @see descriptor.ts - payload.hits (RAW) vs payload.maskedResults (MASKED)
 */
import type { SearchHit } from '../../fileSearch/search';
import type { ReplacementMap } from '../pseudonymization/replacementMap';
import { unmaskText } from '../pseudonymization/unmasker';

/**
 * How much of a sentence is used to anchor a citation.
 *
 * Long enough to be distinctive in a message, short enough that a lightly-quoted sentence
 * still matches. Exported so a test asserts the cap rather than restating the number.
 */
export const CITATION_NEEDLE_MAX_LENGTH = 120;

/**
 * The shortest sentence allowed to WIN the message-aware search in `citationNeedle`.
 *
 * The floor is the whole reason that search is safe. Preferring any sentence the message
 * happens to contain lets a chunk anchor on `"Yes."` or `"See appendix."` — words that
 * appear in an answer for reasons having nothing to do with the passage. That trades this
 * module's honest failure mode (a VISIBLE ABSENCE: no citation) for the one it exists to
 * prevent (an INVISIBLE WRONG: a citation underlining unrelated text). Thirty characters
 * is long enough that a verbatim match is evidence of quotation rather than coincidence.
 *
 * It bounds only the SEARCH. The blind longest-sentence fallback is unaffected, so a chunk
 * that is one short sentence still anchors exactly as it did before the search existed —
 * which is what makes "never a worse anchor than picking the longest sentence blind" true
 * rather than merely likely.
 */
export const CITATION_NEEDLE_MIN_LENGTH = 30;

/**
 * One `file_citation`.
 *
 * VERIFIED against a real OpenAI response on 2026-08-06. A live
 * `POST /v1/responses` with a `file_search` tool and
 * `include: ["file_search_call.results"]` was captured through a proxy; the
 * annotation it returned carried exactly four fields — `type`, `file_id`,
 * `filename`, `index` — and `index` pointed at the LAST character of the
 * cited span (text length 100, index 99), not the first.
 *
 * @see ../../../../../docs/superpowers/specs/2026-07-29-responses-file-search-design.md
 */
export interface FileCitationAnnotation {
  type: 'file_citation';
  file_id: string;
  filename: string;
  /**
   * The single offset OpenAI documents, set to the END of the cited span — the
   * position of its last character.
   *
   * This was previously the span START, on a reading of OpenAI's documentation
   * that a captured response disproved: for the text "…after three years of
   * negotiation." (length 100) OpenAI returned `index: 99`, the final `.`. The
   * value marks where the citation marker sits, i.e. where a renderer would
   * place the footnote, which is why it trails the quoted text rather than
   * leading it.
   */
  index: number;
  /**
   * An EXTENSION, not parity. OpenAI documents the `start_index`/`end_index` pair on
   * `url_citation`; we carry it on `file_citation` as well because a single offset cannot
   * describe a span, and a client that reads only `index` is unaffected by its presence.
   */
  start_index: number;
  end_index: number;
}

export interface CitedMessage {
  /** The message text the offsets below are indices into: UNMASKED. */
  text: string;
  annotations: FileCitationAnnotation[];
}

/**
 * A hit's chunk text. `SearchHit.content` is a parts array, always text parts today.
 *
 * Deliberately a local copy of `descriptor.ts`'s `textOf` rather than an import: this
 * module stays free of the descriptor (and hence of `configService`, the search stack and
 * the hosted-tool engine), which is what lets the suite test it as a pure function. The
 * `'\n'` separator is part of that copy and is load-bearing — it is what the deployment saw
 * this chunk as, so a different separator here yields a needle the model never read. Pinned
 * by "joins multi-part chunk content with a newline, not a space".
 */
function chunkTextOf(hit: SearchHit): string {
  if (!Array.isArray(hit?.content)) return '';
  return hit.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/**
 * A chunk's sentences, each capped at `CITATION_NEEDLE_MAX_LENGTH`, longest first.
 *
 * A sentence longer than the cap is TRUNCATED, never dropped — a long sentence is the most
 * distinctive thing in a chunk, and dropping it would leave the chunk uncitable. Sorted on
 * the capped length, because the cap is what a caller will actually search for.
 */
function candidateNeedles(chunkText: string): string[] {
  if (typeof chunkText !== 'string') return [];
  return chunkText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.slice(0, CITATION_NEEDLE_MAX_LENGTH).trim())
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** The `[start, end)` offsets of every whitespace-delimited word in `text`. */
function wordSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    m = re.exec(text);
  }
  return spans;
}

/**
 * The longest run of consecutive WHOLE WORDS of `candidate` that occurs in
 * `messageText`, or `''`.
 *
 * Word-aligned on purpose. A character-aligned longest-common-substring would
 * happily return `"tocol was ratified in 19"` — a worse anchor to render a
 * footnote against, and one far likelier to collide with unrelated text than a
 * run of real words is.
 *
 * The inner extension is greedy and correct to cut short: if the run from word
 * `i` to word `j` is absent from the message, every longer run starting at `i`
 * contains it and is absent too. The outer loop stops once no remaining start
 * position has enough characters left to beat the best run already found. Both
 * bounds matter — this is called per candidate sentence of a chunk that may be
 * ~800 tokens.
 */
function longestQuotedRun(candidate: string, messageText: string): string {
  const spans = wordSpans(candidate);
  let best = '';
  for (let i = 0; i < spans.length; i++) {
    if (candidate.length - spans[i].start <= best.length) break;
    let run = '';
    for (let j = i; j < spans.length; j++) {
      const slice = candidate.slice(spans[i].start, spans[j].end);
      if (!messageText.includes(slice)) break;
      run = slice;
    }
    if (run.length > best.length) best = run;
  }
  return best;
}

/**
 * The phrase we look for in the model's message to anchor a citation.
 *
 * The model paraphrases, so a whole chunk will rarely appear verbatim. Sentences are the
 * unit: long enough to be distinctive, short enough that a lightly-quoted one still
 * matches. Returning the whole chunk would mean almost no citation ever anchors.
 *
 * WITHOUT `messageText` this is the blind heuristic — the chunk's longest sentence, a pure
 * function of the chunk.
 *
 * WITH `messageText` it returns the longest sentence that ACTUALLY OCCURS in the message,
 * falling back to the blind answer when none does. A production chunk is ~800 tokens and
 * many sentences, of which a model quotes at most one; blind selection therefore misses
 * whenever the quoted sentence is not the longest, which is most of the time.
 *
 * The search never considers a candidate shorter than `CITATION_NEEDLE_MIN_LENGTH` — see
 * that constant for why the floor, not the search, is what makes this strictly better than
 * blind selection rather than a new way to be confidently wrong. The candidate list is
 * sorted longest-first, so the first sub-floor candidate ends the search.
 *
 * `messageText` must be the text the caller will INDEX INTO — the unmasked message. Passing
 * the masked one selects a needle that cannot be located in the text the offsets describe.
 *
 * Returns `''` for a chunk with no usable sentence. `buildCitations` treats that as "no
 * citation" rather than passing it to `indexOf`, which answers `0` for an empty needle.
 */
export function citationNeedle(chunkText: string, messageText?: string): string {
  const candidates = candidateNeedles(chunkText);
  const blind = candidates[0] ?? '';
  if (typeof messageText !== 'string') return blind;

  for (const candidate of candidates) {
    if (candidate.length < CITATION_NEEDLE_MIN_LENGTH) break;
    if (messageText.includes(candidate)) return candidate;
  }

  // No sentence survived VERBATIM. That is the common case, not the exotic one:
  // a model quoting a source reformats it. Observed live on 2026-08-07, the
  // chunk read
  //
  //   The Kestrel Protocol was ratified in 1987 by the Aurelian Assembly.
  //
  // and the model wrote it back as
  //
  //   > "The Kestrel Protocol was ratified in **1987** by the **Aurelian Assembly**."
  //
  // The sentence is quoted in full and every word is in the right order, but the
  // markdown emphasis means `includes` is false, so the turn produced ZERO
  // annotations for a correctly-cited answer. Bold, italics, a changed quote
  // mark, an ellipsis, a bracketed insertion — all do this.
  //
  // So fall back to the longest WORD-ALIGNED run of a candidate that the message
  // does contain. This preserves the invariant the whole module is built on —
  // the needle genuinely occurs in the text the offsets index into, so
  // `buildCitations`'s `indexOf` cannot go negative and no offset is ever
  // invented. It only ever runs when the turn was already heading for no
  // citation at all, so it costs nothing on the path that already worked.
  let best = '';
  for (const candidate of candidates) {
    if (candidate.length < CITATION_NEEDLE_MIN_LENGTH) break;
    const run = longestQuotedRun(candidate, messageText);
    if (run.length > best.length) best = run;
  }
  if (best.length >= CITATION_NEEDLE_MIN_LENGTH) return best;

  return blind;
}

/**
 * Unmask the model's message and build one `file_citation` per hit that can be located in
 * it.
 *
 * `map` is undefined when masking is off for the request; the text then passes through
 * untouched, which is both correct (there is nothing to reverse) and the only behaviour
 * that keeps "masking disabled" indistinguishable from "no masking configured".
 *
 * A hit whose needle does not occur in the message yields NO annotation. `indexOf`'s `-1`
 * must never reach the output: negative offsets produce a structurally valid annotation
 * that slices from the end of the string, so a missing citation would surface as a
 * confidently wrong one.
 *
 * `index` duplicates `start_index`. They are assigned from one variable so they cannot
 * drift. This was previously justified as "OpenAI's shape carries both and clients read
 * either", stated as fact; it is not one. No real OpenAI `file_citation` has been observed
 * here, `start_index`/`end_index` are documented on `url_citation` rather than
 * `file_citation`, and setting `index` to the START of the span is our reading of an
 * unverified field. See `FileCitationAnnotation`. The duplication is still the right call
 * — it is the only choice that is correct whichever of the two a client reads — but it is
 * a hedge, not confirmed parity.
 *
 * Annotations come out in TEXT order, not hit order. Hits arrive in relevance order, so
 * emitting them as-is yields non-monotonic offsets — and a client splicing citation markers
 * into the string left to right corrupts its own offsets the moment they go backwards.
 * OpenAI orders by position; so do we. The sort is stable, so two hits anchored at the same
 * offset keep their relevance order.
 */
export function buildCitations(
  messageText: string, hits: SearchHit[] | undefined, map: ReplacementMap | undefined,
): CitedMessage {
  // UNMASK FIRST. Every offset below is an index into `text`, never into `messageText`.
  const text = map ? unmaskText(messageText, map) : messageText;

  const annotations = (Array.isArray(hits) ? hits : []).flatMap((h): FileCitationAnnotation[] => {
    // `text`, never `messageText`: the needle has to be selected against the same string
    // the offsets below index into.
    const needle = citationNeedle(chunkTextOf(h), text);
    if (needle.length === 0) return [];
    const start = text.indexOf(needle);
    if (start < 0) return [];
    return [{
      type: 'file_citation',
      file_id: h.fileId,
      filename: h.filename,
      // END of the span, matching the captured OpenAI behaviour — the last
      // character's index, so `end_index - 1` rather than `end_index`.
      index: start + needle.length - 1,
      start_index: start,
      end_index: start + needle.length,
    }];
  });

  return { text, annotations: annotations.sort((a, b) => a.start_index - b.start_index) };
}
