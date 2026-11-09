import { getDefaultLogger } from '@libs/logger';
import { deleteCredential } from './credentialStore';
import { recordAuditEvent } from '../services/auditEventService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();

const CREDENTIALS_ENTITY = 'sap.llm.gateway.admin.SiemCredentials';
const CONFIGURATIONS_ENTITY = 'sap.llm.gateway.admin.ApiConfigurations';

/**
 * A `SiemCredentials` row that nothing can reach any more: either its configuration is gone,
 * or the configuration exists but no sink in it names this slot. Metadata only - see
 * findOrphanedCredentials for why a value or ciphertext must never end up on this shape.
 */
export interface OrphanedCredential {
  configurationId: string;
  configurationName: string | null;   // null when the configuration no longer exists
  name: string;                       // the slot
  reason: 'no-configuration' | 'not-referenced';
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Every credential slot name a configuration's sinks reference: the value of every `*_env`
 * field on every entry of `api_config.observability.siem.sinks`. Mirrors the client-side computation in
 * ConfigFormSinks.ts's confirmRemove, which walks the same `*_env` fields for the same reason.
 *
 * Returns null - never an empty set - when the document cannot be trusted to say what it
 * needs: `configData` that fails to parse, or that parses but carries no `siem` block. An
 * empty set would tell the caller "this configuration needs nothing", which is a very
 * different claim from "this configuration's needs could not be determined" and would turn a
 * malformed document into a mass deletion. The caller treats null as "assume referenced".
 */
function referencedSlots(configData: string): Set<string> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(configData);
  } catch {
    return null;
  }

  const siem = parsed?.api_config?.observability?.siem;
  if (!siem || typeof siem !== 'object') return null;

  const slots = new Set<string>();
  for (const sink of Array.isArray(siem.sinks) ? siem.sinks : []) {
    if (!sink || typeof sink !== 'object') continue;
    for (const [key, value] of Object.entries(sink)) {
      if (/_env$/.test(key) && typeof value === 'string' && value.length > 0) {
        slots.add(value);
      }
    }
  }
  return slots;
}

/**
 * Walks every `SiemCredentials` row and classifies it. Never deletes, never returns a value or
 * ciphertext - this is a report, and the only thing it is safe to act on unattended is the
 * decision NOT to delete.
 *
 * A configuration is looked up once per row rather than joined, because the composition from
 * ApiConfigurations to SiemCredentials only reaches rows whose configuration still exists;
 * the `no-configuration` case is exactly a row that composition can no longer see.
 */
export async function findOrphanedCredentials(): Promise<OrphanedCredential[]> {
  const { SELECT } = cds.ql;
  const [credentials, configurations] = await Promise.all([
    SELECT.from(CREDENTIALS_ENTITY).columns('configuration_ID', 'name', 'modifiedAt', 'modifiedBy'),
    SELECT.from(CONFIGURATIONS_ENTITY).columns('ID', 'name', 'configData'),
  ]);

  const configById = new Map<string, { name: string; configData: string }>(
    configurations.map((c: any) => [c.ID, { name: c.name, configData: c.configData }]),
  );

  // Parsing configData is the expensive part; a configuration with many credential rows would
  // otherwise reparse the same document once per row.
  const referencedCache = new Map<string, Set<string> | null>();

  const orphans: OrphanedCredential[] = [];
  for (const row of credentials) {
    const configurationId = row.configuration_ID;
    const config = configById.get(configurationId);

    if (!config) {
      orphans.push({
        configurationId,
        configurationName: null,
        name: row.name,
        reason: 'no-configuration',
        updatedAt: row.modifiedAt,
        updatedBy: row.modifiedBy,
      });
      continue;
    }

    if (!referencedCache.has(configurationId)) {
      referencedCache.set(configurationId, referencedSlots(config.configData));
    }
    const referenced = referencedCache.get(configurationId)!;

    // null: the document could not be trusted to say what it needs - treat every credential
    // in it as referenced rather than risk deleting a live one over a parse failure.
    if (referenced === null) continue;

    if (!referenced.has(row.name)) {
      orphans.push({
        configurationId,
        configurationName: config.name,
        name: row.name,
        reason: 'not-referenced',
        updatedAt: row.modifiedAt,
        updatedBy: row.modifiedBy,
      });
    }
  }

  return orphans;
}

/**
 * Deletes exactly the rows named by `orphans` - nothing is re-derived or re-classified here,
 * so the caller (the deleteOrphanedSiemCredentials action) is the one place that decides which
 * rows this actually touches. One audit event per deletion, naming the slot and configuration
 * and never a value, using the same action/resourceType deleteSiemCredential already writes so
 * a manual delete and a swept delete land in the same audit trail. A failure on one row is
 * logged and skipped rather than aborting the rest - one bad row must not block cleaning up
 * the others.
 */
export async function deleteOrphanedCredentials(
  orphans: OrphanedCredential[], actor: string,
): Promise<number> {
  let deleted = 0;
  for (const orphan of orphans) {
    try {
      await deleteCredential(orphan.configurationId, orphan.name);
      deleted += 1;
      await recordAuditEvent({
        actorId: actor,
        actorType: 'admin_user',
        action: 'siem_credential.delete',
        resourceType: 'SiemCredential',
        resourceId: orphan.name,          // the NAME, never the value
        outcome: 'success',
        severity: 'high',
        details: JSON.stringify({ configurationId: orphan.configurationId, reason: orphan.reason, sweep: true }),
      });
    } catch (error) {
      logger.error(
        'SiemCredentialSweep',
        `Failed to delete orphaned credential '${orphan.name}' for configuration ${orphan.configurationId}`,
        error as Error,
      );
    }
  }
  return deleted;
}
