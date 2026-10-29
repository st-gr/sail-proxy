/**
 * The network-free core of the question generator: planning the requests, the prompt, parsing the
 * model's answer, verifying every answer quote against the text ingestion will see, deduplicating,
 * and picking the final mix. generate-questions.js supplies the texts and a real SAP client; the
 * tests supply a fake client.
 */
const { normalise } = require('./normalise');
const { KINDS, MAX_QUOTE_CHARS } = require('./questions-schema');

const DEFAULT_MIX = { markdown: 40, pdf: 40, table: 20, scanned: 20, multihop: 30 };
const MULTIHOP_SOURCE_KINDS = ['markdown', 'pdf'];
const MIN_QUOTE_CHARS = 20;
const MULTIHOP_MIN_GAP = 400;
const DUPLICATE_SIMILARITY = 0.8;
const MAX_PER_CALL = 15;
const WINDOW_CHARS = { single: 12000, multihop: 40000 };
// A scanned PDF shows rendered Markdown: emphasis, code ticks, link brackets and table pipes are gone,
// so a quote carrying them could never match the text OCR will produce.
const SCANNED_MARKUP = /[*`[\]|#<>]/;

function parseMix(spec) {
  const mix = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const part of String(spec).split(',')) {
    const m = /^\s*([a-z]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (!m || !KINDS.includes(m[1])) throw new Error(`--mix: "${part}" is not kind=count (kinds: ${KINDS.join(', ')})`);
    mix[m[1]] = Number(m[2]);
  }
  return mix;
}

/** Scales a mix to a target total (largest remainder), keeping the proportions. */
function scaleMix(mix, target) {
  const sum = KINDS.reduce((s, k) => s + mix[k], 0);
  if (sum === 0) throw new Error('the mix asks for no questions');
  if (target === undefined || target === sum) return { ...mix };
  const exact = KINDS.map(k => (mix[k] * target) / sum);
  const out = Object.fromEntries(KINDS.map((k, i) => [k, Math.floor(exact[i])]));
  let left = target - KINDS.reduce((s, k) => s + out[k], 0);
  const order = KINDS.map((k, i) => [k, exact[i] - Math.floor(exact[i])]).sort((a, b) => b[1] - a[1]);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) out[order[i][0]]++;
  return out;
}

/** Splits text into windows of at most `size` characters, preferring paragraph boundaries. */
function splitWindows(text, size) {
  const windows = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      if (para > start + size / 2) end = para;
    }
    const w = text.slice(start, end);
    if (w.trim()) windows.push(w);
    start = end;
  }
  return windows;
}

/** docs: [{ file, kind, text }] in a fixed order. Returns windows per question kind with their share. */
function planWindows(docs, mix) {
  const plan = {};
  for (const kind of KINDS) {
    if (!mix[kind]) continue;
    const pool = docs.filter(d => (kind === 'multihop' ? MULTIHOP_SOURCE_KINDS.includes(d.kind) : d.kind === kind));
    if (pool.length === 0) throw new Error(`no corpus file can supply ${kind} questions`);
    const size = kind === 'multihop' ? WINDOW_CHARS.multihop : WINDOW_CHARS.single;
    const windows = pool.flatMap(d => splitWindows(d.text, size).map(text => ({ kind, file: d.file, text })));
    const total = windows.reduce((s, w) => s + w.text.length, 0);
    windows.forEach((w, i) => Object.assign(w, { index: i, share: w.text.length / total, accepted: 0, asked: [] }));
    plan[kind] = windows;
  }
  return plan;
}

/** Splits n over windows by weight (largest remainder, ties to the earlier window). */
function allocate(n, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  const exact = weights.map(w => (n * w) / total);
  const out = exact.map(Math.floor);
  const order = exact.map((e, i) => [i, e - Math.floor(e)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (let i = 0, left = n - out.reduce((s, x) => s + x, 0); left > 0; i++, left--) out[order[i % order.length][0]]++;
  return out;
}

const RULES = [
  'Each answer quote is copied character for character from the document: one contiguous span of 40 to 250',
  'characters, no ellipsis, no paraphrase, no added or removed words, punctuation or formatting.',
  'The quote alone must answer the question. Ask about a concrete fact: a value, a name, a command, a setting,',
  'a limit, a behaviour or a reason. Do not reuse the wording of the quote in the question.',
  'Make each question self-contained and specific enough that only this passage answers it: name the product',
  'feature, tool or setting it is about, never "this document", "the text" or "the chapter".',
  'Spread the questions over different parts of the document; do not ask the same thing twice.',
];
const KIND_RULES = {
  markdown: [],
  pdf: ['The document is text extracted from a PDF; quote it as extracted, including its line breaks.'],
  table: [
    'The document is text extracted from PDF tables, one cell after another. Ask questions whose answer is',
    'in one table cell, and quote that cell text exactly as extracted.',
  ],
  scanned: [
    'Quote plain sentences only: no Markdown markup characters (* ` [ ] | # < >), no link targets, no code',
    'blocks and no table rows.',
  ],
  multihop: [
    'Every question needs two facts from two different sections of the document that are far apart;',
    'give exactly two quotes, one per fact. Neither quote alone answers the question.',
  ],
};

function buildPrompt(window, count) {
  const quotes = window.kind === 'multihop' ? 'two quotes' : 'one quote';
  const system = [
    'You write evaluation questions for a document retrieval system.',
    ...RULES,
    ...KIND_RULES[window.kind],
    `Answer with JSON only, no prose: {"questions":[{"question":"...","quotes":["..."]}]} with ${quotes} per question.`,
  ].join('\n');
  const avoid = window.asked.length
    ? `\n\nThese questions exist already; ask different ones:\n${window.asked.map(q => `- ${q}`).join('\n')}`
    : '';
  const user = `Document "${window.file}":\n<document>\n${window.text}\n</document>\n\nWrite ${count} questions.${avoid}`;
  return { system, user };
}

/** The model's candidate list, or null when the answer is not the requested JSON. */
function parseResponse(text) {
  const body = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.questions;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Normalised words only: punctuation and symbols become single spaces. */
function bareWords(text) {
  return normalise(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function questionTokens(question) {
  return new Set(bareWords(question).split(' ').filter(w => w.length >= 3));
}

function similarity(a, b) {
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  const union = a.size + b.size - common;
  return union === 0 ? 1 : common / union;
}

/**
 * Checks candidates against the texts. `texts` maps each corpus file to the text its questions are
 * checked against (extracted text, or the source Markdown for scanned files). Returns the cleaned
 * question or the rejection reason; accepted questions are remembered for deduplication.
 */
function createVerifier(texts) {
  const norm = new Map([...texts].map(([file, text]) => [file, normalise(text)]));
  const seen = [];

  function verify(candidate, kind, file) {
    if (!candidate || typeof candidate.question !== 'string' || !Array.isArray(candidate.quotes)) return { reason: 'malformed' };
    if (!candidate.quotes.every(q => typeof q === 'string')) return { reason: 'malformed' };
    const question = candidate.question.trim().replace(/\s+/g, ' ');
    const quotes = candidate.quotes.map(q => q.trim());
    if (question.length < 10) return { reason: 'malformed' };
    if (quotes.length !== (kind === 'multihop' ? 2 : 1)) return { reason: 'quote-count' };
    const text = norm.get(file);
    const spans = [];
    for (const quote of quotes) {
      const q = normalise(quote);
      if (quote.length > MAX_QUOTE_CHARS) return { reason: 'quote-too-long' };
      if (q.length < MIN_QUOTE_CHARS) return { reason: 'quote-too-short' };
      if (kind === 'scanned' && SCANNED_MARKUP.test(quote)) return { reason: 'markup-in-scanned-quote' };
      const at = text.indexOf(q);
      if (at < 0) return { reason: 'quote-not-found' };
      for (const [other, otherText] of norm) if (other !== file && otherText.includes(q)) return { reason: 'quote-in-other-file' };
      if (bareWords(question).includes(bareWords(quote))) return { reason: 'question-contains-quote' };
      spans.push([at, at + q.length]);
    }
    if (kind === 'multihop') {
      const [a, b] = spans.sort((x, y) => x[0] - y[0]);
      if (b[0] - a[1] < MULTIHOP_MIN_GAP) return { reason: 'quotes-same-passage' };
    }
    const tokens = questionTokens(question);
    const quoteKey = `${file}\n${quotes.map(normalise).sort().join('\n')}`;
    for (const s of seen) {
      if (s.quoteKey === quoteKey) return { reason: 'duplicate-quotes' };
      if (similarity(s.tokens, tokens) >= DUPLICATE_SIMILARITY) return { reason: 'duplicate-question' };
    }
    seen.push({ tokens, quoteKey });
    return { question, quotes };
  }
  return { verify };
}

/** A rough token count for text whose usage the service did not report: four characters a token. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/** Round-robin over files (in first-accepted order) so a trimmed kind keeps every file represented. */
function pickFair(accepted, quota) {
  const byFile = new Map();
  for (const a of accepted) byFile.set(a.file, [...(byFile.get(a.file) || []), a]);
  const queues = [...byFile.values()];
  const out = [];
  for (let i = 0; out.length < quota && queues.some(q => q.length); i = (i + 1) % queues.length) {
    if (queues[i].length) out.push(queues[i].shift());
  }
  return out;
}

/**
 * docs: [{ file, kind, text }] (kind = corpus kind); llm.complete({ system, user }) resolves to
 * { text, usage: { prompt_tokens, completion_tokens }, attempts? } and throws an error with
 * `fatal: true` when retrying cannot help, or `budget: true` when the client's request cap is spent
 * (both may carry `attempts`). Missing usage and failed attempts are charged with an estimate, so
 * maxTokens holds even when the service reports nothing. Returns the questions in kind order, the per-kind counts and the statistics.
 */
async function generateQuestionSet({ docs, mix, llm, maxCalls, maxTokens, rounds = 3, overgenerate = 1.5, log = () => {} }) {
  const plan = planWindows(docs, mix);
  const { verify } = createVerifier(new Map(docs.map(d => [d.file, d.text])));
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, candidates: 0, rejected: {}, stopped: null };
  const accepted = Object.fromEntries(KINDS.map(k => [k, []]));
  const reject = reason => { stats.rejected[reason] = (stats.rejected[reason] || 0) + 1; };

  outer: for (let round = 1; round <= rounds; round++) {
    for (const kind of Object.keys(plan)) {
      const deficit = mix[kind] - accepted[kind].length;
      if (deficit <= 0) continue;
      const windows = plan[kind];
      const weights = windows.map(w => w.share / (1 + w.accepted));
      const counts = allocate(Math.ceil(deficit * overgenerate), weights);
      for (const w of windows) {
        const count = Math.min(MAX_PER_CALL, counts[w.index]);
        if (count === 0) continue;
        if (stats.calls >= maxCalls) { stats.stopped = 'max-calls'; break outer; }
        if (stats.promptTokens + stats.completionTokens >= maxTokens) { stats.stopped = 'max-tokens'; break outer; }
        stats.calls++;
        const prompt = buildPrompt(w, count);
        const promptEstimate = estimateTokens(prompt.system + prompt.user);
        const charge = (promptTokens, completionTokens, estimated) => {
          stats.promptTokens += promptTokens;
          stats.completionTokens += completionTokens;
          if (estimated) stats.estimatedTokens += promptTokens + completionTokens;
        };
        let response;
        try {
          response = await llm.complete(prompt);
        } catch (err) {
          // A failed attempt still costs its prompt; usage is unknown, so it is estimated.
          charge(promptEstimate * (err.attempts === undefined ? 1 : err.attempts), 0, true);
          if (err.budget) { stats.stopped = 'max-calls'; break outer; }
          if (err.fatal) throw err;
          log(`call ${stats.calls} (${kind}, ${w.file}) failed: ${err.message}`);
          reject('call-failed');
          continue;
        }
        if (response.attempts > 1) charge(promptEstimate * (response.attempts - 1), 0, true);
        const usage = response.usage || {};
        if (Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
          charge(usage.prompt_tokens, usage.completion_tokens, false);
        } else {
          charge(promptEstimate, estimateTokens(response.text), true);
        }
        const candidates = parseResponse(response.text);
        if (!candidates) { reject('unparseable-response'); continue; }
        let kept = 0;
        for (const c of candidates) {
          stats.candidates++;
          if (c && typeof c.question === 'string') w.asked.push(c.question.trim());
          const v = verify(c, kind, w.file);
          if (v.reason) { reject(v.reason); continue; }
          accepted[kind].push({ kind, file: w.file, question: v.question, quotes: v.quotes });
          w.accepted++;
          kept++;
        }
        log(`round ${round} ${kind} ${w.file} #${w.index}: asked ${count}, got ${candidates.length}, kept ${kept}`);
      }
    }
  }

  const questions = [];
  const counts = {};
  for (const kind of KINDS) {
    const picked = pickFair(accepted[kind], mix[kind]);
    counts[kind] = { target: mix[kind], accepted: accepted[kind].length, selected: picked.length };
    questions.push(...picked);
  }
  questions.forEach((q, i) => { q.id = `q${String(i + 1).padStart(3, '0')}`; });
  return {
    questions: questions.map(({ id, question, file, kind, quotes }) => ({ id, question, file, kind, quotes })),
    counts,
    stats,
  };
}

module.exports = {
  KINDS, DEFAULT_MIX, MAX_QUOTE_CHARS, parseMix, scaleMix, splitWindows, planWindows, allocate,
  buildPrompt, parseResponse, createVerifier, pickFair, estimateTokens, generateQuestionSet,
};
