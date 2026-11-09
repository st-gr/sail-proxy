// Quota profile + assignment, tool policy (draft-enabled entity) + assignment, one manual model price.
import { must } from './access.mjs';

export async function seedGovernance(client, todo, log) {
  const out = {};
  if (todo.quotaProfile || todo.toolPolicy) {
    // Self-healing backfill of the Users rows for every credential e-mail; both assignments need them.
    must(await client.get('/odata/v4/admin/quotaProfileUsers()'), 'quotaProfileUsers');
  }
  if (todo.quotaProfile) {
    const { assignTo, ...profile } = todo.quotaProfile;
    const r = must(await client.post('/odata/v4/admin/QuotaProfiles', profile), 'QuotaProfiles');
    out.quotaProfileId = r.ID;
    must(await client.action('assignQuotaProfile', { email: assignTo, profileId: r.ID }), 'assignQuotaProfile');
    log('quota profile created and assigned');
  }
  if (todo.toolPolicy) {
    const { assignTo, allows, denies, ...policy } = todo.toolPolicy;
    const id = must(await client.post('/odata/v4/admin/ToolPolicies', policy), 'ToolPolicies draft').ID;
    const draft = `/odata/v4/admin/ToolPolicies(ID=${id},IsActiveEntity=false)`;
    for (const pattern of allows) must(await client.post(`${draft}/allows`, { pattern }), `allow ${pattern}`);
    for (const pattern of denies) must(await client.post(`${draft}/denies`, { pattern }), `deny ${pattern}`);
    must(await client.boundAction(`ToolPolicies(ID=${id},IsActiveEntity=false)`, 'draftActivate', {}), 'ToolPolicies draftActivate');
    must(await client.boundAction(`ToolPolicies(ID=${id},IsActiveEntity=true)`, 'assignUser', { email: assignTo }), 'ToolPolicies assignUser');
    out.toolPolicyId = id;
    log('tool policy created, activated and assigned');
  }
  if (todo.price) {
    const { modelId, inputCost, outputCost, imageOutputCost } = todo.price;
    const r = must(await client.boundAction(`LibraryModels('${encodeURIComponent(modelId)}')`, 'setPrice', {
      inputCost, outputCost, imageOutputCost, cacheReadInputCost: null, cacheCreationInputCost: null, audioInputCost: null, audioOutputCost: null
    }), `setPrice ${modelId}`);
    out.priceId = r.ID;
    log(`manual model price set for ${modelId}`);
  }
  return out;
}

/**
 * Resolves the price selector to a Model Library id: the preferred id, else the first id containing
 * `contains` that is not an embedding model, else the first model. Refreshes the library first.
 */
export async function resolvePriceModel(client, selector, log) {
  const refresh = await client.action('refreshModelLibrary', {});
  if (refresh.status >= 300) log(`refreshModelLibrary answered ${refresh.status}; using the stored library`);
  const ids = async (q) => (must(await client.entity('LibraryModels', q), 'LibraryModels').value ?? []).map((m) => m.modelId);
  const matches = await ids(`?$select=modelId&$orderby=modelId&$filter=contains(modelId,'${selector.contains}')`);
  const chosen = matches.find((m) => m === selector.prefer) ?? matches.find((m) => !m.includes('embed')) ?? (await ids('?$select=modelId&$top=1'))[0];
  if (!chosen) throw new Error('LibraryModels is empty: no model to price');
  return chosen;
}
