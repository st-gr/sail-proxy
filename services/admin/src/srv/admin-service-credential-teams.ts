// services/admin/src/srv/admin-service-credential-teams.ts
/**
 * Teams on the credential pages (spec 2026-10-14 §9, Part B): the two read-only virtuals that say
 * which team a key or AWS credential is enforced under, and the choices the Change Team dialog
 * offers. A team's NAME reaches a user-readable credential row only through this handler - those
 * projections carry `team_ID` and no `team` navigation (Ruling R9) - and the owner is a member of
 * that team, so the name is theirs to see.
 */
import * as lookups from '../services/teamLookups';
import { isAdminRole } from '../services/modelEntitlementService';

const cds = require('@sap/cds');

const roles = (req: any): string[] => { const r = req.user?.roles || req.user?.scope || []; return Array.isArray(r) ? r : Object.keys(r); };
const isAdmin = (req: any): boolean => isAdminRole(roles(req));
const actor = (req: any): string => req.user?.id || 'anonymous';

export function registerCredentialTeamHandlers(service: any): void {
  service.after('READ', ['ApiKeys', 'ApiKeys.drafts', 'AwsCredentials', 'AwsCredentials.drafts'], async (rows: any, req: any) => {
    const list = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((r: any) => r?.ID);
    if (list.length === 0) return;
    const isAws = String(req.target?.name || '').includes('AwsCredentials');
    // A $select without email or team_ID (a list column, the object page's own $select) still
    // needs both: one SELECT by ID for exactly those rows.
    const base = new Map<string, { email: string | null; team_ID: string | null }>();
    for (const r of list) if ('email' in r && 'team_ID' in r) base.set(r.ID, { email: r.email ?? null, team_ID: r.team_ID ?? null });
    const missing = list.map((r: any) => r.ID).filter((id: string) => !base.has(id));
    if (missing.length) {
      for (const r of await cds.run(cds.ql.SELECT.from(isAws ? lookups.AWS : lookups.KEYS).columns('ID', 'email', 'team_ID').where({ ID: { in: missing } }))) {
        base.set(r.ID, { email: r.email ?? null, team_ID: r.team_ID ?? null });
      }
    }
    const teams = await lookups.credentialTeamsFor(cds, [...base].map(([ID, v]) => ({ ID, ...v })));
    for (const row of list) {
      const t = teams.get(row.ID);
      row.effectiveTeamName = t?.name ?? null;
      row.followsPrimaryTeam = t ? t.followsPrimary : null;
    }
  });

  service.on('credentialTeamChoices', async (req: any) => {
    const email = String(req.data.email ?? '').trim();
    if (!email) { req.reject(400, 'email is required'); return; }
    if (!isAdmin(req) && email !== actor(req)) { req.reject({ status: 403, code: 'TEAM_FORBIDDEN', message: 'TEAM_FORBIDDEN' }); return; }
    const rows = await lookups.teamsOf(cds, email);
    return rows.map(({ membership, team }) => ({ teamId: team.ID, name: team.name, isPrimary: !!membership.isPrimary }))
      .sort((x, y) => x.name.localeCompare(y.name));
  });
}
