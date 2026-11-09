// Seed part 2: grounding corpus, real usage backdated over 30 days, two failed sign-ins, the run's SAP cost.
// Each step records itself in the state file, so a re-run skips what is done and makes no new calls.
import { seedGrounding } from './grounding.mjs';
import { runUsage, waitForUsage, backdateUsage, failSignIns } from './usage.mjs';

export async function seedPart2({ client, state, gatewayUrl, corpusDir, models, adminEmail, save, log }) {
  const keyList = Object.values(state.keys).map((k) => k.key);
  const keyIds = Object.values(state.keys).map((k) => k.id);
  if (keyList.length !== 4) throw new Error(`expected the four active demo keys, found ${keyList.length}`);

  if (!state.vectorStoreId) {
    const g = await seedGrounding({ gatewayUrl, apiKey: state.keys[adminEmail].key, corpusDir, log });
    state.vectorStoreId = g.vectorStoreId;
    if (g.fileIds) state.fileIds = g.fileIds;
    save(state);
  } else log(`vector store ${state.vectorStoreId} already seeded`);

  if (!state.usage) {
    // Rows of this run only: five minutes of slack for the clock of the Docker VM.
    const since = new Date(Date.now() - 5 * 60000).toISOString();
    const u = await runUsage({ gatewayUrl, keyList, models, log });
    if (u.ok < u.total / 2) throw new Error(`only ${u.ok} of ${u.total} usage calls succeeded`);
    const rows = await waitForUsage({ client, keyIds, since, expected: u.ok, log });
    if (!rows) throw new Error('no usage rows arrived within 2 minutes');
    const backdated = backdateUsage({ keyIds, since, log });
    state.usage = { at: new Date().toISOString(), ok: u.ok, failed: u.failed, rows, backdated };
    save(state);
  } else log(`usage already seeded (${state.usage.backdated} rows backdated)`);

  if (!state.failedSignIns && state.disabled && state.expired) {
    state.failedSignIns = await failSignIns({ gatewayUrl, client, disabledKey: state.disabled.key, expired: state.expired, model: models.cheapChat, log });
    save(state);
  } else if (state.failedSignIns) log('failed sign-ins already made');

  const cost = await sapCost(client, keyIds);
  log(`SAP cost of the demo keys: ${cost || 'none recorded'}`);
  return cost;
}

/** Sums ApiKeyUsageSapCostStats over the demo keys, per currency ("0.012345 EUR"). */
export async function sapCost(client, keyIds) {
  const filter = encodeURIComponent(keyIds.map((id) => `apiKey_ID eq ${id}`).join(' or '));
  const r = await client.entity('ApiKeyUsageSapCostStats', `?$filter=${filter}`);
  if (r.status >= 300) throw new Error(`ApiKeyUsageSapCostStats: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  const sums = {};
  for (const row of r.json.value ?? []) sums[row.sapCostCurrency ?? 'n/a'] = (sums[row.sapCostCurrency ?? 'n/a'] ?? 0) + Number(row.totalSapCost ?? 0);
  return Object.entries(sums).map(([c, v]) => `${v.toFixed(6)} ${c}`).join(', ');
}
