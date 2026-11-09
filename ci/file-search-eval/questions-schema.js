/**
 * Validates a questions.json object (the contract between the question generator and the evaluation
 * runner). Returns a list of error strings; an empty list means valid.
 *
 * { version: 1, corpusManifestSha256, generatedWith: { model, date },
 *   questions: [{ id, question, file, kind, quotes, files? }] }
 */
const { normalise } = require('./normalise');

const KINDS = ['markdown', 'pdf', 'table', 'scanned', 'multihop'];
/** Kinds whose questions are written by hand (the synthetic Office files, build-office-corpus.js);
 *  the generator writes none of them. */
const OFFICE_KINDS = ['pptx', 'xlsx'];
const MULTIHOP_FILE_KINDS = ['markdown', 'pdf', 'table'];
const MAX_QUOTE_CHARS = 300;
const MIN_QUESTIONS = 100;
const MAX_QUESTIONS = 200;

/** manifest: the corpus manifest array; manifestSha256: sha256 of its file bytes. */
function validateQuestionSet(set, { manifest, manifestSha256 }) {
  const errors = [];
  const err = msg => errors.push(msg);
  const kindOf = new Map(manifest.map(e => [e.file, e.kind]));

  if (!set || typeof set !== 'object') return ['not an object'];
  const extra = Object.keys(set).filter(k => !['version', 'corpusManifestSha256', 'generatedWith', 'questions'].includes(k));
  if (extra.length) err(`unknown top-level fields: ${extra.join(', ')}`);
  if (set.version !== 1) err('version is not 1');
  if (set.corpusManifestSha256 !== manifestSha256) err('corpusManifestSha256 does not match corpus/manifest.json');
  const g = set.generatedWith;
  if (!g || typeof g.model !== 'string' || !g.model) err('generatedWith.model missing');
  if (!g || typeof g.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g.date)) err('generatedWith.date is not YYYY-MM-DD');
  if (!Array.isArray(set.questions)) return [...errors, 'questions is not an array'];
  const n = set.questions.length;
  if (n < MIN_QUESTIONS || n > MAX_QUESTIONS) err(`${n} questions, expected ${MIN_QUESTIONS}-${MAX_QUESTIONS}`);

  const ids = new Set();
  const texts = new Set();
  set.questions.forEach((q, i) => {
    const at = q && typeof q.id === 'string' ? q.id : `questions[${i}]`;
    if (!q || typeof q !== 'object') return err(`${at}: not an object`);
    const unknown = Object.keys(q).filter(k => !['id', 'question', 'file', 'kind', 'quotes', 'files'].includes(k));
    if (unknown.length) err(`${at}: unknown fields ${unknown.join(', ')}`);
    if (typeof q.id !== 'string' || !/^q\d{3,}$/.test(q.id)) err(`${at}: id is not q###`);
    else if (ids.has(q.id)) err(`${at}: duplicate id`);
    ids.add(q.id);
    if (typeof q.question !== 'string' || !q.question.trim()) err(`${at}: empty question`);
    else if (texts.has(normalise(q.question))) err(`${at}: duplicate question`);
    else texts.add(normalise(q.question));
    if (!KINDS.includes(q.kind) && !OFFICE_KINDS.includes(q.kind)) err(`${at}: unknown kind ${q.kind}`);
    if (!kindOf.has(q.file)) err(`${at}: file ${q.file} is not in the corpus manifest`);
    else if (q.kind === 'multihop' && !MULTIHOP_FILE_KINDS.includes(kindOf.get(q.file))) err(`${at}: multihop on a ${kindOf.get(q.file)} file`);
    else if (q.kind !== 'multihop' && kindOf.get(q.file) !== q.kind) err(`${at}: kind ${q.kind} but the file is ${kindOf.get(q.file)}`);
    if (!Array.isArray(q.quotes) || q.quotes.length === 0) return err(`${at}: no quotes`);
    if (q.kind === 'multihop' && q.quotes.length !== 2) err(`${at}: multihop needs exactly two quotes`);
    for (const quote of q.quotes) {
      if (typeof quote !== 'string' || !normalise(quote)) err(`${at}: empty quote`);
      else if (quote.length > MAX_QUOTE_CHARS) err(`${at}: quote longer than ${MAX_QUOTE_CHARS} characters`);
    }
    if (q.files !== undefined) {
      const ok = q.kind === 'multihop' && Array.isArray(q.files) && q.files.length === 2 && q.files[0] === q.file
        && q.files[0] !== q.files[1] && q.files.every(f => MULTIHOP_FILE_KINDS.includes(kindOf.get(f)));
      if (!ok) err(`${at}: files must be two different text-bearing corpus files, the first equal to file (multihop only)`);
    }
  });
  return errors;
}

module.exports = { validateQuestionSet, KINDS, OFFICE_KINDS, MAX_QUOTE_CHARS, MIN_QUESTIONS, MAX_QUESTIONS };
