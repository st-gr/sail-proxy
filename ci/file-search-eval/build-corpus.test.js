#!/usr/bin/env node
/**
 * Validates the committed evaluation corpus against its manifest: every entry exists with the recorded
 * size and sha256, no file is unlisted, all six kinds are present, the scanned PDFs carry no text
 * layer marker, the Office files are what build-office-corpus.js writes, and the tracked corpus stays
 * under 15 MB. Needs no external tools.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizePdf, tablesMarkdown } = require('./build-corpus');
const { officeFiles, OFFICE_KINDS, SOURCE: OFFICE_SOURCE, crc32 } = require('./build-office-corpus');

const CORPUS = path.join(__dirname, 'corpus');
const REPO = path.resolve(__dirname, '..', '..');
const KINDS = ['markdown', 'pdf', 'table', 'scanned', ...OFFICE_KINDS];
const MAX_BYTES = 15 * 1024 * 1024;

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
assert(Array.isArray(manifest) && manifest.length > 0, 'manifest.json is a non-empty array');

const files = manifest.map(e => e.file);
assert.deepStrictEqual(files, [...files].sort(), 'manifest is sorted by file');
assert.strictEqual(new Set(files).size, files.length, 'manifest lists each file once');

let total = 0;
const seenSources = new Set();
for (const e of manifest) {
  assert.deepStrictEqual(Object.keys(e).sort(), ['bytes', 'file', 'kind', 'sha256', 'source'], `${e.file}: fields`);
  assert(KINDS.includes(e.kind), `${e.file}: known kind ${e.kind}`);
  const sources = Array.isArray(e.source) ? e.source : [e.source];
  assert(sources.length > 0, `${e.file}: has a source`);
  for (const s of OFFICE_KINDS.includes(e.kind) ? [] : sources) {
    assert(/^docs\/(guide(\/clients)?|developer)\/[^/]+\.md$/.test(s), `${e.file}: source ${s} is a docs chapter`);
    assert(fs.existsSync(path.join(REPO, s)), `${e.file}: source ${s} exists`);
    assert(!seenSources.has(s), `${s} appears in one corpus file only`);
    seenSources.add(s);
  }
  const bytes = fs.readFileSync(path.join(CORPUS, e.file));
  assert.strictEqual(bytes.length, e.bytes, `${e.file}: size`);
  assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), e.sha256, `${e.file}: sha256`);
  if (OFFICE_KINDS.includes(e.kind)) {
    assert.strictEqual(e.source, OFFICE_SOURCE, `${e.file}: made by build-office-corpus.js`);
    assert.strictEqual(bytes.subarray(0, 4).toString('latin1'), 'PK\x03\x04', `${e.file}: is a zip`);
  }
  // Markdown copies are a snapshot: they are not compared with docs/, which keeps changing.
  else if (e.kind !== 'markdown') {
    assert.strictEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-', `${e.file}: is a PDF`);
    const text = bytes.toString('latin1');
    assert(!/\/(CreationDate|ModDate)\s*\(D:(?!20000101000000)/.test(text), `${e.file}: fixed dates`);
    if (e.kind === 'scanned') assert(!/\/Font\b/.test(text), `${e.file}: no fonts, i.e. no text layer`);
    else assert(/\/Font\b/.test(text), `${e.file}: has fonts, i.e. a text layer`);
  }
  total += bytes.length;
}
for (const k of KINDS) assert(manifest.some(e => e.kind === k), `kind ${k} present`);

const onDisk = listFiles(CORPUS).filter(f => f !== 'manifest.json').sort();
assert.deepStrictEqual(onDisk, files, 'files on disk match the manifest');
assert(total <= MAX_BYTES, `corpus is ${total} bytes, limit ${MAX_BYTES}`);

// normalizePdf: same-length rewrite of volatile fields.
const raw = Buffer.from("/CreationDate (D:20261008052952+00'00') /ModDate (D:20261008052952) /ID [<ABCD12> <ef0193>]", 'latin1');
const norm = normalizePdf(raw).toString('latin1');
assert.strictEqual(norm.length, raw.length, 'normalizePdf keeps the length');
assert.strictEqual(norm, "/CreationDate (D:20000101000000+00'00') /ModDate (D:20000101000000) /ID [<000000> <000000>]");

// The Office files are synthetic and rebuilt identically anywhere: the committed bytes are the script's.
for (const { file, kind, bytes } of officeFiles()) {
  const entry = manifest.find(e => e.file === file);
  assert(entry && entry.kind === kind, `${file}: listed as ${kind}`);
  assert(bytes.equals(fs.readFileSync(path.join(CORPUS, file))), `${file}: equals build-office-corpus.js output (run it after editing the script)`);
}
assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926, 'crc32 check value');

// tablesMarkdown: tables come out under their headings (checked against a real chapter).
const md = tablesMarkdown(['docs/developer/reranker-datasets.md']);
assert(/^\|/m.test(md) && /^## /m.test(md), 'tablesMarkdown emits headed tables');

console.log(`file-search-eval corpus: ${manifest.length} files, ${(total / 1024 / 1024).toFixed(2)} MB, kinds ${KINDS.join('/')} - OK`);
