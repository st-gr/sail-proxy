/**
 * The quota-profile mode of the Catalogs view, in the parts that need no controller state: the
 * shape quotaProfileUsers() rows have to take before mergeUsers can lay the staged assignments
 * over them, and the seven limits the detail form shows. Pure, no UI5 imports — unit-tested with
 * jest like catalogPending.ts and headerDirty.ts.
 */

/** One row of AdminService.quotaProfileUsers(). */
export interface ProfileUserRow {
  email: string;
  displayName?: string | null;
  status?: string | null;
  profileId?: string | null;
  profileName?: string | null;
}

/** The same user in the shape the Assignments table and catalogPending already speak. */
export interface CatalogShapedUserRow {
  email: string;
  displayName: string | null;
  status: string | null;
  catalogId: string | null;
  catalogName: string | null;
}

/**
 * In profile mode the selected profile is what a catalog is in catalogs mode: one selected object,
 * one staged assign map, one Save. Renaming these two fields is the whole adaptation — mergeUsers,
 * stageAssign and the Assignments table's bindings stay exactly as the catalogs mode left them.
 */
export function toCatalogShapedUsers(rows: ProfileUserRow[] | null | undefined): CatalogShapedUserRow[] {
  return (rows || []).map(r => ({
    email: r.email,
    displayName: r.displayName ?? null,
    status: r.status ?? null,
    catalogId: r.profileId ?? null,
    catalogName: r.profileName ?? null
  }));
}

export interface ProfileLimitField {
  /** The QuotaProfiles property, which is also the id of its Input in Catalogs.view.xml. */
  name: string;
  /** Its label's key in the app's i18n bundles. */
  labelKey: string;
}

/**
 * The seven limits in the order the Limits form shows them — Requests, then Tokens, then Spend.
 * The form is written out in XML rather than built from this list, so profileRows.test.ts holds
 * the two together: every field here has an Input with that id and a Label bound to that key, in
 * this order, and every key is in both bundles.
 */
export const PROFILE_LIMIT_FIELDS: ReadonlyArray<ProfileLimitField> = [
  { name: "requestsPerMinute", labelKey: "requestsPerMinute" },
  { name: "tokensPerDay", labelKey: "tokensPerDay" },
  { name: "tokensPerWeek", labelKey: "tokensPerWeek" },
  { name: "tokensPerMonth", labelKey: "tokensPerMonth" },
  { name: "spendPerDay", labelKey: "spendPerDay" },
  { name: "spendPerWeek", labelKey: "spendPerWeek" },
  { name: "spendPerMonth", labelKey: "spendPerMonth" }
];
