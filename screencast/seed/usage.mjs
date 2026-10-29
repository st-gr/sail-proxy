// Real calls through the gateway with the four demo keys (cheap models from the live table), then this
// run's rows are backdated over 30 days with SQL on the throwaway Postgres. Two failed sign-ins (disabled
// and expired key) make the Security Notifications app show something.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { backdatePlan, backdateSql } from './backdate.mjs';

const PROMPTS = ['Summarize the benefits of an API gateway in one sentence.', 'List three uses of embeddings.', 'What is SigV4? One line.',
  'Name one Kubernetes concept and define it in a sentence.', 'Explain rate limiting briefly.'];
const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
const TABLE = 'sap_llm_gateway_admin_apikeyusage';
const UUID = /^[0-9a-f-]{36}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(gatewayUrl, path, key, body) {
  try {
    const r = await fetch(`${gatewayUrl}/openai/v1/${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await r.arrayBuffer();
    return r.status;
  } catch { return 0; }
}

/** The call list (pure): chats round-robin over the keys, one in five on Claude, then embeddings, then tool calls. */
export function usageJobs(keyList, models, counts) {
  const jobs = [];
  for (let i = 0; i < counts.chat; i++) jobs.push({ key: keyList[i % keyList.length], path: 'chat/completions',
    body: { model: i % 5 === 0 ? models.claude : models.cheapChat, messages: [{ role: 'user', content: PROMPTS[i % PROMPTS.length] }], max_tokens: 60 } });
  for (let i = 0; i < counts.embed; i++) jobs.push({ key: keyList[i % keyList.length], path: 'embeddings',
    body: { model: models.embedding, input: PROMPTS[i % PROMPTS.length] } });
  for (let i = 0; i < counts.tools; i++) jobs.push({ key: keyList[0], path: 'chat/completions',
    body: { model: models.cheapChat, messages: [{ role: 'user', content: 'What is the weather in Oslo? Use the tool.' }], tools: TOOLS, max_tokens: 60 } });
  return jobs;
}

/** One sequential worker per key, so no key runs faster than one request at a time. */
export async function runUsage({ gatewayUrl, keyList, models, counts = { chat: 120, embed: 20, tools: 3 }, log }) {
  const jobs = usageJobs(keyList, models, counts);
  const statuses = {};
  await Promise.all(keyList.map(async (key) => {
    for (const j of jobs.filter((x) => x.key === key)) { const s = await post(gatewayUrl, j.path, j.key, j.body); statuses[s] = (statuses[s] ?? 0) + 1; }
  }));
  const ok = statuses[200] ?? 0;
  log(`usage: ${ok} ok, ${jobs.length - ok} failed of ${jobs.length} (statuses ${JSON.stringify(statuses)})`);
  return { ok, failed: jobs.length - ok, total: jobs.length };
}

const keyFilter = (keyIds) => keyIds.map((id) => `apiKey_ID eq ${id}`).join(' or ');

export async function usageCount(client, keyIds, since) {
  const r = await client.entity('ApiKeyUsage', `?$count=true&$top=0&$filter=(${encodeURIComponent(keyFilter(keyIds))})${since ? `%20and%20validFrom%20ge%20${since}` : ''}`);
  if (r.status >= 300) throw new Error(`ApiKeyUsage count: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json['@odata.count'];
}

/**
 * Polls until the count of this run's rows stops growing for `quietMs` (at most `maxMs`). No early exit at
 * `expected`: refused calls (429) and the grounding's embeddings write rows too, and rows land in bursts.
 */
export async function waitForUsage({ client, keyIds, since, expected, log, quietMs = 20000, maxMs = 120000, stepMs = 5000 }) {
  const start = Date.now(); let last = -1, lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    const n = await usageCount(client, keyIds, since);
    if (n !== last) { last = n; lastChange = Date.now(); }
    if (n > 0 && Date.now() - lastChange >= quietMs) break;
    await sleep(stepMs);
  }
  log(`usage rows arrived: ${last} (${expected} calls answered 200) after ${Math.round((Date.now() - start) / 1000)} s`);
  return last;
}

/** psql inside the Postgres container; the user name comes from the container's own environment. SQL on stdin. */
export function psql(sql, container = 'sail-docs-postgres-1') {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'psql -U "$POSTGRES_USER" -d sap_llm_gateway -At -v ON_ERROR_STOP=1'],
    { input: sql, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
}

/** Backdates this run's usage rows of the listed keys only (never the product's own service key). */
export function backdateUsage({ keyIds, since, log, run = psql, now = new Date() }) {
  if (!keyIds.length || !keyIds.every((id) => UUID.test(id))) throw new Error('backdate: key ids must be UUIDs');
  const rows = run(`SELECT id FROM ${TABLE} WHERE apikey_id IN (${keyIds.map((id) => `'${id}'`).join(',')}) AND validfrom >= '${since}';\n`)
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const sql = backdateSql(backdatePlan(rows, { days: 30, now }), TABLE);
  log(`backdate SQL: ${sql.trim().split('\n').length} lines; first: ${(sql.split('\n')[0] ?? '').replace(/WHERE id = '[^']*'/, "WHERE id = '<id>'")}`);
  if (rows.length) run(`BEGIN;\n${sql}COMMIT;\n`);
  log(`backdated ${rows.length} usage rows over 30 days`);
  return rows.length;
}

/** Two failed sign-ins: the disabled key, and the expired key once its expiry has lapsed. Falls back to a never-issued key. */
export async function failSignIns({ gatewayUrl, client, disabledKey, expired, model, log }) {
  const wait = new Date(expired.expiresAt).getTime() + 5000 - Date.now();
  if (wait > 0) { log(`waiting ${Math.ceil(wait / 1000)} s for the trial key to expire`); await sleep(wait); }
  const body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 };
  const before = await failedAuthCount(client);
  const a = await post(gatewayUrl, 'chat/completions', disabledKey, body);
  const b = await post(gatewayUrl, 'chat/completions', expired.key, body);
  log(`failed sign-ins answered ${a} (disabled) and ${b} (expired)`);
  const after = await pollNotifications(client, before, 2);
  if (after - before >= 2) { log(`security notifications: ${after - before} new failed_auth`); return { disabled: a, expired: b, fallback: false }; }
  const c = await post(gatewayUrl, 'chat/completions', randomBytes(32).toString('hex'), body);
  const final = await pollNotifications(client, before, 2);
  log(`only ${after - before} notification(s) from the two keys; fallback never-issued key answered ${c}; now ${final - before} new`);
  return { disabled: a, expired: b, fallback: true };
}

async function failedAuthCount(client) {
  const r = await client.entity('SecurityNotifications', `?$count=true&$top=0&$filter=eventType%20eq%20'failed_auth'`);
  if (r.status >= 300) throw new Error(`SecurityNotifications: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json['@odata.count'];
}

async function pollNotifications(client, before, want, maxMs = 30000) {
  const start = Date.now(); let n = before;
  while (Date.now() - start < maxMs) { n = await failedAuthCount(client); if (n - before >= want) break; await sleep(2000); }
  return n;
}
