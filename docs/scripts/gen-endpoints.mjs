// Generates the route tables of docs/reference/api-endpoints.md from openapi/gateway.yaml (one section per tag, in
// the document's tag order) and the Administration section from openapi/internal-routes.json. Only the text
// between the generated markers is replaced; gen-endpoints.test.mjs fails when the committed page is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const START = '<!-- generated:endpoints:start -->';
export const END = '<!-- generated:endpoints:end -->';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const ADMIN_SECTION = 'Administration';
const ADMIN_INTRO = 'These routes are for operating the gateway, not for clients. [API authentication](/reference/authentication#administration-endpoints) says where each of them is served and who may call it.';
const CREDENTIALS_INTRO = 'Header names, precedence and the SigV4 rules are on [API authentication](/reference/authentication); the administration routes have [their own rules](/reference/authentication#administration-endpoints).';

const cell = (text) => String(text).replace(/\|/g, '\\|');
const code = (text) => `\`${text}\``;

// Rows of one table: the routes in order, the methods of one path with the same upstream joined in one row.
function table(routes) {
  const rows = [];
  for (const r of routes) {
    const row = rows.find((x) => x.path === r.path && x.upstream === r.upstream);
    if (row) row.methods.push(r.method);
    else rows.push({ path: r.path, aliases: r.aliases, upstream: r.upstream, methods: [r.method] });
  }
  const lines = ['| Method | Path | Upstream |', '|---|---|---|'];
  for (const row of rows) {
    const path = [code(row.path), ...(row.aliases.length ? [`also ${row.aliases.map(code).join(', ')}`] : [])].join('<br>');
    lines.push(`| ${row.methods.map((m) => code(m.toUpperCase())).join(', ')} | ${path} | ${cell(row.upstream)} |`);
  }
  return lines.join('\n');
}

function operations(doc) {
  const tagNames = (doc.tags ?? []).map((t) => t.name);
  const out = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item).filter((k) => METHODS.includes(k))) {
      const op = item[method];
      const where = `${method} ${path}`;
      for (const field of ['x-sail-upstream', 'x-sail-credential']) {
        if (!op[field]) throw new Error(`${where} has no ${field}`);
      }
      const tag = op.tags?.[0];
      if (!tagNames.includes(tag)) throw new Error(`${where} has tag ${tag}, which is not in the document's tags`);
      out.push({ tag, method, path, aliases: item['x-sail-aliases'] ?? [], upstream: op['x-sail-upstream'], credential: op['x-sail-credential'] });
    }
  }
  return out;
}

export function renderEndpoints(doc, internal) {
  const ops = operations(doc);
  const sections = [];
  const ordered = [];
  for (const tag of doc.tags ?? []) {
    const routes = ops.filter((o) => o.tag === tag.name);
    if (!routes.length) continue;
    ordered.push(...routes);
    sections.push([`## ${tag.name}`, table(routes), ...(tag.description ? [tag.description.trim()] : [])].join('\n\n'));
  }
  const admin = (internal.gateway ?? []).filter((e) => e.section === ADMIN_SECTION).map((e) => ({ ...e, aliases: [] }));
  if (admin.length) sections.push([`## ${ADMIN_SECTION}`, ADMIN_INTRO, table(admin)].join('\n\n'));
  const byCredential = new Map();
  for (const o of ordered) byCredential.set(o.credential, [...(byCredential.get(o.credential) ?? []), `${o.method.toUpperCase()} ${o.path}`]);
  const credentials = [...byCredential].map(([credential, routes]) => `- **${cell(credential)}:** ${routes.map(code).join(', ')}`);
  sections.push(['## Credentials per route', CREDENTIALS_INTRO, credentials.join('\n')].join('\n\n'));
  return `${sections.join('\n\n')}\n`;
}

export function replaceGenerated(page, generated) {
  const start = page.indexOf(START);
  const end = page.indexOf(END);
  if (start < 0 || end < start) throw new Error(`the page has no ${START} … ${END} markers`);
  return `${page.slice(0, start + START.length)}\n\n${generated}\n${page.slice(end)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const doc = parse(readFileSync(join(docsRoot, '..', 'openapi', 'gateway.yaml'), 'utf8'));
  const internal = JSON.parse(readFileSync(join(docsRoot, '..', 'openapi', 'internal-routes.json'), 'utf8'));
  const pagePath = join(docsRoot, 'reference', 'api-endpoints.md');
  const page = readFileSync(pagePath, 'utf8');
  const next = replaceGenerated(page, renderEndpoints(doc, internal));
  if (next !== page) writeFileSync(pagePath, next);
  console.log(next === page ? 'api-endpoints.md is up to date' : 'api-endpoints.md regenerated');
}
