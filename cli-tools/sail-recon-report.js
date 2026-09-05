// cli-tools/sail-recon-report.js
'use strict';

const METRICS = [
  { key: 'input',         capturedField: 'totalInputTokens',           expected: 1 },
  { key: 'output',        capturedField: 'totalOutputTokens',          expected: 1 },
  { key: 'cacheRead',     capturedField: 'totalCacheReadInputTokens',  expected: 2 },
  { key: 'cacheWrite',    capturedField: 'totalCacheWriteInputTokens', expected: null },
  { key: 'image',         capturedField: 'totalImageInputTokens',      expected: 1 },
  { key: 'genAi',         capturedField: 'totalGenAiTokens',           expected: null },
  { key: 'capacityUnits', capturedField: 'totalCapacityUnits',         expected: null },
];

function impliedFactor(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function buildReconTable(captured, billed) {
  return METRICS.map((m) => {
    const cap = Number((captured || {})[m.capturedField] || 0);
    const bill = Number((billed || {})[m.key] || 0);
    const factor = impliedFactor(bill, cap);
    const delta = factor === null || m.expected === null ? null : factor - m.expected;
    return { metric: m.key, captured: cap, billed: bill, impliedFactor: factor, expected: m.expected, delta };
  });
}

const fs = require('fs');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { db: 'services/admin/db/admin.db', keyName: undefined, month: undefined, bill: undefined,
                runId: new Date().toISOString().replace(/[:.]/g, '-') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--key-name') out.keyName = argv[++i];
    else if (a === '--month') out.month = argv[++i];
    else if (a === '--bill') out.bill = argv[++i];
    else if (a === '--run-id') out.runId = argv[++i];
  }
  return out;
}

function sumQuery(keyName, month) {
  const cols = [
    'COALESCE(SUM(inputTokens),0) AS totalInputTokens',
    'COALESCE(SUM(outputTokens),0) AS totalOutputTokens',
    'COALESCE(SUM(cacheReadInputTokens),0) AS totalCacheReadInputTokens',
    'COALESCE(SUM(cacheCreationInputTokens),0) AS totalCacheWriteInputTokens',
    'COALESCE(SUM(imageInputTokens),0) AS totalImageInputTokens',
    'COALESCE(SUM(genAiTokens),0) AS totalGenAiTokens',
    'COALESCE(SUM(capacityUnits),0) AS totalCapacityUnits',
  ].join(', ');
  return `SELECT ${cols} FROM sap_llm_gateway_admin_ApiKeyUsage ` +
         `WHERE keyName = '${keyName}' AND strftime('%Y-%m', validFrom) = '${month}';`;
}

function renderTable(rows) {
  const head = ['metric', 'captured', 'billed', 'impliedFactor', 'expected', 'delta'];
  const fmt = (v) => (v === null || v === undefined ? '-' : String(v));
  const lines = [head.join('\t')];
  for (const r of rows) lines.push([r.metric, r.captured, r.billed, fmt(r.impliedFactor), fmt(r.expected), fmt(r.delta)].join('\t'));
  return lines.join('\n');
}

function readCaptured(db, keyName, month) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sumQuery(keyName, month)], { encoding: 'utf8' });
  const rows = JSON.parse(out || '[]');
  return rows[0] || {};
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.keyName || !a.month || !a.bill) { console.error('Usage: --key-name <n> --month <YYYY-MM> --bill <bill.json> [--db <p>] [--run-id <id>]'); process.exit(1); }
  const snap = `${a.db}.bak-recon-${a.runId}`;
  execFileSync('sqlite3', ['-readonly', a.db, `.backup '${snap}'`]);
  console.log(`Snapshot: ${snap}`);
  const captured = readCaptured(a.db, a.keyName, a.month);
  const billed = JSON.parse(fs.readFileSync(a.bill, 'utf8')); // { input, output, cacheRead, cacheWrite, image, genAi, capacityUnits }
  const table = buildReconTable(captured, billed);
  console.log(renderTable(table));
  const imageRow = table.find((r) => r.metric === 'image');
  if (imageRow && captured.totalImageInputTokens === 0 && billed.image > 0) {
    console.log('\n⚠️  IMAGE CAPTURE GAP: SAP billed image tokens but sail-proxy captured 0 on /anthropic. ' +
      'The billed count is the ground truth for fixing capture on the native route.');
  }
}

if (require.main === module) { main(); }

module.exports = { METRICS, impliedFactor, buildReconTable, parseArgs, sumQuery, renderTable };
