/**
 * The SAP AI Core tenants table (spec 2026-10-25 §6): one row per tenant, keyed by the identity
 * zone of its service keys, so rotating a key keeps the row. Writes join the caller's transaction
 * through cds.run (the admin's SQLite has one connection; see admin-service-connections.ts).
 */
import type { SapTenantIdentity } from '@libs/service-key-parser/types';
import { isProductive } from './sapCapacityService';

const cds = require('@sap/cds');
const TENANTS = 'sap.llm.gateway.admin.SapTenants';

export interface SapTenantPatch {
  productive?: boolean;
  priceRegion?: string | null;
  displayName?: string;
}

/** Inserts the tenant or refreshes its identity; the patch's fields are written when present (null included). */
export async function upsertTenant(identity: SapTenantIdentity, patch: SapTenantPatch): Promise<void> {
  const { SELECT, INSERT, UPDATE } = cds.ql;
  const fields: Record<string, any> = { region: identity.region };
  if (identity.zoneId) fields.zoneId = identity.zoneId;
  for (const f of ['productive', 'priceRegion', 'displayName'] as const) if (patch[f] !== undefined) fields[f] = patch[f];
  const existing = await cds.run(SELECT.one.from(TENANTS).columns('zone').where({ zone: identity.zone }));
  if (existing) await cds.run(UPDATE(TENANTS).set(fields).where({ zone: identity.zone }));
  else await cds.run(INSERT.into(TENANTS).entries({ zone: identity.zone, ...fields }));
}

/** The billing settings of a tenant; null when the tenant is unknown. */
export async function tenantSettings(zone: string): Promise<{ productive: boolean; priceRegion: string | null } | null> {
  const row = await cds.run(cds.ql.SELECT.one.from(TENANTS).columns('productive', 'priceRegion').where({ zone }));
  return row ? { productive: !!row.productive, priceRegion: row.priceRegion ?? null } : null;
}

/** What a usage row of a tenant is priced with. */
export interface TenantBilling {
  productive: boolean;
  priceRegion: string | null;
}

/**
 * The billing terms of the tenants in `zones`, read once for a batch: a tenant's own productive
 * flag when set, else the installation default (platform.billing.productive); its price region or
 * null (any region). A row without a tenant, or of an unknown tenant, gets the default. `db` may be
 * a transaction.
 */
export async function billingForTenants(db: any, zones: string[]): Promise<(zone?: string | null) => TenantBilling> {
  const rows: any[] = zones.length
    ? await db.run(cds.ql.SELECT.from(TENANTS).columns('zone', 'productive', 'priceRegion').where({ zone: { in: zones } }))
    : [];
  const byZone = new Map<string, any>((rows ?? []).map((r: any) => [r.zone, r]));
  const fallback = isProductive();
  return (zone) => {
    const row = zone ? byZone.get(zone) : undefined;
    return { productive: row?.productive == null ? fallback : !!row.productive, priceRegion: row?.priceRegion ?? null };
  };
}

/** The tenant's productive flag when set, else the installation default. */
export async function productiveFor(tenant: string | null): Promise<boolean> {
  return (await billingForTenants(await cds.connect.to('db'), tenant ? [tenant] : []))(tenant).productive;
}

/** The zones in `zones` that have no tenant row yet. */
export async function unknownTenants(db: any, zones: string[]): Promise<string[]> {
  if (zones.length === 0) return [];
  const known = new Set(((await db.run(cds.ql.SELECT.from(TENANTS).columns('zone').where({ zone: { in: zones } }))) ?? []).map((r: any) => r.zone));
  return zones.filter((z) => !known.has(z));
}

/** Copies a SAP AI Core connection's billing settings to its tenant row; false when the tenant has no row. */
export async function setTenantBilling(zone: string, patch: { productive?: boolean | null; priceRegion?: string | null }): Promise<boolean> {
  const fields: Record<string, any> = {};
  for (const f of ['productive', 'priceRegion'] as const) if (patch[f] !== undefined) fields[f] = patch[f];
  if (Object.keys(fields).length === 0) return false;
  const affected = await cds.run(cds.ql.UPDATE(TENANTS).set(fields).where({ zone }));
  return Number(affected) > 0;
}
