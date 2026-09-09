/**
 * What the server said about a Save that did not go through.
 *
 * ODataModel#submitBatch rejects only when the batch REQUEST fails: a single PATCH inside the
 * change set answered 400 leaves the batch itself successful, the change still pending, and the
 * reason ("tokensPerDay must not exceed tokensPerWeek") nowhere but the message manager. Without
 * reading it out the detail page can only say "try again", which is the one thing that will not
 * help. These are pure functions over the message model's raw entries - no UI5 runtime - so the
 * filtering is testable on its own, like headerDirty/contextWindow.
 */

/** One entry of sap/ui/core/Messaging#getMessageModel()#getData(), as far as this needs it. */
export interface UiMessage {
  message?: string;
  type?: string;
  /** OData V4 reports a bound message's target absolutely, e.g. "/QuotaProfiles(<id>)/tokensPerDay". */
  target?: string;
  targets?: string[];
}

const targetsOf = (m: UiMessage): string[] =>
  ((m.targets && m.targets.length ? m.targets : m.target ? [m.target] : []) as string[]).filter(Boolean);

/**
 * Is this message about what is on screen? An unbound message (no target) is: the service raises
 * the constraint check without naming a field. A bound one only when it points at the context the
 * detail page is showing - a message left over from another row must not be reported as this
 * Save's reason.
 */
function belongsTo(message: UiMessage, contextPath?: string | null): boolean {
  const targets = targetsOf(message);
  if (targets.length === 0) return true;
  if (!contextPath) return false;
  return targets.some((t) => t === contextPath || t.startsWith(`${contextPath}/`));
}

/** The error messages this Save should report, in the order the message model holds them. */
export function serverErrors(messages: UiMessage[] | null | undefined, contextPath?: string | null): UiMessage[] {
  return (messages ?? []).filter((m) => m && m.type === 'Error' && String(m.message ?? '').trim() !== '' && belongsTo(m, contextPath));
}

/** The same as one block of text, one message per line, deduplicated; '' when there is nothing to say. */
export function serverErrorText(messages: UiMessage[] | null | undefined, contextPath?: string | null): string {
  return [...new Set(serverErrors(messages, contextPath).map((m) => String(m.message).trim()))].join('\n');
}
