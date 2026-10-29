/**
 * The one text normaliser of the file_search evaluation. The question generator checks every answer
 * quote against the normalised extracted text with it, and the runner decides relevance with it (a
 * returned chunk is relevant when its normalised text contains any normalised quote), so both sides
 * must use this function.
 *
 * Normalising: Unicode NFKC (folds ligatures such as "ﬁ" and full-width forms), soft hyphens and
 * zero-width characters removed, typographic quotes and dashes folded to ASCII (pandoc smartens the
 * PDF text, the Markdown copies keep straight quotes), lowercase, every whitespace run (spaces, line
 * breaks, form feeds, no-break spaces) collapsed to one space, trimmed.
 */
const INVISIBLE = /[­​‌‍⁠﻿]/g;
const SINGLE_QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;
const DASHES = /[‐‑‒–—―−]/g;

function normalise(text) {
  return String(text)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the chunk contains any of the quotes, both sides normalised. */
function containsAnyQuote(chunkText, quotes) {
  const chunk = normalise(chunkText);
  return quotes.some(q => {
    const n = normalise(q);
    return n.length > 0 && chunk.includes(n);
  });
}

module.exports = { normalise, containsAnyQuote };
