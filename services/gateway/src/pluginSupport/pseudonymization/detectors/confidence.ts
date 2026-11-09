/**
 * Confidence scoring and thresholds.
 *
 * Task 1 gave the pipeline a VETO: a candidate span that is plainly part of the text's
 * machinery is dropped outright. A veto is all-or-nothing, and its widest rule — "an
 * ALL-CAPS word of four letters or more is an identifier" — costs real recall: `JOHN
 * SMITH` in a header, `Dear MARIA SCHNEIDER,` in a letter and `ACME GMBH` in an invoice
 * were all silently unmasked (task-1-report.md, false-negative class 1).
 *
 * Because that veto runs first, what reaches this module is already free of identifiers,
 * SQL columns, JSON keys, paths and code. A capitalised multi-token run that survives it is
 * a NAME by default — which is why the run heuristic's base is 0.5 and the work here is
 * finding the evidence AGAINST: a machinery line, an ALL-CAPS token, a run of ordinary
 * English words. Scoring the other way round (a low base, hunting for evidence FOR) is what
 * fix round 2 replaced: it turned every layout that is not a sentence — a table row, a CSV
 * line, a bullet, a chat prefix, a `Subject:` header, a JSON value, a SQL literal — into a
 * silent false negative.
 *
 * This module is the graduated answer the spec asks for. Every match carries a score; the
 * evidence around it moves that score; and one configurable threshold decides. Nothing
 * here masks anything new on its own — scoring can only reorder and filter candidates the
 * detectors already produced.
 *
 * Two invariants keep this from re-opening what task 1 closed:
 *
 *  - The veto still runs FIRST. A vetoed span never reaches the gate, so an object name
 *    cannot buy its way back in by sitting next to an honorific.
 *  - EXEMPT_FROM_SUPPRESSION types take NO NEGATIVE ADJUSTMENT AT ALL — shape or code
 *    context. A secret is opaque by construction, an IBAN is upper-case by format, a
 *    configured location may be shouted, and code is exactly where a credential lives.
 *    Penalising any of them is the same mistake the veto exemption exists to prevent, one
 *    tier down: a fenced `password: …` must stay masked however high an operator sets the
 *    bar.
 */

import { EntityMatch, MaskingConfig } from '../types';
import {
  EXEMPT_FROM_SUPPRESSION,
  PERSON_CONTEXT_WORDS,
  hasTriggerWord,
  inCodeContext,
} from './technicalContext';
import {
  CONFIDENCE_ADJUSTMENTS,
  DEFAULT_MIN_CONFIDENCE,
} from './confidenceScores';
import { EXCLUDED_WORDS } from './nerDetector';

// Re-exported so the scorer stays the single import site for everything about scoring;
// the tables live in their own dependency-free module (see confidenceScores.ts).
export {
  DETECTOR_CONFIDENCE,
  CONFIDENCE_ADJUSTMENTS,
  DEFAULT_MIN_CONFIDENCE,
} from './confidenceScores';

/** Window for the honorific and contact-adjacency evidence, per the spec. */
const EVIDENCE_WINDOW = 40;

/** One whitespace token, stripped of surrounding punctuation. */
function bareTokens(span: string): string[] {
  return span
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/^[^A-Za-z0-9_]+/, '').replace(/[^A-Za-z0-9_]+$/, ''))
    .filter(t => t.length > 0);
}

/**
 * An ALL-CAPS WORD: letters only, at least two of them. Letters only is what separates a
 * shouted word from a structured identifier — `AB123456C` (a national-insurance number)
 * and `DE89370400440532013000` (an IBAN) are upper-case but are not words, and their own
 * detectors validated them.
 */
const ALL_CAPS_TOKEN = /^[A-Z]{2,}$/;

export function hasAllCapsToken(span: string): boolean {
  return bareTokens(span).some(t => ALL_CAPS_TOKEN.test(t));
}

/** Does any token of the span appear in the given-name list? */
export function hasFirstNameToken(span: string, firstNames: ReadonlySet<string>): boolean {
  return bareTokens(span).some(t => firstNames.has(t.toLowerCase()));
}

/** An e-mail address, and a phone number carrying a real phone signal (`+`, `(`, `-`). */
const NEARBY_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const NEARBY_PHONE = /(?:\+\d|\(\d{2,4}\)|\d[\d\s.]*-)[\d\s().-]{5,}\d/;

/**
 * Is an e-mail address or a phone number within EVIDENCE_WINDOW characters either side?
 *
 * The span itself is cut out of the window first: an e-mail match must not count itself as
 * its own neighbour, and a phone number must not either.
 */
export function hasContactAdjacency(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - EVIDENCE_WINDOW), start);
  const after = text.slice(end, end + EVIDENCE_WINDOW);
  return NEARBY_EMAIL.test(before) || NEARBY_EMAIL.test(after)
    || NEARBY_PHONE.test(before) || NEARBY_PHONE.test(after);
}

/** The span's own LINE, with the span itself cut out. */
function lineAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;
  return `${text.slice(lineStart, start)} ${text.slice(end, lineEnd)}`;
}

/** Field separators for a table row, a CSV line or a tab-delimited dump. */
const FIELD_DELIMITER = /[|,;\t]/;

/**
 * The span's own FIELD — the cell of a table row or CSV line it sits in — with the span cut
 * out. Falls back to the whole line when there are no delimiters.
 *
 * This is the unit for the identifier-shaped signals below, and the reason is the incident's
 * own shape: `| Ferreira Nakamura | ZPC_FICA_TRAN_DAILY | 2026 |` is a row that pairs a
 * PERSON column with an OBJECT column, and it is precisely the row an operator most wants
 * masked. Judging it by the whole line makes the neighbouring column's identifier evidence
 * against the name, which is backwards — a name in its own cell next to an id column is a
 * name.
 */
function fieldAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline === -1 ? text.length : newline;

  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  const cutBefore = Math.max(...[...before].map((c, k) => (FIELD_DELIMITER.test(c) ? k + 1 : -1)), 0);
  const cutAfterIndex = [...after].findIndex(c => FIELD_DELIMITER.test(c));
  const cutAfter = cutAfterIndex === -1 ? after.length : cutAfterIndex;
  return `${before.slice(cutBefore)} ${after.slice(0, cutAfter)}`;
}

/**
 * Shapes that colour the span's own FIELD — the cell it sits in, see `fieldAround`: an
 * underscore identifier, a long opaque upper-case run, a camelCase token, and a JSON/YAML
 * KEY that opens the cell.
 *
 * A shouted word (`\b[A-Z]{4,}\b`) was in this set and was REMOVED in fix round 3. It cost
 * eight ordinary sentences their name: `URGENT: Ferreira Nakamura must sign`, `The
 * ACCOUNTING team says …`, `… ASAP.`, a signature line `Ferreira Nakamura | ACME GMBH |
 * Finance`, a log line carrying a level, and a table row with an id column. Capitals are how
 * people write emphasis, headers, department names and log levels — they are not evidence
 * about the name beside them. An ALL-CAPS token INSIDE the span is a different claim, and
 * `hasAllCapsToken` still makes it.
 *
 * The JSON key arrived here in fix round 4, from the line scan, and it is ANCHORED to a
 * structural position: a quoted string followed by a colon counts only where a key can
 * begin — after `{`, after a `,`, or at the start of the cell. Unanchored and line-scoped it
 * read `The "owner": field was set by Ferreira Nakamura today.` as a JSON payload, because a
 * quoted word before a colon is also how ordinary writing quotes a field name. A real
 * payload (`{"owner": "Ferreira Nakamura", …}`) still matches, and `isDataLiteral` cancels
 * it there exactly.
 *
 * Deliberately NOT included: brackets, `=` and other punctuation. `(f.n@example.invalid)` is
 * an ordinary parenthesis in an ordinary sentence, and treating punctuation as machinery
 * would call half of normal writing technical.
 */
const FIELD_SHAPE = new RegExp([
  String.raw`\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b`,
  String.raw`\b[A-Z][A-Z0-9]{19,}\b`,
  String.raw`\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b`,
  String.raw`(?:^|[{,])\s*"[^"\n]*"\s*:`,
].join('|'));

/**
 * The one shape that still colours a WHOLE LINE by itself: a code fence. Every line of a
 * fenced block is machinery, whatever its own cells look like.
 *
 * A URL and a path were here until fix round 4, and both are now gone — not narrowed to the
 * field, GONE. Narrowing does not reach the cases they cost, because an ordinary sentence
 * has no cell boundary in it: `See https://intranet.example.invalid/filings — Ferreira
 * Nakamura signed it.`, `… on www.example.invalid before Ferreira Nakamura signs.` and
 * `Ferreira Nakamura attached /var/log/filing.txt to the ticket.` are one field, one line
 * and one sentence, and each lost its name to a link that says nothing about it.
 *
 * A name INSIDE a URL or a path is the claim worth making, and task 1's classifier already
 * makes it — on the SPAN, where it can be proved: `/home/Ferreira Nakamura/` is vetoed as
 * `path` before scoring ever sees it (technicalContext.ts, the `url`/`path` rules). This is
 * the round-3 argument about shouted words, applied to the two signals that survived it.
 */
const LINE_SHAPE = /```/;

/**
 * SQL as a SEQUENCE of keywords, matched case-INSENSITIVELY and anchored to the START of the
 * line.
 *
 * Three constraints, each earned by a case that broke without it. Case-insensitive, because
 * a lower-case dump is still a dump — `select name from … where id = 1` read as ordinary
 * prose. A SEQUENCE, because one keyword alone is an ordinary English word. And anchored,
 * because a sequence alone is not enough either: "Please select the option you want from the
 * list." contains `select … from` and is a sentence. A statement begins its line; a sentence
 * that happens to use both words does not.
 *
 * The trade is a lower-case query quoted mid-sentence, which is not recognised. Task 1's
 * classifier has the same blind spot (it matches upper-case only), the evidence here is worth
 * -0.15 rather than a veto, and the alternative — calling every sentence with "select" and
 * "from" in it machinery — costs real names.
 */
const SQL_SEQUENCE = new RegExp('^\\s*(?:' + [
  String.raw`select\b[^\n]*\bfrom\b`,
  String.raw`update\b[^\n]*\bset\b`,
  String.raw`where\b[^\n]*=`,
  String.raw`insert\s+into\b`,
  String.raw`delete\s+from\b`,
  String.raw`merge\s+into\b`,
  String.raw`create\s+(?:table|view|index)\b`,
  String.raw`alter\s+table\b`,
  String.raw`drop\s+(?:table|view|index)\b`,
  String.raw`truncate\s+table\b`,
].join('|') + ')', 'i');

/**
 * Is the span's line machinery rather than text?
 *
 * Weak evidence AGAINST the candidate — a BW listing row, a log line, a SQL statement, a JSON
 * payload. Weak, not a veto: task 1's classifier already vetoed what it could prove about a
 * SPAN, and this is a claim about the span's neighbourhood. Hence -0.15 rather than a drop,
 * and hence `dataLiteral` below, which cancels it exactly where a name legitimately lives
 * inside machinery.
 *
 * Two scopes, deliberately. A neighbouring identifier or a JSON key is only evidence within
 * the span's own FIELD; a fence and a line-anchored SQL statement colour the whole LINE.
 */
export function onTechnicalLine(text: string, start: number, end: number): boolean {
  const line = lineAround(text, start, end);
  return LINE_SHAPE.test(line)
    || SQL_SEQUENCE.test(line)
    || FIELD_SHAPE.test(fieldAround(text, start, end));
}

/**
 * Is the span the WHOLE content of a quoted string literal that holds data?
 *
 * Two forms, and only two: a SQL single-quoted literal (`WHERE OWNER = 'Ferreira Nakamura'`)
 * and a JSON string VALUE — a double-quoted string whose opening quote follows a colon
 * (`"owner": "Ferreira Nakamura"`). A double-quoted string with no colon before it is a
 * quoted identifier in SQL, not data, so it does not qualify.
 *
 * This is the position where real names hide in dumps and payloads, and it is why a
 * technical line cannot be evidence against everything on it: the +0.15 here cancels the
 * -0.15 there, and such a name scores exactly its base.
 */
export function isDataLiteral(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (before === "'" && after === "'") return true;
  if (before === '"' && after === '"') {
    return /:\s*$/.test(text.slice(Math.max(0, start - 40), start - 1));
  }
  return false;
}

/**
 * Capitalised common nouns that are a heading, a column label or a job title far more often
 * than a person — the other half of what the capitalised-run heuristic sweeps up once its
 * base is high enough to mask. `Senior Auditor`, `Data Transfer Process`, `Chain Restart Log`.
 *
 * The rule for adding a word: it must be a GENERIC English noun or adjective, never a
 * surname and never a given name. `Baker`, `Fisher`, `Mason`, `Grace` and `May` are names in
 * the world and would silently unmask real people. The penalty needs EVERY token of the span
 * to be in this set (or in nerDetector's EXCLUDED_WORDS, which it extends), so one real name
 * token anywhere in the run cancels it.
 */
const GENERIC_RUN_WORDS = new Set([
  // Job titles and organisational roles
  'senior', 'junior', 'lead', 'deputy', 'chief', 'head', 'principal', 'staff',
  'auditor', 'manager', 'director', 'officer', 'analyst', 'consultant', 'engineer',
  'developer', 'administrator', 'assistant', 'associate', 'supervisor', 'specialist',
  'coordinator', 'controller', 'accountant', 'operator', 'reviewer', 'approver',
  // Process and data-warehouse vocabulary, which is what the incident was built from
  'process', 'chain', 'data', 'transfer', 'load', 'delta', 'queue', 'monitor', 'restart',
  'daily', 'hourly', 'weekly', 'monthly', 'nightly', 'quarterly', 'annual',
  'report', 'request', 'response', 'system', 'service', 'server', 'client', 'source',
  'target', 'group', 'team', 'department', 'division', 'project', 'program', 'release',
  'version', 'status', 'state', 'stage', 'step', 'task', 'job', 'batch', 'run',
  'summary', 'detail', 'master', 'header', 'footer', 'item', 'entry', 'record',
  'order', 'invoice', 'customer', 'vendor', 'supplier', 'account', 'ledger', 'journal',
  // 'field' is deliberately absent: it is a surname, and one wrong entry here unmasks a
  // real person. Same reason `baker`, `mason`, `fisher` and `carpenter` are not here.
  'table', 'view', 'index', 'column', 'row', 'level', 'type', 'category',
  'total', 'balance', 'amount', 'quantity', 'period', 'quarter', 'year', 'month', 'week',
  'error', 'warning', 'failure', 'success', 'test', 'production', 'development',
  'quality', 'change', 'update', 'insert', 'delete', 'select', 'create', 'business',
  'management', 'operations', 'finance', 'sales', 'purchasing', 'logistics', 'planning',
  'overview', 'analysis', 'review', 'approval', 'template', 'default', 'general',
]);

/** Is every token of the span an ordinary English word rather than a name? */
export function isCommonWordRun(span: string): boolean {
  const tokens = bareTokens(span);
  if (tokens.length === 0) return false;
  return tokens.every(token => {
    const word = token.toLowerCase();
    return GENERIC_RUN_WORDS.has(word) || EXCLUDED_WORDS.has(word);
  });
}

/**
 * An honorific, salutation or `contact` within EVIDENCE_WINDOW characters before the span —
 * OR inside the span itself.
 *
 * "Inside" is not a nicety. `Mr` and `Dr` are not in EXCLUDED_WORDS, so the capitalised-run
 * heuristic swallows them: the run it emits for "I spoke with Dr. Watson" is `Dr. Watson`,
 * and a strictly-backward window then sees "I spoke with" and finds nothing. The commonest
 * written form of a name would have scored 0.35 and gone unmasked. Measured before the
 * window was widened.
 *
 * Widening it costs nothing on the other side: every honorific that a run CAN swallow is
 * one of the titles above, and the words that would be dangerous inside a span — `dear`,
 * `contact`, `regards` — are in EXCLUDED_WORDS and therefore never part of a run.
 */
export function hasHonorificNear(text: string, start: number, end: number): boolean {
  return hasTriggerWord(text, end, PERSON_CONTEXT_WORDS, EVIDENCE_WINDOW + (end - start));
}

/** Everything `scoreMatch` needs that is not in the match or the text. */
export interface ScoringContext {
  firstNames: ReadonlySet<string>;
}

/** Confidence of `match` after every adjustment the surrounding text licenses, clamped to [0,1]. */
export function scoreMatch(match: EntityMatch, text: string, ctx: ScoringContext): number {
  const exempt = EXEMPT_FROM_SUPPRESSION.has(match.type);
  let score = match.confidence;

  if (hasHonorificNear(text, match.start, match.end)) score += CONFIDENCE_ADJUSTMENTS.honorific;
  if (hasContactAdjacency(text, match.start, match.end)) score += CONFIDENCE_ADJUSTMENTS.contactAdjacency;
  if (hasFirstNameToken(match.original, ctx.firstNames)) score += CONFIDENCE_ADJUSTMENTS.firstName;
  if (isDataLiteral(text, match.start, match.end)) score += CONFIDENCE_ADJUSTMENTS.dataLiteral;

  // No negative adjustment ever touches the exempt tier — see the module header. Code
  // context is included: a fenced block is exactly where a credential lives, and an
  // operator raising the threshold to 0.8 must not thereby unmask the secrets in their
  // own snippets.
  if (!exempt && hasAllCapsToken(match.original)) score += CONFIDENCE_ADJUSTMENTS.allCaps;
  if (!exempt && isCommonWordRun(match.original)) score += CONFIDENCE_ADJUSTMENTS.commonWords;
  if (!exempt && onTechnicalLine(text, match.start, match.end)) score += CONFIDENCE_ADJUSTMENTS.technicalLine;
  if (!exempt && inCodeContext(text, match.start, match.end)) score += CONFIDENCE_ADJUSTMENTS.codeContext;

  // Rounded to two decimals before clamping, and that rounding is load-bearing, not
  // cosmetic. Every number in the two tables is a multiple of 0.05, so two decimals is
  // lossless — but binary floating point is not: `0.5 - 0.15 + 0.15` evaluates to
  // 0.5000000000000001, so a name in a JSON value or a SQL literal misses a `>= 0.5` gate
  // by 1e-16 without this. A threshold an operator writes as a two-decimal number must be
  // compared against a two-decimal score.
  return Math.min(1, Math.max(0, Math.round(score * 100) / 100));
}

/**
 * Would this candidate be masked, given the resolved thresholds?
 * `perType` wins over `min` for the categories it names.
 */
export interface ResolvedThresholds {
  min: number;
  perType: Record<string, number>;
}

/** A threshold is a finite number in [0,1]; anything else is ignored rather than obeyed. */
function validThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

/**
 * Resolve the request's thresholds from its masking config.
 *
 * An out-of-range or non-numeric value is DROPPED, not clamped: the admin form and the
 * backend schema both reject such a value (`minimum: 0` / `maximum: 1`), so one arriving
 * here came from a hand-edited file, and silently turning 1.5 into 1 would mask nothing
 * while looking configured. Falling back to the default is the behaviour an operator can
 * still recognise.
 */
export function resolveThresholds(config: MaskingConfig): ResolvedThresholds {
  const min = validThreshold(config.min_confidence) ?? DEFAULT_MIN_CONFIDENCE;
  const perType: Record<string, number> = {};
  for (const [type, value] of Object.entries(config.thresholds ?? {})) {
    const valid = validThreshold(value);
    if (valid !== undefined) perType[type] = valid;
  }
  return { min, perType };
}

export function thresholdFor(type: string, thresholds: ResolvedThresholds): number {
  return thresholds.perType[type] ?? thresholds.min;
}

/**
 * Person evidence: an honorific/salutation before the span, an adjacent e-mail or phone
 * number, or a token that is a common given name. Any ONE of the three is enough.
 */
export function hasPersonEvidence(
  text: string,
  match: EntityMatch,
  firstNames: ReadonlySet<string>,
): boolean {
  return hasHonorificNear(text, match.start, match.end)
    || hasContactAdjacency(text, match.start, match.end)
    || hasFirstNameToken(match.original, firstNames);
}

/** Letters only, at least two — every token of a shouted NAME looks like this. */
const CAPS_WORD = /^[A-Z]{2,}$/;

/**
 * Does this vetoed span deserve to be SCORED as a person instead of dropped?
 *
 * The one conversion the coordinator's task-1 review asked for. `JOHN SMITH` and `MARIA
 * SCHNEIDER` are vetoed as identifiers today, and the veto cannot tell them from
 * `RSPROCESS INFOAREA`. Three conditions together can:
 *
 *  1. the candidate is a PERSON candidate (nothing else is lifted);
 *  2. every token is an ALL-CAPS WORD — letters only. `ZPC_FICA_TRAN_DAILY` (underscores),
 *     `DGCSH86VQSKEXIK70LO0HJI3A` (digits) and any SAP object key carrying either are
 *     therefore never lifted, whatever surrounds them;
 *  3. the span carries person evidence.
 *
 * A lifted span is not masked — it is SCORED, and every adjustment applies to it like to
 * any other candidate. `Dear JOHN SMITH,` reaches 0.5 + 0.3 (salutation) + 0.15 (given name)
 * - 0.3 (ALL-CAPS) = 0.65 and masks; `JOHN SMITH audited the ledger.`, with the salutation
 * gone, reaches 0.35 and does not. The gate, not the lift, is what decides.
 *
 * The lift ignores WHICH veto reason fired, deliberately. A shouted name inside a code
 * fence, a path or a SQL statement is lifted too — and then meets the -0.3 code/SQL
 * adjustment, which puts it back below the threshold. That is the whole point of the
 * conversion: the same evidence, weighed instead of applied as a switch.
 */
export function isCapsPersonCandidate(
  match: EntityMatch,
  text: string,
  firstNames: ReadonlySet<string>,
): boolean {
  if (match.type !== 'profile-person') return false;
  const tokens = bareTokens(match.original);
  if (tokens.length === 0 || !tokens.every(t => CAPS_WORD.test(t))) return false;
  return hasPersonEvidence(text, match, firstNames);
}
