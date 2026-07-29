/**
 * Perplexity sonar-pro search execution, shared by the Anthropic and Responses
 * web-search plugins.
 *
 * Extracted from webSearchPlugin.ts so both wire formats can reuse one search
 * implementation. Everything here is format-agnostic: it takes a query string
 * and returns SearchResult[]. All Anthropic- and Responses-specific shaping
 * lives in the respective plugins.
 *
 * Strategy: a direct sonar-pro deployment is preferred because it preserves
 * Perplexity's real `citations` / `search_results`. SAP's orchestration wrapper
 * strips those fields, so URLs from the fallback path are model-generated.
 *
 * @see webSearchPlugin.ts - Anthropic consumer
 * @see responsesWebSearchPlugin.ts - Responses consumer
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import configService from '../../services/configService';
import { getDefaultLogger } from '@libs/logger';
import { savePayload } from '../../utils/payloadLogger';

const logger = getDefaultLogger();

export interface Logger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

export interface SearchResult {
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
    // Development: running from src, file one directory up (plugins/)
    path.join(__dirname, '..', 'webSearchPlugin.system-prompt.txt'),
    // Production: running from dist, file in src
    path.join(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'plugins', 'webSearchPlugin.system-prompt.txt'),
    // Alternative: resolved from the process working directory
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
    const deploymentService = await import('../../services/deploymentDiscoveryService');
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
export async function executeWebSearch(query: string, pluginLogger: Logger): Promise<SearchResult[]> {
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
