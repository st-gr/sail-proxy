// The demo Connections (video 05 section 8): one per provider whose credentials are in the provider env files
// (stack/provider-redactions.mjs reads the same files and masks every value on screen). Each connection gets its
// credential, a test, one priced and published model, and one short call so Usage shows Connection spend.
// Bedrock is created and tested only: the maintainer's AWS account signs in but is not allowed to invoke.
import { must } from './access.mjs';

/** The connections the env allows, each with the one model it publishes. Secrets stay in `secret`, never logged. */
export function connectionSpecs(env) {
  const specs = [];
  if (env.OPENAI_API_KEY) specs.push({ name: 'openai', title: 'OpenAI', providerType: 'openai', fields: {},
    secret: env.OPENAI_API_KEY, model: 'gpt-4.1-mini', family: 'openai', call: 'chat', price: [0.0004, 0.0016] });
  if (env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_DEPLOYMENT) specs.push({ name: 'azure', title: 'Azure OpenAI',
    providerType: 'azure-openai', fields: { endpoint: env.AZURE_OPENAI_ENDPOINT, authMode: 'api-key' },
    secret: env.AZURE_OPENAI_API_KEY, model: env.AZURE_OPENAI_DEPLOYMENT, family: 'openai', call: 'chat', price: [0.0004, 0.0016] });
  if (env.ANTHROPIC_API_KEY) specs.push({ name: 'anthropic', title: 'Anthropic', providerType: 'anthropic', fields: {},
    secret: env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5-20251001', family: 'claude', call: 'messages', price: [0.001, 0.005] });
  if (env.AWS_REGION && env.BEDROCK_MODEL_ID && env.AWS_BEARER_TOKEN_BEDROCK) specs.push({ name: 'bedrock', title: 'AWS Bedrock',
    providerType: 'bedrock', fields: { region: env.AWS_REGION, authMode: 'bearer' },
    secret: env.AWS_BEARER_TOKEN_BEDROCK, model: env.BEDROCK_MODEL_ID, family: 'claude', call: null, price: [0.001, 0.005] });
  return specs;
}

// About ten tokens; repeated to make a prompt of roughly the asked size.
const FILLER = 'The quick brown fox jumps over the lazy dog near the river bank. ';

/** The request body and gateway path for one short call to a published connection model; `tokens` pads the prompt. */
export function usageCall(spec, tokens = 0) {
  const model = `${spec.model}--${spec.name}`;
  const content = FILLER.repeat(Math.ceil(tokens / 10)) + 'Say hello in five words.';
  if (spec.call === 'chat') return { path: '/openai/v1/chat/completions', body: { model, max_tokens: 20, messages: [{ role: 'user', content }] } };
  if (spec.call === 'messages') return { path: '/anthropic/v1/messages', body: { model, max_tokens: 20, messages: [{ role: 'user', content }] } };
  return null;
}

/** Real credential hints (first and last four characters of a key) → a mask, for redact.extra.local.json. */
export function hintMap(rows) {
  return Object.fromEntries(rows.map((r) => r.credentialHint).filter((h) => h && h !== '…').map((h) => [h, '••••…••••']));
}

export async function seedConnections({ client, specs, gatewayUrl, apiKey, log, spend = 0 }) {
  const list = async (set, q) => must(await client.entity(set, q), set).value ?? [];
  for (const s of specs) {
    let id = (await list('ProviderConnections', `?$select=ID&$filter=name eq '${s.name}' and IsActiveEntity eq true`))[0]?.ID;
    if (!id) {
      id = must(await client.post('/odata/v4/admin/ProviderConnections',
        { name: s.name, title: s.title, providerType: s.providerType, ...s.fields, IsActiveEntity: true }), `connection ${s.name}`).ID;
      log(`connection ${s.name} created`);
    }
    const path = `ProviderConnections(ID=${id},IsActiveEntity=true)`;
    must(await client.boundAction(path, 'setCredential', { secret: s.secret, sessionToken: null }), `setCredential ${s.name}`);
    const test = must(await client.boundAction(path, 'testConnection', {}), `testConnection ${s.name}`);
    log(`connection ${s.name} test: ${test?.ok ? 'ok' : `failed (${test?.reason ?? test?.code ?? 'no reason'})`}`);
    let model = (await list('ConnectionModels', `?$select=ID,isPublished&$filter=connection_ID eq ${id} and upstreamModel eq '${s.model}'`))[0];
    if (!model) model = must(await client.boundAction(path, 'addModel', { upstreamModel: s.model, displayName: null, family: s.family }), `addModel ${s.name}`);
    if (!model.isPublished) {
      const mp = `ConnectionModels(ID=${model.ID})`;
      must(await client.boundAction(mp, 'setListPrice', { inputCost: s.price[0], outputCost: s.price[1], cacheReadCost: null, cacheCreationCost: null, currency: null }), `setListPrice ${s.name}`);
      must(await client.boundAction(mp, 'publish', {}), `publish ${s.name}`);
      log(`connection ${s.name}: ${s.model} priced and published`);
    }
    if (!usageCall(s)) { log(`connection ${s.name}: no call (test only)`); continue; }
    // spend: that many extra calls with a ~25k-token prompt, so the Connections cost tile shows cents, not $0.00.
    for (let i = 0; i <= spend; i++) {
      const call = usageCall(s, i === 0 ? 0 : 25000);
      const r = await fetch(gatewayUrl + call.path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(call.body) });
      await r.text();
      log(`connection ${s.name}: call ${r.status}`);
    }
  }
}

/** SAP AI Core tenants from service key objects, the installation's own tenant first (a, b, …). */
export function sapTenantSpecs(keys) {
  return keys.map((key, i) => {
    const t = String.fromCharCode(97 + i);
    return { name: `sap-tenant-${t}`, title: i === 0 ? 'SAP AI Core (installation)' : `SAP AI Core (tenant ${t.toUpperCase()})`,
      providerType: 'sap-ai-core', fields: { productive: true }, secret: JSON.stringify(key) };
  });
}

// Every SAP tenant is created and tested; each later tenant is activated for one short SAP call (so Usage has
// cost per tenant), then the first tenant, the installation's own, is active again. The gateways switch through the
// change marker, so each switch waits before the call.
/** The SAP calls made while tenant `index` is active: one short call, plus `spend` long ones on later tenants. */
export function sapCalls(index, spend, model, spendModel) {
  const calls = [{ model, tokens: 0 }];
  if (index > 0) for (let i = 0; i < spend; i++) calls.push({ model: spendModel, tokens: 25000 });
  return calls;
}

export async function seedSapTenants({ client, specs, gatewayUrl, apiKey, model, log, settleMs = 8000, spend = 0, spendModel = model }) {
  const list = async (set, q) => must(await client.entity(set, q), set).value ?? [];
  const paths = [];
  for (const s of specs) {
    let id = (await list('ProviderConnections', `?$select=ID&$filter=name eq '${s.name}' and IsActiveEntity eq true`))[0]?.ID;
    if (!id) {
      id = must(await client.post('/odata/v4/admin/ProviderConnections',
        { name: s.name, title: s.title, providerType: s.providerType, ...s.fields, IsActiveEntity: true }), `connection ${s.name}`).ID;
      log(`connection ${s.name} created`);
    }
    const path = `ProviderConnections(ID=${id},IsActiveEntity=true)`;
    const current = (await list('ProviderConnections', `?$select=isActive&$filter=ID eq ${id} and IsActiveEntity eq true`))[0];
    if (!current?.isActive) must(await client.boundAction(path, 'setCredential', { secret: s.secret, sessionToken: null }), `setCredential ${s.name}`);
    const test = must(await client.boundAction(path, 'testConnection', {}), `testConnection ${s.name}`);
    log(`connection ${s.name} test: ${test?.ok ? 'ok' : `failed (${test?.reason ?? test?.code ?? 'no reason'})`}`);
    paths.push(path);
  }
  const call = async (label, { model: m, tokens }) => {
    const r = await fetch(gatewayUrl + '/openai/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: m, max_tokens: 20, messages: [{ role: 'user', content: FILLER.repeat(Math.ceil(tokens / 10)) + 'Say hello in five words.' }] }) });
    await r.text();
    log(`${label}: SAP call ${r.status}`);
  };
  for (const [i, path] of paths.entries()) {
    must(await client.boundAction(path, 'activate', {}), `activate ${specs[i].name}`);
    await new Promise((res) => setTimeout(res, settleMs));
    for (const c of sapCalls(i, spend, model, spendModel)) await call(specs[i].name, c);
  }
  if (paths.length > 1) {
    must(await client.boundAction(paths[0], 'activate', {}), `activate ${specs[0].name}`);
    log(`connection ${specs[0].name} active again`);
  }
}
