/**
 * OData V4 `in` filter builders for a set of LibraryModels ids, used by Catalogs.controller.ts's
 * member-availability check (loadMembers) and the "Add models" / "Exclude models" pickers
 * (openPicker). These replace a `modelId eq 'a' or modelId eq 'b' or ...` chain that was capped
 * at the first 100 ids (silently mislabeling/hiding anything past that) — `in (...)` carries the
 * whole list in one clause, with no cap.
 */

function quote(id: string): string {
  return `'${String(id).replace(/'/g, "''")}'`;
}

/**
 * `modelId in ('a','b',…)`. An empty list has no ids to match, so this returns a filter that
 * matches nothing (`modelId eq '__none__'`) rather than an empty/omitted filter, which would
 * match everything.
 */
export function modelIdIn(ids: string[]): string {
  if (!ids.length) return "modelId eq '__none__'";
  return `modelId in (${ids.map(quote).join(",")})`;
}

/**
 * `not (modelId in ('a','b',…))`. An empty list excludes nothing, so this returns `undefined` —
 * the caller omits the filter entirely rather than filtering on an empty `in (...)`.
 */
export function modelIdNotIn(ids: string[]): string | undefined {
  if (!ids.length) return undefined;
  return `not (modelId in (${ids.map(quote).join(",")}))`;
}
