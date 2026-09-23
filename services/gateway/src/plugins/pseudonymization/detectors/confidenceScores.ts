/**
 * The confidence tables — base score per detector tier, and the adjustments.
 *
 * A module of its own, with NO imports, for one structural reason: every detector needs
 * the base scores, and the scorer that consumes them (`confidence.ts`) needs
 * `technicalContext.ts`, which in turn needs `nerDetector.ts`'s honorific list. Putting the
 * tables in the scorer closed that ring, and Node resolved the cycle by handing
 * `technicalContext` a half-initialised `nerDetector` — a module-load crash the moment a
 * detector was imported first. Constants with no dependencies cannot take part in a cycle.
 *
 * The numbers are the spec's (2026-08-25-pseudonymization-precision, Decisions/Confidence).
 */

/**
 * Base score per detector tier.
 *
 * `propnRun` is 0.5 — the spec's table said 0.35, raised by coordinator ruling (fix round
 * 2). Two reasons, both measured. Task 1's veto already removes the identifiers, SQL and
 * code that heuristic used to sweep up, so what reaches scoring is a capitalised multi-token
 * run with no technical shape — which IS a name by default. And the wink-nlp entity tier
 * never fires with the shipped lite model, so this tier is the ONLY detector of personal
 * names there is; anything below the threshold here means no name detection at all. The
 * evidence that a run is NOT a name is now carried by the negative adjustments — a technical
 * line, an ALL-CAPS token, a run of ordinary English words — rather than by a base too low
 * to mask anything.
 *
 * `validatedRegex` covers a tier-1 rule whose PATTERN is the evidence: a checksum
 * (`validate`) or a format exact enough to stand alone (an e-mail, an SSN, a street
 * address). `anchoredRegex` covers a rule that only fires next to a trigger word, whether
 * the trigger lives in the pattern (`captureValue`) or beside it (`anchor`) — the
 * structure alone is weak there, which is precisely why it is anchored.
 *
 * The organisation and location detectors also score `validatedRegex`: their "validation"
 * is an operator-configured legal-form suffix or gazetteer literal, which is stronger
 * evidence than any pattern — the same argument that made them exempt from the veto.
 */
export const DETECTOR_CONFIDENCE = {
  custom: 1.0,
  validatedRegex: 0.95,
  anchoredRegex: 0.85,
  ner: 0.7,
  dictionary: 0.5,
  propnRun: 0.5,
  /**
   * `Surname, Given:` heading a line of a text that shows it is a transcript (the label repeats,
   * or the line carries a cue). Scored like an anchored rule: the structure around the words is
   * the evidence, the words alone would be none. See detectors/speakerLabelDetector.ts.
   */
  speakerLabel: 0.85,
} as const;

/**
 * How the evidence around a span moves its score.
 *
 * Each fires at most ONCE per span, however many tokens or triggers qualify: they are
 * evidence that a condition holds, not a count of it.
 */
export const CONFIDENCE_ADJUSTMENTS = {
  /** An honorific, `Dear`, `contact:` … within 40 characters BEFORE the span. */
  honorific: 0.3,
  /** An e-mail address or a phone number within 40 characters on either side. */
  contactAdjacency: 0.2,
  /** Some token of the span is a common given name. */
  firstName: 0.15,
  /**
   * The span IS the whole content of a quoted string literal — a SQL `'…'` or a JSON string
   * VALUE. That is where a real name sits in a dump or a payload, and it is the one position
   * inside machinery that argues FOR a value rather than against it. It cancels
   * `technicalLine` exactly, so a name in a JSON value or a SQL literal scores its base.
   */
  dataLiteral: 0.15,
  /**
   * The span's LINE is machinery: SQL keyword sequences, identifiers, JSON keys, a fence, a
   * path or a URL. Not a veto — task 1's classifier already vetoed what it could prove — but
   * a line built out of object names is weak evidence against everything on it.
   */
  technicalLine: -0.15,
  /**
   * EVERY token of the span is an ordinary English word — `Senior Auditor`, `Data Transfer
   * Process`. Two capitalised common nouns are a heading or a job title far more often than
   * a person, and the capitalised-run heuristic cannot tell the difference.
   */
  commonWords: -0.15,
  /** Some token of the span is an ALL-CAPS word — an object name far more often than a shout. */
  allCaps: -0.3,
  /** The span sits inside a code fence or a SQL statement (and is not a quoted literal). */
  codeContext: -0.3,
} as const;

/** Threshold applied to a category with no entry in `thresholds`. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/*
 * There is deliberately NO saturation adjustment here.
 *
 * The spec had one (-0.2 once a request carried more than `saturation_warn` distinct
 * values) and it was removed in fix round 3, because it is a cliff rather than a slope: a
 * roster of 41 names masked NOTHING while the same roster of 30 masked all of them. The
 * quantity of PII in a request is not evidence about any one value in it, and a rule that
 * silently stops masking exactly when a request carries the most personal data is the
 * opposite of what this plugin is for.
 *
 * Saturation stays a REPORTING signal — task 3 logs it and ships it on the SIEM event. It
 * must never lower a score.
 */

