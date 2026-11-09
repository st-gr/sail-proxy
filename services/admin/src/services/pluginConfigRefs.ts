const cds = require('@sap/cds');

const ACTIVE_CONFIGURATION = 'sap.llm.gateway.admin.ApiConfigurations';

/** Every `callback.id` anywhere in the document: the rules its hooks name. */
export function callbackIds(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((child) => callbackIds(child, found));
  } else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'callback' && child && typeof (child as any).id === 'string') found.add((child as any).id);
      else callbackIds(child, found);
    }
  }
  return found;
}

/** The active stored configuration (`configData` parsed), or null when none is active. */
export async function activeConfiguration(): Promise<{ ID: string; configData: Record<string, unknown> } | null> {
  const row = await cds.run(cds.ql.SELECT.one.from(ACTIVE_CONFIGURATION).columns('ID', 'configData').where({ isActive: true }).orderBy('version desc'));
  return row?.configData ? { ID: row.ID, configData: JSON.parse(row.configData) } : null;
}

/** The rule ids the active configuration's hooks name; empty when none is active. */
export async function activeConfigCallbackIds(): Promise<Set<string>> {
  const active = await activeConfiguration();
  return active ? callbackIds(active.configData) : new Set();
}
