/**
 * The Assignments tab's user search (J). The rows come from libraryUsers() into a JSON model, so
 * the narrowing is a plain predicate over the array rather than an OData $filter — kept here, out
 * of the controller, so it is testable without a UI5 runtime.
 */
export interface AssignmentRow {
  email?: string | null;
  catalogName?: string | null;
}

/** Matches the typed text against the e-mail and the assigned catalog's name, case-insensitively. */
export function matchesUserQuery(row: AssignmentRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (row.email || '').toLowerCase().includes(q) || (row.catalogName || '').toLowerCase().includes(q);
}

/** The rows the table shows for a query; an empty query keeps every row, in the server's order. */
export function filterUsers<T extends AssignmentRow>(rows: T[], query: string): T[] {
  const q = query.trim();
  return q ? rows.filter(r => matchesUserQuery(r, q)) : rows;
}

/** What a bulk assign/unassign did: how many calls went through, and whose did not. */
export interface BulkOutcome { done: number; failed: string[]; }

/**
 * Runs one action per e-mail, strictly in sequence, and never rejects: a user the server refuses
 * is collected instead of aborting the rest. Sequential on purpose — assignCatalog prunes the
 * user's selections server-side, so overlapping calls would race those writes.
 */
export async function runPerUser(
  emails: string[],
  invoke: (email: string) => Promise<unknown>
): Promise<BulkOutcome> {
  const failed: string[] = [];
  let done = 0;
  for (const email of emails) {
    try {
      await invoke(email);
      done++;
    } catch {
      failed.push(email);
    }
  }
  return { done, failed };
}
