#!/usr/bin/env node
/**
 * Unit tests for the question generator's network-free parts: the shared normaliser, the mix, the
 * prompt/response handling, quote verification, deduplication and the generation loop driven by a
 * fake model. No network, no external tools.
 */
const assert = require('assert');
const { normalise, containsAnyQuote } = require('./normalise');
const {
  DEFAULT_MIX, parseMix, scaleMix, splitWindows, allocate, buildPrompt, parseResponse, createVerifier, generateQuestionSet,
} = require('./question-set');

// normalise
assert.strictEqual(normalise('  The ﬁle\n\n\fSEARCH\ttool  '), 'the file search tool', 'ligature, nbsp, case, whitespace');
assert.strictEqual(normalise('re­trieval​'), 'retrieval', 'soft hyphen and zero-width space');
assert.strictEqual(normalise('“It’s” – a — b'), '"it\'s" - a - b', 'typographic quotes and dashes');
assert.strictEqual(normalise('ＡＢＣ１'), 'abc1', 'full-width forms');
assert(containsAnyQuote('Line one.\nThe  default  is 20\nchunks.', ['nope', 'the default is 20 chunks']), 'chunk contains a quote');
assert(!containsAnyQuote('The default is 20.', ['the default is 30', '']), 'empty quote never matches');

// mix
assert.deepStrictEqual(parseMix('markdown=40,pdf=40,table=20,scanned=20,multihop=30'), DEFAULT_MIX);
assert.deepStrictEqual(parseMix('pdf=5'), { markdown: 0, pdf: 5, table: 0, scanned: 0, multihop: 0 });
assert.throws(() => parseMix('images=3'), /not kind=count/);
assert.deepStrictEqual(scaleMix(DEFAULT_MIX, 150), DEFAULT_MIX);
const scaled = scaleMix(DEFAULT_MIX, 100);
assert.strictEqual(Object.values(scaled).reduce((a, b) => a + b, 0), 100, 'scaled mix hits the target');
assert.deepStrictEqual(allocate(5, [1, 1, 2]), [1, 1, 3]);
assert.deepStrictEqual(allocate(1, [1, 1]), [1, 0], 'ties go to the earlier window');

// windows cover the text exactly and respect the size
const long = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} ${'x'.repeat(i % 50)}`).join('\n\n');
const windows = splitWindows(long, 1000);
assert.strictEqual(windows.join(''), long, 'windows concatenate to the text');
assert(windows.every(w => w.length <= 1000), 'windows are at most the size');

// prompt and response
const prompt = buildPrompt({ kind: 'multihop', file: 'pdf/a.pdf', text: 'TEXT {{?x}}', asked: ['Old question?'] }, 4);
assert(/two quotes per question/.test(prompt.system) && /Write 4 questions/.test(prompt.user), 'prompt asks for the count');
assert(prompt.user.includes('TEXT {{?x}}') && !prompt.system.includes('TEXT'), 'the document travels in the user message only');
assert(prompt.user.includes('- Old question?'), 'earlier questions are listed');
assert.deepStrictEqual(parseResponse('```json\n{"questions":[{"question":"q","quotes":["a"]}]}\n```'), [{ question: 'q', quotes: ['a'] }]);
assert.deepStrictEqual(parseResponse('[{"question":"q","quotes":[]}]'), [{ question: 'q', quotes: [] }]);
assert.strictEqual(parseResponse('Sure! Here are some questions.'), null);
assert.strictEqual(parseResponse('{"items":[]}'), null);

// verification
const filler = 'Unrelated filler sentence about nothing in particular. '.repeat(12);
const texts = new Map([
  ['markdown/a.md', `# Alpha\n\nThe **alpha** gateway listens on port 7011 by default.\n${filler}\nRetries stop after\nfive attempts with back-off.\nShared boilerplate sentence for every file.`],
  ['pdf/b.pdf', 'The beta worker ﬂushes its queue every 30 seconds.\fShared boilerplate sentence for every file.'],
  ['scanned/c.pdf', 'Plain prose about the gamma cache size of 512 entries.\nThe **delta** flag turns tracing on.'],
]);
const v = createVerifier(texts);
const ok = (q, quotes, kind, file) => v.verify({ question: q, quotes }, kind, file);
assert.deepStrictEqual(ok('  Which port does the alpha gateway use when nothing is configured? ', ['The **alpha** gateway listens on port 7011 by default.'], 'markdown', 'markdown/a.md'),
  { question: 'Which port does the alpha gateway use when nothing is configured?', quotes: ['The **alpha** gateway listens on port 7011 by default.'] });
assert.strictEqual(ok('How often does the beta worker empty its queue?', ['The beta worker flushes its queue every 30 seconds.'], 'pdf', 'pdf/b.pdf').question,
  'How often does the beta worker empty its queue?', 'ligature in the extracted text still matches');
const reason = (q, quotes, kind, file) => ok(q, quotes, kind, file).reason;
assert.strictEqual(reason('What is the beta port?', ['The beta worker listens on port 9000.'], 'pdf', 'pdf/b.pdf'), 'quote-not-found');
assert.strictEqual(reason('What is the beta interval?', ['every 30 seconds'], 'pdf', 'pdf/b.pdf'), 'quote-too-short');
assert.strictEqual(reason('What is the beta interval?', ['x'.repeat(301)], 'pdf', 'pdf/b.pdf'), 'quote-too-long');
assert.strictEqual(reason('What is the beta interval?', ['The beta worker flushes', 'its queue every 30 seconds.'], 'pdf', 'pdf/b.pdf'), 'quote-count');
assert.strictEqual(reason('What is shared by all files here?', ['Shared boilerplate sentence for every file.'], 'pdf', 'pdf/b.pdf'), 'quote-in-other-file');
assert.strictEqual(reason('Which flag turns tracing on?', ['The **delta** flag turns tracing on.'], 'scanned', 'scanned/c.pdf'), 'markup-in-scanned-quote');
assert.strictEqual(reason('How large is the gamma cache?', ['Plain prose about the gamma cache size of 512 entries.'], 'scanned', 'scanned/c.pdf'), undefined, 'plain prose from a scanned source passes');
assert.strictEqual(reason('Is it true that the beta worker flushes its queue every 30 seconds?', ['The beta worker flushes its queue every 30 seconds.'], 'pdf', 'pdf/b.pdf'), 'question-contains-quote');
assert.strictEqual(reason('Which port does the alpha gateway use when nothing is configured?!', ['Retries stop after five attempts with back-off.'], 'markdown', 'markdown/a.md'), 'duplicate-question');
assert.strictEqual(reason('What number does the beta worker wait between queue flushes?', ['The beta worker flushes its queue every 30 seconds.'], 'pdf', 'pdf/b.pdf'), 'duplicate-quotes');
assert.strictEqual(reason('Which port and how many retries apply to alpha?', ['The **alpha** gateway listens on port 7011', 'gateway listens on port 7011 by default.'], 'multihop', 'markdown/a.md'), 'quotes-same-passage');
assert.strictEqual(ok('How many tries does alpha make on its default port before it gives up?', ['The **alpha** gateway listens on port 7011', 'Retries stop after five attempts with back-off.'], 'multihop', 'markdown/a.md').quotes.length, 2, 'multihop across passages');
assert.strictEqual(reason(null, [], 'pdf', 'pdf/b.pdf'), 'malformed');
assert.strictEqual(reason('Why?', ['The beta worker flushes its queue every 30 seconds.'], 'pdf', 'pdf/b.pdf'), 'malformed');

// generation loop with a fake model
const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heath', 'inlet', 'jade', 'kelp', 'larch'];
function makeDoc(file, kind, n) {
  const facts = Array.from({ length: n }, (_, i) => `The ${file.replace(/\W/g, '')} unit ${WORDS[i % WORDS.length]}${i} keeps setting ${1000 + i} active.`);
  return { file, kind, text: facts.join('\n\n') };
}
const docs = [
  makeDoc('markdown/m1.md', 'markdown', 60), makeDoc('markdown/m2.md', 'markdown', 30),
  makeDoc('pdf/p1.pdf', 'pdf', 60), makeDoc('scanned/s1.pdf', 'scanned', 40), makeDoc('table/t1.pdf', 'table', 40),
];

function fakeModel({ failFirst = false } = {}) {
  const calls = [];
  return {
    calls,
    async complete({ system, user }) {
      calls.push({ system, user });
      if (failFirst && calls.length === 1) throw new Error('HTTP 503');
      const text = /<document>\n([\s\S]*)\n<\/document>/.exec(user)[1];
      const count = Number(/Write (\d+) questions/.exec(user)[1]);
      const facts = text.split('\n\n').filter(Boolean);
      const multihop = /two quotes per question/.test(system);
      const out = [];
      for (let i = 0; i < count; i++) {
        const k = (calls.length * 7 + i) % facts.length;
        const [, fileTag, tag] = /The (\w+) unit (\w+)/.exec(facts[k]);
        if (i === 0) out.push({ question: 'Which setting is invented here?', quotes: ['This sentence is not in the document at all.'] });
        out.push(multihop
          ? { question: `How does ${tag} in ${fileTag} relate to its distant partner?`, quotes: [facts[k], facts[(k + 15) % facts.length]] }
          : { question: `Which value does ${tag} in ${fileTag} hold?`, quotes: [facts[k]] });
      }
      return { text: JSON.stringify({ questions: out }), usage: { prompt_tokens: 100, completion_tokens: 50 } };
    },
  };
}

(async () => {
  const mix = { markdown: 8, pdf: 5, table: 4, scanned: 4, multihop: 6 };
  const model = fakeModel();
  const run = await generateQuestionSet({ docs, mix, llm: model, maxCalls: 50, maxTokens: 1e9 });
  assert.strictEqual(run.questions.length, 27, 'meets the mix');
  for (const [k, n] of Object.entries(mix)) assert.strictEqual(run.counts[k].selected, n, `${k} selected`);
  assert.deepStrictEqual(run.questions.map(q => q.id), run.questions.map((_, i) => `q${String(i + 1).padStart(3, '0')}`));
  assert(run.stats.rejected['quote-not-found'] >= 1, 'invented quotes are rejected');
  assert.strictEqual(run.stats.promptTokens, model.calls.length * 100);
  assert(run.questions.filter(q => q.kind === 'multihop').every(q => q.quotes.length === 2 && /^(markdown|pdf)\//.test(q.file)), 'multihop: two quotes from a text file');
  const md = run.questions.filter(q => q.kind === 'markdown');
  assert(md.some(q => q.file === 'markdown/m1.md') && md.some(q => q.file === 'markdown/m2.md'), 'every file represented');
  for (const q of run.questions) {
    const doc = docs.find(d => d.file === q.file);
    assert(q.quotes.every(quote => normalise(doc.text).includes(normalise(quote))), `${q.id} quotes are in its file`);
    assert.deepStrictEqual(Object.keys(q), ['id', 'question', 'file', 'kind', 'quotes']);
  }
  const again = await generateQuestionSet({ docs, mix, llm: fakeModel(), maxCalls: 50, maxTokens: 1e9 });
  assert.deepStrictEqual(again.questions, run.questions, 'same answers, same set');

  const capped = await generateQuestionSet({ docs, mix, llm: fakeModel(), maxCalls: 2, maxTokens: 1e9 });
  assert.strictEqual(capped.stats.calls, 2);
  assert.strictEqual(capped.stats.stopped, 'max-calls');
  const tokenCapped = await generateQuestionSet({ docs, mix, llm: fakeModel(), maxCalls: 50, maxTokens: 300 });
  assert.strictEqual(tokenCapped.stats.calls, 2, 'stops once the token budget is spent');

  const flaky = await generateQuestionSet({ docs, mix, llm: fakeModel({ failFirst: true }), maxCalls: 60, maxTokens: 1e9 });
  assert.strictEqual(flaky.stats.rejected['call-failed'], 1, 'a failed call is counted and skipped');
  const fatalModel = { complete: async () => { throw Object.assign(new Error('HTTP 400'), { fatal: true }); } };
  await assert.rejects(generateQuestionSet({ docs, mix, llm: fatalModel, maxCalls: 5, maxTokens: 1e9 }), /HTTP 400/);

  console.log(`file-search-eval question generator: ${model.calls.length} fake calls, ${run.questions.length} questions, rejected ${JSON.stringify(run.stats.rejected)} - OK`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
