/**
 * Web Search Plugin
 *
 * Intercepts Anthropic API requests containing the `web_search` server tool,
 * detects when Claude requests a search (via tool_use), executes the search
 * using Perplexity's sonar-pro model via SAP AI Core, and returns results
 * in Anthropic's expected format.
 *
 * Background:
 * The Anthropic web_search tool (`web_search_20250305` / `web_search_20260209`) is a
 * server-side tool that Anthropic executes automatically. Since SAP AI Core doesn't
 * support this tool type, the gateway needs to:
 * 1. Convert the server tool to a regular tool that Claude can use
 * 2. Let Claude process the request and make tool_use calls
 * 3. Intercept Claude's tool_use response for web_search
 * 4. Execute searches via Perplexity sonar-pro
 * 5. Format and return results in Anthropic's web_search_tool_result format
 *
 * Applied to: Claude models with web_search tool enabled (via api_config.json hooks)
 * Strategy: before (transforms server tool to regular tool) + after (executes search)
 *
 * @see api_config.json - Hook configuration
 * @see chapter-13-plugin-system.md - Plugin system documentation
 */

import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { executeWebSearch, Logger, SearchResult } from './webSearch/searchExecutor';
import { remaskSearchQuery } from './webSearch/queryMasking';
import { buildWebSearchToolResultContent } from './webSearch/webSearchTool';

const logger = getDefaultLogger();

// Type definitions
interface PluginContext {
  req: Request;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: any;
}

interface PluginUtils {
  logger: Logger;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: {
    query: string;
    [key: string]: any;
  };
}

interface WebSearchToolResult {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: Array<{
    type: 'web_search_result';
    url: string;
    title: string;
    encrypted_content: string;
    page_age?: string;
  }>;
}

// Web search tool schema for conversion from server tool to regular tool
const WEB_SEARCH_TOOL_SCHEMA = {
  name: 'web_search',
  description: 'Search the web for current information. Use this tool when you need to find up-to-date information about topics, news, documentation, or any other web content.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up on the web'
      }
    },
    required: ['query']
  }
};

/**
 * Check if the request contains a web_search tool
 */
function hasWebSearchTool(tools: any[]): boolean {
  if (!tools || !Array.isArray(tools)) {
    return false;
  }

  return tools.some(tool =>
    tool.type?.startsWith('web_search_') ||
    tool.type === 'web_search' ||
    tool.name === 'web_search'
  );
}

/**
 * Transform web_search server tool to regular tool schema
 * SAP AI Core doesn't support server tool types, so we convert to a regular tool
 */
function transformWebSearchTool(tools: any[]): void {
  if (!tools || !Array.isArray(tools)) {
    return;
  }

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    // Check if this is a web_search server tool (by type starting with 'web_search_')
    if (tool.type?.startsWith('web_search_') || tool.type === 'web_search') {
      logger.debug('webSearchPlugin', `Transforming web_search server tool type "${tool.type}" to regular tool schema`);
      // Replace the server tool definition with a regular tool definition
      tools[i] = WEB_SEARCH_TOOL_SCHEMA;
    }
  }
}

/**
 * Find a pending web_search tool_use in the messages that doesn't have a corresponding tool_result
 */
function findPendingWebSearch(messages: any[]): { id: string; query: string } | null {
  if (!messages || !Array.isArray(messages)) {
    return null;
  }

  // Collect all tool_result IDs
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Find web_search tool_use without a corresponding tool_result
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_use' &&
            block.name === 'web_search' &&
            !toolResultIds.has(block.id)) {
          return {
            id: block.id,
            query: block.input?.query || ''
          };
        }
      }
    }
  }

  return null;
}

/**
 * Find web_search tool_use in the response content
 */
function findWebSearchToolUse(content: any[]): ToolUseBlock | null {
  if (!content || !Array.isArray(content)) {
    return null;
  }

  return content.find(block =>
    block.type === 'tool_use' &&
    block.name === 'web_search'
  ) as ToolUseBlock || null;
}

/**
 * Build response content with search results in Anthropic's expected format
 */
function buildResponseWithSearchResults(
  originalContent: any[],
  toolUse: ToolUseBlock,
  searchResults: SearchResult[],
  pluginLogger: Logger
): any[] {
  const newContent: any[] = [];

  // 1. Keep text blocks that came before tool_use
  for (const block of originalContent) {
    if (block.type === 'text') {
      newContent.push(block);
    }
    if (block === toolUse) break;
  }

  // 2. Add server_tool_use block (Claude's search request)
  newContent.push({
    type: 'server_tool_use',
    id: toolUse.id,
    name: 'web_search',
    input: toolUse.input
  });

  // 3. Add web_search_tool_result
  const webSearchToolResult: WebSearchToolResult = {
    type: 'web_search_tool_result',
    tool_use_id: toolUse.id,
    content: searchResults.map(result => ({
      type: 'web_search_result',
      url: result.url,
      title: result.title,
      encrypted_content: Buffer.from(result.content).toString('base64'),
      page_age: result.date
    }))
  };
  newContent.push(webSearchToolResult);

  // 4. Add final text with summary/citations if we have results
  if (searchResults.length > 0) {
    const summaryText = formatSearchSummary(searchResults, toolUse.input.query);
    newContent.push({
      type: 'text',
      text: summaryText,
      citations: searchResults.map((result, idx) => ({
        type: 'web_search_result_location',
        url: result.url,
        title: result.title,
        encrypted_index: Buffer.from(String(idx)).toString('base64'),
        cited_text: result.snippet || result.content.substring(0, 150)
      }))
    });
  } else {
    // No results found
    newContent.push({
      type: 'text',
      text: `I searched for "${toolUse.input.query}" but couldn't find relevant results. Let me try to help based on my existing knowledge.`
    });
  }

  // Filter out intermediate blocks for 1P API spec compliance
  // (server_tool_use and web_search_tool_result are server-side artifacts)
  const filteredContent = newContent.filter(
    (block: any) => block.type !== 'server_tool_use' && block.type !== 'web_search_tool_result'
  );

  pluginLogger.info(`Built response with ${searchResults.length} search results, returning ${filteredContent.length} blocks (filtered ${newContent.length - filteredContent.length} intermediate blocks)`);
  return filteredContent;
}

/**
 * Format a summary of search results
 */
function formatSearchSummary(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No search results found for "${query}".`;
  }

  const resultSummaries = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] [${r.title}](${r.url})\n${r.snippet}`)
    .join('\n\n');

  return `Based on web search results for "${query}":\n\n${resultSummaries}`;
}

/**
 * Inject search results into messages as a tool_result
 */
function injectSearchResults(messages: any[], toolUseId: string, searchResults: SearchResult[]): void {
  // Create a user message with the tool_result.
  // The payload itself is shared with the streaming continuation
  // (webSearch/anthropicWebSearchStream.ts): what the MODEL reads back from a
  // search must not depend on which transport the request arrived on, and the
  // two had drifted into identical copies of the same builder.
  const toolResult = {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: buildWebSearchToolResultContent(searchResults)
    }]
  };

  messages.push(toolResult);
}

/**
 * Before handler - Transform web_search server tool to regular tool and handle pending searches
 */
async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const pluginLogger = utils.logger;

  try {
    if (!req.body) {
      pluginLogger.debug('No request body found');
      return { stop: false };
    }

    const requestBody = req.body as any;

    // 1. Check for web_search tool
    if (!hasWebSearchTool(requestBody.tools)) {
      return { stop: false };
    }

    pluginLogger.info('Detected web_search tool in request, transforming to regular tool schema');

    // 2. Transform server tool to regular tool (so SAP AI Core accepts it)
    transformWebSearchTool(requestBody.tools);

    // 3. Check for pending search execution (from a previous response's tool_use)
    const pendingSearch = findPendingWebSearch(requestBody.messages);
    if (!pendingSearch) {
      pluginLogger.debug('No pending web_search tool_use found, continuing with transformed request');
      return { stop: false };
    }

    pluginLogger.info(`Found pending web_search with ID ${pendingSearch.id}, query: "${pendingSearch.query}"`);

    // 4. Execute search via Perplexity
    const searchResults = await executeWebSearch(pendingSearch.query, pluginLogger);

    // 5. Inject tool_result into messages
    injectSearchResults(requestBody.messages, pendingSearch.id, searchResults);

    pluginLogger.info(`Injected ${searchResults.length} search results into messages`);

    return { stop: false };  // Continue with modified request

  } catch (error: any) {
    pluginLogger.error(`Error in webSearchPlugin beforeHandler: ${error.message}`, {
      stack: error.stack
    });
    return { stop: false };
  }
}

/**
 * After handler - Intercept tool_use response and execute search
 */
async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const pluginLogger = utils.logger;

  try {
    if (!upstreamResponse) {
      return upstreamResponse;
    }

    const requestBody = req.body as any;

    // Only process if the original request had web_search tool
    if (!hasWebSearchTool(requestBody.tools)) {
      return upstreamResponse;
    }

    // Check if response contains tool_use for web_search
    const webSearchUse = findWebSearchToolUse(upstreamResponse.content);
    if (!webSearchUse) {
      return upstreamResponse;  // Pass through unchanged
    }

    // pseudonymizationPlugin sits ahead of this plugin in the same hook array, and that
    // array is walked in order on the response side too — so `tool_use.input` has already
    // been unmasked in place (unmaskToolBlocks) by the time we get here. Re-mask before
    // the query leaves the process; the tool_use block handed back to the client keeps
    // the unmasked query.
    const searchQuery = remaskSearchQuery(req, webSearchUse.input.query);
    pluginLogger.info(`Intercepted web_search tool_use: ${webSearchUse.id}, query: "${searchQuery}"`);

    // Execute the search via Perplexity sonar-pro
    const searchResults = await executeWebSearch(searchQuery, pluginLogger);

    // Build response with search results in Anthropic format
    const transformedContent = buildResponseWithSearchResults(
      upstreamResponse.content,
      webSearchUse,
      searchResults,
      pluginLogger
    );

    // afterHandler handles a single web_search tool_use per call (findWebSearchToolUse
    // returns only the first match), so one search executed here means one search.
    const searchCount = 1;

    // Claude Code — and any client rendering a search count — reads this and
    // nothing else. Verified against a real api.anthropic.com capture on
    // 2026-08-07: one search reports {"web_search_requests":1,
    // "web_fetch_requests":0}. Emitting the result blocks without it shows
    // "0 searches executed" over a turn that plainly searched.
    // web_fetch_requests is always 0: we do not implement web_fetch, and the
    // key is present in the golden, so its absence would be a shape difference.
    return {
      ...upstreamResponse,
      content: transformedContent,
      stop_reason: 'end_turn',  // Search completed, turn ends
      usage: {
        ...(upstreamResponse.usage || {}),
        server_tool_use: { web_search_requests: searchCount, web_fetch_requests: 0 },
      },
    };

  } catch (error: any) {
    pluginLogger.error(`Error in webSearchPlugin afterHandler: ${error.message}`, {
      stack: error.stack
    });
    // Return original response on error
    return upstreamResponse;
  }
}

// Plugin rules
const pluginRules = [
  {
    id: "webSearchPlugin",
    match: [],
    strategy: "before",
    handler: beforeHandler
  },
  {
    id: "webSearchPlugin",
    match: [],
    strategy: "after",
    handler: afterHandler
  }
];

export = pluginRules;
