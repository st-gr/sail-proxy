/**
 * The answering call: what a hosted-tool turn gets once a tool's per-request budget is used up.
 *
 * A model that asks for more calls of a tool than the budget allows is told so in the refused
 * calls' outputs and asked once more, WITHOUT that tool on offer, so the turn ends with its
 * answer rather than with a result dump. The tool is taken off the list instead of being left
 * to the model's discretion: a model that still sees it asks again (seen on the Anthropic
 * route, which has done the same since its first version).
 *
 * Pure: no I/O, no config access. The engine decides WHEN, this only shapes the body, and the
 * orchestration builder in responsesController reuses it for the same decision.
 */

/** Whether `tool` is the function tool a hosted tool was rewritten into. */
function isFunctionToolNamed(tool: any, names: readonly string[]): boolean {
  if (!tool || tool.type !== 'function') return false;
  const name = typeof tool.name === 'string' ? tool.name : tool.function?.name;
  return typeof name === 'string' && names.includes(name);
}

/**
 * `body` without the function tools named in `names`. Returns `body` itself when there is
 * nothing to remove; otherwise a shallow copy, so a payload shared by reference keeps its
 * tools for whoever else holds it.
 *
 * With no tool left, `tools` and `tool_choice` are both removed: some deployments reject
 * `"tools": []`, and a `tool_choice` with no tools to choose from. A `tool_choice` naming a
 * removed tool falls back to `'auto'`.
 */
export function withoutFunctionTools<T extends Record<string, any>>(body: T, names: readonly string[]): T {
  if (names.length === 0 || !body || !Array.isArray(body.tools)) return body;
  const remaining = body.tools.filter((tool: any) => !isFunctionToolNamed(tool, names));
  if (remaining.length === body.tools.length) return body;

  const next: Record<string, any> = { ...body };
  if (remaining.length === 0) {
    delete next.tools;
    delete next.tool_choice;
    return next as T;
  }
  next.tools = remaining;
  if (isFunctionToolNamed(next.tool_choice, names)) next.tool_choice = 'auto';
  return next as T;
}
