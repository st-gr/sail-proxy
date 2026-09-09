/**
 * Is the entitlement catalog's header edited but unsaved (I)? The header's Name/Description
 * Inputs write into a deferred update group, so nothing reaches the server until Save — which
 * means the Save/Discard buttons and the data-loss guard both need a truthful "dirty" answer.
 *
 * Two sources, because sap.m.Input only writes its bound property on `change` (focus out or
 * Enter): while the user is still typing, the model knows nothing yet, so the typed text is
 * compared against what the bound context holds; the model's own pending-changes flag covers the
 * other field, and this one once its change event has committed it.
 *
 * A pure function in its own module — like contextWindow/costDisplay — so it is testable without
 * a UI5 runtime.
 */
export function headerDirty(
  typed: string | null | undefined,
  stored: string | null | undefined,
  hasPendingChanges: boolean
): boolean {
  // An empty Input and a null property are the same thing: a catalog with no description must not
  // look edited just because the server stores null and the field shows "".
  return hasPendingChanges || (typed ?? '') !== (stored ?? '');
}

/** What the data-loss guard has to weigh up before letting a navigation through. */
export interface HeaderSaveState {
  /** A submitBatch for the header's group has been sent and has not come back yet. */
  saveInFlight: boolean;
  /** What the OData model reports for that group right now. */
  pending: boolean;
}

/**
 * May a navigation away from the header proceed without asking? A batch that is still in flight
 * counts as clean: the model keeps reporting the edit as pending for the whole round trip, but
 * the user has already said "save it", so warning about it contradicts the Save/Discard buttons,
 * which went dark the moment the batch was sent. It is also the safe answer - a "Discard" given
 * there would hit resetChanges' "requests for the group are running" throw and then navigate out
 * from under a live batch.
 */
export function isHeaderClean(state: HeaderSaveState): boolean {
  return state.saveInFlight || !state.pending;
}

/** The whole catalog's unsaved state: the header's deferred edits plus the staged list changes (catalogPending.ts). */
export interface CatalogSaveState extends HeaderSaveState {
  /** How many list changes (members, exclusions, assignments) are staged and not yet written. */
  pendingCount: number;
}

/** Is anything about the catalog edited but unsaved? Drives the Save/Discard buttons. */
export function catalogDirty(state: Pick<CatalogSaveState, 'pending' | 'pendingCount'>): boolean {
  return state.pending || state.pendingCount > 0;
}

/** May a navigation away from the catalog proceed without asking? The same in-flight rule as isHeaderClean, over everything. */
export function isCatalogClean(state: CatalogSaveState): boolean {
  return state.saveInFlight || !catalogDirty(state);
}
