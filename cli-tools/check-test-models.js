#!/usr/bin/env node
/**
 * check-test-models.js
 *
 * Reports which model names the live-call tests use that the gateway no longer routes or SAP
 * is retiring, proposes successors, and with --apply rewrites the ONE file that holds those
 * names: libs/test-utils/src/live-models.ts. Mocked tests are reported, never edited.
 *
 * A test file counts as live-call only when it can send a model request to a live service:
 * it uses getOllamaServiceUrl or OLLAMA_BASE_URL (the Ollama integration suites) or
 * SAP_AI_CORE_SERVICE_KEY (gateway suites that need the real SAP key), or FILE_SEARCH_LIVE_GATE /
 * FILE_SEARCH_LIVE_PROBE (the gateway's file-search live probes, which send real model requests
 * when those env gates are set). Suites that only store model names as configuration
 * (getGatewayUrl, GATEWAY_URL, ADMIN_SERVICE_URL, describeLive) are mocked for this purpose.
 *
 * Usage:
 *   node cli-tools/check-test-models.js [--gateway-url URL] [--api-key KEY] [--days N] [--apply]
 *
 * Environment: GATEWAY_URL (default http://localhost:3000), GATEWAY_API_KEY.
 * The gateway must run with SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true so that each model
 * carries its SAP versions (deprecated flag and retirementDate).
 *
 * Exit codes: 0 every live name is current; 1 a live-table or live-call name is unknown,
 * deprecated or expiring; 2 the gateway could not be read.
 */

const fs = require('fs');
const path = require('path');

const INVALID_NAME_PREFIXES = ['non-existent-', 'nonexistent-'];
const DEPLOYED_SUFFIX = '--deployed';

// e.g. anthropic--claude-4.5-haiku--deployed, gpt-4.1-nano, gemini-2.0-flash-lite, amazon--nova-lite
const NAME_PATTERN = /^(?:([a-z0-9]+--))?([a-z]+[a-z0-9]*?)(?:-(\d+(?:\.\d+)*))?(?:-([a-z][a-z0-9-]*))?$/;

function parseModelName(name) {
  if (typeof name !== 'string' || name === '') return null;
  if (INVALID_NAME_PREFIXES.some((p) => name.startsWith(p))) return null;
  const deployed = name.endsWith(DEPLOYED_SUFFIX);
  const bare = deployed ? name.slice(0, -DEPLOYED_SUFFIX.length) : name;
  const m = NAME_PATTERN.exec(bare);
  if (!m) return null;
  const [, prefix = '', family, version = '', variant = ''] = m;
  return {
    prefix,
    family,
    version: version === '' ? [] : version.split('.').map((n) => parseInt(n, 10)),
    variant,
    deployed,
  };
}

function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function classifyModel(item, now, days) {
  const versions = Array.isArray(item.versions) ? item.versions : [];
  const deprecated = versions.length > 0 && versions.every((v) => v.deprecated === true);
  const dates = versions
    .map((v) => (typeof v.retirementDate === 'string' ? v.retirementDate.trim() : ''))
    .filter((d) => d !== '')
    .sort();
  const retirementDate = dates.length > 0 ? dates[0] : null;
  const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const expiring = retirementDate !== null && new Date(retirementDate) <= horizon;
  return {
    id: item.id,
    routable: item.routable !== false,
    deprecated,
    retirementDate,
    expiring,
  };
}

function proposeSuccessor(name, models) {
  const wanted = parseModelName(name);
  if (!wanted) return null;
  let best = null;
  for (const model of models) {
    if (model.id === name || !model.routable || model.deprecated || model.expiring) continue;
    const candidate = parseModelName(model.id);
    if (!candidate) continue;
    if (candidate.prefix !== wanted.prefix || candidate.family !== wanted.family ||
        candidate.variant !== wanted.variant || candidate.deployed !== wanted.deployed) continue;
    if (compareVersions(candidate.version, wanted.version) <= 0) continue;
    if (!best || compareVersions(candidate.version, best.parsed.version) > 0) {
      best = { id: model.id, parsed: candidate };
    }
  }
  return best ? best.id : null;
}

const TEST_DIRS = ['services/gateway/test', 'services/admin/test', 'services/ollama/test', 'libs'];
const TEST_FILE = /\.(test|spec)\.(ts|js)$/;
const LITERAL_PATTERN = /['"]((?:gpt-[0-9][a-z0-9.-]*|o[134](?:-mini|-pro)?|gemini-[0-9][a-z0-9.-]*|anthropic--claude-[a-z0-9.-]*|claude-[0-9][a-z0-9.-]*|amazon--nova-[a-z]+|mistralai--[a-z-]+|text-embedding-[0-9a-z-]+|non-existent-[a-z0-9-]*|nonexistent-[a-z0-9-]*))['"]/g;
const LIVE_MARKERS = /getOllamaServiceUrl|OLLAMA_BASE_URL|SAP_AI_CORE_SERVICE_KEY|FILE_SEARCH_LIVE_GATE|FILE_SEARCH_LIVE_PROBE|ANTHROPIC_CACHE_LIVE_PROBE/;
const TABLE_RELATIVE = 'libs/test-utils/src/live-models.ts';
const TABLE_LINE = /^(\s{2})([a-zA-Z]+): '([^']+)',$/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

function scanTestTree(root) {
  const findings = [];
  for (const dir of TEST_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const text = fs.readFileSync(file, 'utf8');
      const live = LIVE_MARKERS.test(text);
      const seen = new Set();
      for (const match of text.matchAll(LITERAL_PATTERN)) {
        const name = match[1];
        if (seen.has(name) || INVALID_NAME_PREFIXES.some((p) => name.startsWith(p))) continue;
        seen.add(name);
        findings.push({ file: path.relative(root, file).split(path.sep).join('/'), name, live });
      }
    }
  }
  return findings;
}

function readLiveTable(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').flatMap((text, index) => {
    const m = TABLE_LINE.exec(text);
    return m ? [{ role: m[2], name: m[3], line: index + 1 }] : [];
  });
}

function applyToTable(filePath, replacements) {
  const changed = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map((text) => {
    const m = TABLE_LINE.exec(text);
    if (!m || !replacements[m[2]]) return text;
    changed.push(m[2]);
    return `${m[1]}${m[2]}: '${replacements[m[2]]}',`;
  });
  fs.writeFileSync(filePath, lines.join('\n'));
  return changed;
}

async function fetchModels({ gatewayUrl, apiKey, fetchImpl = fetch }) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, '')}/v1/models?include=unroutable`, { headers });
  if (!response.ok) throw new Error(`gateway answered ${response.status} for /v1/models - check GATEWAY_URL and GATEWAY_API_KEY`);
  const body = await response.json();
  const items = Array.isArray(body.data) ? body.data : [];
  if (items.length === 0) throw new Error('the gateway listed no models');
  if (!items.some((item) => Array.isArray(item.versions))) {
    throw new Error('the model list carries no SAP versions - start the gateway with SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true');
  }
  return items;
}

function describe(name, byId, models) {
  const model = byId.get(name);
  const successor = proposeSuccessor(name, models);
  const fix = successor ? `successor ${successor}` : 'no successor in the list';
  if (!model) return { failing: true, text: `not listed by the gateway (retired or unknown); ${fix}` };
  if (model.deprecated) return { failing: true, text: `deprecated in every version; ${fix}` };
  if (model.expiring) return { failing: true, text: `retires ${model.retirementDate}; ${fix}` };
  if (!model.routable) return { failing: true, text: `listed but not routable; ${fix}` };
  return { failing: false, text: 'current' };
}

async function run(options) {
  const {
    root = path.resolve(__dirname, '..'),
    gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:3000',
    apiKey = process.env.GATEWAY_API_KEY,
    days = 30,
    apply = false,
    fetchImpl = fetch,
    log = console.log,
    now = new Date(),
  } = options;

  const tablePath = path.join(root, TABLE_RELATIVE);
  if (!fs.existsSync(tablePath)) {
    log(`check-test-models: no live-model table at ${TABLE_RELATIVE}`);
    return 2;
  }

  let items;
  try {
    items = await fetchModels({ gatewayUrl, apiKey, fetchImpl });
  } catch (error) {
    log(`check-test-models: ${error.message}`);
    return 2;
  }
  const models = items.map((item) => classifyModel(item, now, days));
  const byId = new Map(models.map((m) => [m.id, m]));

  const table = readLiveTable(tablePath);
  const findings = scanTestTree(root);

  let failing = 0;
  const replacements = {};
  log(`Live-model table (${TABLE_RELATIVE}):`);
  for (const entry of table) {
    const verdict = describe(entry.name, byId, models);
    log(`  ${verdict.failing ? 'FAIL' : 'ok  '} ${entry.role}: ${entry.name} - ${verdict.text}`);
    if (verdict.failing) {
      failing++;
      const successor = proposeSuccessor(entry.name, models);
      if (successor) replacements[entry.role] = successor;
    }
  }

  const grouped = new Map();
  for (const f of findings) {
    if (!grouped.has(f.name)) grouped.set(f.name, { live: [], mocked: [] });
    grouped.get(f.name)[f.live ? 'live' : 'mocked'].push(f.file);
  }
  log('Model names in test files:');
  for (const [name, where] of [...grouped.entries()].sort()) {
    const verdict = describe(name, byId, models);
    const kind = where.live.length > 0 ? 'live-call' : 'mocked';
    if (verdict.failing && kind === 'live-call') failing++;
    const marker = verdict.failing ? (kind === 'live-call' ? 'FAIL' : 'note') : 'ok  ';
    log(`  ${marker} ${name} [${kind}] - ${verdict.text} - ${[...where.live, ...where.mocked].join(', ')}`);
  }

  if (apply && Object.keys(replacements).length > 0) {
    const changed = applyToTable(tablePath, replacements);
    for (const role of changed) log(`applied ${role}: -> ${replacements[role]}`);
  }
  log(failing === 0 ? 'check-test-models: every live name is current' : `check-test-models: ${failing} live name(s) need attention`);
  return failing === 0 ? 0 : 1;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--gateway-url') options.gatewayUrl = argv[++i];
    else if (arg === '--api-key') options.apiKey = argv[++i];
    else if (arg === '--days') options.days = parseInt(argv[++i], 10);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

module.exports = {
  INVALID_NAME_PREFIXES, LIVE_MARKERS, parseModelName, classifyModel, proposeSuccessor,
  scanTestTree, readLiveTable, applyToTable, fetchModels, run, parseArgs,
};

if (require.main === module) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (options.help) {
    console.log('usage: node cli-tools/check-test-models.js [--gateway-url URL] [--api-key KEY] [--days N] [--apply]');
    process.exit(0);
  }
  run(options).then((code) => process.exit(code));
}
