#!/usr/bin/env node
/**
 * Validates ci/file-search-eval/questions.json against its schema and the committed corpus: fields,
 * ids, kinds that match the manifest, quote limits, the manifest hash, and (for Markdown files, which
 * need no extraction tool) that every quote is in its file. The validator itself is exercised on a
 * synthetic set first, so it is tested even before questions.json exists; until then the file check
 * is skipped with a notice.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalise } = require('./normalise');
const { validateQuestionSet } = require('./questions-schema');

const CORPUS = path.join(__dirname, 'corpus');
const QUESTIONS = path.join(__dirname, 'questions.json');
const manifestBytes = fs.readFileSync(path.join(CORPUS, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
const ctx = { manifest, manifestSha256 };

// The validator on a synthetic set.
const fileOf = kind => manifest.find(e => e.kind === kind).file;
const sample = () => ({
  version: 1,
  corpusManifestSha256: manifestSha256,
  generatedWith: { model: 'gpt-4.1', date: '2026-10-08' },
  questions: Array.from({ length: 100 }, (_, i) => {
    const kind = ['markdown', 'pdf', 'table', 'scanned', 'multihop'][i % 5];
    return {
      id: `q${String(i + 1).padStart(3, '0')}`,
      question: `Synthetic question number ${i + 1}?`,
      file: fileOf(kind === 'multihop' ? 'pdf' : kind),
      kind,
      quotes: kind === 'multihop' ? ['first passage', 'second passage'] : ['a passage'],
    };
  }),
});
assert.deepStrictEqual(validateQuestionSet(sample(), ctx), [], 'a valid set passes');
const broken = (mutate, pattern) => {
  const s = sample();
  mutate(s);
  const errors = validateQuestionSet(s, ctx);
  assert(errors.some(e => pattern.test(e)), `expected ${pattern}, got ${JSON.stringify(errors)}`);
};
broken(s => { s.version = 2; }, /version/);
broken(s => { s.corpusManifestSha256 = '0'.repeat(64); }, /corpusManifestSha256/);
broken(s => { s.generatedWith.date = '8.10.2026'; }, /date/);
broken(s => { s.questions.length = 99; }, /99 questions/);
broken(s => { s.questions[1].id = 'q001'; }, /duplicate id/);
broken(s => { s.questions[1].question = s.questions[0].question.toUpperCase(); }, /duplicate question/);
broken(s => { s.questions[0].file = 'markdown/missing.md'; }, /not in the corpus manifest/);
broken(s => { s.questions[0].kind = 'pdf'; }, /kind pdf but the file is markdown/);
broken(s => { s.questions[0].kind = 'images'; }, /unknown kind/);
broken(s => { s.questions[4].quotes = ['only one']; }, /exactly two quotes/);
broken(s => { s.questions[4].file = fileOf('scanned'); }, /multihop on a scanned file/);
broken(s => { s.questions[0].quotes = ['x'.repeat(301)]; }, /longer than 300/);
broken(s => { s.questions[0].quotes = []; }, /no quotes/);
broken(s => { s.questions[0].answer = 'x'; }, /unknown fields answer/);
broken(s => { s.questions[0].files = [fileOf('markdown'), fileOf('pdf')]; }, /multihop only/);
const twoFiles = sample();
Object.assign(twoFiles.questions[4], { file: fileOf('pdf'), files: [fileOf('pdf'), fileOf('markdown')] });
assert.deepStrictEqual(validateQuestionSet(twoFiles, ctx), [], 'a two-file multihop question passes');

if (!fs.existsSync(QUESTIONS)) {
  console.log('file-search-eval questions: questions.json not generated yet - validator OK, file check SKIPPED');
  process.exit(0);
}

const set = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
const errors = validateQuestionSet(set, ctx);
assert.deepStrictEqual(errors, [], `questions.json is invalid:\n${errors.join('\n')}`);

const markdownText = new Map(manifest.filter(e => e.kind === 'markdown')
  .map(e => [e.file, normalise(fs.readFileSync(path.join(CORPUS, e.file), 'utf8'))]));
let checked = 0;
for (const q of set.questions) {
  for (const f of q.files || [q.file]) {
    if (!markdownText.has(f)) continue;
    if (q.files) assert(q.quotes.some(quote => markdownText.get(f).includes(normalise(quote))), `${q.id}: a quote is in ${f}`);
    else for (const quote of q.quotes) assert(markdownText.get(f).includes(normalise(quote)), `${q.id}: quote is in ${f}`);
    checked++;
  }
}

const byKind = {};
for (const q of set.questions) byKind[q.kind] = (byKind[q.kind] || 0) + 1;
console.log(`file-search-eval questions: ${set.questions.length} (${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}), ` +
  `${checked} Markdown quote sets found in their files - OK`);
