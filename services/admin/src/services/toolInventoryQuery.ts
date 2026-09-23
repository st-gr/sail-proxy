/**
 * Filters for the Tool Inventory page (`AdminService.ToolInventory`).
 *
 * The page is aggregated by an on-READ handler, so no database applies its filters: they are parsed
 * from the CQN where clause here and evaluated against the folded rows. Two rules matter.
 *
 * The inventory filters by `day` (a range), `identity` (the Tool column), `facet` and `agents` (the
 * Requested By column), plus the filter bar's search field. Several values of ONE field are
 * alternatives, as Fiori Elements sends them; different fields must all match.
 *
 * `agents` is filtered as the LIST it is: a row whose cell reads "codex-tui, curl" matches a filter
 * for either of them. The filter deliberately uses the column's own property rather than a
 * filter-only one beside it - two properties labelled "Requested By" put two entries in the table's
 * Group By dropdown, of which only the column's did anything.
 *
 * Anything this module cannot honour is reported, and the handler answers 400. A silently dropped
 * filter is worse than a refused one: the table comes back with every row and reads as a filter
 * that does nothing, which is exactly how the missing Tool filter was first reported.
 */
export type FilterOp = 'eq' | 'contains' | 'startswith' | 'endswith';
export interface Predicate { op: FilterOp; value: string; }
export interface InventoryFilter {
  dayFrom?: string;
  dayTo?: string;
  identity: Predicate[];
  facet: Predicate[];
  agents: Predicate[];
  /** Every term of the filter bar's search field; a row must contain them all. */
  searchTerms: string[];
}
export interface InventoryRow { identity: string; facet: string; agents: string[]; }

/** Fields a caller may filter by, beside the `day` range. */
const TEXT_FIELDS = ['identity', 'facet', 'agents'] as const;
type TextField = typeof TEXT_FIELDS[number];

/**
 * `agent` is the property name of the ToolAgents value-help entity, `agents` the inventory column
 * it fills in. The same parser serves both reads, so the singular is an alias of the plural.
 */
const FIELD_ALIASES: Record<string, TextField> = { agent: 'agents' };
const textField = (field: string): TextField | null =>
  (TEXT_FIELDS as readonly string[]).includes(field) ? (field as TextField) : (FIELD_ALIASES[field] ?? null);

const DAY_OPERATORS: Record<string, 'from' | 'to' | 'both'> = {
  '>=': 'from', ge: 'from', '<=': 'to', le: 'to', '=': 'both', '==': 'both', eq: 'both'
};
const EQ_OPERATORS = new Set(['=', '==', 'eq']);
const FUNCTIONS: Record<string, FilterOp> = { contains: 'contains', startswith: 'startswith', endswith: 'endswith' };

const unsupportedOperator = (field: string, op: string) =>
  `${field} supports eq, contains, startswith and endswith, not ${op}`;
const unfilterable = (field: string) =>
  `${field} cannot be filtered; the inventory filters by day, identity, facet and agents`;

function emptyFilter(): InventoryFilter {
  return { identity: [], facet: [], agents: [], searchTerms: [] };
}

/**
 * The search term(s) of `SELECT.search`. CAP hands `$search` over as CQN, not as a string: one
 * `{ val }` per word, with the operators between them - reading it as a string silently dropped the
 * search box, which then looked like a field that does nothing.
 */
function searchTerms(search: unknown): string[] {
  const terms: string[] = [];
  const visit = (node: any): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === 'string') return;            // 'and' / 'or' / 'not'
    if (typeof node === 'object') {
      if (typeof node.val === 'string') { terms.push(node.val); return; }
      if (node.args) visit(node.args);
      if (node.xpr) visit(node.xpr);
    }
  };
  visit(typeof search === 'string' ? [{ val: search }] : search);
  return terms.map((t) => t.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/**
 * Reads the where clause of a ToolInventory READ. `search` is the filter bar's search term
 * (`req.query.SELECT.search`), which applies to the tool and the client programs together.
 */
export function parseInventoryQuery(where: any[] | undefined, search?: unknown): { filter: InventoryFilter; errors: string[] } {
  const filter = emptyFilter();
  const errors: string[] = [];
  const w = Array.isArray(where) ? where : [];
  filter.searchTerms = searchTerms(search);

  for (let i = 0; i < w.length; i += 1) {
    const token = w[i];
    if (!token || typeof token === 'string') continue;   // 'and' / 'or' / '(' / ')'

    // contains(field, 'x') and its siblings
    if (token.func) {
      const field = token.args?.[0]?.ref?.[0];
      const value = token.args?.[1]?.val;
      if (typeof field !== 'string') continue;
      const op = FUNCTIONS[String(token.func)];
      const target = textField(field);
      if (!target) { errors.push(unfilterable(field)); continue; }
      if (!op) { errors.push(unsupportedOperator(field, String(token.func))); continue; }
      if (value !== undefined && value !== null) filter[target].push({ op, value: String(value) });
      continue;
    }

    const field = token.ref?.[0];
    if (typeof field !== 'string') continue;
    const operator = typeof w[i + 1] === 'string' ? String(w[i + 1]) : '';
    const value = w[i + 2]?.val;

    if (field === 'day') {
      const side = DAY_OPERATORS[operator];
      if (!side) { errors.push(`day supports only eq, ge and le, not ${operator || '(nothing)'}`); i += 2; continue; }
      const text = String(value ?? '').slice(0, 10);
      if (side === 'from' || side === 'both') filter.dayFrom = text;
      if (side === 'to' || side === 'both') filter.dayTo = text;
      i += 2;
      continue;
    }

    const target = textField(field);
    if (!target) { errors.push(unfilterable(field)); i += 2; continue; }
    if (!EQ_OPERATORS.has(operator)) { errors.push(unsupportedOperator(field, operator || '(nothing)')); i += 2; continue; }
    if (value !== undefined && value !== null) filter[target].push({ op: 'eq', value: String(value) });
    i += 2;
  }
  return { filter, errors };
}

function satisfies(predicate: Predicate, candidates: string[]): boolean {
  const wanted = predicate.value.toLowerCase();
  return candidates.some((candidate) => {
    const text = candidate.toLowerCase();
    if (predicate.op === 'eq') return text === wanted;
    if (predicate.op === 'startswith') return text.startsWith(wanted);
    if (predicate.op === 'endswith') return text.endsWith(wanted);
    return text.includes(wanted);
  });
}

/** True when the row satisfies every field that was filtered (one matching value per field is enough). */
export function matchesRow(filter: InventoryFilter, row: InventoryRow): boolean {
  const values: Record<TextField, string[]> = {
    identity: [row.identity],
    facet: [row.facet],
    agents: row.agents ?? []
  };
  for (const field of TEXT_FIELDS) {
    const predicates = filter[field];
    if (predicates.length === 0) continue;
    if (!predicates.some((p) => satisfies(p, values[field]))) return false;
  }
  if (filter.searchTerms.length > 0) {
    const haystack = [row.identity, ...(row.agents ?? [])];
    if (!filter.searchTerms.every((term) => satisfies({ op: 'contains', value: term }, haystack))) return false;
  }
  return true;
}
