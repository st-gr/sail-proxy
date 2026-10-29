/** A team the signed-in user may see a store shared with, and whether they may share with it (spec 2026-10-14 §8). */
export type TeamOption = { id: string; name: string; canShare: boolean };

/**
 * The user's teams: a platform admin may share with every team (the Teams entity set), anyone else
 * with the teams they administer (myTeams, role admin). Never rejects: no teams means no team UI.
 */
export async function loadTeams(isAdmin: boolean, fetchJson: (url: string) => Promise<any>): Promise<TeamOption[]> {
  try {
    if (isAdmin) {
      const r = await fetchJson("/odata/v4/admin/Teams?$select=ID,name&$orderby=name&$filter=IsActiveEntity%20eq%20true");
      return (r?.value ?? []).map((x: any) => ({ id: x.ID, name: x.name, canShare: true }));
    }
    const r = await fetchJson("/odata/v4/admin/myTeams()");
    return (r?.value ?? []).map((x: any) => ({ id: x.teamId, name: x.name, canShare: x.role === "admin" }));
  } catch {
    return [];
  }
}
