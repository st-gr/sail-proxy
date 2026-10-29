#!/usr/bin/env node
/**
 * Generates ci/file-search-eval/questions.json: evaluation questions for the file_search corpus, each
 * with verbatim answer quotes. Run by hand with live SAP AI Core credentials; CI only validates the
 * committed result (questions.test.js).
 *
 * Text: every corpus file goes through the gateway's own extractor (services/gateway/src/fileSearch/
 * extractors/registry.ts, loaded through the gateway's ts-node), so quotes are checked against exactly
 * what ingestion will index. Scanned PDFs extract to nothing; their questions come from the source
 * Markdown chapter and keep kind `scanned`, so they measure OCR once it exists.
 *
 * Model: a SAP-served chat model through the orchestration service (the newest RUNNING deployment of
 * scenario `orchestration`), with AUTH_URL, CLIENT_ID, CLIENT_SECRET, SAP_AI_CORE_URL and
 * SAP_AI_RESOURCE_GROUP read from the gateway's .env (client: sap-client.js). Credentials and tokens
 * are never printed. --max-calls caps HTTP requests (token, deployment list, completions and their
 * retries); --max-tokens caps reported usage plus an estimate wherever usage is missing.
 *
 * Usage: node ci/file-search-eval/generate-questions.js [--model gpt-4.1] [--target 150]
 *   [--mix markdown=40,pdf=40,table=20,scanned=20,multihop=30] [--max-calls 120] [--max-tokens 1500000]
 *   [--rounds 3] [--env services/gateway/.env] [--out ci/file-search-eval/questions.json]
 * --max-calls 0 extracts and plans without any HTTP request (and writes nothing).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const axios = require('axios');
const dotenv = require('dotenv');
const { DEFAULT_MIX, KINDS, parseMix, scaleMix, generateQuestionSet } = require('./question-set');
const { validateQuestionSet } = require('./questions-schema');
const { createSapClient } = require('./sap-client');

const REPO = path.resolve(__dirname, '..', '..');
const GATEWAY = path.join(REPO, 'services', 'gateway');
const CORPUS = path.join(__dirname, 'corpus');

const gatewayRequire = createRequire(path.join(GATEWAY, 'package.json'));
gatewayRequire('ts-node').register({ transpileOnly: true, project: path.join(GATEWAY, 'tsconfig.json') });
const tsconfigPaths = gatewayRequire('tsconfig-paths');
const gatewayPaths = tsconfigPaths.loadConfig(GATEWAY);
tsconfigPaths.register({ baseUrl: gatewayPaths.absoluteBaseUrl, paths: gatewayPaths.paths });
const { extractText } = require(path.join(GATEWAY, 'src', 'fileSearch', 'extractors', 'registry.ts'));

const EXTRACT_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const opts = {
    model: 'gpt-4.1', target: undefined, mix: DEFAULT_MIX, maxCalls: 120, maxTokens: 1500000, rounds: 3,
    env: path.join(GATEWAY, '.env'), out: path.join(__dirname, 'questions.json'),
  };
  const ints = { '--target': 'target', '--max-calls': 'maxCalls', '--max-tokens': 'maxTokens', '--rounds': 'rounds' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (ints[flag]) {
      if (!/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number`);
      opts[ints[flag]] = Number(value);
    } else if (flag === '--model') opts.model = value;
    else if (flag === '--mix') opts.mix = parseMix(value);
    else if (flag === '--env') opts.env = path.resolve(value);
    else if (flag === '--out') opts.out = path.resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  return opts;
}

/** The texts questions are generated from and checked against, in manifest (= file) order. */
async function loadDocs(manifest) {
  const docs = [];
  for (const e of manifest) {
    const extracted = await extractText(e.file, fs.readFileSync(path.join(CORPUS, e.file)), { timeoutMs: EXTRACT_TIMEOUT_MS });
    let text = extracted;
    if (e.kind === 'scanned') {
      if (extracted.trim()) console.log(`note: ${e.file} now extracts ${extracted.trim().length} characters`);
      text = fs.readFileSync(path.join(REPO, e.source), 'utf8');
    }
    console.log(`${e.kind.padEnd(8)} ${e.file}: ${text.length} characters${e.kind === 'scanned' ? ` (from ${e.source})` : ''}`);
    docs.push({ file: e.file, kind: e.kind, text });
  }
  return docs;
}

function printReport(counts, stats, requests) {
  console.log('\nkind      target accepted selected');
  for (const k of KINDS) {
    const c = counts[k];
    console.log(`${k.padEnd(9)} ${String(c.target).padStart(6)} ${String(c.accepted).padStart(8)} ${String(c.selected).padStart(8)}`);
  }
  console.log(`\nHTTP requests ${requests}, model calls ${stats.calls}, tokens ${stats.promptTokens} in / ${stats.completionTokens} out` +
    ` (${stats.estimatedTokens} estimated), candidates ${stats.candidates}` +
    (stats.stopped ? `, stopped by ${stats.stopped}` : ''));
  const reasons = Object.entries(stats.rejected).sort((a, b) => b[1] - a[1]);
  console.log(`rejected: ${reasons.length ? reasons.map(([r, n]) => `${r} ${n}`).join(', ') : 'none'}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mix = scaleMix(opts.mix, opts.target);
  const manifestBytes = fs.readFileSync(path.join(CORPUS, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const docs = await loadDocs(manifest);
  const llm = opts.maxCalls > 0
    ? createSapClient(dotenv.parse(fs.readFileSync(opts.env)), opts.model, { http: axios, maxRequests: opts.maxCalls, log: m => console.log(m) })
    : { complete: async () => { throw Object.assign(new Error('no HTTP requests allowed'), { budget: true }); }, stats: { requests: 0 } };

  const { questions, counts, stats } = await generateQuestionSet({
    docs, mix, llm, maxCalls: opts.maxCalls, maxTokens: opts.maxTokens, rounds: opts.rounds, log: m => console.log(m),
  });
  printReport(counts, stats, llm.stats.requests);

  const set = {
    version: 1,
    corpusManifestSha256: manifestSha256,
    generatedWith: { model: opts.model, date: new Date().toISOString().slice(0, 10) },
    questions,
  };
  const errors = validateQuestionSet(set, { manifest, manifestSha256 });
  if (errors.length) {
    const aside = path.join(os.tmpdir(), `file-search-questions-${process.pid}.json`);
    if (questions.length) fs.writeFileSync(aside, `${JSON.stringify(set, null, 2)}\n`);
    console.error(`\nnot written, the set is invalid:\n- ${errors.slice(0, 20).join('\n- ')}` +
      (questions.length ? `\nthe invalid set is in ${aside}` : ''));
    process.exitCode = 1;
    return;
  }
  const tmp = `${opts.out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(set, null, 2)}\n`);
  fs.renameSync(tmp, opts.out);
  console.log(`\nwrote ${questions.length} questions to ${path.relative(REPO, opts.out)}`);
}

main().catch(err => {
  console.error(`generate-questions: ${err.message}`);
  process.exitCode = 1;
});
