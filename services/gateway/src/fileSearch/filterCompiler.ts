// Compiles OpenAI-style attribute filter ASTs (eq/ne/gt/gte/lt/lte/in/nin, and/or)
// into parameterised SQL fragments over the `vector_store_files.attributes` jsonb
// column. This module is pure: no I/O, no database.
//
// SECURITY: `filter` is attacker-controlled (it comes straight from the client's
// file_search tool call). Every attribute *key* and *value* MUST travel as a bound
// parameter — never string-templated into the SQL — and every `type` MUST be
// checked against a literal allowlist. A previous task on this plan shipped an
// allowlist implemented with the `in` operator over a plain object, which a
// `__proto__`-shaped input walked straight through (because `in` also matches
// inherited properties like `toString`/`constructor`). This module uses `Map`/`Set`
// allowlists (whose `.has()` only ever matches entries we inserted ourselves) and
// only ever reads OWN properties off attacker-supplied nodes, so a node with a
// tampered or unusual prototype chain cannot smuggle a value past validation.

export interface CompileResult {
  sql: string;
  params: any[];
  nextIndex: number;
}

// Cheap denial-of-service guard: an attacker can nest `and`/`or` arbitrarily deep
// to blow the recursion (call) stack. This limit is generous for any real filter
// (OpenAI's own file_search filters rarely nest more than 2-3 levels) while
// keeping recursion shallow enough that it can never threaten the stack.
// Pinned by test: a 10-deep filter must compile, an 11-deep filter must throw.
const MAX_FILTER_DEPTH = 10;

// Cheap denial-of-service guard: an `in`/`nin` array is bound as a single
// parameter (safe from injection either way), but an unbounded array still costs
// query-planning and network time proportional to its size. This cap is far above
// any legitimate metadata filter while still being a hard ceiling.
// Pinned by test: an array of exactly this length must compile, one longer must throw.
const MAX_IN_ARRAY_LENGTH = 10_000;

// Cheap denial-of-service guard, independent of MAX_FILTER_DEPTH: depth limits
// stack recursion but do nothing to stop a *wide* tree — thousands of sibling
// leaves under a single `and`/`or` at depth 1. Each leaf costs 2-3 bound
// parameters and tens of bytes of SQL text; a request body well within the
// gateway's upload limit can otherwise produce hundreds of thousands of
// parameters and megabytes of generated SQL (observed to trip Postgres's int16
// parameter-count wraparound and to guarantee slow/failed requests well before
// that). 512 leaves is far beyond any realistic metadata filter — a filter with
// many acceptable values for one key should use `in`, not hundreds of `or`'d
// `eq` siblings — while keeping worst-case parameter count in the low thousands.
// Pinned by test: exactly 512 leaves must compile, 513 must throw.
const MAX_TOTAL_LEAVES = 512;

const COMPARISON_OPERATORS: ReadonlyMap<string, string> = new Map([
  ['eq', '='],
  ['ne', '<>'],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
]);

const ORDINAL_OPERATORS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * THE MISSING-KEY ARM, and why `ne`/`nin` are not a plain SQL negation.
 *
 * `attributes` is free-form per-file jsonb: a file attached to a store may simply
 * not carry the key a filter names, and the column itself is nullable (a file
 * attached with no attributes at all stores SQL NULL, not `{}`). A naive
 * `(attributes->>'dept') <> 'legal'` evaluates to NULL for both of those rows,
 * and `WHERE NULL` excludes them — so `ne dept legal` silently drops every file
 * that has no `dept` at all. That is the opposite of what a caller means: a file
 * with no `dept` is emphatically NOT "a file whose dept is legal", so `ne` must
 * return it. The same argument applies to `nin`. OpenAI does not specify the
 * behaviour; this is the reading that matches how callers describe the filter,
 * and it is recorded as a documented divergence in the parity matrix.
 *
 * `eq` keeps the opposite behaviour — a row lacking the key is NOT equal to
 * anything and stays excluded. That asymmetry is deliberate and pinned by test.
 *
 * The arm is written `(attributes ? $k) IS NOT TRUE` rather than
 * `NOT (attributes ? $k)`, because `?` against a SQL-NULL `attributes` yields
 * NULL, and `NOT NULL` is NULL — which would exclude exactly the attribute-less
 * rows this arm exists to include. `IS NOT TRUE` collapses both NULL (column is
 * SQL NULL) and FALSE (key absent from the object) to TRUE.
 *
 * Pinned by test: dropping this arm from `ne`, dropping it from `nin`, or adding
 * one to `eq` each fails a named test.
 */
const MISSING_KEY_ARM = (index: number): string => `(vsf.attributes ? $${index}) IS NOT TRUE`;
const COMPOUND_OPERATORS: ReadonlySet<string> = new Set(['and', 'or']);
const INCLUSION_OPERATORS: ReadonlySet<string> = new Set(['in', 'nin']);

/**
 * ARRAY-MEMBERSHIP operators, and why they are not substring matching.
 *
 * The names invite the reading "does this string contain that substring". They do
 * not mean that. Probed against the real API on 2026-08-06:
 *
 *   contains  tag  "beta"    -> 400 "Filter type (contains) requires metadata
 *                                    key 'tag' to be a list"
 *   contains  tags "gamma"   -> 200, matched only the file whose `tags` ARRAY
 *                                    holds "gamma"
 *
 * So the attribute must be a JSON array and the operator asks about membership.
 * Note this also means OpenAI accepts ARRAY-valued attributes, which their
 * published type (string | number | boolean) does not mention.
 *
 * `ncontainsany tags ["gamma"]` matched the two files carrying NO `tags` key at
 * all — so the negative forms include the missing-key rows, exactly as `ne`/`nin`
 * do here. That is measured behaviour, not our reading this time.
 */
const MEMBERSHIP_OPERATORS: ReadonlySet<string> = new Set([
  'contains', 'ncontains', 'containsany', 'ncontainsany',
]);
const MEMBERSHIP_MULTI: ReadonlySet<string> = new Set(['containsany', 'ncontainsany']);
const MEMBERSHIP_NEGATED: ReadonlySet<string> = new Set(['ncontains', 'ncontainsany']);

// What an unsupported-operator error says INSTEAD of quoting the operator it was given.
//
// `type` is caller-supplied and unbounded, it arrives inside `body.filters`, and
// `body.filters` is never walked by pseudonymization — so echoing it puts caller text
// into a `RecallInputError` message, and `RecallInputError` is one of the classes
// `fileSearch/descriptor.ts` is ALLOWED to log. That made the allow-list leaky through a
// class that is on it. Reproduced before this was fixed, with PII in the operator field:
//
//   [warn] file_search call call_2 failed: file_search_unavailable
//          (RecallInputError: Invalid attribute filter:
//           Unsupported filter type: "Jane Doe, MRN 4471")
//
// The supported list is fixed and derived from this module's own operator tables, never
// from input, so naming it leaks nothing — and it is strictly more useful to a caller
// debugging a typo than their own typo echoed back. Same principle as
// `assertOrdinalValue`, which likewise declines to echo `value`.
//
// An allow-listed class is only as safe as the messages it carries: adding a class to
// LOGGABLE_MESSAGE_CLASSES is a promise about every `new`-site of that class, including
// the ones in other modules.
const UNSUPPORTED_TYPE_MESSAGE = `Filter "type" must be one of: ${
  [...COMPOUND_OPERATORS, ...COMPARISON_OPERATORS.keys(), ...INCLUSION_OPERATORS,
   ...MEMBERSHIP_OPERATORS].join(', ')}`;

interface CompileState {
  params: any[];
  index: number;
  leafCount: number;
}

export function compileFilter(filter: unknown, startIndex: number): CompileResult {
  // Number.isInteger admits values like 2**53, where `index++` is a no-op in
  // floating point — key and value would then collapse onto the same
  // placeholder, silently misbinding params. Number.isSafeInteger rejects that.
  if (!Number.isSafeInteger(startIndex) || startIndex < 1) {
    throw new Error('compileFilter: startIndex must be a positive safe integer');
  }
  const state: CompileState = { params: [], index: startIndex, leafCount: 0 };
  const sql = compileNode(filter, state, 1);
  return { sql, params: state.params, nextIndex: state.index };
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Reads an OWN property only — never inherited — so a node whose prototype chain
// carries attacker-influenced junk (or a shared/frozen object with unexpected
// inherited fields) cannot supply a value we didn't literally see in the payload.
function readOwn(obj: Record<string, unknown>, key: string): unknown {
  return hasOwn(obj, key) ? obj[key] : undefined;
}

function isPlainFilterNode(node: unknown): node is Record<string, unknown> {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// A NUL byte is valid JSON inside a string but Postgres's text encoding cannot
// represent it: `[22021] invalid byte sequence for encoding "UTF8": 0x00`. Left
// unchecked, a client-controlled key or value reaches the database and turns
// into an unhandled 500 rather than a clean 400. Reject it during compilation,
// where it can still be reported as a normal validation error.
// (Built via fromCharCode rather than a literal escape so no raw NUL byte lives
// in this source file.)
const NUL_BYTE = String.fromCharCode(0);

function assertNoNulByte(value: string, label: string): void {
  if (value.includes(NUL_BYTE)) {
    throw new Error(`Filter "${label}" must not contain a NUL byte`);
  }
}

function compileNode(node: unknown, state: CompileState, depth: number): string {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds the maximum supported depth of ${MAX_FILTER_DEPTH}`);
  }
  if (!isPlainFilterNode(node)) {
    throw new Error('Filter node must be a plain object');
  }

  const type = readOwn(node, 'type');
  if (typeof type !== 'string') {
    throw new Error('Filter node must have a string "type"');
  }

  if (COMPOUND_OPERATORS.has(type)) {
    return compileCompound(node, type as 'and' | 'or', state, depth);
  }
  if (COMPARISON_OPERATORS.has(type)) {
    return compileComparison(node, type, state);
  }
  if (INCLUSION_OPERATORS.has(type)) {
    return compileInclusion(node, type as 'in' | 'nin', state);
  }
  if (MEMBERSHIP_OPERATORS.has(type)) {
    return compileMembership(node, type, state);
  }
  throw new Error(UNSUPPORTED_TYPE_MESSAGE);
}

function readKey(node: Record<string, unknown>): string {
  const key = readOwn(node, 'key');
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Filter "key" must be a non-empty string');
  }
  assertNoNulByte(key, 'key');
  return key;
}

// Counts leaf (comparison/inclusion) nodes across the *whole* tree and enforces
// MAX_TOTAL_LEAVES. Called once per leaf, from within the leaf compiler
// functions rather than compileNode, so a compound node itself never counts —
// only the actual parameter-producing predicates do (see the constant's
// rationale above).
function countLeaf(state: CompileState): void {
  state.leafCount += 1;
  if (state.leafCount > MAX_TOTAL_LEAVES) {
    throw new Error(`Filter has too many leaf conditions (max ${MAX_TOTAL_LEAVES})`);
  }
}

function assertScalarValue(value: unknown): asserts value is string | number | boolean {
  if (!isScalar(value)) {
    throw new Error('Filter "value" must be a string, number, or boolean');
  }
  if (typeof value === 'string') {
    assertNoNulByte(value, 'value');
  }
}

// The COLUMN side of an ordinal comparison is already guarded (see the
// CASE/jsonb_typeof fragment in compileComparison), but the VALUE side is not:
// it is bound as an untyped parameter against a `numeric` expression, so
// Postgres coerces it to `numeric` and throws `[22P02] invalid input syntax for
// type numeric: "<the caller's value>"` for anything that is not a number.
// That is an unhandled 500 out of a routine caller mistake -- `{"type":"gte",
// "key":"hired","value":"2026-01-01"}` is the obvious one -- and, worse, the
// driver's message ECHOES THE CALLER'S VALUE VERBATIM into a `pg` DatabaseError
// that then reaches two log lines (repository.ts's recall catch and
// descriptor.ts's tool-exec catch). `body.filters` is not pseudonymized, so
// that value is unmasked. Rejecting it here turns a 500-shaped failure into the
// 400 it always was.
//
// The message names the operator and the offending TYPE, never the value: this
// error is wrapped into `RecallInputError` by recallCandidates and
// RecallInputError's messages are the ones descriptor.ts is allowed to log.
function assertOrdinalValue(value: string | number | boolean, type: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Filter "value" for the ordinal operator "${type}" must be a finite number, got ${
        typeof value === 'number' ? 'a non-finite number' : `a ${typeof value}`}`);
  }
}

function compileComparison(node: Record<string, unknown>, type: string, state: CompileState): string {
  countLeaf(state);
  const key = readKey(node);
  const value = readOwn(node, 'value');
  assertScalarValue(value);

  const op = COMPARISON_OPERATORS.get(type);
  /* istanbul ignore next -- guarded by the COMPARISON_OPERATORS.has() check in compileNode */
  if (!op) {
    throw new Error(UNSUPPORTED_TYPE_MESSAGE);
  }

  if (ORDINAL_OPERATORS.has(type)) {
    assertOrdinalValue(value, type);
    // `attributes` is free-form per-file JSON: nothing stops one file in a
    // store from having a non-numeric value under a key another file uses
    // numerically. A plain `(text)::numeric` cast throws
    // `[22P02] invalid input syntax for type numeric` for the *whole query* the
    // moment it hits one such row — a client-triggerable 500 from ordinary,
    // legitimate data, not just hostile input. An `AND`-guarded cast doesn't
    // fix this either: Postgres does not guarantee left-to-right short-circuit
    // evaluation of AND, so a non-numeric row can still reach the cast.
    // Guarding the cast inside a CASE/jsonb_typeof check instead makes a
    // non-numeric (or missing) value simply not match — the same semantics
    // OpenAI's file_search gives a type-mismatched attribute — rather than
    // erroring. The key is bound twice (once for the type check, once for the
    // cast) since it is referenced twice in the fragment.
    //
    // That guard covers the COLUMN side only. The bound value on the right of
    // `op` is coerced to `numeric` by Postgres and would throw the very same
    // 22P02 -- with the caller's value quoted into the driver message -- which
    // is what `assertOrdinalValue` above rejects before the SQL is ever built.
    const typeofIndex = state.index++;
    const castIndex = state.index++;
    const valueIndex = state.index++;
    state.params.push(key, key, value);
    return (
      `(CASE WHEN jsonb_typeof(vsf.attributes->$${typeofIndex}) = 'number' ` +
      `THEN (vsf.attributes->>$${castIndex})::numeric END) ${op} $${valueIndex}`
    );
  }

  if (type === 'ne') {
    // See MISSING_KEY_ARM. The key is bound twice because the fragment
    // references it twice.
    //
    // The comparison stays `<>` rather than `IS DISTINCT FROM`. The two differ
    // only for a key that EXISTS carrying a JSON `null` value (where `->>` also
    // yields SQL NULL), and `validateAttributes` rejects `null` as an attribute
    // value outright, so no row reachable through this API has one.
    // `IS DISTINCT FROM` is NULL-total, so it would produce the right answer
    // for every attribute-less row ON ITS OWN — turning the arm above into dead
    // SQL that the tests below claim is load-bearing. `<>` keeps the arm the
    // thing actually doing the work, so removing it fails a BEHAVIOURAL test
    // and not merely a string-shape one.
    const existsIndex = state.index++;
    const keyIndex = state.index++;
    const valueIndex = state.index++;
    state.params.push(key, key, value);
    return (
      `(${MISSING_KEY_ARM(existsIndex)} `
      + `OR (vsf.attributes->>$${keyIndex}) ${op} $${valueIndex})`
    );
  }

  const keyIndex = state.index++;
  const valueIndex = state.index++;
  state.params.push(key, value);
  return `(vsf.attributes->>$${keyIndex}) ${op} $${valueIndex}`;
}

/**
 * `contains` / `ncontains` / `containsany` / `ncontainsany` — membership in an
 * ARRAY-valued attribute. See MEMBERSHIP_OPERATORS for the probed semantics.
 *
 * The SQL uses jsonb containment (`@>`) rather than unnesting, so it can use a
 * GIN index on `attributes` if one is ever added, and so element comparison is
 * jsonb-typed: `contains n 1` does not match the string `"1"`, matching how
 * `eq` already distinguishes them.
 *
 * `jsonb_typeof(...) = 'array'` guards the containment test because `@>` on a
 * non-array (say a plain string attribute) is not an error in Postgres — it
 * quietly answers for object/scalar containment instead, which would make
 * `contains tag "beta"` match a scalar `tag` and diverge from OpenAI, who
 * rejects that request outright. We return no match rather than raising: the
 * attribute's type is per-ROW data, not a property of the request, so there is
 * no point at which we could 400 the way they do. Recorded as a divergence.
 */
function compileMembership(node: Record<string, unknown>, type: string, state: CompileState): string {
  countLeaf(state);
  const key = readKey(node);
  const value = readOwn(node, 'value');

  let elements: unknown[];
  if (MEMBERSHIP_MULTI.has(type)) {
    if (!Array.isArray(value)) {
      throw new Error(`Filter "value" for ${type} must be an array`);
    }
    if (value.length === 0) {
      throw new Error(`Filter "value" for ${type} must be a non-empty array`);
    }
    if (value.length > MAX_IN_ARRAY_LENGTH) {
      throw new Error(`Filter "value" for ${type} must not exceed ${MAX_IN_ARRAY_LENGTH} entries`);
    }
    for (const item of value) assertScalarValue(item);
    elements = value;
  } else {
    assertScalarValue(value);
    elements = [value];
  }

  // One containment test per candidate element, ORed: `@>` with a multi-element
  // array means "contains ALL of these", which is `containsall` — not the
  // any-of semantics probed for containsany.
  const keyIndex = state.index++;
  state.params.push(key);
  const tests = elements.map((el) => {
    const i = state.index++;
    state.params.push(JSON.stringify(el));
    return `(vsf.attributes->$${keyIndex}) @> $${i}::jsonb`;
  });
  const positive = `(jsonb_typeof(vsf.attributes->$${keyIndex}) = 'array' AND (${tests.join(' OR ')}))`;

  if (!MEMBERSHIP_NEGATED.has(type)) return positive;

  // Negated forms include rows lacking the key entirely — measured, not assumed:
  // `ncontainsany tags ["gamma"]` returned the two files with no `tags` at all.
  // `IS NOT TRUE` collapses both NULL (no attributes column) and FALSE, for the
  // same reason MISSING_KEY_ARM does.
  return `((${positive}) IS NOT TRUE)`;
}

function compileInclusion(node: Record<string, unknown>, type: 'in' | 'nin', state: CompileState): string {
  countLeaf(state);
  const key = readKey(node);
  const value = readOwn(node, 'value');
  if (!Array.isArray(value)) {
    throw new Error('Filter "value" for in/nin must be an array');
  }
  if (value.length === 0) {
    throw new Error('Filter "value" for in/nin must be a non-empty array');
  }
  if (value.length > MAX_IN_ARRAY_LENGTH) {
    throw new Error(`Filter "value" for in/nin must not exceed ${MAX_IN_ARRAY_LENGTH} entries`);
  }
  for (const item of value) {
    assertScalarValue(item);
  }

  if (type === 'nin') {
    // See MISSING_KEY_ARM: a row that has no such key is not a row whose value
    // is one of these, so it must come back. The key is bound twice because the
    // fragment references it twice.
    const existsIndex = state.index++;
    const keyIndex = state.index++;
    const valueIndex = state.index++;
    state.params.push(key, key, value);
    return (
      `(${MISSING_KEY_ARM(existsIndex)} `
      + `OR NOT ((vsf.attributes->>$${keyIndex}) = ANY($${valueIndex})))`
    );
  }

  const keyIndex = state.index++;
  const valueIndex = state.index++;
  state.params.push(key, value);

  return `(vsf.attributes->>$${keyIndex}) = ANY($${valueIndex})`;
}

function compileCompound(
  node: Record<string, unknown>,
  type: 'and' | 'or',
  state: CompileState,
  depth: number,
): string {
  const filters = readOwn(node, 'filters');
  if (!Array.isArray(filters) || filters.length === 0) {
    throw new Error(`Filter "filters" for "${type}" must be a non-empty array`);
  }

  const parts = filters.map((child) => compileNode(child, state, depth + 1));
  const joiner = type === 'and' ? ' AND ' : ' OR ';
  return `(${parts.join(joiner)})`;
}
