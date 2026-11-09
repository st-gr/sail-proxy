/**
 * --plan: what a configuration's run would cost and which SAP calls it would make, computed from the
 * corpus and the questions alone. No database, no credentials, no SAP call; pdftotext runs locally
 * to find each PDF's pages, and the context estimate extracts each file as ingestion would.
 *
 * Ingestion is shown as for a fresh store (a run that reuses its store ingests nothing). Figures are
 * estimates at the meter's prices (costMeter.ts): "expected" is what the corpus is likely to take,
 * "upper bound" what the meter's own pre-step checks allow for.
 */
import * as fs from 'fs';
import * as path from 'path';
import { countTokens } from '../../src/fileSearch/structureChunker';
import { estimateTokens } from '../../src/fileSearch/chunker';
import { EMBED_TOKEN_ESTIMATE_FACTOR } from '../../src/fileSearch/embedder';
import { runExtractor } from '../../src/fileSearch/extractors/runners';
import { extractText, isPdfFile } from '../../src/fileSearch/extractors/registry';
import { splitPages, textlessPages, pageCount } from '../../src/fileSearch/extractors/pdfOcr';
import { OCR_TOKENS_PER_PAGE } from '../../src/fileSearch/reextract';
import { getFileSearchConfig } from '../../src/services/configService';
import { CostMeter } from './costMeter';
import { estimateFileContext, estimateFileTokens, ManifestEntry, PipelineSettings } from './ingest';
import { fileVisionEstimate, visionPagesOf } from './parsing';
import type { EvalConfig } from './options';

/** Cohere bills a search unit per 100 documents; 50 candidates per arm can make two (as the runner assumes). */
const RERANK_UNITS_PER_QUERY = 2;

export interface PlanRow { step: string; calls: number; amount: string; expectedUsd: number; upperUsd: number }

export interface Plan {
  config: string;
  description: string;
  files: number;
  questions: number;
  /** PDF pages vision would send, per file (only files with pages). */
  visionPages: Array<{ file: string; pages: number; selected: number }>;
  /** Pages without a text layer that OCR would read (local, no SAP call). */
  ocrPages: number;
  rows: PlanRow[];
  totalExpectedUsd: number;
  totalUpperUsd: number;
}

/** The static strategy's windows overlap: each token is embedded max / (max - overlap) times. */
function overlapFactor(settings: PipelineSettings): number {
  const c = settings.chunking;
  return c.type === 'static' && c.overlap_tokens > 0 ? c.max_tokens / (c.max_tokens - c.overlap_tokens) : 1;
}

export async function planRun(opts: {
  name: string; config: EvalConfig; settings: PipelineSettings; meter: CostMeter;
  corpusDir: string; manifest: ManifestEntry[]; questions: Array<{ question: string }>;
}): Promise<Plan> {
  const { config, settings, meter, corpusDir, manifest, questions } = opts;
  const rows: PlanRow[] = [];
  const visionPages: Plan['visionPages'] = [];
  let ocrPages = 0;
  let embedTokens = 0;
  let embedCeiling = 0;
  let embedCalls = 0;
  let contextIn = 0;
  let contextOut = 0;
  let contextCalls = 0;
  const vision = { calls: 0, input: 0, expectedOut: 0, upperOut: 0 };
  for (const entry of manifest) {
    const bytes = fs.readFileSync(path.join(corpusDir, entry.file));
    embedCeiling += estimateFileTokens(entry.bytes);
    let tokens: number;
    let readsPages = 0;
    let hasText: boolean;
    if (isPdfFile(entry.file)) {
      const text = await runExtractor('pdftotext', ['-', '-'], bytes, { timeoutMs: 60_000 });
      const textless = textlessPages(splitPages(text), pageCount(text)).length;
      let sent = 0;
      if (settings.vision && settings.chunking.vision) {
        const { pages, selected } = await visionPagesOf(entry.file, bytes, settings.chunking.vision);
        const e = fileVisionEstimate(selected.length, settings.vision);
        if (selected.length) visionPages.push({ file: entry.file, pages, selected: selected.length });
        sent = e.pages;
        vision.calls += e.pages;
        vision.input += e.input;
        vision.expectedOut += e.outputExpected;
        vision.upperOut += e.outputUpperBound;
      }
      // Pages without a text layer gain text from vision or OCR; the rest is pdftotext's.
      if (settings.ocr) ocrPages += Math.max(0, textless - sent);
      readsPages = settings.ocr || settings.vision ? textless : 0;
      tokens = countTokens(text) + readsPages * OCR_TOKENS_PER_PAGE;
      hasText = /\S/.test(text) || readsPages > 0;
    } else {
      const text = await extractText(entry.file, bytes, { timeoutMs: 60_000 });
      tokens = countTokens(text);
      hasText = /\S/.test(text);
    }
    const fileTokens = Math.ceil(tokens * overlapFactor(settings));
    embedTokens += fileTokens;
    if (hasText) embedCalls += 1; // under 256 chunks and 250k tokens: one embedding request per file
    if (settings.contextual) {
      const c = await estimateFileContext(entry.file, bytes, settings.chunking, settings.contextual);
      contextIn += c.input;
      contextOut += c.outputUpperBound;
      contextCalls += c.calls;
    }
  }
  rows.push({
    step: 'ingestion embeddings', calls: embedCalls, amount: `${embedTokens.toLocaleString('en')} tokens`,
    expectedUsd: meter.embeddingUsd(embedTokens), upperUsd: meter.embeddingUsd(embedCeiling),
  });
  if (settings.contextual) {
    const model = settings.contextual.model;
    rows.push({
      step: `contexts (${model})`, calls: contextCalls,
      amount: `${contextIn.toLocaleString('en')} in / up to ${contextOut.toLocaleString('en')} out`,
      expectedUsd: meter.contextUsd(model, contextIn, 0, contextOut), upperUsd: meter.contextUsd(model, contextIn, 0, contextOut),
    });
  }
  if (settings.vision) {
    const model = settings.vision.model;
    rows.push({
      step: `vision (${model}, ${settings.chunking.vision})`, calls: vision.calls,
      amount: `${vision.input.toLocaleString('en')} in / ~${vision.expectedOut.toLocaleString('en')} out (up to ${vision.upperOut.toLocaleString('en')})`,
      expectedUsd: meter.visionUsd(model, vision.input, 0, vision.expectedOut),
      upperUsd: meter.visionUsd(model, vision.input, 0, vision.upperOut),
    });
  }
  const queryTokens = questions.reduce((n, q) => n + estimateTokens(q.question) * EMBED_TOKEN_ESTIMATE_FACTOR + 16, 0);
  rows.push({
    step: 'query embeddings', calls: questions.length, amount: `~${Math.ceil(queryTokens).toLocaleString('en')} tokens`,
    expectedUsd: meter.embeddingUsd(queryTokens), upperUsd: meter.embeddingUsd(queryTokens),
  });
  if (getFileSearchConfig().hybrid.rerank.enabled !== false) {
    const units = questions.length * RERANK_UNITS_PER_QUERY;
    rows.push({
      step: 'rerank', calls: questions.length, amount: `up to ${units} search units (one per question when chunks are small)`,
      expectedUsd: meter.rerankUsd(units), upperUsd: meter.rerankUsd(units),
    });
  }
  return {
    config: opts.name, description: config.description, files: manifest.length, questions: questions.length,
    visionPages, ocrPages, rows,
    totalExpectedUsd: rows.reduce((n, r) => n + r.expectedUsd, 0),
    totalUpperUsd: rows.reduce((n, r) => n + r.upperUsd, 0),
  };
}

const usd = (n: number) => `$${n.toFixed(4)}`;

export function formatPlan(p: Plan): string {
  const lines = [
    `plan for --config ${p.config} (${p.description}): ${p.files} corpus files, ${p.questions} questions; nothing was run`,
    '| Step | SAP calls | Tokens / units | Expected | Upper bound |',
    '| --- | --- | --- | --- | --- |',
    ...p.rows.map((r) => `| ${r.step} | ${r.calls} | ${r.amount} | ${usd(r.expectedUsd)} | ${usd(r.upperUsd)} |`),
    `| total | ${p.rows.reduce((n, r) => n + r.calls, 0)} | | ${usd(p.totalExpectedUsd)} | ${usd(p.totalUpperUsd)} |`,
  ];
  if (p.visionPages.length) {
    lines.push(`vision pages: ${p.visionPages.map((v) => `${v.file} ${v.selected} of ${v.pages}`).join(', ')}`);
  }
  if (p.ocrPages) lines.push(`OCR reads ${p.ocrPages} page(s) locally (tesseract; no SAP call)`);
  lines.push('A run that finds its store already built ingests nothing and pays only for the searches.');
  return lines.join('\n');
}
