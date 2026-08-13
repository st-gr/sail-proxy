/**
 * Task 9: `file_citation` annotations whose character offsets survive unmasking.
 *
 * THE DEFECT THIS SUITE EXISTS TO CATCH IS SILENT. An annotation carries character
 * offsets into the assistant's message text. The model writes that text containing
 * PLACEHOLDERS, and unmasking CHANGES STRING LENGTHS — `MASKED_PERSON_1` is 15
 * characters, `Jo` is 2. An offset computed against the masked text therefore points at
 * the wrong words once the client sees the unmasked one. Nothing throws; the citation
 * simply underlines the wrong phrase.
 *
 * So every fixture below deliberately makes the masked and unmasked forms DIFFER IN
 * LENGTH. A fixture whose placeholder and replacement happen to be the same length
 * passes whether or not any remapping exists, which is worse than no test at all.
 *
 * The second silent case is the empty needle: `''.indexOf` aside, `text.indexOf('')` is
 * `0`, not `-1`, so a chunk with no usable sentence would anchor a zero-length citation
 * at the start of the message rather than producing none. Pinned by
 * "produces no annotation for a chunk with no usable sentence".
 *
 * Nothing is mocked. `citations.ts` is pure, and the ReplacementMap is the real class —
 * a hand-built stand-in would not reproduce `unmaskText`'s `map.size === 0` short
 * circuit, which is exactly the trap `mapWith` documents below.
 *
 * @see ../src/plugins/fileSearch/citations.ts
 * @see ../src/plugins/pseudonymization/unmasker.ts - unmaskText, the length change
 */
import { describe, it, expect } from '@jest/globals';
import type { SearchHit } from '../src/fileSearch/search';
import { ReplacementMap } from '../src/plugins/pseudonymization/replacementMap';
import {
  buildCitations, citationNeedle, CITATION_NEEDLE_MAX_LENGTH, CITATION_NEEDLE_MIN_LENGTH,
} from '../src/plugins/fileSearch/citations';

/**
 * A ReplacementMap carrying exactly the given placeholder -> original pairs.
 *
 * BOTH directions are written, and `forward` is not decorative: `unmaskText` returns the
 * text untouched when `map.size === 0`, and `size` reads `forward.size`. A reverse-only
 * fixture would silently disable unmasking altogether and make this entire suite vacuous
 * — every assertion about "the unmasked text" would be asserting about the masked one.
 *
 * Real placeholders in this codebase are content-derived (`MASKED_PERSON_06034362`); the
 * short `MASKED_PERSON_1` form is used here only because the length contrast against `Jo`
 * is the point. `getPlaceholder` cannot mint a chosen token, so the pairs are registered
 * directly.
 */
function mapWith(pairs: Record<string, string>): ReplacementMap {
  const map = new ReplacementMap('pseudonymization');
  for (const [placeholder, original] of Object.entries(pairs)) {
    map.forward.set(original, placeholder);
    map.reverse.set(placeholder, original);
  }
  return map;
}

/** One retrieval hit in the RAW shape `execute()` puts on `payload.hits`. */
function hit(text: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    fileId: 'file_abc123',
    filename: 'quarterly-report.md',
    score: 0.87,
    attributes: {},
    content: [{ type: 'text', text }],
    ...overrides,
  };
}

describe('fileSearch citations', () => {
  describe('buildCitations', () => {
    it('computes annotation indices against the UNMASKED text', () => {
      // The fixture MUST make masked and unmasked lengths differ, or the test passes
      // whether or not any remapping exists. `MASKED_PERSON_1` is 15 chars, `Jo` is 2.
      const map = mapWith({ MASKED_PERSON_1: 'Jo' });
      const maskedText = 'As MASKED_PERSON_1 reported, revenue rose.';
      const unmasked = 'As Jo reported, revenue rose.';

      const { text, annotations } = buildCitations(maskedText, [hit('revenue rose')], map);

      expect(text).toBe(unmasked);
      expect(annotations).toHaveLength(1);
      const a = annotations[0];
      expect(text.slice(a.start_index, a.end_index)).toBe('revenue rose');
      expect(a.type).toBe('file_citation');
      expect(a.file_id).toBe('file_abc123');
      expect(a.filename).toBe('quarterly-report.md');
      // And the offsets are NOT the ones the masked text would have produced: 29 there,
      // 16 here. Without this line an implementation that never unmasks could still
      // satisfy the slice above if the two happened to coincide.
      expect(a.start_index).toBe(unmasked.indexOf('revenue rose'));
      expect(a.start_index).not.toBe(maskedText.indexOf('revenue rose'));
    });

    it('handles multiple substitutions of differing lengths in one message', () => {
      const map = mapWith({
        MASKED_PERSON_1: 'Jo',
        MASKED_EMAIL_1: 'a-very-long-address@example.com',
      });
      const masked = 'MASKED_PERSON_1 wrote to MASKED_EMAIL_1 about revenue.';

      const { text, annotations } = buildCitations(masked, [hit('revenue')], map);

      // One replacement shrinks the text, the other grows it. An implementation that
      // adjusted offsets by a single delta rather than re-locating in the final text
      // lands in the wrong place here.
      expect(text).toBe('Jo wrote to a-very-long-address@example.com about revenue.');
      expect(annotations).toHaveLength(1);
      const a = annotations[0];
      expect(text.slice(a.start_index, a.end_index)).toBe('revenue');
    });

    it('anchors a citation whose span CONTAINS a placeholder', () => {
      // The realistic shape, and the one an offsets-against-masked-text implementation
      // cannot fake: the cited sentence itself spans the substitution. The needle comes
      // from the RAW chunk (`Jo ...`) while the model wrote `MASKED_PERSON_1 ...`, so the
      // phrase exists in the unmasked text and NOWHERE in the masked one.
      const map = mapWith({ MASKED_PERSON_1: 'Jo' });
      const masked = 'Per the file: MASKED_PERSON_1 reported that revenue rose. Anything else?';

      const { text, annotations } = buildCitations(
        masked, [hit('Jo reported that revenue rose.')], map);

      expect(annotations).toHaveLength(1);
      const a = annotations[0];
      expect(text.slice(a.start_index, a.end_index)).toBe('Jo reported that revenue rose.');
    });

    it('produces no annotation when the cited phrase is absent from the message', () => {
      const { annotations } = buildCitations('Nothing relevant.', [hit('revenue')], mapWith({}));
      expect(annotations).toEqual([]);
    });

    it('never emits an annotation with a negative index', () => {
      // `indexOf` returns -1 for a miss, and an unguarded -1 makes a well-formed-looking
      // annotation that slices from the END of the string. The matching hit is present so
      // that dropping the guard yields TWO annotations, not zero — a length assertion
      // alone would not distinguish "guard removed" from "nothing matched".
      const map = mapWith({ MASKED_PERSON_1: 'Jo' });
      const { annotations } = buildCitations(
        'As MASKED_PERSON_1 reported, revenue rose.',
        [hit('never appears anywhere'), hit('revenue rose')],
        map);

      expect(annotations).toHaveLength(1);
      for (const a of annotations) {
        expect(a.index).toBeGreaterThanOrEqual(0);
        expect(a.start_index).toBeGreaterThanOrEqual(0);
        expect(a.end_index).toBeGreaterThan(a.start_index);
      }
    });

    it('anchors on the chunk\'s longest sentence, not the whole chunk', () => {
      // The model quotes ONE sentence of a multi-sentence passage — the ordinary case.
      // A needle of the whole chunk appears nowhere in the message, so this is the test
      // that fails if `citationNeedle` ever returns `chunkText` unchanged.
      const chunk = 'Short note. Revenue rose sharply in the fourth quarter across all regions. '
        + 'See appendix.';
      // The quote is byte-exact, including case: `indexOf` is not fuzzy, and a fixture
      // that differs only in case would fail for a reason unrelated to the needle.
      const { annotations } = buildCitations(
        'From the report: Revenue rose sharply in the fourth quarter across all regions.',
        [hit(chunk)],
        mapWith({}));

      expect(annotations).toHaveLength(1);
      expect(annotations[0].start_index).toBe(17);
    });

    it('produces no annotation for a chunk with no usable sentence', () => {
      // `text.indexOf('')` is 0, not -1. Without an explicit empty-needle guard an empty
      // or whitespace-only chunk anchors a zero-length citation at offset 0.
      const message = 'As MASKED_PERSON_1 reported, revenue rose.';
      expect(buildCitations(message, [hit('')], mapWith({ MASKED_PERSON_1: 'Jo' })).annotations)
        .toEqual([]);
      expect(buildCitations(message, [hit('   \n  ')], mapWith({ MASKED_PERSON_1: 'Jo' })).annotations)
        .toEqual([]);
    });

    it('keeps index, start_index and end_index consistent with each other', () => {
      const map = mapWith({ MASKED_PERSON_1: 'Jo' });
      const { text, annotations } = buildCitations(
        'MASKED_PERSON_1 says revenue rose.', [hit('revenue rose')], map);

      const a = annotations[0];
      // `index` is the END of the span — the LAST character's offset — verified
      // against a real OpenAI response on 2026-08-06: for a 100-character text
      // it returned index 99, the final '.'. It is where a renderer places the
      // footnote marker, so it trails the quotation.
      //
      // start_index/end_index are our extension and keep the half-open
      // convention, so the relationship is index === end_index - 1.
      expect(a.end_index).toBe(a.start_index + 'revenue rose'.length);
      expect(a.index).toBe(a.end_index - 1);
      expect(text.slice(a.start_index, a.end_index)).toBe('revenue rose');
      // The character `index` actually points at is the last of the quotation.
      expect(text[a.index]).toBe('e');
    });

    it('emits annotations in TEXT order, not hit (relevance) order', () => {
      // Hits arrive in score order. Emitting them as-is gives non-monotonic offsets, and a
      // client splicing citation markers left-to-right corrupts its own offsets the moment
      // they go backwards. The higher-scoring hit here is the one that appears LATER.
      const map = mapWith({ MASKED_PERSON_1: 'Jo' });
      const { text, annotations } = buildCitations(
        'MASKED_PERSON_1 says revenue rose and costs fell.',
        [hit('costs fell', { fileId: 'file_costs', filename: 'costs.md', score: 0.9 }),
          hit('revenue rose', { fileId: 'file_rev', filename: 'revenue.md', score: 0.4 })],
        map);

      expect(annotations.map((a) => a.file_id)).toEqual(['file_rev', 'file_costs']);
      expect(annotations.map((a) => a.start_index))
        .toEqual([...annotations.map((a) => a.start_index)].sort((x, y) => x - y));
      expect(text.slice(annotations[0].start_index, annotations[0].end_index)).toBe('revenue rose');
      expect(text.slice(annotations[1].start_index, annotations[1].end_index)).toBe('costs fell');
    });

    it('spans exactly the quoted sentence of a multi-sentence chunk', () => {
      // THE PRODUCTION SHAPE, and the one every other assertion here misses: a real chunk
      // is ~800 tokens and many sentences, and the model quotes ONE. Every fixture whose
      // chunk IS its own needle leaves `end_index` free to be `start + chunk.length` —
      // which slices past the end of the message and nothing notices.
      const quoted = 'Revenue rose sharply in the fourth quarter across every region.';
      const chunk = `Preamble about the reporting period. ${quoted} `
        + 'A closing remark that is also part of this passage.';
      const map = mapWith({ MASKED_PERSON_1: 'Jo' });

      const { text, annotations } = buildCitations(
        `MASKED_PERSON_1 writes: ${quoted} Anything else?`, [hit(chunk)], map);

      expect(annotations).toHaveLength(1);
      const a = annotations[0];
      expect(text.slice(a.start_index, a.end_index)).toBe(quoted);
      expect(a.end_index).toBeLessThanOrEqual(text.length);
      // Derived from the module, not restated: the span is the needle, never the chunk.
      expect(a.end_index - a.start_index).toBe(citationNeedle(chunk, text).length);
      expect(a.end_index - a.start_index).toBeLessThan(chunk.length);
    });

    it('anchors on a SHORTER sentence when the longest one was not quoted', () => {
      // Blind longest-sentence selection misses whenever the model quotes anything but the
      // longest sentence — most of the time, for a real chunk. The message-aware search is
      // what turns this from "no citation" into a correct one.
      const quoted = 'Revenue rose sharply in Q4 across every region.';
      const longest = 'The board also approved a dividend increase of eleven percent for the '
        + 'coming financial year.';
      const chunk = `${longest} ${quoted}`;

      const { text, annotations } = buildCitations(
        `Per the file: ${quoted}`, [hit(chunk)], mapWith({}));

      expect(longest.length).toBeGreaterThan(quoted.length);
      expect(annotations).toHaveLength(1);
      expect(text.slice(annotations[0].start_index, annotations[0].end_index)).toBe(quoted);
    });

    it('refuses to anchor on a sentence below the minimum needle length', () => {
      // The floor is what keeps the message-aware search honest. `Yes.` appears in the
      // answer for reasons having nothing to do with the passage; anchoring on it would
      // trade a VISIBLE ABSENCE (no citation) for an INVISIBLE WRONG (a citation
      // underlining unrelated text) — the exact defect class this module exists to prevent.
      const chunk = 'Yes. Revenue rose sharply in the fourth quarter across every region.';
      const { annotations } = buildCitations(
        'The answer is: Yes. The file says nothing further about regions.',
        [hit(chunk)], mapWith({}));

      expect(annotations).toEqual([]);
    });

    it('joins multi-part chunk content with a newline, not a space', () => {
      // The separator is load-bearing whenever a part does not end in sentence punctuation:
      // the two parts then form ONE needle, and the separator is a literal character of it.
      // `descriptor.ts` shows the deployment the newline-joined form, so that is the text
      // the model read and the only form worth searching for.
      const chunk = hit('', {
        content: [{ type: 'text', text: 'Revenue rose sharply across all regions' },
          { type: 'text', text: 'and costs fell by twelve percent.' }],
      });
      const joined = 'Revenue rose sharply across all regions\nand costs fell by twelve percent.';

      const withNewline = buildCitations(`It says: ${joined}`, [chunk], mapWith({}));
      expect(withNewline.annotations).toHaveLength(1);
      expect(withNewline.text.slice(
        withNewline.annotations[0].start_index,
        withNewline.annotations[0].end_index)).toBe(joined);

      // And the space-joined form is NOT what we search for, so it cannot anchor the
      // WHOLE joined chunk.
      //
      // This used to assert zero annotations. The partial-quote fallback in
      // `citationNeedle` changed that, on purpose: a message that reproduces most of a
      // chunk now anchors the part it does reproduce rather than nothing at all. The
      // separator is still load-bearing and this still proves it — reaching the full
      // joined span requires the newline, which is what the half above shows. What the
      // space-joined message gets is a strictly shorter span, and one that is real text
      // in the message either way.
      const spaceJoined = buildCitations(
        'It says: Revenue rose sharply across all regions and costs fell by twelve percent.',
        [chunk], mapWith({}));
      expect(spaceJoined.annotations).toHaveLength(1);
      const anchored = spaceJoined.text.slice(
        spaceJoined.annotations[0].start_index, spaceJoined.annotations[0].end_index);
      expect(anchored).not.toBe(joined);
      expect(anchored.length).toBeLessThan(joined.length);
      // Whatever it anchored is genuinely present in the message — the invariant that
      // keeps `indexOf` from ever going negative and inventing an offset.
      expect(spaceJoined.text).toContain(anchored);
    });

    it('leaves the text untouched when the request has no replacement map', () => {
      // Masking off for this request. Absent config must mean unchanged behaviour, and
      // there is nothing to unmask against either way.
      const { text, annotations } = buildCitations(
        'Revenue rose sharply.', [hit('Revenue rose sharply.')], undefined);

      expect(text).toBe('Revenue rose sharply.');
      expect(annotations).toHaveLength(1);
      expect(annotations[0].start_index).toBe(0);
    });

    it('joins a multi-part chunk the same way the descriptor renders it', () => {
      const chunk = hit('', { content: [{ type: 'text', text: 'Revenue rose sharply.' },
        { type: 'text', text: 'Costs fell.' }] });
      const { annotations } = buildCitations(
        'It says: Revenue rose sharply.', [chunk], mapWith({}));

      expect(annotations).toHaveLength(1);
      expect(annotations[0].start_index).toBe(9);
    });

    it('survives an empty hit list and a malformed hit', () => {
      expect(buildCitations('Anything.', [], mapWith({})).annotations).toEqual([]);
      expect(buildCitations('Anything.', undefined as any, mapWith({})).annotations).toEqual([]);
      expect(buildCitations('Anything.', [{} as any], mapWith({})).annotations).toEqual([]);
    });
  });

  describe('citationNeedle', () => {
    it('yields an empty needle for an empty chunk', () => {
      expect(citationNeedle('')).toBe('');
      expect(citationNeedle('   ')).toBe('');
    });

    it('yields the sentence itself for a single-sentence chunk', () => {
      expect(citationNeedle('Revenue rose sharply in Q4.')).toBe('Revenue rose sharply in Q4.');
    });

    it('yields the LONGEST sentence, not the first and not the whole chunk', () => {
      const chunk = 'Short. Revenue rose sharply in the fourth quarter. Also short.';
      expect(citationNeedle(chunk)).toBe('Revenue rose sharply in the fourth quarter.');
    });

    it('truncates a sentence longer than the cap rather than dropping it', () => {
      const long = `Revenue ${'x'.repeat(200)} rose.`;
      const needle = citationNeedle(long);

      expect(needle.length).toBeGreaterThan(0);
      expect(needle.length).toBeLessThanOrEqual(CITATION_NEEDLE_MAX_LENGTH);
      expect(long.startsWith(needle)).toBe(true);
      expect(CITATION_NEEDLE_MAX_LENGTH).toBe(120);
    });

    it('prefers the longest sentence that ACTUALLY OCCURS in the message', () => {
      const quoted = 'Revenue rose sharply in Q4 across every region.';
      const longest = 'The board also approved a dividend increase of eleven percent for the '
        + 'coming financial year.';
      const chunk = `${longest} ${quoted}`;

      // Blind (no message): the longest sentence, unchanged from before this existed.
      expect(citationNeedle(chunk)).toBe(longest);
      // Message-aware: the sentence the message actually contains.
      expect(citationNeedle(chunk, `Per the file: ${quoted}`)).toBe(quoted);
      // And it falls back to blind when the message quotes neither.
      expect(citationNeedle(chunk, 'A paraphrase of the whole thing.')).toBe(longest);
    });

    it('never lets a sentence below the floor win the message-aware search', () => {
      const chunk = 'Yes. Revenue rose sharply in the fourth quarter across every region.';
      const long = 'Revenue rose sharply in the fourth quarter across every region.';

      expect('Yes.'.length).toBeLessThan(CITATION_NEEDLE_MIN_LENGTH);
      expect(long.length).toBeGreaterThanOrEqual(CITATION_NEEDLE_MIN_LENGTH);
      // `Yes.` is in the message and the long sentence is not — the search still declines
      // it and falls back to blind, which then simply fails to anchor.
      expect(citationNeedle(chunk, 'The answer is: Yes. Nothing further.')).toBe(long);
      expect(CITATION_NEEDLE_MIN_LENGTH).toBe(30);
    });

    it('anchors a partial quote when the model reformats what it quotes', () => {
      // THE case from a live run on 2026-08-07. The model quoted the sentence in full,
      // in order, and added markdown emphasis — so `includes` was false and a correctly
      // cited answer carried zero annotations.
      const chunk = 'The Kestrel Protocol was ratified in 1987 by the Aurelian Assembly.';
      const message = 'According to the document:\n\n'
        + '> "The Kestrel Protocol was ratified in **1987** by the **Aurelian Assembly**."';

      const needle = citationNeedle(chunk, message);
      expect(message).toContain(needle);                // the invariant: it is really there
      expect(needle.length).toBeGreaterThanOrEqual(CITATION_NEEDLE_MIN_LENGTH);
      expect(chunk).toContain(needle);                  // and it really came from the chunk
      expect(needle).toBe('The Kestrel Protocol was ratified in');
    });

    it('takes the LONGEST partial run, not the first one it finds', () => {
      const chunk = 'Costs fell by twelve percent this year. '
        + 'Revenue rose sharply across every region in the fourth quarter.';
      // Both sentences are reformatted; the second leaves a longer intact run.
      const message = 'Costs fell by **twelve** percent this year. '
        + 'Revenue rose sharply across every region in the **fourth** quarter.';

      expect(citationNeedle(chunk, message)).toBe('Revenue rose sharply across every region in the');
    });

    it('runs only AFTER an exact sentence match fails, never instead of one', () => {
      // The two passes must be able to DISAGREE here or this proves nothing: the partial
      // pass finds a whole sentence too when one is quoted verbatim, so a naive fixture
      // gets the same answer either way and the ordering goes untested.
      //
      // Short sentence, quoted in full. Long sentence, quoted all but its last two words —
      // leaving a partial run LONGER than the short sentence. Exact-match-first must still
      // pick the short one.
      const short = 'Revenue rose sharply in the fourth quarter.';
      const long = 'The board also approved a dividend increase of eleven percent for the coming year.';
      const chunk = `${long} ${short}`;
      const partOfLong = 'The board also approved a dividend increase of eleven percent for the';
      const message = `It notes: ${short} It adds: ${partOfLong} — details pending.`;

      expect(partOfLong.length).toBeGreaterThan(short.length);   // the passes disagree
      expect(message).toContain(short);
      expect(message).not.toContain(long);

      expect(citationNeedle(chunk, message)).toBe(short);
    });

    it('declines a partial run below the floor and falls back to blind', () => {
      const chunk = 'Revenue rose sharply across every region in the fourth quarter.';
      // Shares only short fragments — nothing near 30 characters.
      const message = 'The quarter was fine and revenue was up.';

      const needle = citationNeedle(chunk, message);
      expect(needle).toBe(chunk);          // blind fallback, exactly as before
      expect(message).not.toContain(needle); // so it anchors nothing, which is correct
    });

    it('still returns a below-floor sentence when it is the whole chunk', () => {
      // The floor bounds the SEARCH, not the blind fallback. A one-short-sentence chunk
      // anchors exactly as it did before the search existed — this is what makes "never a
      // worse anchor than blind selection" true rather than merely likely.
      expect(citationNeedle('Revenue fell.', 'It says: Revenue fell.')).toBe('Revenue fell.');
    });

    it('splits on ! and ? as well as .', () => {
      expect(citationNeedle('Wow! Did revenue really rise that sharply? No.'))
        .toBe('Did revenue really rise that sharply?');
    });
  });
});
