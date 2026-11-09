// Creates the API keys and the AWS credential through the admin's OData actions (admin identity).
// Returns the secrets so seed.js can store them in out/seed-keys.json (never printed).

/** Throws with the status and the first 200 characters of the body unless the answer is 2xx. */
export function must(r, label) {
  if (r.status >= 300) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
}

// The cockpit creates keys through the ApiKeys draft, which writes no permission rows, and the
// gateway grants nothing per key permission: an empty list is the cockpit's default.
const KEY_PERMISSIONS = [];
// createAwsCredentials parses "service:action" strings; this is the gateway's own default grant.
const AWS_PERMISSIONS = ['bedrock:InvokeModel'];
const EXPIRES_IN_MS = 120 * 1000;

export async function seedAccess(client, todo, log) {
  const out = {};
  for (const k of todo.keys) {
    const created = must(await client.action('createApiKey', { name: k.name, email: k.email, permissions: KEY_PERMISSIONS,
      rateLimits: { requestsPerMinute: 60, requestsPerHour: 1000, requestsPerDay: 10000 } }), `createApiKey ${k.name}`);
    const rec = { id: created.id, key: created.key, name: k.name };
    if (k.state === 'disabled') {
      const d = must(await client.action('disableApiKey', { keyId: rec.id }), `disableApiKey ${k.name}`);
      if (d && d.success === false) throw new Error(`disableApiKey ${k.name}: ${String(d.message).slice(0, 200)}`);
      out.disabled = rec;
    } else if (k.state === 'expired') {
      rec.expiresAt = new Date(Date.now() + EXPIRES_IN_MS).toISOString();
      log(`expiry set through ${await expire(client, rec.id, rec.expiresAt)}`);
      out.expired = rec;
    } else {
      (out.keys ??= {})[k.email] = rec;
    }
    log(`key ${k.name} (${k.state})`);
  }
  if (todo.aws) {
    const a = todo.aws;
    const r = must(await client.action('createAwsCredentials', { userId: a.email, email: a.email, name: a.name, description: a.description,
      expiresAt: null, permissions: AWS_PERMISSIONS }), 'createAwsCredentials');
    out.aws = { id: r.id, accessKeyId: r.accessKeyId };
    log('aws credential created');
  }
  return out;
}

// The admin refuses an expiry in the past, so the "expired" key lapses shortly after seeding.
// Direct PATCH on the active entity first; the draft edit/activate flow if the admin refuses it.
async function expire(client, id, expiresAt) {
  const body = { expiresAt, neverExpires: false };
  const direct = await client.patch(`/odata/v4/admin/ApiKeys(ID=${id},IsActiveEntity=true)`, body);
  if (direct.status < 300) return 'direct PATCH';
  console.log(`seed: direct expiry PATCH refused: ${direct.status} ${JSON.stringify(direct.json).slice(0, 200)}`);
  must(await client.boundAction(`ApiKeys(ID=${id},IsActiveEntity=true)`, 'draftEdit', { PreserveChanges: true }), 'expire draftEdit');
  must(await client.patch(`/odata/v4/admin/ApiKeys(ID=${id},IsActiveEntity=false)`, body), 'expire draft PATCH');
  must(await client.boundAction(`ApiKeys(ID=${id},IsActiveEntity=false)`, 'draftActivate', {}), 'expire draftActivate');
  return `draft flow (direct PATCH answered ${direct.status})`;
}
