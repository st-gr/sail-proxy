// One vector store ("Team handbook") with the three corpus files, uploaded through the gateway with the
// admin's demo key, so the Grounding app shows a store, files and a finished indexing job. Idempotent by name.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const STORE_NAME = 'Team handbook';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(r, label) {
  const text = await r.text();
  if (!r.ok) throw new Error(`${label}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

export async function seedGrounding({ gatewayUrl, apiKey, corpusDir, log, pollMs = 5000, maxPolls = 72 }) {
  const h = { authorization: `Bearer ${apiKey}` };
  const vs = `${gatewayUrl}/openai/v1/vector_stores`;
  const listed = await json(await fetch(`${vs}?limit=100`, { headers: h }), 'list vector stores');
  const existing = (listed.data ?? []).find((s) => s.name === STORE_NAME);
  if (existing) { log(`vector store exists (${existing.id})`); return { vectorStoreId: existing.id }; }

  const fileIds = [];
  for (const name of readdirSync(corpusDir).filter((f) => f.endsWith('.md')).sort()) {
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([readFileSync(join(corpusDir, name))], { type: 'text/markdown' }), name);
    fileIds.push((await json(await fetch(`${gatewayUrl}/openai/v1/files`, { method: 'POST', headers: h, body: form }), `upload ${name}`)).id);
    log(`uploaded ${name}`);
  }
  const store = await json(await fetch(vs, { method: 'POST', headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ name: STORE_NAME, file_ids: fileIds }) }), 'create vector store');
  log(`vector store ${store.id} created, indexing ${fileIds.length} files`);

  // The store's own status can stay in_progress after every file is done: judge by file_counts.
  for (let i = 0; i < maxPolls; i++) {
    const c = (await json(await fetch(`${vs}/${store.id}`, { headers: h }), 'poll vector store')).file_counts ?? {};
    if (c.failed > 0) {
      const files = await json(await fetch(`${vs}/${store.id}/files`, { headers: h }), 'list store files');
      const bad = (files.data ?? []).filter((f) => f.status === 'failed').map((f) => `${f.id}: ${JSON.stringify(f.last_error)}`);
      throw new Error(`indexing failed for ${c.failed} file(s): ${bad.join('; ').slice(0, 400)}`);
    }
    if (c.completed === fileIds.length && !c.in_progress) {
      log(`vector store ${store.id} indexed (${c.completed} files)`);
      return { vectorStoreId: store.id, fileIds };
    }
    await sleep(pollMs);
  }
  throw new Error(`vector store ${store.id} still indexing after ${(maxPolls * pollMs) / 1000} s`);
}

/** Deletes the store, then its files. Answers what is left (ids whose deletion failed) and the warnings. */
export async function teardownGrounding({ gatewayUrl, apiKey, vectorStoreId, fileIds = [], log }) {
  const h = { authorization: `Bearer ${apiKey}` };
  const warnings = [];
  const gone = async (path, label) => {
    const r = await fetch(`${gatewayUrl}/openai/v1/${path}`, { method: 'DELETE', headers: h }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (r.ok) { log(`${label}: removed`); return true; }
    if (r.status === 404) { log(`${label}: already gone`); return true; }
    warnings.push(`${label}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return false;
  };
  const left = {};
  if (vectorStoreId && !(await gone(`vector_stores/${vectorStoreId}`, `vector store ${vectorStoreId}`))) left.vectorStoreId = vectorStoreId;
  const files = [];
  for (const id of fileIds) if (!(await gone(`files/${id}`, `file ${id}`))) files.push(id);
  if (files.length) left.fileIds = files;
  return { left, warnings };
}
