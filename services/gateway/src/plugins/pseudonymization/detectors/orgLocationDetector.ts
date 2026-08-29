/**
 * Tier 1: Organisation and location detectors.
 *
 * Both categories refuse to guess. Organisations are recognised ONLY by an explicit
 * legal-form suffix; locations ONLY by a literal term the operator configured. Neither
 * infers anything from capitalisation, because over-masking is the more dangerous error
 * here: a masked value the model then fabricates a variant of produces a placeholder that
 * exists in no reverse map and can never be unmasked (see commit f236892). A missed value
 * is merely missed.
 *
 * The gazetteer ships EMPTY. Place names identify a deployment, and this repository is
 * public — they belong in operator configuration, never in tracked code.
 */
import { EntityMatch, MaskingConfig } from '../types';
import { EXCLUDED_WORDS, HONORIFICS_AND_SALUTATIONS } from './nerDetector';
import { DETECTOR_CONFIDENCE } from './confidenceScores';

/** Escape a configured literal so it cannot act as a regex. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One capitalised token plus its trailing whitespace, used to walk a leading run. */
const LEADING_TOKEN = /[A-Z][\w&'-]*\s+/g;

/**
 * Words that must NOT be trimmed off the front of an organisation match, even though
 * they're in EXCLUDED_WORDS for the person heuristic. The general rule: any shared-set
 * term that can legitimately OPEN a real organisation name has to be kept here, or
 * trimming it truncates the entity instead of just dropping prose ahead of it. Two
 * groups currently qualify:
 *
 *  - "the": commonly opens a real legal name ("The Home Depot Inc").
 *  - Every term in HONORIFICS_AND_SALUTATIONS: nothing stops an organisation's own name
 *    from starting with one of these words the same way a person's name can be preceded
 *    by one used as a title (e.g. "Hola Cafe Inc", "Sr Perez Holdings Inc"). Spread in
 *    from nerDetector's export rather than hand-copied so a future addition to that list
 *    is automatically protected here too, instead of silently reintroducing this bug.
 *
 * Leaving a kept word in the mask is harmless and deterministic — every occurrence trims
 * identically, so the placeholder is still stable across turns — whereas trimming it
 * risks cutting a real word off the organisation name, the exact failure this detector
 * exists to avoid.
 *
 * Spanish articles ('la', 'el', ...) do NOT need a place in this set for a different
 * reason than the two groups above: they were never added to EXCLUDED_WORDS in the first
 * place, because they occur inside real compound surnames ("De La Cruz") — see the
 * comment on EXCLUDED_WORDS in nerDetector.ts. There's nothing in the shared set for the
 * org-side trim to strip, so no carve-out is needed to protect them.
 */
const ORG_LEADING_KEPT_WORDS = new Set(['the', ...HONORIFICS_AND_SALUTATIONS]);

const ORG_LEADING_EXCLUDED_WORDS = new Set(
  [...EXCLUDED_WORDS].filter(word => !ORG_LEADING_KEPT_WORDS.has(word)),
);

/**
 * Organisations: a run of 1-5 capitalised tokens immediately followed by a configured
 * legal form. The suffix is part of the entity, so "Acme Industries Inc" masks whole
 * rather than leaving a dangling "Inc".
 *
 * The leading run is greedy so it doesn't stop short and leave part of the name
 * unmasked, but that means it also swallows ordinary capitalised prose ahead of the
 * name — "Please Contact Acme Industries Inc" — since nothing in the pattern itself
 * marks where the organisation starts. Rather than shrinking the run (which would
 * truncate the name instead), the leading run is captured separately and any tokens
 * at its front that are ordinary sentence-position words (EXCLUDED_WORDS, shared with
 * nerDetector's person heuristic for the same reason) are trimmed off before the match
 * is emitted. A masked span that includes surrounding prose hashes differently per
 * sentence (placeholders are content-derived, commit 6b314a7), so the same organisation
 * would mint unrelated placeholders across turns — trimming keeps the entity, and only
 * the entity, in the match.
 */
function detectOrgs(text: string, suffixes: string[]): EntityMatch[] {
  if (suffixes.length === 0) return [];

  const trimmedSuffixes = suffixes.map(suffix => suffix.trim()).filter(suffix => suffix.length > 0);
  if (trimmedSuffixes.length === 0) return [];

  // Each configured suffix ALSO matches fully upper-cased: "ACME GMBH" is the same
  // organisation as "Acme GmbH", and before this the ALL-CAPS form was invisible to the
  // detector — which is what left `ACME GMBH` unmasked after task 1's shape veto claimed
  // it (task-1-report.md, fix-round item 5). Deliberately NOT a case-insensitive regex:
  // the configured form and its upper-case twin, nothing else, so lower-case "limited"
  // in prose is still not a legal form.
  const matchableSuffixes = [...new Set(
    trimmedSuffixes.flatMap(suffix => [suffix, suffix.toUpperCase()]),
  )];

  // Longest suffix first so "Inc." wins over "Inc" on the same span.
  const alternation = [...matchableSuffixes]
    .sort((a, b) => b.length - a.length)
    .map(suffix => escapeLiteral(suffix))
    .join('|');

  // Case-sensitive by design (see matchableSuffixes above).
  // Group 1 captures the leading token run so it can be trimmed independently below.
  // Group 2 captures the matched suffix itself, so the trailing-period trim below can
  // be decided from the suffix that actually matched rather than from the span's tail.
  // Trailing (?![\w-]) matches the location detector's boundary below so a hyphenated
  // continuation ("Corporation-wide") is not absorbed into the organisation match.
  const pattern = new RegExp(
    String.raw`\b((?:[A-Z][\w&'-]*\s+){1,5})(${alternation})(?![\w-])`,
    'g',
  );

  const matches: EntityMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const leadingRun = m[1];
    const matchedSuffix = m[2];
    LEADING_TOKEN.lastIndex = 0;
    let tokenMatch: RegExpExecArray | null;
    let trimEnd = 0;
    let foundRealToken = false;
    while ((tokenMatch = LEADING_TOKEN.exec(leadingRun)) !== null) {
      const word = tokenMatch[0].trim();
      if (ORG_LEADING_EXCLUDED_WORDS.has(word.toLowerCase())) {
        trimEnd = tokenMatch.index + tokenMatch[0].length;
        continue;
      }
      foundRealToken = true;
      break;
    }
    // The entire leading run was ordinary prose words with no real name token: nothing
    // to mask as an organisation (a bare suffix like "Inc" alone is not an entity).
    if (!foundRealToken) continue;

    const start = m.index + trimEnd;
    let end = m.index + m[0].length;
    let original = text.slice(start, end);

    // A matched suffix ending in a literal period is ambiguous: the same source text
    // results whether that period belongs to the abbreviation or terminates the
    // sentence. The decision must be CONTEXT-FREE — made from the span alone, never
    // from what follows it — because a per-occurrence (right-context) decision lets
    // the identical organisation name produce two different spans depending on
    // sentence position, which mints two different content-derived placeholders for
    // one entity (placeholders are content-derived, commit 6b314a7; the resulting
    // unresolvable residue is commit f236892's failure).
    //
    // The rule: trim the trailing period only if the MATCHED SUFFIX without it is
    // itself a configured suffix. This mirrors the unconditional trailing-punctuation
    // trim regexDetectors.ts applies to credential values, but conditioned rather than
    // unconditional — an unconditional trim corrupts a legal form whose period is
    // part of the name (e.g. "Acme S.A." -> "Acme S.A", "Fabrikam B.V." -> "Fabrikam
    // B.V"). Conditioning on the suffix list means "Inc."/"Inc" unify only when both
    // are configured (stripping the period leaves the still-valid suffix "Inc"), and
    // "S.A." is left alone (stripping leaves "S.A", which is not itself configured).
    //
    // The check is deliberately against `matchedSuffix` (group 2, exactly what the
    // alternation matched) rather than against the span's tail: a raw tail test like
    // `original.endsWith(suffix)` fires on any configured suffix that happens to be a
    // string-tail of a longer legal form — e.g. with suffixes ['S.A.', 'A'], the span
    // "Acme S.A" (period already stripped) ends with the unrelated configured suffix
    // "A", which would wrongly license the trim. Comparing the matched suffix itself
    // has no such false positive, since the alternation is sorted longest-first and
    // `matchedSuffix` is exactly the one legal form the regex actually matched.
    //
    // A span can only end in '.' when `matchedSuffix` ends in '.': the (?![\w-])
    // lookahead prevents a sentence-ending period from being absorbed after a
    // period-less suffix, so a trailing period in `original` is always the final
    // character of `matchedSuffix` too. Reducing `end` by one keeps the period in the
    // surrounding text rather than deleting it.
    if (matchedSuffix.endsWith('.')) {
      const withoutPeriod = matchedSuffix.slice(0, -1);
      // Against the MATCHABLE set, not the configured one: an upper-cased "INC." must
      // unify with "INC" exactly as "Inc." unifies with "Inc", or the same organisation
      // shouted would mint a placeholder the un-shouted form never produces.
      if (matchableSuffixes.includes(withoutPeriod)) {
        original = original.slice(0, -1);
        end -= 1;
      }
    }

    matches.push({
      original,
      type: 'profile-org',
      start,
      end,
      priority: 1,
      // The operator's configured legal form IS the validation — the same argument that
      // exempts this category from the technical-context veto.
      confidence: DETECTOR_CONFIDENCE.validatedRegex,
    });
  }
  return matches;
}

/**
 * Locations: literal, case-insensitive, whole-word matches against the configured
 * gazetteer. Multi-word entries match as complete phrases only.
 */
function detectLocations(text: string, gazetteer: string[]): EntityMatch[] {
  if (gazetteer.length === 0) return [];

  // Longest first so "Rivertown Heights" wins over a bare "Rivertown" entry.
  const alternation = [...gazetteer]
    .filter(term => term.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map(term => escapeLiteral(term.trim()))
    .join('|');
  if (alternation.length === 0) return [];

  const pattern = new RegExp(String.raw`(?<![\w-])(?:${alternation})(?![\w-])`, 'gi');

  const matches: EntityMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({
      original: m[0],
      type: 'profile-location',
      start: m.index,
      end: m.index + m[0].length,
      priority: 1,
      // A literal the operator put in the gazetteer: nothing was inferred.
      confidence: DETECTOR_CONFIDENCE.validatedRegex,
    });
  }
  return matches;
}

export function detectOrgLocationEntities(text: string, config: MaskingConfig): EntityMatch[] {
  const enabled = new Set((config.entities || []).filter(e => e.enabled !== false).map(e => e.type));
  const matches: EntityMatch[] = [];

  if (enabled.has('profile-org')) {
    matches.push(...detectOrgs(text, config.org_suffixes ?? []));
  }
  if (enabled.has('profile-location')) {
    matches.push(...detectLocations(text, config.location_gazetteer ?? []));
  }
  return matches;
}
