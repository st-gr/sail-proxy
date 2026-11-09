/**
 * A tiny, pure (no `cds`, no `req`) evaluator for OData query options against a plain in-memory
 * array of rows - for the handful of AdminService entities that have no single backing table CAP
 * could push $filter/$orderby/$top/$skip/$count down to (spec §4's UserCredentials is the first;
 * any future one needing the same treatment should use this rather than reinvent it).
 *
 * `where`/`orderBy`/`limit` are exactly the CQN shapes CAP hands a `.on READ` handler on
 * `req.query.SELECT` (or the un-cleansed original a draft-enabled service stashes - see
 * admin-service-users.ts's `realQuery`): `where` an array of `{ref:[field]}`/operator-string/
 * `{val}` tokens with `'and'`/`'or'` separators and `{xpr:[...]}` for a parenthesised group,
 * `orderBy` an array of `{ref:[field], sort?: 'asc'|'desc'}`, `limit` a `{rows:{val}, offset:{val}}`.
 */
const FILTER_OPS = new Set(['=', '!=', '<>']);

/** Recursive descent over a flat CQN token array: `or` binds looser than `and` (SQL precedence),
 * achieved by splitting on top-level `or` first, then each side on top-level `and`. */
function compile(tokens: any[], fields: ReadonlySet<string>): (row: any) => boolean {
  const splitTop = (ts: any[], op: string): any[][] => {
    const groups: any[][] = []; let cur: any[] = [];
    for (const t of ts) { if (typeof t === 'string' && t.toLowerCase() === op) { groups.push(cur); cur = []; } else cur.push(t); }
    groups.push(cur);
    return groups;
  };
  const evalGroup = (ts: any[]): (row: any) => boolean => {
    const ors = splitTop(ts, 'or');
    if (ors.length > 1) { const fns = ors.map(evalGroup); return (row: any) => fns.some((f) => f(row)); }
    const ands = splitTop(ts, 'and');
    if (ands.length > 1) { const fns = ands.map(evalGroup); return (row: any) => fns.every((f) => f(row)); }
    if (ts.length === 1 && ts[0]?.xpr) return evalGroup(ts[0].xpr);
    if (ts.length === 3 && typeof ts[1] === 'string' && FILTER_OPS.has(ts[1])) {
      const [lhs, op, rhs] = ts;
      const field = lhs?.ref?.[0] ?? rhs?.ref?.[0];
      if (!field || !fields.has(field)) throw new Error(`unsupported $filter field "${field}"`);
      const value = lhs?.ref ? rhs?.val : lhs?.val;
      return (row: any) => (op === '=' ? row[field] === value : row[field] !== value);
    }
    throw new Error('unsupported $filter expression');
  };
  return evalGroup(tokens);
}

/**
 * Filters `rows` by a CQN `where` array, restricted to `fields`: `and`/`or`, parenthesised groups
 * (CQN's `{xpr:[...]}`), and `=`/`!=`/`<>`. Anything else - a function call, an unknown field, an
 * unsupported operator - throws a plain `Error`; callers map that to a 400. `where` undefined or
 * empty returns `rows` unchanged.
 */
export function applyWhere(rows: any[], where: any[] | undefined, fields: ReadonlySet<string>): any[] {
  if (!where?.length) return rows;
  return rows.filter(compile(where, fields));
}

/** Stable multi-key sort by a CQN `orderBy` array (`{ref:[field], sort?}`); `orderBy` undefined
 * or empty returns `rows` itself (not a copy - matches `applyWhere`/`applyLimit`'s no-op case). */
export function applyOrderBy(rows: any[], orderBy: any[] | undefined): any[] {
  if (!orderBy?.length) return rows;
  const specs = orderBy.map((o: any) => ({ field: o?.ref?.[0], desc: (o?.sort || 'asc').toLowerCase() === 'desc' }));
  return [...rows].sort((a, b) => {
    for (const { field, desc } of specs) {
      if (!field) continue;
      const av = a[field]; const bv = b[field];
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

/** Slices `rows` by a CQN `limit` (`{rows:{val}, offset:{val}}`); `limit` undefined returns
 * `rows` unchanged. */
export function applyLimit(rows: any[], limit: any): any[] {
  if (!limit) return rows;
  const offset = limit.offset?.val ?? 0;
  const count = limit.rows?.val;
  return typeof count === 'number' ? rows.slice(offset, offset + count) : rows.slice(offset);
}

/**
 * Composes `applyWhere` + `applyOrderBy` + `applyLimit` against a CQN `SELECT` clause
 * (`{where?, orderBy?, limit?}` - `select.count` is read by the caller, not here, since attaching
 * `.$count` to the OData result is CAP's mechanism, not this module's concern). `count` is the
 * post-filter, PRE-PAGING length - what `@odata.count` reports.
 */
export function applyQueryOptions(rows: any[], select: { where?: any[]; orderBy?: any[]; limit?: any } | undefined, fields: ReadonlySet<string>): { rows: any[]; count: number } {
  const filtered = applyWhere(rows, select?.where, fields);
  const count = filtered.length;
  const ordered = applyOrderBy(filtered, select?.orderBy);
  const paged = applyLimit(ordered, select?.limit);
  return { rows: paged, count };
}
