/**
 * The Tool Inventory's filters (src/services/toolInventoryQuery.ts).
 *
 * The page is served by an on-READ handler over aggregated daily rows, so every filter is applied
 * here rather than by the database. Two things were wrong before this module existed: the filter
 * bar offered no Tool field at all, and a filter the handler did not understand - a "contains" from
 * Adapt Filters, the search box, anything but an exact match - was silently dropped, so the table
 * answered with the UNFILTERED rows and looked broken. Everything it cannot honour is now an error.
 */
import { parseInventoryQuery, matchesRow } from '../../../src/services/toolInventoryQuery';

const row = (identity: string, facet: string, agents: string[] = []) => ({ identity, facet, agents });

describe('parseInventoryQuery', () => {
  it('reads a day range and leaves the other fields empty', () => {
    const { filter, errors } = parseInventoryQuery([{ ref: ['day'] }, '>=', { val: '2026-09-01' }, 'and', { ref: ['day'] }, '<=', { val: '2026-09-18' }]);
    expect(errors).toEqual([]);
    expect(filter).toMatchObject({ dayFrom: '2026-09-01', dayTo: '2026-09-18', identity: [], facet: [], agents: [], searchTerms: [] });
  });

  it('reads eq, contains, startswith and endswith on the tool', () => {
    const shapes: [any[], any][] = [
      [[{ ref: ['identity'] }, '=', { val: 'hosted:custom/exec' }], { op: 'eq', value: 'hosted:custom/exec' }],
      [[{ func: 'contains', args: [{ ref: ['identity'] }, { val: 'web' }] }], { op: 'contains', value: 'web' }],
      [[{ func: 'startswith', args: [{ ref: ['identity'] }, { val: 'mcp:' }] }], { op: 'startswith', value: 'mcp:' }],
      [[{ func: 'endswith', args: [{ ref: ['identity'] }, { val: 'exec' }] }], { op: 'endswith', value: 'exec' }]
    ];
    for (const [where, expected] of shapes) {
      const { filter, errors } = parseInventoryQuery(where);
      expect(errors).toEqual([]);
      expect(filter.identity).toEqual([expected]);
    }
  });

  it('treats several values of one field as alternatives and different fields as conditions to meet together', () => {
    const { filter, errors } = parseInventoryQuery([
      '(', { ref: ['identity'] }, '=', { val: 'function:a' }, 'or', { ref: ['identity'] }, '=', { val: 'function:b' }, ')',
      'and', { ref: ['facet'] }, '=', { val: 'declared' }
    ]);
    expect(errors).toEqual([]);
    expect(filter.identity).toEqual([{ op: 'eq', value: 'function:a' }, { op: 'eq', value: 'function:b' }]);
    expect(filter.facet).toEqual([{ op: 'eq', value: 'declared' }]);
  });

  /**
   * The Requested By column IS the filtered property - `agents`, matched per client program. A
   * filter-only `agent` property beside it put a second "Requested By" in the table's Group By
   * dropdown, where only the column's entry grouped anything; the singular survives only as the
   * name the ToolAgents value help uses for its own rows.
   */
  it('reads the client program filter and the search terms', () => {
    const { filter } = parseInventoryQuery([{ func: 'contains', args: [{ ref: ['agents'] }, { val: 'codex' }] }], 'web_search');
    expect(filter.agents).toEqual([{ op: 'contains', value: 'codex' }]);
    expect(filter.searchTerms).toEqual(['web_search']);
    // CAP hands $search over as CQN, one { val } per word - not as a string
    expect(parseInventoryQuery([], [{ val: 'axios' }]).filter.searchTerms).toEqual(['axios']);
    expect(parseInventoryQuery([], [{ val: 'web' }, 'and', { val: 'search' }]).filter.searchTerms).toEqual(['web', 'search']);
    expect(parseInventoryQuery([], { xpr: [{ val: '"exec"' }] }).filter.searchTerms).toEqual(['exec']);
    // the value help's own rows call the field `agent`; it is the same filter
    expect(parseInventoryQuery([{ ref: ['agent'] }, '=', { val: 'curl' }]).filter.agents).toEqual([{ op: 'eq', value: 'curl' }]);
  });

  it('names every filter it cannot honour instead of ignoring it', () => {
    expect(parseInventoryQuery([{ ref: ['identity'] }, '>', { val: 'a' }]).errors)
      .toEqual(['identity supports eq, contains, startswith and endswith, not >']);
    expect(parseInventoryQuery([{ ref: ['users'] }, '=', { val: 3 }]).errors)
      .toEqual(['users cannot be filtered; the inventory filters by day, identity, facet and agents']);
    expect(parseInventoryQuery([{ func: 'substringof', args: [{ ref: ['identity'] }, { val: 'x' }] }]).errors)
      .toEqual(['identity supports eq, contains, startswith and endswith, not substringof']);
    expect(parseInventoryQuery([{ ref: ['day'] }, '>', { val: '2026-09-01' }]).errors)
      .toEqual(['day supports only eq, ge and le, not >']);
  });
});

describe('matchesRow', () => {
  const filter = (over: any) => ({ identity: [], facet: [], agents: [], searchTerms: [], ...over });

  it('keeps a row only when every field that was filtered matches one of its values', () => {
    const f = filter({ identity: [{ op: 'contains', value: 'web' }], facet: [{ op: 'eq', value: 'declared' }] });
    expect(matchesRow(f, row('hosted:web_search', 'declared'))).toBe(true);
    expect(matchesRow(f, row('hosted:web_search', 'invoked'))).toBe(false);
    expect(matchesRow(f, row('function:wait', 'declared'))).toBe(false);
  });

  it('matches a client program against the row\'s own list of them', () => {
    const f = filter({ agents: [{ op: 'eq', value: 'codex-tui' }] });
    expect(matchesRow(f, row('function:wait', 'declared', ['codex-tui', 'curl']))).toBe(true);
    expect(matchesRow(f, row('function:wait', 'declared', ['curl']))).toBe(false);
    expect(matchesRow(f, row('function:wait', 'declared', []))).toBe(false);
  });

  it('searches the tool and the client programs at once, case-insensitively', () => {
    expect(matchesRow(filter({ searchTerms: ['WEB'] }), row('hosted:web_search', 'declared'))).toBe(true);
    expect(matchesRow(filter({ searchTerms: ['codex'] }), row('function:wait', 'declared', ['codex-tui']))).toBe(true);
    expect(matchesRow(filter({ searchTerms: ['nothing'] }), row('function:wait', 'declared', ['codex-tui']))).toBe(false);
    // every word must be found, in the tool or in the client programs
    expect(matchesRow(filter({ searchTerms: ['web', 'codex'] }), row('hosted:web_search', 'declared', ['codex-tui']))).toBe(true);
    expect(matchesRow(filter({ searchTerms: ['web', 'curl'] }), row('hosted:web_search', 'declared', ['codex-tui']))).toBe(false);
  });

  it('keeps every row when nothing was filtered', () => {
    expect(matchesRow(filter({}), row('function:wait', 'declared'))).toBe(true);
  });
});
