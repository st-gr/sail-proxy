/**
 * odataInMemory.ts is pure (no `cds`, no `req`) - plain jest, no cds.test(), no in-memory DB.
 * users-odata.test.ts's UserCredentials cases are the integration proof this is wired up
 * correctly end to end; these are the evaluator's own unit cases: operators, and/or precedence,
 * a nested (parenthesised) group, an unknown field/operator, orderBy asc/desc, limit
 * offset/rows, and the pre-paging count.
 */
import { applyWhere, applyOrderBy, applyLimit, applyQueryOptions } from '../../../src/srv/odataInMemory';

const FIELDS = new Set(['name', 'type', 'active']);
const ref = (f: string) => ({ ref: [f] });
const val = (v: any) => ({ val: v });
const rows = [
  { name: 'a', type: 'x', active: true },
  { name: 'b', type: 'y', active: true },
  { name: 'c', type: 'x', active: false },
  { name: 'd', type: 'y', active: false }
];

describe('applyWhere', () => {
  it('= and <>/!= over an allowed field', () => {
    expect(applyWhere(rows, [ref('type'), '=', val('x')], FIELDS).map((r) => r.name)).toEqual(['a', 'c']);
    expect(applyWhere(rows, [ref('type'), '!=', val('x')], FIELDS).map((r) => r.name)).toEqual(['b', 'd']);
    expect(applyWhere(rows, [ref('type'), '<>', val('x')], FIELDS).map((r) => r.name)).toEqual(['b', 'd']);
  });

  it('and/or combine, with and binding tighter than or', () => {
    // type = x and active = true, or type = y and active = false -> a, d
    const where = [ref('type'), '=', val('x'), 'and', ref('active'), '=', val(true), 'or', ref('type'), '=', val('y'), 'and', ref('active'), '=', val(false)];
    expect(applyWhere(rows, where, FIELDS).map((r) => r.name)).toEqual(['a', 'd']);
  });

  it('a parenthesised group (CQN xpr) is evaluated as one unit', () => {
    // name = a or (type = y and active = false) -> a, d
    const where = [ref('name'), '=', val('a'), 'or', { xpr: [ref('type'), '=', val('y'), 'and', ref('active'), '=', val(false)] }];
    expect(applyWhere(rows, where, FIELDS).map((r) => r.name)).toEqual(['a', 'd']);
  });

  it('an unknown field throws', () => {
    expect(() => applyWhere(rows, [ref('nope'), '=', val('x')], FIELDS)).toThrow(/unsupported \$filter field/);
  });

  it('an unsupported operator (a function call) throws', () => {
    const where = [{ func: 'contains', args: [ref('name'), val('a')] }];
    expect(() => applyWhere(rows, where, FIELDS)).toThrow(/unsupported \$filter/);
  });

  it('undefined or empty where returns rows unchanged', () => {
    expect(applyWhere(rows, undefined, FIELDS)).toBe(rows);
    expect(applyWhere(rows, [], FIELDS)).toBe(rows);
  });
});

describe('applyOrderBy', () => {
  it('sorts ascending by default and descending when asked', () => {
    expect(applyOrderBy(rows, [{ ref: ['name'], sort: 'desc' }]).map((r) => r.name)).toEqual(['d', 'c', 'b', 'a']);
    expect(applyOrderBy([...rows].reverse(), [{ ref: ['name'] }]).map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a multi-key sort uses later keys as tiebreakers', () => {
    const sorted = applyOrderBy(rows, [{ ref: ['type'] }, { ref: ['name'], sort: 'desc' }]);
    expect(sorted.map((r) => r.name)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('undefined or empty orderBy returns rows unchanged', () => {
    expect(applyOrderBy(rows, undefined)).toBe(rows);
    expect(applyOrderBy(rows, [])).toBe(rows);
  });
});

describe('applyLimit', () => {
  it('applies offset and row count', () => {
    expect(applyLimit(rows, { rows: { val: 2 }, offset: { val: 1 } }).map((r) => r.name)).toEqual(['b', 'c']);
  });

  it('offset alone (no row count) slices from offset to the end', () => {
    expect(applyLimit(rows, { offset: { val: 2 } }).map((r) => r.name)).toEqual(['c', 'd']);
  });

  it('undefined limit returns rows unchanged', () => {
    expect(applyLimit(rows, undefined)).toBe(rows);
  });
});

describe('applyQueryOptions', () => {
  it('composes where/orderBy/limit and reports the pre-paging count', () => {
    const select = { where: [ref('active'), '=', val(true)], orderBy: [{ ref: ['name'], sort: 'desc' as const }], limit: { rows: { val: 1 } } };
    const { rows: paged, count } = applyQueryOptions(rows, select, FIELDS);
    expect(count).toBe(2); // a and b match active = true, before paging
    expect(paged.map((r) => r.name)).toEqual(['b']); // ordered desc by name, then top 1
  });

  it('an undefined select returns every row with count = rows.length', () => {
    const { rows: all, count } = applyQueryOptions(rows, undefined, FIELDS);
    expect(all).toEqual(rows);
    expect(count).toBe(4);
  });

  it('propagates a where evaluation error to the caller', () => {
    expect(() => applyQueryOptions(rows, { where: [ref('nope'), '=', val(1)] }, FIELDS)).toThrow(/unsupported \$filter field/);
  });
});
