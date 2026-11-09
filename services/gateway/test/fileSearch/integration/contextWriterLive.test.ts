// OPT-IN live probe for the chunk context writer (src/fileSearch/contextWriter.ts) and the
// internal completion helper behind it (orchestrationCompletion.ts), per model family: three
// context calls over the SAME document, one at a time, printing each call's token split so the
// prompt cache shows on calls 2 and 3 (cachedRead > 0).
//
// Skipped unless FILE_SEARCH_CONTEXT_LIVE_PROBE=1. It spends real tokens (3 calls × about 13k
// input tokens per model, most of them cached on calls 2–3; a few cents in all) and is never run
// by CI.
//
// RUNNING IT (from services/gateway):
//   FILE_SEARCH_CONTEXT_LIVE_PROBE=1 npx jest test/fileSearch/integration/contextWriterLive.test.ts
// It needs services/gateway/.env (SAP AI Core credentials); in a worktree a symlink to the main
// checkout's services/gateway/.env works. Do NOT source it in the shell (see embedder.test.ts in
// this directory); this file loads it. It prints token counts and contexts, never credentials.
// A bare run skips it silently.
//
// What it asserts: every call writes a context; for Claude (explicit cache breakpoint on the
// document message, reliable) at least one of calls 2–3 reads from the cache. For Gemini the
// cache is implicit and has been unreliable on some models, so it is reported, not asserted.
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: false });

import { liveModels } from '@libs/test-utils';
import { writeChunkContexts, ContextCallRecord, ContextChunk } from '../../../src/fileSearch/contextWriter';

const LIVE = process.env.FILE_SEARCH_CONTEXT_LIVE_PROBE === '1';
const live = LIVE ? describe : describe.skip;

/** An invented handbook, about 13k tokens: above every family's minimum cacheable prefix, below the window. */
function handbook(): { document: string; chunks: ContextChunk[] } {
  const topics = ['Installation', 'Storage', 'Networking', 'Backups', 'Monitoring', 'Upgrades', 'Security', 'Troubleshooting'];
  const sections: string[] = ['# Quillmark Operations Handbook\n\nQuillmark is an invented ledger service used to test document handling.'];
  topics.forEach((topic, t) => {
    sections.push(`## ${topic}`);
    for (let p = 1; p <= 5; p++) {
      const lines: string[] = [`### ${topic} step ${p}`, ''];
      for (let s = 1; s <= 6; s++) {
        lines.push(`Step ${p}.${s} of ${topic.toLowerCase()}: set the ledger option q${t}${p}${s} to ${(t + 1) * 100 + p * 10 + s} `
          + `and confirm that the ${topic.toLowerCase()} report lists node ${p * s} as healthy before you continue; `
          + `if it does not, wait ${s * 5} seconds and repeat the check up to ${p + 2} times.`);
      }
      sections.push(lines.join('\n'));
    }
  });
  const document = sections.join('\n\n');
  const pick = (heading: string, headingPath: string): ContextChunk => {
    const start = document.indexOf(heading);
    const end = document.indexOf('\n\n###', start + 1);
    return { text: document.slice(start, end === -1 ? undefined : end), headingPath, start };
  };
  return {
    document,
    chunks: [
      pick('### Storage step 2', 'Quillmark Operations Handbook > Storage > Storage step 2'),
      pick('### Backups step 4', 'Quillmark Operations Handbook > Backups > Backups step 4'),
      pick('### Security step 1', 'Quillmark Operations Handbook > Security > Security step 1'),
    ],
  };
}

async function probe(model: string): Promise<ContextCallRecord[]> {
  const { document, chunks } = handbook();
  const calls: ContextCallRecord[] = [];
  const result = await writeChunkContexts(document, chunks, {
    settings: { model, concurrency: 1, requestTimeoutMs: 60_000, fileDeadlineMs: 300_000 },
    onCall: (r) => calls.push(r),
  });
  // eslint-disable-next-line no-console
  console.log(`[context probe] ${model}\n${calls.map((c, i) => `  call ${i + 1}: input ${c.usage.input} `
    + `(cache write ${c.usage.cacheWrite}), cached read ${c.usage.cachedRead}, output ${c.usage.output}, ${c.elapsedMs} ms`).join('\n')}\n`
    + `  failed ${result.failed}${result.stopped ? `, stopped ${result.stopped}` : ''}\n`
    + `${result.contexts.map((c, i) => `  context ${i + 1}: ${c}`).join('\n')}`);
  expect(result.failed).toBe(0);
  expect(calls).toHaveLength(3);
  return calls;
}

live('context writer against the live tenant (opt-in)', () => {
  it(`${liveModels.cheapChat}: three contexts; cached tokens on calls 2+ reported`, async () => {
    const calls = await probe(liveModels.cheapChat);
    for (const c of calls) expect(c.usage.input + c.usage.cachedRead).toBeGreaterThan(5000);
  }, 240_000);

  it(`${liveModels.claude}: three contexts; calls 2+ read the document from the cache`, async () => {
    const calls = await probe(liveModels.claude);
    expect(calls[0].usage.cacheWrite + calls[0].usage.cachedRead).toBeGreaterThan(0);
    expect(Math.max(calls[1].usage.cachedRead, calls[2].usage.cachedRead)).toBeGreaterThan(5000);
  }, 240_000);
});
