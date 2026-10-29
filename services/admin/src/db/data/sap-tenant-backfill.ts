import { tenantFromAuthUrl } from '@libs/service-key-parser/parser';
import type { SapTenantIdentity } from '@libs/service-key-parser/types';
import type { IndexSpec, IndexResult } from './tool-usage-indexes';

const cds = require('@sap/cds');

/**
 * The SAP tenant of usage rows recorded before the rows carried one (spec 2026-10-25 §6).
 *
 * Until SAP AI Core connections, an installation served SAP traffic from one tenant at a time: the
 * one its environment key names. So the SAP rows without a tenant are given that tenant's zone, once
 * ever, and only rows older than the first row that carries a tenant (or than the given moment when
 * none does yet): a row without a tenant written after that came from somewhere else (an older
 * gateway during a rolling upgrade) and is left alone. Connection rows (origin 'external') never
 * reached SAP and stay without one. An installation that moved tenants by editing its environment
 * before this feature is a documented limit.
 *
 * Once: the marker row (SapTenantBackfill) is written in the same transaction as the UPDATEs, so a
 * second run - another boot, another admin replica, another environment zone - finds it and does
 * nothing; two replicas racing both try to insert the one key and the loser's transaction rolls back.
 * The zone and the bound are bound parameters, so the UPDATEs run on PostgreSQL as well (see
 * never-expires-backfill.ts for why a parameter-less UPDATE does not).
 */
const ENTITIES = [
  'sap.llm.gateway.admin.ApiKeyUsage',
  'sap.llm.gateway.admin.AwsCredentialUsage',
];
const MARKER = 'sap.llm.gateway.admin.SapTenantBackfill';
const MARKER_ID = 'sap-tenant';

/** Set once the marker is known to exist in this process: later batches skip the lookup. */
let done = false;

export function __resetBackfillDoneForTests(): void {
  done = false;
}

/** The environment key's tenant, from AUTH_URL and SAP_AI_CORE_URL; null without a usable AUTH_URL. */
export function environmentTenant(env: Record<string, string | undefined> = process.env): SapTenantIdentity | null {
  if (!env.AUTH_URL) return null;
  try {
    return tenantFromAuthUrl(env.AUTH_URL, env.SAP_AI_CORE_URL || '');
  } catch {
    return null;
  }
}

/** The earliest validFrom of a usage row that carries a tenant, as stored; null when none does. */
async function earliestStamped(tx: any): Promise<string | null> {
  let earliest: string | null = null;
  for (const entity of ENTITIES) {
    const row = await tx.run(cds.ql.SELECT.one.from(entity).columns('min(validFrom) as earliest').where('sapTenant is not null'));
    const at = row?.earliest ? new Date(row.earliest).toISOString() : null;
    if (at && (!earliest || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * Gives the SAP usage rows without a tenant that are older than the first stamped row (else than
 * `fallbackBound`) the zone, once ever. Returns the number of rows changed, or null when the
 * backfill already ran.
 */
export async function backfillEnvironmentTenantOnce(db: any, zone: string, fallbackBound: Date): Promise<number | null> {
  if (done) return null;
  const { SELECT, INSERT, UPDATE } = cds.ql;
  // db.tx(fn) would open a root transaction and deadlock the single SQLite connection from inside a
  // request; db.run(fn) joins the ambient one or opens its own.
  const result: number | null = await db.run(async (tx: any) => {
    if (await tx.run(SELECT.one.from(MARKER).columns('ID').where({ ID: MARKER_ID }))) return null;
    const bound = (await earliestStamped(tx)) ?? fallbackBound.toISOString();
    await tx.run(INSERT.into(MARKER).entries({ ID: MARKER_ID, zone, bound, rowsUpdated: 0, ranAt: new Date().toISOString() }));
    let updated = 0;
    for (const entity of ENTITIES) {
      // origin is null on rows older than that column's default; both count as SAP rows.
      for (const origin of [null, { '!=': 'external' }]) {
        const affected = await tx.run(UPDATE(entity).set({ sapTenant: zone })
          .where({ sapTenant: null }).and({ origin }).and({ validFrom: { '<': bound } }));
        updated += Number(affected) || 0;
      }
    }
    await tx.run(UPDATE(MARKER).set({ rowsUpdated: updated }).where({ ID: MARKER_ID }));
    return updated;
  });
  done = true;
  return result;
}

/** Per-tenant usage reads (reconciliation, the Cost tab filter): rows of one tenant in a date range. */
export const SAP_TENANT_INDEXES: IndexSpec[] = [
  { name: 'idx_apikeyusage_saptenant_date', table: 'sap_llm_gateway_admin_ApiKeyUsage', columns: ['sapTenant', 'validFrom'] },
  { name: 'idx_awscredentialusage_saptenant_date', table: 'sap_llm_gateway_admin_AwsCredentialUsage', columns: ['sapTenant', 'validFrom'] },
];

/** Created on every boot like tool-usage-indexes.ts (CAP's schema evolution makes none). Never throws. */
export async function ensureSapTenantIndexes(db: { run: (sql: string) => Promise<any> }): Promise<IndexResult> {
  const result: IndexResult = { ensured: 0, failed: [] };
  for (const idx of SAP_TENANT_INDEXES) {
    try {
      await db.run(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table} (${idx.columns.join(', ')})`);
      result.ensured += 1;
    } catch (error) {
      result.failed.push({ name: idx.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
