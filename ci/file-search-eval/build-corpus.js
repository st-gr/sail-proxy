#!/usr/bin/env node
/**
 * Builds the file_search evaluation corpus (ci/file-search-eval/corpus/) from this repository's own
 * documentation. The corpus is committed; CI and the eval runner read it and never need the tools below.
 *
 * Kinds:
 *   markdown  chapters copied byte for byte
 *   pdf       pandoc (Markdown -> HTML) + headless Chrome --print-to-pdf; text layer present
 *   table     one PDF assembled from the Markdown tables of a few chapters (with their headings)
 *   scanned   chapters printed as above, rasterized with pdftoppm and reassembled by ImageMagick
 *             into an image-only PDF (no text layer)
 *   pptx, xlsx synthetic Office files about an invented company, written by build-office-corpus.js
 *             (no tools needed; that script alone refreshes them)
 *
 * Every chapter appears in exactly one kind, so each passage has a single correct file.
 *
 * Tools needed to rebuild (not to use the corpus): pandoc, Google Chrome (or Chromium; override the
 * binary with CHROME_BIN), pdftoppm (poppler), magick (ImageMagick 7).
 *
 * Determinism: inputs are a fixed list; images are dropped and links reduced to their text (no local
 * paths reach a PDF); Chrome prints without header/footer; the date and ID fields of every PDF are
 * overwritten in place with fixed values of the same length, so xref offsets stay valid. Two runs on the
 * same machine produce identical bytes. Output can differ across tool versions and installed fonts.
 *
 * Usage: node ci/file-search-eval/build-corpus.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { officeFiles } = require('./build-office-corpus');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'corpus');

const MARKDOWN = [
  ['docs/developer/debugging.md', 'developer-chapter-11-debugging'],
  ['docs/developer/file-search-tool.md', 'developer-chapter-16-file-search-tool'],
  ['docs/guide/features.md', 'user-chapter-2-features'],
  ['docs/guide/clients/codex.md', 'user-chapter-5-codex'],
  ['docs/guide/clients/opencode.md', 'user-chapter-6-opencode'],
  ['docs/guide/roles.md', 'user-chapter-9-roles']
];
const PDF = [
  ['docs/developer/plugins.md', 'developer-chapter-13-plugin-system'],
  ['docs/developer/architecture.md', 'developer-chapter-2-architecture'],
  ['docs/developer/gateway-testing.md', 'developer-chapter-4-gateway-testing'],
  ['docs/developer/model-library-entitlements.md', 'developer-model-library-entitlements'],
  ['docs/guide/clients/gemini.md', 'user-chapter-12-google-gemini'],
  ['docs/guide/clients/tabular-prediction.md', 'user-chapter-15-tabular-prediction']
];
const TABLE_SOURCES = ['docs/developer/release.md', 'docs/developer/reranker-datasets.md', 'docs/developer/gateway.md', 'docs/developer/tool-governance.md'];
const TABLE_FILE = 'table/developer-tables.pdf';
const SCANNED = [
  ['docs/developer/ollama-service.md', 'developer-chapter-6-ollama'],
  ['docs/guide/introduction.md', 'user-chapter-1-introduction'],
  ['docs/guide/clients/realtime.md', 'user-chapter-14-realtime']
];
const SCAN_DPI = 150;
const SCAN_JPEG_QUALITY = 60;

const CHROME_BIN = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].find(p => fs.existsSync(p));

/** pandoc filter: images become their alt text, links their text — no screenshots, no local paths. */
const LUA_FILTER = `
function Image(el) return el.caption end
function Link(el) return el.content end
`;
const STYLE = `<style>
@page { size: A4; margin: 16mm; }
html { font-size: 11pt; }
body { max-width: none; margin: 0; padding: 0; font-family: Helvetica, Arial, sans-serif; }
pre, code { font-family: Menlo, Courier, monospace; font-size: 9pt; }
pre { white-space: pre-wrap; word-break: break-all; }
table { border-collapse: collapse; margin: 0.6em 0; font-size: 9pt; }
th, td { border: 1px solid #888; padding: 2px 5px; vertical-align: top; }
</style>
`;

function requireTools() {
  const missing = [];
  for (const [name, args] of [['pandoc', ['--version']], ['pdftoppm', ['-v']], ['magick', ['-version']]]) {
    try { execFileSync(name, args, { stdio: 'ignore' }); } catch { missing.push(name); }
  }
  if (!CHROME_BIN) missing.push('Google Chrome / Chromium (set CHROME_BIN)');
  if (missing.length) {
    console.error(`build-corpus: missing tool(s): ${missing.join(', ')}.`);
    console.error('The committed corpus does not need them; they are only required to rebuild it.');
    process.exit(1);
  }
}

/** [source, name] pairs: the name is fixed so the corpus files keep their identities across doc moves. */
function slug([, name]) { return name; }

/** Markdown file -> PDF bytes (pandoc HTML printed by headless Chrome). */
function printPdf(markdownFile, tmp, name) {
  const filter = path.join(tmp, 'filter.lua');
  const header = path.join(tmp, 'style.html');
  if (!fs.existsSync(filter)) fs.writeFileSync(filter, LUA_FILTER);
  if (!fs.existsSync(header)) fs.writeFileSync(header, STYLE);
  const html = path.join(tmp, `${name}.html`);
  const pdf = path.join(tmp, `${name}.pdf`);
  execFileSync('pandoc', [markdownFile, '--from', 'gfm+yaml_metadata_block', '--to', 'html5', '--standalone',
    '--lua-filter', filter, '--include-in-header', header, '--metadata', `pagetitle=${name}`, '--output', html]);
  execFileSync(CHROME_BIN, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${path.join(tmp, 'chrome-profile')}`, '--no-pdf-header-footer',
    `--print-to-pdf=${pdf}`, `file://${html}`], { stdio: 'ignore' });
  return normalizePdf(fs.readFileSync(pdf));
}

/**
 * Overwrites the volatile fields of a PDF in place with fixed values of the same byte length: the
 * D:... dates of /CreationDate and /ModDate, XMP dates, the hex strings of /ID and XMP uuids.
 */
function normalizePdf(buf) {
  let s = buf.toString('latin1');
  // Each digit takes the digit at the same position of a fixed date (2000-01-01 00:00:00 UTC).
  const fixDate = (fixed) => (date) => { let i = 0; return date.replace(/[0-9]/g, () => fixed[i++] || '0'); };
  s = s.replace(/(\/(?:CreationDate|ModDate)\s*\(D:)([^)]*)/g, (m, key, date) => key + fixDate('20000101000000')(date));
  s = s.replace(/(<(?:xmp|xap|pdf):(?:CreateDate|ModifyDate|MetadataDate)>)([^<]*)/g, (m, tag, date) => tag + fixDate('20000101000000')(date));
  s = s.replace(/\/ID\s*\[\s*<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\]/g, m => m.replace(/<[0-9A-Fa-f]+>/g, h => '<' + '0'.repeat(h.length - 2) + '>'));
  s = s.replace(/uuid:[0-9a-fA-F-]{36}/g, m => m.replace(/[0-9a-fA-F]/g, '0'));
  return Buffer.from(s, 'latin1');
}

/** The Markdown tables of the given chapters, each under its chapter title and nearest heading. */
function tablesMarkdown(sources) {
  const out = ['---', 'title: Reference tables from the developer guide', '---', ''];
  for (const source of sources) {
    const lines = fs.readFileSync(path.join(REPO, source), 'utf8').split('\n');
    const title = (lines.find(l => /^title:\s*/.test(l)) || source).replace(/^title:\s*/, '').replace(/^["']|["']$/g, '');
    out.push(`# ${title}`, '');
    let heading = null;
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      if (/^#{1,6}\s/.test(line)) { heading = line.replace(/^#+\s*/, ''); continue; }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const block = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
        if (heading) out.push(`## ${heading}`, '');
        out.push(...block, '');
        heading = null;
      }
    }
  }
  return out.join('\n');
}

/** Chapter PDF -> image-only PDF (pages rasterized, no text layer). */
function scanPdf(pdfBytes, tmp, name) {
  const dir = path.join(tmp, `scan-${name}`);
  fs.mkdirSync(dir);
  const src = path.join(dir, 'src.pdf');
  fs.writeFileSync(src, pdfBytes);
  execFileSync('pdftoppm', ['-r', String(SCAN_DPI), '-gray', '-png', src, path.join(dir, 'page')]);
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => path.join(dir, f));
  const out = path.join(dir, `${name}.pdf`);
  execFileSync('magick', [...pages, '-strip', '-units', 'PixelsPerInch', '-density', String(SCAN_DPI),
    '-compress', 'jpeg', '-quality', String(SCAN_JPEG_QUALITY), out]);
  return normalizePdf(fs.readFileSync(out));
}

function main() {
  requireTools();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-eval-corpus-'));
  const entries = [];
  const write = (file, source, kind, bytes) => {
    const target = path.join(OUT, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    entries.push({ file, source, kind, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    console.log(`${kind.padEnd(8)} ${file} (${bytes.length} bytes)`);
  };
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    for (const [source, name] of MARKDOWN) {
      write(`markdown/${name}.md`, source, 'markdown', fs.readFileSync(path.join(REPO, source)));
    }
    for (const [source, name] of PDF) {
      write(`pdf/${name}.pdf`, source, 'pdf', printPdf(path.join(REPO, source), tmp, name));
    }
    const tablesMd = path.join(tmp, 'developer-tables.md');
    fs.writeFileSync(tablesMd, tablesMarkdown(TABLE_SOURCES));
    write(TABLE_FILE, TABLE_SOURCES, 'table', printPdf(tablesMd, tmp, 'developer-tables'));
    for (const [source, name] of SCANNED) {
      const printed = printPdf(path.join(REPO, source), tmp, name);
      write(`scanned/${name}.pdf`, source, 'scanned', scanPdf(printed, tmp, name));
    }
    for (const office of officeFiles()) write(office.file, office.source, office.kind, office.bytes);
    entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(entries, null, 2) + '\n');
    const total = entries.reduce((n, e) => n + e.bytes, 0);
    console.log(`${entries.length} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { normalizePdf, tablesMarkdown };
