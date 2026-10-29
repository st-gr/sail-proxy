// OPT-IN live probe for the vision transcriber (src/fileSearch/visionTranscriber.ts): pages 1–2 of
// the eval corpus's scanned PDF (scanned/user-chapter-1-introduction.pdf, no text layer) rendered
// by the real poppler + sharp and transcribed by each candidate model, after the model check (one
// blank 16 × 16 image). Prints per model and page: tokens, time, the share of the transcription's
// words found in the chapter's Markdown source, and the text — to decide whether the cheaper
// gemini-3.5-flash-lite reads pages as well as gemini-3.8-flash (plan decision on the vision model).
//
// Skipped unless FILE_SEARCH_VISION_LIVE_PROBE=1. It spends real tokens: 2 models × (1 check + 2
// pages × about 1.5k input + 1k output tokens) — a few cents at most — and is never run by CI.
//
// RUNNING IT (from services/gateway; needs pdftotext/pdfinfo/pdftoppm on PATH):
//   FILE_SEARCH_VISION_LIVE_PROBE=1 npx jest test/fileSearch/integration/visionLive.test.ts
// It needs services/gateway/.env (SAP AI Core credentials); in a worktree a symlink to the main
// checkout's services/gateway/.env works. Do NOT source it in the shell; this file loads it. It
// prints token counts and transcriptions, never credentials. A bare run skips it silently.
import * as path from 'path';
import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: false });

import { liveModels } from '@libs/test-utils';
import { runExtractor } from '../../../src/fileSearch/extractors/runners';
import { splitPages } from '../../../src/fileSearch/extractors/pdfOcr';
import {
  checkVisionModel, defaultVisionDeps, transcribePdfPages, VisionCallRecord, VisionMemo,
} from '../../../src/fileSearch/visionTranscriber';

const LIVE = process.env.FILE_SEARCH_VISION_LIVE_PROBE === '1';
const live = LIVE ? describe : describe.skip;

const REPO = path.join(__dirname, '../../../../..');
const PDF = path.join(REPO, 'ci/file-search-eval/corpus/scanned/user-chapter-1-introduction.pdf');
const SOURCE = path.join(REPO, 'docs/guide/introduction.md');

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];

async function probe(model: string): Promise<string> {
  const check = await checkVisionModel({ settings: { model } });
  const pdf = readFileSync(PDF);
  const text = await runExtractor('pdftotext', ['-', '-'], pdf, { timeoutMs: 60_000 });
  const records: Array<VisionCallRecord & { page: number }> = [];
  const memo = new VisionMemo();
  let page = 0;
  const result = await transcribePdfPages(text, pdf, {
    mode: 'no_text', memo, settings: { model, maxPagesPerFile: 2, concurrency: 1 },
    onCall: (r) => records.push({ ...r, page: ++page }),
  }, defaultVisionDeps);
  const source = new Set(words(readFileSync(SOURCE, 'utf8')));
  const pages = splitPages(result.text);
  const lines = [`[vision probe] ${model}: model check ${check.result}`];
  for (const r of records) {
    const got = words(pages[r.page - 1]);
    const found = got.filter((w) => source.has(w)).length / Math.max(1, got.length);
    lines.push(`  page ${r.page}: input ${r.usage.input} (cached ${r.usage.cachedRead}), output ${r.usage.output}, `
      + `${r.elapsedMs} ms, ${got.length} words, ${(found * 100).toFixed(1)} % in the source`);
  }
  const t = memo.totals();
  lines.push(`  transcribed ${t.visionPages}, skipped ${t.skippedPages}, failed ${t.failedPages}${t.stopped ? `, stopped ${t.stopped}` : ''}`);
  for (const p of result.transcribed) lines.push(`  ----- page ${p} -----\n${pages[p - 1]}`);
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  expect(check.result).toBe('served');
  expect(result.transcribed).toEqual([1, 2]);
  return pages.slice(0, 2).join('\n');
}

live('vision transcriber against the live tenant (opt-in)', () => {
  it(`${liveModels.cheapChat}: transcribes pages 1–2 of the scanned chapter`, async () => {
    expect(await probe(liveModels.cheapChat)).toContain('What is SAIL-PROXY');
  }, 300_000);

  it(`${liveModels.vision}: transcribes pages 1–2 of the scanned chapter`, async () => {
    expect(await probe(liveModels.vision)).toContain('What is SAIL-PROXY');
  }, 300_000);
});
