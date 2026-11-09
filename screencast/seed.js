#!/usr/bin/env node
// Seeds the demo stack (idempotent) or tears the demo data down (--teardown).
// Talks to the admin directly as the admin identity. Secrets go to out/seed-keys.json (0600), never to stdout.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './lib/odata.mjs';
import { loadState } from './lib/state.mjs';
import { desiredState, diff } from './seed/plan.mjs';
import { seedAccess, must } from './seed/access.mjs';
import { seedGovernance, resolvePriceModel } from './seed/governance.mjs';
import { seedTeam } from './seed/teams.mjs';
import { seedPart2 } from './seed/part2.mjs';
import { teardownGrounding } from './seed/grounding.mjs';
import { connectionSpecs, seedConnections, sapTenantSpecs, seedSapTenants, hintMap } from './seed/connections.mjs';
import { defaultPaths, readProviderEnv, mergeInto } from './stack/provider-redactions.mjs';
import { liveModels } from '../libs/test-utils/dist/live-models.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out'); const KEYS = join(OUT, 'seed-keys.json');
const ADMIN = process.env.SAIL_DOCS_ADMIN_URL || 'http://127.0.0.1:14004';
const GATEWAY = process.env.SAIL_DOCS_GATEWAY_URL || 'http://127.0.0.1:13000';
const ids = JSON.parse(readFileSync(join(here, 'identities.json'), 'utf8'));
const log = (m) => console.log(`seed: ${m}`);

async function existingState(c, priceModelId) {
  const list = async (set, q) => must(await c.entity(set, q), set).value ?? [];
  return {
    keys: await list('ApiKeys', '?$select=ID,name,email&$filter=deletedAt eq null'),
    aws: await list('AwsCredentials', '?$select=ID,name,email&$filter=IsActiveEntity eq true'),
    quotaProfiles: await list('QuotaProfiles', '?$select=ID,name'),
    toolPolicies: await list('ToolPolicies', '?$select=ID,name&$filter=IsActiveEntity eq true'),
    teams: await list('Teams', '?$select=ID,name&$filter=IsActiveEntity eq true'),
    // The current price row is the one whose validity has not ended (open rows carry dateTo 9999-12-31).
    prices: (await list('ModelPrices', "?$select=ID,model,dateTo&$filter=source eq 'manual'")).filter((p) => !p.dateTo || new Date(p.dateTo) > new Date()),
    priceModelId
  };
}

function writeState(state) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(KEYS, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(KEYS, 0o600);
}

// Accepts 2xx and 404 (already gone) and answers true; anything else becomes a warning (false) so the rest still runs.
function settled(r, label, warnings) {
  if (r.status < 300 && r.json?.success !== false) { log(`${label}: removed`); return true; }
  if (r.status === 404 || /not found/i.test(String(r.json?.message ?? ''))) { log(`${label}: already gone`); return true; }
  warnings.push(`${label}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return false;
}

async function teardown(c) {
  if (!existsSync(KEYS)) return log('nothing to tear down');
  const s = loadState(readFileSync(KEYS, 'utf8'));
  const d = desiredState(ids); const warnings = [];
  // Whatever fails to go stays in the state file (with its secret), so a second --teardown can retry it.
  const left = {};
  // The store and its files go first, while the admin's key still signs the gateway calls. Usage rows stay:
  // they disappear from the cockpit with the keys, and `down -v` removes them.
  const adminKey = s.keys?.[ids.admin.email]?.key;
  if (s.vectorStoreId || s.fileIds?.length) {
    if (!adminKey) warnings.push('vector store: no admin key in the state file');
    else {
      const g = await teardownGrounding({ gatewayUrl: GATEWAY, apiKey: adminKey, vectorStoreId: s.vectorStoreId, fileIds: s.fileIds, log });
      Object.assign(left, g.left); warnings.push(...g.warnings);
    }
  }
  for (const [slot, rec] of [...Object.entries(s.keys ?? {}).map(([email, r]) => [['keys', email], r]), [['disabled'], s.disabled], [['expired'], s.expired]]) {
    if (!rec) continue;
    // deleteApiKey revokes (soft delete: the row stays listed); the entity DELETE then removes the row.
    const revoked = settled(await c.action('deleteApiKey', { keyId: rec.id }), `key ${rec.name}`, warnings);
    const removed = settled(await c.del(`/odata/v4/admin/ApiKeys(ID=${rec.id},IsActiveEntity=true)`), `key row ${rec.name}`, warnings);
    if (!(revoked && removed)) slot.length === 2 ? ((left.keys ??= {})[slot[1]] = rec) : (left[slot[0]] = rec);
  }
  if (s.aws && !settled(await c.boundAction(`AwsCredentials(ID=${s.aws.id},IsActiveEntity=true)`, 'deleteAwsCredentials', {}), 'aws credential', warnings)) left.aws = s.aws;
  if (s.priceModelId && !settled(await c.boundAction(`LibraryModels('${encodeURIComponent(s.priceModelId)}')`, 'revertToSapPrice', {}), `price ${s.priceModelId}`, warnings)) left.priceModelId = s.priceModelId;
  if (s.quotaProfileId) {
    // The admin refuses (409) to delete a profile that is still assigned.
    await c.action('unassignQuotaProfile', { email: d.quotaProfile.assignTo });
    if (!settled(await c.del(`/odata/v4/admin/QuotaProfiles(${s.quotaProfileId})`), 'quota profile', warnings)) left.quotaProfileId = s.quotaProfileId;
  }
  // The team goes before its member profile and the policy it references.
  if (s.teamId && !settled(await c.del(`/odata/v4/admin/Teams(ID=${s.teamId},IsActiveEntity=true)`), 'team', warnings)) left.teamId = s.teamId;
  if (s.memberProfileId && !settled(await c.del(`/odata/v4/admin/QuotaProfiles(${s.memberProfileId})`), 'member profile', warnings)) left.memberProfileId = s.memberProfileId;
  if (s.toolPolicyId && !settled(await c.del(`/odata/v4/admin/ToolPolicies(ID=${s.toolPolicyId},IsActiveEntity=true)`), 'tool policy', warnings)) left.toolPolicyId = s.toolPolicyId;
  writeState(left);
  for (const w of warnings) log(`left in place: ${w}`);
  log(`teardown done${warnings.length ? ` with ${warnings.length} record(s) left` : ''}`);
}

async function main() {
  const c = createClient({ baseUrl: ADMIN, identity: ids.admin });
  if (process.argv.includes('--teardown')) return teardown(c);
  // --connections: only the demo Connections (video 05 section 8), from the provider env files; needs the seeded admin key.
  if (process.argv.includes('--connections')) {
    const { env, notes } = readProviderEnv(defaultPaths().files);
    notes.forEach((n) => log(n));
    const adminKey = loadState(readFileSync(KEYS, 'utf8')).keys?.[ids.admin.email]?.key;
    if (!adminKey) throw new Error('no admin key in out/seed-keys.json: run the seed first');
    const spend = process.argv.includes('--spend') ? 4 : 0;
    await seedConnections({ client: c, specs: connectionSpecs(env), gatewayUrl: GATEWAY, apiKey: adminKey, log, spend });
    // SAIL_DOCS_SAP_KEYS: the SAP AI Core service key files, the installation's tenant first (as provider-redactions.mjs).
    const keys = defaultPaths().sapKeys.filter((f) => existsSync(f)).map((f) => JSON.parse(readFileSync(f, 'utf8')));
    await seedSapTenants({ client: c, specs: sapTenantSpecs(keys), gatewayUrl: GATEWAY, apiKey: adminKey, model: liveModels.cheapChat, log,
      spend, spendModel: liveModels.claude });
    // The cockpit shows each key's first and last four characters: masked like the keys (gitignored, mode 600).
    const rows = must(await c.entity('ProviderConnections', '?$select=credentialHint&$filter=IsActiveEntity eq true'), 'hints').value ?? [];
    const extraPath = defaultPaths().extra;
    const { merged, added } = mergeInto(existsSync(extraPath) ? JSON.parse(readFileSync(extraPath, 'utf8')) : {}, hintMap(rows));
    writeFileSync(extraPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 }); chmodSync(extraPath, 0o600);
    return log(`${added.length} credential hints masked; re-run with-service-key.mjs to refresh redact.local.json`);
  }
  const desired = desiredState(ids);
  const priceModelId = await resolvePriceModel(c, desired.price, log);
  const existing = await existingState(c, priceModelId);
  const todo = diff(desired, existing);
  const state = existsSync(KEYS) ? loadState(readFileSync(KEYS, 'utf8')) : {};
  const currentPrice = existing.prices.find((p) => p.model === priceModelId);
  if (currentPrice) state.priceId = currentPrice.ID;
  state.keys ??= {};
  const access = await seedAccess(c, todo, log);
  Object.assign(state.keys, access.keys ?? {}); delete access.keys;
  Object.assign(state, access);
  writeState(state); // the new secrets are on disk before anything else can fail
  Object.assign(state, await seedGovernance(c, todo, log), { priceModelId });
  Object.assign(state, await seedTeam(c, todo.team, log));
  writeState(state);
  const cost = await seedPart2({ client: c, state, gatewayUrl: GATEWAY, corpusDir: join(here, 'seed', 'corpus'), models: liveModels,
    adminEmail: ids.admin.email, save: writeState, log });
  log(`done: ${Object.keys(state.keys).length} active keys, disabled ${!!state.disabled}, expired ${!!state.expired}, aws ${!!state.aws}, price model ${priceModelId}, vector store ${state.vectorStoreId}, ${state.usage?.backdated ?? 0} usage rows backdated, SAP cost ${cost || 'n/a'}`);
}
main().catch((e) => { console.error(`seed failed: ${e.message}`); process.exit(1); });
