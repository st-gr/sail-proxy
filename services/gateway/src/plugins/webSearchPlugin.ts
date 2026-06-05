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
import * as fs from 'fs';
import * as path from 'path';
import configService from '../services/configService';
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
import { savePayload } from '../utils/payloadLogger';

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

interface Logger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content: string;
  date?: string;
}

interface PerplexityResponse {
  summary: string;
  results: SearchResult[];
  citations_used?: string[];
}

interface PerplexitySearchResult {
  title?: string;
  url?: string;
  date?: string;
  snippet?: string;
}

interface NormalizedCitation {
  url: string;
  title?: string;
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

// Cache for the system prompt
let cachedSystemPrompt: string | null = null;

/**
 * Load system prompt from external file for easy tuning
 * Tries multiple paths to support both development and production environments
 */
function loadSystemPrompt(): string {
  if (cachedSystemPrompt) {
    return cachedSystemPrompt;
  }

  // Try multiple paths to find the system prompt file
  const possiblePaths = [
    // Development: running from src directory
    path.join(__dirname, 'webSearchPlugin.system-prompt.txt'),
    // Production: running from dist, file in src
    path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'plugins', 'webSearchPlugin.system-prompt.txt'),
    // Alternative: file alongside the source
    path.resolve(process.cwd(), 'src', 'plugins', 'webSearchPlugin.system-prompt.txt'),
  ];

  for (const promptPath of possiblePaths) {
    try {
      if (fs.existsSync(promptPath)) {
        cachedSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
        logger.info('webSearchPlugin', `Loaded system prompt from ${promptPath}`);
        return cachedSystemPrompt;
      }
    } catch (error) {
      // Continue to next path
    }
  }

  logger.warn('webSearchPlugin', 'Failed to load system prompt from any path, using fallback');
  // Fallback to inline prompt if file not found
  cachedSystemPrompt = `You are a web search assistant. Your task is to search for information and return results in a structured format.

IMPORTANT: Return your response in the following JSON format:

{
  "summary": "A brief 1-2 sentence summary answering the query",
  "results": [
    {
      "title": "Page title",
      "url": "https://example.com/page",
      "snippet": "Relevant excerpt from the page (100-200 chars)",
      "content": "Longer relevant content from the page",
      "date": "Publication or last updated date if available (e.g., 'April 2025')"
    }
  ],
  "citations_used": ["[1]", "[2]"]
}

Guidelines:
- Include 3-5 most relevant results
- Use only URLs from your citations — do not fabricate or guess URLs
- snippet should be the most relevant sentence or two
- content should be 1-2 paragraphs of relevant information
- date should be in human-readable format
- Only include results you are confident are accurate
- If no results found, return empty results array with explanation in summary`;

  return cachedSystemPrompt;
}

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
 * Get access token for SAP AI Core
 */
async function getAccessToken(): Promise<string> {
  return await configService.getAccessToken();
}

/**
 * Try to find a direct Perplexity deployment via auto-discovery.
 * Returns the deployment ID or null if not available.
 */
async function getPerplexityDeploymentId(pluginLogger: Logger): Promise<string | null> {
  try {
    const deploymentService = await import('../services/deploymentDiscoveryService');
    const id = await deploymentService.getPerplexityDeploymentId();
    return id;
  } catch (error: any) {
    pluginLogger.debug(`Perplexity deployment discovery unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Execute web search via Perplexity sonar-pro.
 *
 * Tries a direct Perplexity deployment first (preserves citation URLs),
 * then falls back to SAP AI Core orchestration if no direct deployment is available.
 */
async function executeWebSearch(query: string, pluginLogger: Logger): Promise<SearchResult[]> {
  const systemPrompt = loadSystemPrompt();

  pluginLogger.info(`Executing web search via Perplexity sonar-pro for query: "${query}"`);

  try {
    const sapConfig = configService.getSAPAICoreConfig();
    const accessToken = await getAccessToken();

    // Try direct Perplexity deployment first (real citation URLs)
    const forceOrchestration = process.env.WEBSEARCH_FORCE_ORCHESTRATION === 'true';
    const perplexityDeploymentId = forceOrchestration ? null : await getPerplexityDeploymentId(pluginLogger);

    if (perplexityDeploymentId) {
      pluginLogger.info(`Using direct Perplexity deployment: ${perplexityDeploymentId}`);
      return await executeDirectPerplexitySearch(query, systemPrompt, sapConfig, accessToken, perplexityDeploymentId, pluginLogger);
    }

    // Fall back to orchestration
    pluginLogger.info(forceOrchestration
      ? 'WEBSEARCH_FORCE_ORCHESTRATION=true, using orchestration path'
      : 'No direct Perplexity deployment found, falling back to orchestration');
    return await executeOrchestrationSearch(query, systemPrompt, sapConfig, accessToken, pluginLogger);

  } catch (error: any) {
    pluginLogger.error(`Failed to execute web search: ${error.message}`);
    return [];
  }
}

/**
 * Execute search via direct Perplexity deployment (OpenAI-compatible endpoint).
 * This preserves Perplexity's native citations and search_results fields.
 */
async function executeDirectPerplexitySearch(
  query: string,
  systemPrompt: string,
  sapConfig: any,
  accessToken: string,
  deploymentId: string,
  pluginLogger: Logger
): Promise<SearchResult[]> {
  const payload = {
    model: 'sonar-pro',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Search query: ${query}\n\nProvide results in the specified JSON format.` }
    ],
    temperature: 0.1
  };

  const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/chat/completions`;
  pluginLogger.debug(`Calling direct Perplexity endpoint at: ${url}`);

  const response = await axios.post(url, payload, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'AI-Resource-Group': sapConfig.resourceGroup || 'default',
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  if (process.env.DEBUG === 'true') {
    savePayload('websearch-direct', '10_perplexity_direct_response', {
      deploymentId,
      url,
      query,
      responseKeys: Object.keys(response.data || {}),
      hasCitations: Array.isArray(response.data?.citations),
      citationCount: response.data?.citations?.length || 0,
      hasSearchResults: Array.isArray(response.data?.search_results),
      searchResultCount: response.data?.search_results?.length || 0,
      rawResponse: response.data
    });
  }

  return parsePerplexityResponse(response.data, pluginLogger);
}

/**
 * Execute search via SAP AI Core orchestration v2 endpoint.
 * The v2 endpoint forwards Perplexity's citations as structured { ref_id, title, url } objects.
 */
async function executeOrchestrationSearch(
  query: string,
  systemPrompt: string,
  sapConfig: any,
  accessToken: string,
  pluginLogger: Logger
): Promise<SearchResult[]> {
  const deploymentId = await configService.getDeploymentId();
  if (!deploymentId) {
    throw new Error('No SAP AI Core deployment ID available');
  }

  const sapPayload = {
    config: {
      modules: {
        prompt_templating: {
          prompt: {
            template: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Search query: ${query}\n\nProvide results in the specified JSON format.` }
            ]
          },
          model: {
            name: 'sonar-pro',
            version: 'latest',
            params: {
              temperature: 0.1
            }
          }
        }
      }
    }
  };

  const url = `${sapConfig.url}/v2/inference/deployments/${deploymentId}/v2/completion`;
  pluginLogger.debug(`Calling SAP AI Core orchestration v2 for web search at: ${url}`);

  const response = await axios.post(url, sapPayload, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'AI-Resource-Group': sapConfig.resourceGroup || 'default',
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  if (process.env.DEBUG === 'true') {
    savePayload('websearch-orchestration', '11_perplexity_orchestration_v2_response', {
      deploymentId,
      url,
      query,
      responseKeys: Object.keys(response.data || {}),
      finalResultKeys: Object.keys(response.data?.final_result || {}),
      hasCitations: Array.isArray(response.data?.final_result?.citations) || Array.isArray(response.data?.intermediate_results?.llm?.citations),
      citationCount: response.data?.final_result?.citations?.length || response.data?.intermediate_results?.llm?.citations?.length || 0,
      rawResponse: response.data
    });
  }

  return parsePerplexityResponse(response.data, pluginLogger);
}

/**
 * Normalize a raw citations array into { url, title } objects.
 * Handles both flat URL strings (direct Perplexity) and structured objects (orchestration v2).
 */
function normalizeCitations(raw: any[]): NormalizedCitation[] {
  return raw.map(item => {
    if (typeof item === 'string') {
      return { url: item };
    }
    if (item && typeof item === 'object' && item.url) {
      return { url: item.url, title: item.title };
    }
    return { url: String(item) };
  });
}

/**
 * Extract structured citations and search_results from the API response.
 *
 * Handles three response formats:
 * - Direct Perplexity deployment: citations/search_results at top level
 * - SAP AI Core orchestration v1: nested under orchestration_result or module_results
 * - SAP AI Core orchestration v2: nested under final_result or intermediate_results.llm
 */
function extractApiCitations(response: any, pluginLogger: Logger): { citations: NormalizedCitation[]; searchResults: PerplexitySearchResult[] } {
  const citations: NormalizedCitation[] = [];
  const searchResults: PerplexitySearchResult[] = [];

  // Debug logging — discover response structure
  pluginLogger.debug(`Response keys: ${JSON.stringify(Object.keys(response || {}))}`);

  // 1. Check top-level (direct Perplexity deployment response)
  if (Array.isArray(response?.citations)) {
    pluginLogger.info(`Found ${response.citations.length} citations at top level`);
    citations.push(...normalizeCitations(response.citations));
  }
  if (Array.isArray(response?.search_results)) {
    pluginLogger.info(`Found ${response.search_results.length} search_results at top level`);
    searchResults.push(...response.search_results);
  }

  // 2. Check orchestration v1: orchestration_result level
  if (!citations.length && Array.isArray(response?.orchestration_result?.citations)) {
    pluginLogger.info(`Found citations in orchestration_result`);
    citations.push(...normalizeCitations(response.orchestration_result.citations));
  }
  if (!searchResults.length && Array.isArray(response?.orchestration_result?.search_results)) {
    pluginLogger.info(`Found search_results in orchestration_result`);
    searchResults.push(...response.orchestration_result.search_results);
  }

  // 3. Check orchestration v2: final_result / intermediate_results.llm
  if (!citations.length && Array.isArray(response?.final_result?.citations)) {
    pluginLogger.info(`Found ${response.final_result.citations.length} citations in final_result (v2)`);
    citations.push(...normalizeCitations(response.final_result.citations));
  }
  if (!citations.length && Array.isArray(response?.intermediate_results?.llm?.citations)) {
    pluginLogger.info(`Found ${response.intermediate_results.llm.citations.length} citations in intermediate_results.llm (v2)`);
    citations.push(...normalizeCitations(response.intermediate_results.llm.citations));
  }

  // 4. Check v1 module_results / intermediate_results (legacy)
  const moduleResults = response?.module_results || response?.orchestration_result?.module_results;
  if (moduleResults) {
    pluginLogger.debug(`module_results keys: ${JSON.stringify(Object.keys(moduleResults))}`);
    const llmResult = moduleResults.llm || moduleResults.intermediate_results;
    if (llmResult) {
      if (Array.isArray(llmResult.citations) && !citations.length) {
        pluginLogger.info(`Found citations in module_results.llm`);
        citations.push(...normalizeCitations(llmResult.citations));
      }
      if (Array.isArray(llmResult.search_results) && !searchResults.length) {
        pluginLogger.info(`Found search_results in module_results.llm`);
        searchResults.push(...llmResult.search_results);
      }
    }
  }

  if (citations.length || searchResults.length) {
    pluginLogger.info(`Extracted ${citations.length} citations, ${searchResults.length} search_results from API`);
  }

  return { citations, searchResults };
}

/**
 * Parse Perplexity sonar-pro response and extract search results.
 *
 * Prefers structured citations/search_results from the API response (real URLs)
 * over LLM-generated JSON in the content (which contains hallucinated URLs).
 */
function parsePerplexityResponse(response: any, pluginLogger: Logger): SearchResult[] {
  try {
    // 1. Try to extract real URLs from API-level citations/search_results
    const { citations, searchResults: apiSearchResults } = extractApiCitations(response, pluginLogger);

    // 2. Extract LLM content — handle direct, orchestration v1, and orchestration v2 response formats
    const content = response?.choices?.[0]?.message?.content
      || response?.orchestration_result?.choices?.[0]?.message?.content
      || response?.final_result?.choices?.[0]?.message?.content
      || '';

    if (!content && !apiSearchResults.length) {
      pluginLogger.warn('Empty content in Perplexity response and no API search_results');
      return [];
    }

    // 3. If we have API-level search_results, use those (real URLs)
    if (apiSearchResults.length > 0) {
      pluginLogger.info(`Using ${apiSearchResults.length} search_results from API response (real URLs)`);
      return apiSearchResults.map((r: PerplexitySearchResult) => ({
        title: r.title || 'Search Result',
        url: r.url || '',
        snippet: r.snippet || '',
        content: r.snippet || '',
        date: r.date
      }));
    }

    // 4. If we have citations array but no search_results, merge citations
    //    with LLM-parsed results to replace hallucinated URLs (and titles when available from v2)
    if (citations.length > 0) {
      pluginLogger.info(`Using ${citations.length} citation URLs from API response to replace LLM URLs`);
      const llmResults = parseLlmContent(content, pluginLogger);

      return llmResults.map((r, idx) => ({
        ...r,
        url: citations[idx]?.url || r.url,
        title: citations[idx]?.title || r.title
      }));
    }

    // 5. Fallback: no structured API fields available — use LLM JSON parsing
    //    (URLs will be hallucinated — log a warning)
    pluginLogger.warn('No citations or search_results in API response — falling back to LLM content parsing (URLs may be hallucinated)');
    return parseLlmContent(content, pluginLogger);

  } catch (error: any) {
    pluginLogger.error(`Failed to parse Perplexity response: ${error.message}`);
    return [];
  }
}

/**
 * Parse LLM-generated content for search results (JSON or text fallback).
 * Note: URLs in LLM content are hallucinated by the model and should be
 * replaced with real URLs from API citations when available.
 */
function parseLlmContent(content: string, pluginLogger: Logger): SearchResult[] {
  // Try to parse as JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    pluginLogger.warn('No JSON found in Perplexity response, falling back to text parsing');
    return parseTextResponse(content, pluginLogger);
  }

  const parsed: PerplexityResponse = JSON.parse(jsonMatch[0]);

  if (!parsed.results || !Array.isArray(parsed.results)) {
    pluginLogger.warn('No results array in parsed Perplexity response');
    return [];
  }

  return parsed.results.map((r: any) => ({
    title: r.title || 'Search Result',
    url: r.url || '',
    snippet: r.snippet || '',
    content: r.content || r.snippet || '',
    date: r.date
  }));
}

/**
 * Fallback text parsing when JSON parsing fails
 */
function parseTextResponse(content: string, pluginLogger: Logger): SearchResult[] {
  pluginLogger.debug('Attempting fallback text parsing of Perplexity response');

  // Simple fallback: create a single result from the text content
  return [{
    title: 'Search Results',
    url: '',
    snippet: content.substring(0, 200),
    content: content,
    date: undefined
  }];
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
  // Create a user message with the tool_result
  const toolResult = {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: searchResults.length > 0
        ? JSON.stringify({
            results: searchResults.map(r => ({
              title: r.title,
              url: r.url,
              content: r.content,
              date: r.date
            }))
          })
        : 'No search results found.'
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

    pluginLogger.info(`Intercepted web_search tool_use: ${webSearchUse.id}, query: "${webSearchUse.input.query}"`);

    // Execute the search via Perplexity sonar-pro
    const searchResults = await executeWebSearch(webSearchUse.input.query, pluginLogger);

    // Build response with search results in Anthropic format
    const transformedContent = buildResponseWithSearchResults(
      upstreamResponse.content,
      webSearchUse,
      searchResults,
      pluginLogger
    );

    return {
      ...upstreamResponse,
      content: transformedContent,
      stop_reason: 'end_turn'  // Search completed, turn ends
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
