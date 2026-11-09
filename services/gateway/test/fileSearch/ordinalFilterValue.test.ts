/**
 * FINAL WHOLE-BRANCH REVIEW, CRITICAL #1 — a caller's own filter value reaching the logs
 * verbatim, through an error class nobody here wrote.
 *
 * THE SHAPE OF THE BUG. `compileComparison` already guards the COLUMN side of an ordinal
 * comparison with `CASE WHEN jsonb_typeof(...) = 'number'`, so a store row carrying a
 * non-numeric value under the filtered key simply fails to match. The VALUE side had no
 * such guard: it is bound as an untyped parameter against a `numeric` expression, so
 * Postgres coerces it and raises
 *
 *     [22P02] invalid input syntax for type numeric: "Jane Doe, MRN 4471"
 *
 * — reproduced live against pgvector before this fix, with `err.status === undefined`, i.e.
 * an unhandled 500 rather than the 400 a malformed filter has always been. `body.filters`
 * is never walked by pseudonymization, so the quoted string is the caller's own, unmasked,
 * and `recallCandidates` and `fileSearchDescriptor.execute` each logged it.
 *
 * `{"type":"gte","key":"hired","value":"2026-01-01"}` is the routine caller mistake that
 * triggers it — a date against a numeric operator, not hostile input.
 *
 * TWO INDEPENDENT DEFENCES, TESTED SEPARATELY, because either one alone leaves a hole:
 *   1. reject the filter (here)                — the 400 the caller is owed
 *   2. gate what gets logged (below, and in
 *      responses-filesearch-error-gate.test.ts) — because 1 cannot anticipate the NEXT
 *                                                 unaudited thrower
 */
import { describe, it, expect } from '@jest/globals';
import { compileFilter } from '../../src/fileSearch/filterCompiler';
import { driverErrorCode, redactDriverError } from '../../src/fileSearch/repository';

const ORDINALS = ['gt', 'gte', 'lt', 'lte'] as const;

describe('ordinal filter operators reject a non-numeric value', () => {
  it.each(ORDINALS)('%s refuses a string value rather than letting Postgres coerce it', (type) => {
    expect(() => compileFilter({ type, key: 'hired', value: '2026-01-01' }, 1))
      .toThrow(/ordinal operator/);
  });

  it.each(ORDINALS)('%s refuses a boolean value', (type) => {
    expect(() => compileFilter({ type, key: 'k', value: true }, 1)).toThrow(/ordinal operator/);
  });

  it.each(ORDINALS)('%s refuses a non-finite number (NaN and Infinity are not numerics)', (type) => {
    expect(() => compileFilter({ type, key: 'k', value: NaN }, 1)).toThrow(/ordinal operator/);
    expect(() => compileFilter({ type, key: 'k', value: Infinity }, 1)).toThrow(/ordinal operator/);
  });

  it('does NOT echo the offending value into the message', () => {
    // This message is wrapped into `RecallInputError` by `recallCandidates`, and
    // RecallInputError is on descriptor.ts's allow-list of classes whose `message` may be
    // logged. Interpolating the value here would reintroduce the very leak the throw
    // exists to close, one layer up.
    const value = 'Jane Doe, MRN 4471';
    try {
      compileFilter({ type: 'gte', key: 'hired', value }, 1);
      throw new Error('expected compileFilter to throw');
    } catch (err: any) {
      expect(err.message).not.toContain(value);
      expect(err.message).not.toContain('Jane');
      expect(err.message).toContain('gte');
    }
  });

  it('still compiles a numeric value, including 0 and a negative — the guard is not "truthy"', () => {
    // A `if (!value)` style check would reject 0, which is a perfectly good bound and the
    // one a naive implementation drops.
    for (const value of [0, -1, 2020, 3.5]) {
      const { sql, params } = compileFilter({ type: 'gte', key: 'year', value }, 1);
      expect(sql).toBe(
        "(CASE WHEN jsonb_typeof(vsf.attributes->$1) = 'number' THEN (vsf.attributes->>$2)::numeric END) >= $3");
      expect(params).toEqual(['year', 'year', value]);
    }
  });

  it('leaves eq/ne/in/nin accepting strings — only the ORDINAL operators cast', () => {
    // The narrowing must not have leaked into the operators that compare as text; a
    // string is the normal case for those and rejecting it would break every caller.
    expect(compileFilter({ type: 'eq', key: 'dept', value: 'legal' }, 1).params).toEqual(['dept', 'legal']);
    expect(() => compileFilter({ type: 'ne', key: 'dept', value: 'legal' }, 1)).not.toThrow();
    expect(() => compileFilter({ type: 'in', key: 'dept', value: ['legal', 'hr'] }, 1)).not.toThrow();
    expect(() => compileFilter({ type: 'nin', key: 'dept', value: ['legal'] }, 1)).not.toThrow();
  });

  it('rejects a nested ordinal too — the check is in the leaf compiler, not the entry point', () => {
    expect(() => compileFilter({
      type: 'and',
      filters: [
        { type: 'eq', key: 'dept', value: 'legal' },
        { type: 'or', filters: [{ type: 'lt', key: 'hired', value: 'yesterday' }] },
      ],
    }, 1)).toThrow(/ordinal operator/);
  });
});

/**
 * RE-REVIEW BLOCKER 2 — the same leak through the OPERATOR field instead of the value
 * field, and this time through a class that IS on the allow-list.
 *
 * `compileFilter`'s unsupported-operator error used to be
 * `` `Unsupported filter type: ${JSON.stringify(type)}` ``. `type` is caller-supplied,
 * unbounded, and part of `body.filters`, which pseudonymization never walks.
 * `recallCandidates` wraps that message into `RecallInputError`, and `RecallInputError` is
 * on `descriptor.ts`'s `LOGGABLE_MESSAGE_CLASSES` — so it was logged in full. Reproduced
 * before the fix:
 *
 *   [warn] file_search call call_2 failed: file_search_unavailable
 *          (RecallInputError: Invalid attribute filter:
 *           Unsupported filter type: "Jane Doe, MRN 4471")
 *
 * `safeErrorMessage` could not have stopped this: it decides WHOSE message may be logged,
 * never what is in it. The fix has to be at the throw site, which is what these pin.
 */
describe('an unsupported filter operator is never echoed back', () => {
  const PII = 'Jane Doe, MRN 4471';

  it('does not quote the caller\'s `type` — the operator field is caller-controlled text', () => {
    try {
      compileFilter({ type: PII, key: 'hired', value: 1 }, 1);
      throw new Error('expected compileFilter to throw');
    } catch (err: any) {
      expect(err.message).not.toContain(PII);
      expect(err.message).not.toContain('Jane');
    }
  });

  it('names the supported operators instead, which is fixed text and more useful', () => {
    // Derived from this module's own operator tables, never from input — so it stays
    // correct if an operator is added, and leaks nothing either way.
    try {
      compileFilter({ type: 'greaterthan', key: 'k', value: 1 }, 1);
      throw new Error('expected compileFilter to throw');
    } catch (err: any) {
      expect(err.message).toContain('must be one of');
      for (const op of ['and', 'or', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']) {
        expect(err.message).toContain(op);
      }
      expect(err.message).not.toContain('greaterthan');
    }
  });

  it('holds for a NESTED unsupported operator too', () => {
    try {
      compileFilter({ type: 'and', filters: [{ type: PII, key: 'k', value: 1 }] }, 1);
      throw new Error('expected compileFilter to throw');
    } catch (err: any) {
      expect(err.message).not.toContain(PII);
    }
  });

  it('holds for a non-string `type`, which JSON.stringify would also have echoed', () => {
    // `{"type": {"secret": "…"}}` serialized the whole object into the message.
    try {
      compileFilter({ type: { secret: PII } as any, key: 'k', value: 1 }, 1);
      throw new Error('expected compileFilter to throw');
    } catch (err: any) {
      expect(err.message).not.toContain(PII);
    }
  });

  it('leaves the operator-name interpolations that are NOT caller-controlled alone', () => {
    // `assertOrdinalValue` and `compileCompound` both interpolate `type`, and both run only
    // AFTER it has matched a fixed operator set — so what they interpolate is one of this
    // module's own literals, not the caller's string. A blanket "never interpolate type"
    // rule would have cost these their diagnosability for no gain.
    expect(() => compileFilter({ type: 'gte', key: 'k', value: 'x' }, 1)).toThrow(/gte/);
    expect(() => compileFilter({ type: 'and', filters: [] }, 1)).toThrow(/"and"/);
  });
});

/**
 * The second defence: what `recallCandidates` is allowed to LOG when the driver throws.
 *
 * `logger.error`'s third parameter is serialized as `{name, message, stack}`, so passing a
 * `pg` DatabaseError straight through logs its message TWICE — once as the field, and once
 * more inside `stack`, whose first line V8 builds as `${name}: ${message}`. Both copies
 * carry the caller's value.
 */
describe('driver-error redaction keeps the diagnosis and drops the caller data', () => {
  /** The exact error shape `pg` produced for the live reproduction. */
  function pgError(): any {
    const err: any = new Error('invalid input syntax for type numeric: "Jane Doe, MRN 4471"');
    err.name = 'error';
    err.code = '22P02';
    return err;
  }

  it('reports the SQLSTATE, never the message', () => {
    expect(driverErrorCode(pgError())).toBe('22P02');
  });

  it('falls back to the class name when there is no SQLSTATE, still never the message', () => {
    const bare: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    bare.name = 'AggregateError';
    expect(driverErrorCode(bare)).toBe('AggregateError');
    expect(driverErrorCode(undefined)).toBe('unknown_error');
  });

  it('redacts the message AND the stack header, keeping the frames', () => {
    const redacted = redactDriverError(pgError());

    expect(redacted.message).toBe('22P02');
    expect(redacted.message).not.toContain('Jane Doe');
    // The stack is where a naive redaction leaks: `stack` embeds the original message in
    // its own first line, so copying it across undoes the redaction silently.
    expect(redacted.stack).not.toContain('Jane Doe');
    expect(redacted.stack).not.toContain('invalid input syntax');
    expect(redacted.stack!.split('\n')[0]).toBe('error: 22P02');
    // Still diagnostic: the call frames survive.
    expect(redacted.stack!.split('\n').length).toBeGreaterThan(1);
    expect(redacted.stack).toContain('    at ');
  });

  it('survives an error with no stack at all', () => {
    const redacted = redactDriverError({ code: '22P05', name: 'error', message: 'secret' });
    expect(redacted.message).toBe('22P05');
    expect(redacted.stack).toBe('error: 22P05');
  });
});
