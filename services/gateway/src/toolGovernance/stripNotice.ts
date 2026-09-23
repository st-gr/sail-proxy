/**
 * The line strip mode adds to a request, telling the model which tools were removed.
 *
 * Strip used to be silent: the tool simply was not in the request any more, so the model looked for
 * another way to do the job and the person at the keyboard saw an assistant that quietly would not
 * search the web. Only the administrator learned about it, through the security event. Reject is no
 * answer for an interactive client either - the whole turn fails - so the note is what makes strip
 * both effective and honest.
 *
 * The text is deliberately invariant for a given set of tools: a client that keeps a denied tool in
 * its list is stripped on every turn, and a system prompt that changed each time would defeat the
 * provider's prompt caching. The marker is what keeps a replayed or retried body from accumulating
 * notes, and what lets every adapter recognise its own note in any of the shapes a system prompt
 * takes.
 */
import type { ToolIdentity } from './identity';

export const STRIP_NOTICE_MARKER = '[tool policy]';

/**
 * One line naming the removed tools; the identities are sorted so the text never varies. When the
 * trust chain removed tools (2026-09-22 §3.4), the untrusted sources are named too, sorted.
 */
export function stripNotice(blocked: ToolIdentity[], taintedBy: ToolIdentity[] = []): string {
  const tools = [...new Set(blocked)].sort().join(', ');
  const sources = [...new Set(taintedBy)].sort().join(', ');
  const why = sources ? ` This conversation contains content from ${sources}, so tools that act on it are withheld.` : '';
  return `${STRIP_NOTICE_MARKER} These tools are not permitted for this caller and have been removed`
    + ` from this request: ${tools}.${why} Do not attempt to call them or to reach the same capability another`
    + ` way. If the task cannot be completed without them, say so plainly.`;
}

export const carriesNotice = (text: unknown): boolean =>
  typeof text === 'string' && text.includes(STRIP_NOTICE_MARKER);

/** `text` with the note appended after a blank line, or the note alone when there is no text yet. */
export function appendNotice(text: unknown, blocked: ToolIdentity[], taintedBy: ToolIdentity[] = []): string {
  const notice = stripNotice(blocked, taintedBy);
  return typeof text === 'string' && text.length > 0 ? `${text}\n\n${notice}` : notice;
}
