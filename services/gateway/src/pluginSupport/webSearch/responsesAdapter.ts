/**
 * Pure helpers for emulating the hosted `web_search` tool in the OpenAI
 * Responses wire format.
 *
 * SAP AI Core deployments reject hosted tool types outright
 * (`The following tool is not allowed for model '<model>': web_search`), but
 * Codex CLI attaches one to every request and offers no way to turn it off. So
 * the gateway rewrites it into a plain function tool the deployment accepts,
 * runs the search itself, and hands the client back the hosted-tool shape it
 * expects — the same trick webSearchPlugin plays for Anthropic.
 *
 * Everything here is pure: no I/O, no config, no logging.
 */
import { SearchResult } from './searchExecutor';

/** The flat function tool a deployment accepts in place of the hosted one. */
export const RESPONSES_WEB_SEARCH_TOOL: Record<string, any> = {
  type: 'function',
  name: 'web_search',
  description: 'Search the web for current information. Use this tool when you need up-to-date information about topics, news, documentation, or any other web content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to look up on the web' },
    },
    required: ['query'],
  },
  strict: false,
};

export function hasResponsesWebSearchTool(tools: any): boolean {
  return Array.isArray(tools) && tools.some(t => t && t.type === 'web_search');
}

/**
 * Replace every hosted web_search entry with the function-tool equivalent.
 * Mutates in place; returns whether anything changed.
 *
 * An empty `tools` array is removed rather than forwarded: some deployments
 * reject `"tools": []`.
 */
export function transformResponsesWebSearchTool(body: any): boolean {
  if (!body || !Array.isArray(body.tools)) return false;

  let changed = false;
  body.tools = body.tools.map((t: any) => {
    if (t && t.type === 'web_search') {
      changed = true;
      return { ...RESPONSES_WEB_SEARCH_TOOL };
    }
    return t;
  });

  if (body.tools.length === 0) delete body.tools;
  return changed;
}

export function isWebSearchFunctionCall(item: any): boolean {
  return !!item && item.type === 'function_call' && item.name === 'web_search';
}

/** Read the `query` out of a function call's JSON arguments string. */
export function parseQueryFromArguments(args: any): string {
  if (typeof args !== 'string') return '';
  try {
    const parsed = JSON.parse(args);
    return typeof parsed?.query === 'string' ? parsed.query : '';
  } catch {
    return '';
  }
}

/**
 * A web_search call from the previous turn whose result was never supplied.
 * The client replays the whole conversation (store: false), so this is how the
 * model gets to reason over search results without a second deployment call
 * inside one request.
 */
export function findPendingResponsesSearch(input: any): { callId: string; query: string } | null {
  if (!Array.isArray(input)) return null;

  const satisfied = new Set<string>();
  for (const item of input) {
    if (item && item.type === 'function_call_output' && typeof item.call_id === 'string') {
      satisfied.add(item.call_id);
    }
  }

  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!isWebSearchFunctionCall(item)) continue;
    if (typeof item.call_id !== 'string' || satisfied.has(item.call_id)) continue;
    return { callId: item.call_id, query: parseQueryFromArguments(item.arguments) };
  }
  return null;
}

/** Append the results for a pending call as a function_call_output item. */
export function appendFunctionCallOutput(body: any, callId: string, results: SearchResult[]): void {
  if (!body || !Array.isArray(body.input)) return;
  body.input.push({
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({
      results: results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet, content: r.content, date: r.date })),
    }),
  });
}

/** Human-readable summary of the search, used as the assistant's message text. */
export function formatSearchSummaryText(results: SearchResult[], query: string): string {
  if (!results.length) {
    return `No web search results were found for "${query}".`;
  }
  const lines = results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`);
  return `Web search results for "${query}":\n\n${lines.join('\n')}`;
}

export function buildWebSearchCallItem(query: string, id: string, status: 'completed' | 'failed' = 'completed'): any {
  return { type: 'web_search_call', id, status, action: { type: 'search', query } };
}

export function buildSearchMessageItem(results: SearchResult[], query: string, id: string): any {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{
      type: 'output_text',
      text: formatSearchSummaryText(results, query),
      annotations: results.map(r => ({ type: 'url_citation', url: r.url, title: r.title })),
    }],
  };
}
