/**
 * SAP Capacity-Unit billing for a period: what getUsageStatistics returns as `sapBilling`, and what
 * the Usage app's "SAP Cost" tile and SAP billing tables show.
 *
 * The all-time views ApiKeyUsageStats / ApiKeyUsageSapCostStats have no date, so a figure read from
 * them ignores the chosen Time Period, and they cover API keys only. This reads both usage tables
 * with the caller's period, tenant and row scope.
 */
const cds = require('@sap/cds');

const KEY_USAGE = 'sap.llm.gateway.admin.ApiKeyUsage';
const AWS_USAGE = 'sap.llm.gateway.admin.AwsCredentialUsage';
const AWS_CREDENTIALS = 'sap.llm.gateway.admin.AwsCredentials';

export interface SapBillingScope {
  /** The period filter of getUsageStatistics (`validFrom between …`). */
  period: Record<string, unknown>;
  /** A SAP tenant (zone): only its rows; null = all tenants. */
  tenant: string | null;
  /** The caller's row filter: a team scope, an admin's everything, or a user's own rows. */
  scoped: (clause: any, ownerField: string, teamField: string) => any;
  /** Team billing is for platform admins only. */
  isAdmin: boolean;
}

const sums = (p = ''): string[] => [
  'count(*) as totalRequests',
  `COALESCE(sum(${p}imageInputTokens), 0) as totalImageInputTokens`,
  `COALESCE(sum(${p}imageOutputTokens), 0) as totalImageOutputTokens`,
  `COALESCE(sum(${p}audioInputTokens), 0) as totalAudioInputTokens`,
  `COALESCE(sum(${p}audioOutputTokens), 0) as totalAudioOutputTokens`,
  `COALESCE(sum(${p}genAiTokens), 0) as totalGenAiTokens`,
  `COALESCE(sum(${p}capacityUnits), 0) as totalCapacityUnits`,
  `COALESCE(sum(${p}sapCost), 0) as totalSapCost`,
];

/** Connection (external provider) rows carry no SAP figures: they are not SAP billing. */
const NOT_EXTERNAL = (p = '') => `(${p}origin is null or ${p}origin <> 'external')`;

export async function readSapBilling(scope: SapBillingScope): Promise<{ credentials: any[]; teams: any[] }> {
  const { SELECT } = cds.ql;
  const { period, tenant, scoped, isAdmin } = scope;

  const keyWhere = scoped({ ...period, ...(tenant ? { sapTenant: tenant } : {}), provider: { '!=': null } }, 'email', 'team_ID');
  const keyRows = await cds.run(
    SELECT.from(KEY_USAGE).where(keyWhere).and(NOT_EXTERNAL())
      .columns(['apiKey_ID as credentialId', 'max(keyName) as name', 'sapCostCurrency', ...sums()])
      .groupBy('apiKey_ID', 'sapCostCurrency')
  );

  // The explicit join (not the `credential.` path) for the name and the owner filter, as in the
  // per-credential table of getUsageStatistics.
  const awsWhere = scoped(
    { ...period, ...(tenant ? { 'usage.sapTenant': tenant } : {}), 'usage.provider': { '!=': null } },
    'cred.userId', 'usage.team_ID'
  );
  const awsRows = await cds.run(
    SELECT.from(`${AWS_USAGE} as usage`).leftJoin(`${AWS_CREDENTIALS} as cred`).on('usage.credential_ID = cred.ID')
      .where(awsWhere).and(NOT_EXTERNAL('usage.'))
      .columns([
        'usage.credential_ID as credentialId',
        'COALESCE(MAX(cred.name), MAX(usage.credentialName), (\'Credential-\' || usage.credential_ID)) as name',
        'usage.sapCostCurrency as sapCostCurrency', ...sums('usage.'),
      ])
      .groupBy('usage.credential_ID', 'usage.sapCostCurrency')
  );

  const credentials = [
    ...keyRows.map((r: any) => ({ credentialType: 'apiKey', ...r, sapCostCurrency: r.sapCostCurrency ?? null })),
    ...awsRows.map((r: any) => ({ credentialType: 'awsCredential', ...r, sapCostCurrency: r.sapCostCurrency ?? null })),
  ];

  if (!isAdmin) return { credentials, teams: [] };

  // Through the caller's row scope like the tables above: with one team selected, that team's rows only.
  const teams = await readTeamSapBilling(scoped({ ...period, ...(tenant ? { sapTenant: tenant } : {}) }, 'email', 'team_ID'));
  return { credentials, teams };
}

/**
 * SAP billing per team and currency: the priced rows of both usage tables that `where` selects,
 * grouped by the team snapshot on the row and folded here, sorted by team name and currency. The
 * name is the snapshot's, so a deleted team keeps it. Rows without a team form one entry whose id
 * is `noTeamId`. Shared by getUsageStatistics (a period, the caller's scope) and the entity
 * TeamSapBillingStats (all time, a key that cannot be null).
 */
export async function readTeamSapBilling(where: Record<string, unknown>, noTeamId: string | null = null): Promise<any[]> {
  const { SELECT } = cds.ql;
  const columns = ['team_ID as teamId', 'max(teamName) as teamName', 'sapCostCurrency', 'count(*) as totalRequests',
    'COALESCE(sum(genAiTokens), 0) as totalGenAiTokens', 'COALESCE(sum(capacityUnits), 0) as totalCapacityUnits', 'COALESCE(sum(sapCost), 0) as totalSapCost'];
  const priced = { ...where, provider: { '!=': null }, sapCostCurrency: { '!=': null } };
  const read = (table: string) => cds.run(SELECT.from(table).where(priced).columns(columns).groupBy('team_ID', 'sapCostCurrency'));
  const byTeam = new Map<string, any>();
  for (const r of [...await read(KEY_USAGE), ...await read(AWS_USAGE)]) {
    const teamId = r.teamId ?? noTeamId;
    const key = `${teamId ?? ''}|${r.sapCostCurrency}`;
    const row = byTeam.get(key) ?? { teamId, teamName: null, sapCostCurrency: r.sapCostCurrency, totalRequests: 0, totalGenAiTokens: 0, totalCapacityUnits: 0, totalSapCost: 0 };
    row.totalRequests += Number(r.totalRequests) || 0;
    row.totalGenAiTokens += Number(r.totalGenAiTokens) || 0;
    row.totalCapacityUnits += Number(r.totalCapacityUnits) || 0;
    row.totalSapCost += Number(r.totalSapCost) || 0;
    if (!row.teamName && r.teamName && r.teamId) row.teamName = r.teamName;
    byTeam.set(key, row);
  }
  return [...byTeam.values()].sort((a, b) =>
    String(a.teamName ?? '~').localeCompare(String(b.teamName ?? '~')) || a.sapCostCurrency.localeCompare(b.sapCostCurrency));
}
