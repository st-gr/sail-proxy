#!/usr/bin/env node
// Secret gate: refuses real values, key patterns, foreign e-mails, cluster hosts and IPs in everything
// the toolkit commits and in the site's pages. Exit 1 with file:line:pattern per hit.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLUSTER_HOST, NON_EXAMPLE_EMAIL } from './lib/redact.mjs';

// Documentation examples that look like a SAP deployment id but are not. Add one only with a comment
// saying where it is documented. 1234567890abcdef: the example key suffix in
// docs/developer/admin-cockpit.md:440.
const ALLOWED_DOC_EXAMPLES = ['1234567890abcdef'];

// A client-secret value that starts with one of these is a placeholder or a code expression (env.X), not a secret.
const PLACEHOLDER = '<|your-|\\$\\{|example|changeme|xxx|env\\.|process\\.env';

const PATTERNS = [
  ['anthropic key', /sk-ant-/],
  ['api key', /\bsk-(?!demo-)[A-Za-z0-9_-]{20,}\b/],
  ['github token', /\b(gho_|ghp_|github_pat_)/],
  ['aws access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['sap deployment id', /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{16}\b/],
  ['client secret value', new RegExp(`clientsecret["']?\\s*[:=]\\s*["']?(?!(?:${PLACEHOLDER}))[^\\s"'<>]{16,}`, 'i')],
  ['private key', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['kyma host', new RegExp(CLUSTER_HOST.source, 'i')],
  // The docs' <subdomain>.authentication.<region> placeholder cannot match: '>' precedes the dot.
  ['sap auth host', /\b[a-z0-9-]+\.authentication\.[a-z0-9-]+\.hana\.ondemand\.com\b/i],
  // 0.0.0.0 is the bind-all address, not a host.
  ['ip address', /\b(?!127\.)(?!203\.0\.113\.)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['non-example email', NON_EXAMPLE_EMAIL]
];

export function scan(files, { map = {}, readFile }) {
  const hits = [];
  const real = Object.keys(map);
  for (const file of files) {
    const raw = readFile(file);
    if (raw == null) continue;
    const text = ALLOWED_DOC_EXAMPLES.reduce((t, tok) => t.split(tok).join('ALLOWED-DOC-EXAMPLE'), raw);
    text.split('\n').forEach((line, i) => {
      for (const v of real) if (v && line.includes(v)) hits.push({ file, line: i + 1, pattern: 'redaction map value' });
      for (const [name, re] of PATTERNS) if (re.test(line)) hits.push({ file, line: i + 1, pattern: name });
    });
  }
  return hits;
}

// Parse the local map. A malformed file must never echo its content, so the parse error is replaced.
export function loadMap(text) {
  try { return JSON.parse(text); } catch { throw new Error('redact.local.json is not valid JSON'); }
}

// rel is the path relative to the walk root; skip(rel) prunes a directory, keep(rel) selects a file.
function* walk(root, skip, keep, rel = '') {
  const dir = join(root, rel);
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const r = rel ? `${rel}/${e}` : e;
    if (statSync(join(root, r)).isDirectory()) { if (!skip(r)) yield* walk(root, skip, keep, r); }
    else if (keep(r)) yield join(root, r);
  }
}

const SC_EXT = /\.(md|json|js|mjs|cjs|ts|cast|txt|vtt|srt|yml|yaml|sample|html|css|vue|py)$/;
const SC_SKIP_FILES = ['check.js', 'check.test.mjs', 'lib/redact.mjs', 'lib/redact.test.mjs', 'redact.local.json', 'redact.extra.local.json'];
const DOCS_EXT = /\.(md|cast|vtt|srt|txt|json|ts|vue|css)$/;
const DOCS_SKIP_DIRS = ['.vitepress/cache', '.vitepress/dist', 'dist', '.generated', 'node_modules', 'superpowers', 'notes', 'competitive'];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const mapPath = join(root, 'screencast', 'redact.local.json');
  let map = {};
  if (existsSync(mapPath)) {
    try { map = loadMap(readFileSync(mapPath, 'utf8')); } catch (e) { console.error(e.message); process.exit(1); }
  }
  const sc = join(root, 'screencast');
  const docs = join(root, 'docs');
  // The gate's own sources hold the patterns and test fixtures, so they are the only exclusions.
  const text = [
    ...walk(sc, (r) => r === 'out' || r === 'node_modules' || r.endsWith('/node_modules'), (r) => SC_EXT.test(r) && !SC_SKIP_FILES.includes(r)),
    ...walk(docs, (r) => DOCS_SKIP_DIRS.includes(r) || r.endsWith('/node_modules'), (r) => DOCS_EXT.test(r))
  ];
  const names = [...walk(join(docs, 'assets', 'screenshots'), () => false, () => true)];
  const hits = [...scan(text, { map, readFile: (f) => readFileSync(f, 'utf8') }), ...scan(names, { map, readFile: (f) => relative(root, f) })];
  for (const h of hits) console.error(`${relative(root, h.file)}:${h.line}: ${h.pattern}`);
  if (hits.length) { console.error(`${hits.length} finding(s); nothing with a real value, key, host or address may be committed`); process.exit(1); }
  console.log(`secret gate passed (${text.length} files, ${names.length} image names${Object.keys(map).length ? ', map loaded' : ', no map'})`);
}
