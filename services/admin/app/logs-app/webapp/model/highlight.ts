/**
 * Highlighting the search term in a log text. Log text is untrusted (it can carry parts of requests),
 * so the segments are found as plain text and every piece is escaped before it becomes markup; only
 * the <strong> around a match is ours. No UI5 imports.
 *
 * The match has the meaning of the service's search: the trimmed term, literally, case-insensitive.
 */

export interface Segment { text: string; match: boolean }

/** Lower case per character, keeping the length (a few letters grow when lower-cased; those stay as they are). */
function fold(text: string): string {
  let out = '';
  for (const c of text) {
    const lower = c.toLowerCase();
    out += lower.length === c.length ? lower : c;
  }
  return out;
}

export function searchSegments(text: string, term: string | null | undefined): Segment[] {
  const source = String(text ?? '');
  const needle = fold(String(term ?? '').trim());
  if (!source) return [];
  if (!needle) return [{ text: source, match: false }];
  const haystack = fold(source);
  const segments: Segment[] = [];
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (at > from) segments.push({ text: source.slice(from, at), match: false });
    segments.push({ text: source.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < source.length) segments.push({ text: source.slice(from), match: false });
  return segments;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Markup for sap.m.FormattedText: every segment escaped, a match wrapped in <strong> (bold, not colour alone). */
export function segmentsToHtml(segments: Segment[]): string {
  return segments.map((s) => (s.match ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text))).join('');
}
