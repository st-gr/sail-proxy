/**
 * Shared behavior of the AddModelsDialog SelectDialog fragment (webapp/view/AddModelsDialog.fragment.xml),
 * used by Detail.controller.ts's onAddToCatalog and Library.controller.ts's onAddSelectedToCatalog
 * (and, per the plan, Catalogs.controller.ts's own picker in a later task) so the filter/search/cancel
 * logic lives in one place instead of three copies.
 */

/** The picker's $filter: admins may add to any non-default catalog, non-admins only to their own. */
export function ownCatalogsFilter(isAdmin: boolean, email: string): string {
  if (isAdmin) return "isDefault eq false";
  return `isDefault eq false and ownerEmail eq '${email.replace(/'/g, "''")}'`;
}

/** SelectDialog `search` handler: narrow the picker's items to the typed catalog name. */
export function catalogPickSearch(e: any): void {
  const q = (e.getParameter("value") || "").replace(/'/g, "''");
  e.getSource().getBinding("items").changeParameters({ $search: q ? `"${q}"` : undefined });
}

/** SelectDialog `cancel` handler: drop any search narrowing so the next open starts fresh. */
export function catalogPickCancel(e: any): void {
  e.getSource().getBinding("items").changeParameters({ $search: undefined });
}
