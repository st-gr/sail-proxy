import { compileFilter } from '../../src/fileSearch/filterCompiler';

describe('comparison operators', () => {
  it('compiles eq with the key as a bound parameter', () => {
    const { sql, params, nextIndex } = compileFilter({ type: 'eq', key: 'category', value: 'legal' }, 1);
    expect(sql).toBe('(vsf.attributes->>$1) = $2');
    expect(params).toEqual(['category', 'legal']);
    expect(nextIndex).toBe(3);          // callers append from $3
  });

  it('honours a non-1 start index so it can be composed into a larger query', () => {
    const { sql, nextIndex } = compileFilter({ type: 'eq', key: 'k', value: 'v' }, 5);
    expect(sql).toBe('(vsf.attributes->>$5) = $6');
    expect(nextIndex).toBe(7);
  });

  it('casts numerically for ordinal operators via a jsonb_typeof guard, not a bare cast', () => {
    // A bare `(text)::numeric` cast throws for the whole query the instant any
    // row in the store has a non-numeric value under that key — a
    // client-triggerable 500 from ordinary data, not just hostile input (see
    // the integration test below). The guarded form makes a non-numeric value
    // simply not match, matching OpenAI's own semantics for a type-mismatched
    // attribute. The key is bound twice because it is referenced twice in the
    // fragment (once for the type check, once for the cast).
    const { sql, params, nextIndex } = compileFilter({ type: 'gt', key: 'year', value: 2020 }, 1);
    expect(sql).toBe("(CASE WHEN jsonb_typeof(vsf.attributes->$1) = 'number' THEN (vsf.attributes->>$2)::numeric END) > $3");
    expect(params).toEqual(['year', 'year', 2020]);
    expect(nextIndex).toBe(4);
  });

  it.each([['gte','>='],['lt','<'],['lte','<=']])('supports %s', (t, op) => {
    expect(compileFilter({ type: t, key: 'k', value: 1 }, 1).sql).toContain(op);
  });

  it('supports in', () => {
    expect(compileFilter({ type: 'in', key: 'k', value: ['a','b'] }, 1).sql)
      .toBe('(vsf.attributes->>$1) = ANY($2)');
  });
});

// The semantics these fragments produce against real rows — including the
// attribute-less ones the arms exist for — are pinned in
// test/fileSearch/integration/filterCompiler.test.ts. These tests pin the SQL
// SHAPE, so that dropping an arm is a compile-level failure too and not only a
// database-backed one (which skips without FILE_SEARCH_TEST_DSN).
describe('ne/nin include rows that lack the attribute entirely', () => {
  it('ne compiles a missing-key arm, keyed on the jsonb key-existence operator', () => {
    const { sql, params, nextIndex } = compileFilter({ type: 'ne', key: 'dept', value: 'legal' }, 1);
    expect(sql).toBe('((vsf.attributes ? $1) IS NOT TRUE OR (vsf.attributes->>$2) <> $3)');
    // NOT `IS DISTINCT FROM`: that is NULL-total and would make the arm dead SQL
    // that the behavioural tests claim is load-bearing. See compileComparison.
    expect(sql).not.toContain('IS DISTINCT FROM');
    // The key is bound twice because the fragment references it twice; every
    // value still travels as a parameter, never interpolated.
    expect(params).toEqual(['dept', 'dept', 'legal']);
    expect(nextIndex).toBe(4);
  });

  it('nin compiles a missing-key arm, keyed on the jsonb key-existence operator', () => {
    const { sql, params, nextIndex } = compileFilter({ type: 'nin', key: 'dept', value: ['legal', 'hr'] }, 1);
    expect(sql).toBe(
      '((vsf.attributes ? $1) IS NOT TRUE OR NOT ((vsf.attributes->>$2) = ANY($3)))',
    );
    expect(params).toEqual(['dept', 'dept', ['legal', 'hr']]);
    expect(nextIndex).toBe(4);
  });

  it('uses IS NOT TRUE, not NOT (...), so a SQL-NULL attributes column is caught too', () => {
    // `NULL::jsonb ? 'k'` is NULL and `NOT NULL` is NULL, which WHERE excludes —
    // so `NOT (attributes ? $k)` would drop exactly the attribute-less rows the
    // arm exists to include. A file attached with no attributes at all stores
    // SQL NULL, not '{}', so this is ordinary data rather than an edge case.
    for (const type of ['ne', 'nin'] as const) {
      const value = type === 'ne' ? 'legal' : ['legal'];
      const { sql } = compileFilter({ type, key: 'dept', value }, 1);
      expect(sql).toContain('IS NOT TRUE');
      expect(sql).not.toContain('NOT (vsf.attributes ? ');
    }
  });

  it('eq gets NO missing-key arm — the asymmetry is the point', () => {
    // A row lacking the key is not equal to anything, so `eq` must keep
    // excluding it. Giving `eq` the same arm would make every `eq` match every
    // attribute-less file in the store.
    const { sql } = compileFilter({ type: 'eq', key: 'dept', value: 'legal' }, 1);
    expect(sql).toBe('(vsf.attributes->>$1) = $2');
    expect(sql).not.toContain('?');
    expect(sql).not.toContain('IS NOT TRUE');
  });

  it('still binds a hostile key as data on the negated operators, where it is now bound twice', () => {
    // The arm doubled the number of places the key appears in the fragment;
    // both must be placeholders.
    const evil = "x') OR 1=1 --";
    for (const type of ['ne', 'nin'] as const) {
      const value = type === 'ne' ? 'v' : ['v'];
      const { sql, params } = compileFilter({ type, key: evil, value }, 1);
      expect(sql).not.toContain(evil);
      expect(sql).not.toContain('OR 1=1');
      expect(params[0]).toBe(evil);
      expect(params[1]).toBe(evil);
    }
  });
});

describe('compound operators', () => {
  it('nests and/or with correctly advancing placeholders', () => {
    const { sql, params } = compileFilter({ type: 'and', filters: [
      { type: 'eq', key: 'a', value: 1 },
      { type: 'or', filters: [ { type: 'eq', key: 'b', value: 2 }, { type: 'eq', key: 'c', value: 3 } ] },
    ] }, 1);
    expect(sql).toBe('((vsf.attributes->>$1) = $2 AND ((vsf.attributes->>$3) = $4 OR (vsf.attributes->>$5) = $6))');
    expect(params).toEqual(['a', 1, 'b', 2, 'c', 3]);
  });
});

describe('injection resistance', () => {
  it('never interpolates a key into SQL', () => {
    const evil = "x') OR 1=1 --";
    const { sql, params } = compileFilter({ type: 'eq', key: evil, value: 'v' }, 1);
    expect(sql).not.toContain('OR 1=1');
    expect(sql).not.toContain(evil);
    expect(params[0]).toBe(evil);          // travels as data, never as SQL
  });

  it('rejects an unknown operator rather than passing it through', () => {
    // The message names the SUPPORTED operators rather than echoing the rejected one:
    // `type` is caller-controlled and its message reaches a log line through an
    // allow-listed error class. `ordinalFilterValue.test.ts`'s "an unsupported filter
    // operator is never echoed back" pins the non-echoing itself.
    expect(() => compileFilter({ type: 'drop', key: 'k', value: 1 }, 1)).toThrow(/must be one of/);
    expect(() => compileFilter({ type: 'drop', key: 'k', value: 1 }, 1)).not.toThrow(/drop/);
  });

  it('rejects a non-array value for in/nin', () => {
    expect(() => compileFilter({ type: 'in', key: 'k', value: 'a' }, 1)).toThrow(/array/);
  });

  it('rejects nesting deeper than the supported limit', () => {
    let f: any = { type: 'eq', key: 'k', value: 1 };
    for (let i = 0; i < 25; i++) f = { type: 'and', filters: [f] };
    expect(() => compileFilter(f, 1)).toThrow(/nest/i);
  });
});

describe('additional hardening beyond the brief', () => {
  it('rejects a non-string key (number)', () => {
    expect(() => compileFilter({ type: 'eq', key: 42, value: 'v' }, 1)).toThrow();
  });

  it('rejects a non-string key (object)', () => {
    expect(() => compileFilter({ type: 'eq', key: { toString: () => 'k' }, value: 'v' }, 1)).toThrow();
  });

  it('rejects a null key', () => {
    expect(() => compileFilter({ type: 'eq', key: null, value: 'v' }, 1)).toThrow();
  });

  it('treats the key __proto__ as ordinary bound data, not a special case (does not throw)', () => {
    // __proto__ as a *value* for `key` is legitimate attacker-controlled data and
    // must still be bound as a parameter, never used to reach into the AST node's
    // prototype chain when the compiler reads `node.key`.
    const { sql, params } = compileFilter({ type: 'eq', key: '__proto__', value: 'v' }, 1);
    expect(sql).toBe('(vsf.attributes->>$1) = $2');
    expect(params).toEqual(['__proto__', 'v']);
  });

  it('reads an own "__proto__" property normally, as ordinary data, rather than special-casing it', () => {
    // If key is looked up via node['key'] on an object literal whose OWN key is
    // "__proto__", JS treats that specially at construction time — so this
    // constructs the object with defineProperty to guarantee an own property.
    const node: any = {};
    Object.defineProperty(node, 'type', { value: 'eq', enumerable: true });
    Object.defineProperty(node, 'key', { value: '__proto__', enumerable: true });
    Object.defineProperty(node, 'value', { value: 'v', enumerable: true });
    const { params } = compileFilter(node, 1);
    expect(params[0]).toBe('__proto__');
  });

  it('rejects a value that is a plain object for a scalar operator', () => {
    expect(() => compileFilter({ type: 'eq', key: 'k', value: { nested: true } }, 1)).toThrow();
  });

  it('rejects an empty filters array on a compound node', () => {
    expect(() => compileFilter({ type: 'and', filters: [] }, 1)).toThrow();
  });

  it('rejects a missing filters array on a compound node', () => {
    expect(() => compileFilter({ type: 'and' }, 1)).toThrow();
  });

  it('rejects a filters value that is not an array on a compound node', () => {
    expect(() => compileFilter({ type: 'and', filters: 'not-an-array' }, 1)).toThrow();
  });

  it('rejects a null filter at the top level', () => {
    expect(() => compileFilter(null, 1)).toThrow();
  });

  it('rejects an array filter at the top level', () => {
    expect(() => compileFilter([{ type: 'eq', key: 'k', value: 1 }], 1)).toThrow();
  });

  it('rejects a bare string filter', () => {
    expect(() => compileFilter('eq', 1)).toThrow();
  });

  it('rejects a filter missing a type', () => {
    expect(() => compileFilter({ key: 'k', value: 1 }, 1)).toThrow();
  });

  it('accepts an in filter with a large array under the cap, binding every element as data', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `v${i}`);
    const { sql, params } = compileFilter({ type: 'in', key: 'k', value: big }, 1);
    expect(sql).toBe('(vsf.attributes->>$1) = ANY($2)');
    expect(params[1]).toEqual(big);
  });

  it('rejects an in array beyond the documented size cap', () => {
    const huge = Array.from({ length: 10_001 }, (_, i) => `v${i}`);
    expect(() => compileFilter({ type: 'in', key: 'k', value: huge }, 1)).toThrow();
  });

  it('rejects an empty array for in/nin', () => {
    expect(() => compileFilter({ type: 'in', key: 'k', value: [] }, 1)).toThrow();
  });

  it('rejects an in array containing a non-scalar element', () => {
    expect(() => compileFilter({ type: 'in', key: 'k', value: ['a', { x: 1 }] }, 1)).toThrow();
  });

  it('pins the depth limit: accepts nesting exactly at the documented limit (10)', () => {
    // 9 "and" wrappers around one leaf = depth 10.
    let ok: any = { type: 'eq', key: 'k', value: 1 };
    for (let i = 0; i < 9; i++) ok = { type: 'and', filters: [ok] };
    expect(() => compileFilter(ok, 1)).not.toThrow();
  });

  it('pins the depth limit: rejects nesting exactly one level past the limit (11)', () => {
    // 10 "and" wrappers around one leaf = depth 11 — one past the boundary
    // proven acceptable above. This, paired with the test above, fails if
    // MAX_FILTER_DEPTH is changed in either direction.
    let tooDeep: any = { type: 'eq', key: 'k', value: 1 };
    for (let i = 0; i < 10; i++) tooDeep = { type: 'and', filters: [tooDeep] };
    expect(() => compileFilter(tooDeep, 1)).toThrow(/nest/i);
  });

  it('pins the in/nin array size cap: accepts an array of exactly the documented length (10,000)', () => {
    const atCap = Array.from({ length: 10_000 }, (_, i) => `v${i}`);
    expect(() => compileFilter({ type: 'in', key: 'k', value: atCap }, 1)).not.toThrow();
  });

  it('rejects a key containing a NUL byte (Postgres cannot store it; would otherwise 500)', () => {
    expect(() => compileFilter({ type: 'eq', key: `bad${String.fromCharCode(0)}key`, value: 'v' }, 1)).toThrow();
  });

  it('rejects a string value containing a NUL byte', () => {
    expect(() => compileFilter({ type: 'eq', key: 'k', value: `bad${String.fromCharCode(0)}value` }, 1)).toThrow();
  });

  it('rejects a NUL byte inside an in/nin array element', () => {
    expect(() => compileFilter({ type: 'in', key: 'k', value: ['a', `bad${String.fromCharCode(0)}value`] }, 1)).toThrow();
  });

  it('rejects a startIndex of 2**53 (Number.isInteger admits it, but ++ becomes a float no-op there, misbinding params)', () => {
    expect(() => compileFilter({ type: 'eq', key: 'k', value: 'v' }, 2 ** 53)).toThrow();
  });

  it('pins the total leaf cap: accepts a filter with exactly the documented number of leaves (512)', () => {
    const leaves = Array.from({ length: 512 }, (_, i) => ({ type: 'eq', key: `k${i}`, value: i }));
    const { nextIndex } = compileFilter({ type: 'and', filters: leaves }, 1);
    expect(nextIndex).toBe(1 + 512 * 2);
  });

  it('pins the total leaf cap: rejects a filter with one more than the documented number of leaves (513)', () => {
    // Paired with the test above: fails if MAX_TOTAL_LEAVES changes either way.
    const leaves = Array.from({ length: 513 }, (_, i) => ({ type: 'eq', key: `k${i}`, value: i }));
    expect(() => compileFilter({ type: 'and', filters: leaves }, 1)).toThrow(/leaf|leaves|conditions/i);
  });

  it('rejects a wide (breadth) filter well beyond the leaf cap, without needing extreme depth', () => {
    // The cheaper attack the depth limit alone does not stop: many siblings
    // under one compound node rather than deep nesting.
    const leaves = Array.from({ length: 5000 }, (_, i) => ({ type: 'eq', key: `k${i}`, value: i }));
    expect(() => compileFilter({ type: 'or', filters: leaves }, 1)).toThrow(/leaf|leaves|conditions/i);
  });

  it('enforces the leaf cap for in/nin leaves too, not only comparison leaves', () => {
    // The cap must be enforced from every leaf-producing branch (compileComparison
    // AND compileInclusion) — a filter built entirely of "in" leaves is just as
    // capable of blowing up param/SQL size as one built of "eq" leaves.
    const leaves = Array.from({ length: 513 }, (_, i) => ({ type: 'in', key: `k${i}`, value: ['a', 'b'] }));
    expect(() => compileFilter({ type: 'or', filters: leaves }, 1)).toThrow(/leaf|leaves|conditions/i);
  });
});

describe('mutation probe: allowlist must not use the `in` operator over a plain object', () => {
  it('rejects "toString" as a filter type even though it is inherited on every plain object', () => {
    // Same message change as above; what this probe is really about is that `toString`
    // is REJECTED, not what the rejection says.
    expect(() => compileFilter({ type: 'toString', key: 'k', value: 1 }, 1)).toThrow(/must be one of/);
  });
});
