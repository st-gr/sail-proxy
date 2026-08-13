/**
 * The pieces of Anthropic's `web_search` handling that the streaming and
 * non-streaming paths genuinely share.
 *
 * Shared because three call sites need the same answer and had drifted into
 * three copies of it: the Bedrock streaming handler deciding whether to install
 * the stream interception, the interception itself deciding which tool to strip
 * from a cap-reached continuation, and `awsBedrockResponseCache` deciding that a
 * web_search turn must never be served from or written to the cache.
 *
 * Both spellings match on purpose. `webSearchPlugin`'s before-handler rewrites
 * the server tool (`type: 'web_search_20250305'`) into an ordinary function tool
 * (`name: 'web_search'`), so which one is present depends on whether the caller
 * runs before or after that rewrite — and a check that only knew one spelling
 * would silently answer "no" on the other side of it.
 */

export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** Whether a single entry of a `tools` array is Anthropic's web_search tool. */
export function isWebSearchTool(tool: any): boolean {
  return tool?.name === WEB_SEARCH_TOOL_NAME
    || tool?.type === WEB_SEARCH_TOOL_NAME
    || (typeof tool?.type === 'string' && tool.type.startsWith('web_search_'));
}

/** Whether a request payload declares web_search among its tools. */
export function requestDeclaresWebSearchTool(requestBody: any): boolean {
  const tools = requestBody?.tools;
  return Array.isArray(tools) && tools.some(isWebSearchTool);
}

/**
 * The `tool_result.content` handed back to the MODEL for an executed search.
 *
 * Both paths send this upstream — the non-streaming before-handler injects it
 * into `messages`, the streaming continuation puts it in its synthesized user
 * turn — and they had drifted into two identical copies of it. What the model
 * reads must not depend on which transport the request happened to arrive on.
 *
 * Note `snippet` is deliberately absent: `content` already carries the longer
 * body, and this shape is the one the non-streaming path has always sent.
 */
export function buildWebSearchToolResultContent(
  results: Array<{ title: string; url: string; content: string; date?: string }>,
): string {
  if (results.length === 0) return 'No search results found.';
  return JSON.stringify({
    results: results.map((r) => ({ title: r.title, url: r.url, content: r.content, date: r.date })),
  });
}
