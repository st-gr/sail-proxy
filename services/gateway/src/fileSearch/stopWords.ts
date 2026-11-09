// Words the full-text arm of hybrid recall leaves out of a question before it ORs the rest
// (recallSql.ts, hybrid.lexical_query "any"). English and German, lowercase, as the 'simple'
// text-search configuration emits them (it lowercases and keeps umlauts and ß).
//
// Source: the Snowball stop-word lists for English and German (snowballstem.org, BSD licence),
// trimmed to function words - articles, pronouns, auxiliaries, conjunctions, common
// prepositions and question words. Words that often carry meaning in a technical question
// (not, no, up, down, off, out, over, under, before, after, between, more, most) are kept out
// of the list on purpose: a stop word can never match, so an over-long list costs recall.
// Words of one character are dropped by length in the query itself, so they are not listed.

const ENGLISH = [
  'about', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'having', 'he', 'her', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'may',
  'me', 'might', 'must', 'my', 'myself', 'of', 'on', 'or', 'our', 'ours', 'ourselves', 'shall', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours', 'yourself', 'yourselves',
];

const GERMAN = [
  'aber', 'als', 'also', 'am', 'an', 'auch', 'auf', 'aus', 'bei', 'bin', 'bis', 'bist', 'da', 'damit',
  'dann', 'das', 'dass', 'daß', 'dem', 'den', 'denn', 'der', 'des', 'dich', 'die', 'dies', 'diese',
  'diesem', 'diesen', 'dieser', 'dieses', 'dir', 'doch', 'du', 'durch', 'ein', 'eine', 'einem', 'einen',
  'einer', 'eines', 'er', 'es', 'euch', 'euer', 'eure', 'für', 'hab', 'habe', 'haben', 'hat', 'hatte',
  'hatten', 'ich', 'ihm', 'ihn', 'ihnen', 'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'ihres', 'im', 'in',
  'ins', 'ist', 'jede', 'jedem', 'jeden', 'jeder', 'jedes', 'kann', 'können', 'könnte', 'man', 'mein',
  'meine', 'mich', 'mir', 'mit', 'muss', 'musste', 'nach', 'noch', 'nun', 'nur', 'ob', 'oder', 'sehr',
  'sein', 'seine', 'seinem', 'seinen', 'seiner', 'seines', 'sich', 'sie', 'sind', 'so', 'soll',
  'sollte', 'um', 'und', 'uns', 'unser', 'unsere', 'vom', 'von', 'war', 'waren', 'wann', 'warum', 'was',
  'weil', 'welche', 'welchem', 'welchen', 'welcher', 'welches', 'wem', 'wen', 'wenn', 'wer', 'werde',
  'werden', 'wessen', 'wie', 'wir', 'wird', 'wo', 'wurde', 'wurden', 'würde', 'würden', 'zu', 'zum',
  'zur',
];

/** English and German stop words, lowercase and deduplicated. */
export const STOP_WORDS: readonly string[] = Object.freeze([...new Set([...ENGLISH, ...GERMAN])].sort());
