/**
 * Token counting service using gpt-tokenizer
 * Provides local tokenization for Anthropic Messages API format
 *
 * Encodings are pre-loaded at module initialization to avoid blocking
 * the event loop during request handling.
 */
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Type definitions for messages and tools (OpenAI format after translation)
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionsPayload {
  messages: Message[];
  model: string;
  tools?: Tool[] | null;
  [key: string]: unknown;
}

interface Encoder {
  encode: (text: string) => number[];
}

interface ModelConstants {
  funcInit: number;
  propInit: number;
  propKey: number;
  enumInit: number;
  enumItem: number;
  funcEnd: number;
}

interface TokenCountResult {
  input: number;
  output: number;
}

// Encoding module paths for dynamic import
const ENCODING_PATHS: Record<string, string> = {
  o200k_base: 'gpt-tokenizer/cjs/encoding/o200k_base',
  cl100k_base: 'gpt-tokenizer/cjs/encoding/cl100k_base',
  p50k_base: 'gpt-tokenizer/cjs/encoding/p50k_base',
  p50k_edit: 'gpt-tokenizer/cjs/encoding/p50k_edit',
  r50k_base: 'gpt-tokenizer/cjs/encoding/r50k_base',
};

type SupportedEncoding = keyof typeof ENCODING_PATHS;

// Cache for loaded encoders
const encodingCache = new Map<string, Encoder>();

// Promise that resolves when pre-loading is complete
let preloadPromise: Promise<void> | null = null;

/**
 * Pre-load commonly used encodings at startup
 * This runs asynchronously and doesn't block module initialization
 */
async function preloadEncodings(): Promise<void> {
  const commonEncodings: SupportedEncoding[] = ['cl100k_base', 'o200k_base'];

  for (const encoding of commonEncodings) {
    try {
      await loadEncoding(encoding);
      logger.debug('TokenCountService', `Pre-loaded encoding: ${encoding}`);
    } catch (error) {
      logger.warn('TokenCountService', `Failed to pre-load encoding ${encoding}: ${error}`);
    }
  }

  logger.info('TokenCountService', `Pre-loaded ${encodingCache.size} encodings`);
}

/**
 * Load a single encoding asynchronously
 */
async function loadEncoding(encoding: string): Promise<Encoder> {
  const modulePath = ENCODING_PATHS[encoding as SupportedEncoding] || ENCODING_PATHS.o200k_base;

  // Dynamic import to load asynchronously
  const encodingModule = await import(modulePath) as Encoder;
  encodingCache.set(encoding, encodingModule);
  return encodingModule;
}

/**
 * Get encoder, loading it if necessary
 * If pre-loading hasn't completed, this will wait for it
 */
async function getEncoder(encoding: string): Promise<Encoder> {
  // Wait for pre-loading to complete first
  if (preloadPromise) {
    await preloadPromise;
  }

  // Check cache first
  const cached = encodingCache.get(encoding);
  if (cached) {
    return cached;
  }

  // Load on demand if not in cache
  try {
    return await loadEncoding(encoding);
  } catch (error) {
    logger.warn('TokenCountService', `Failed to load encoding ${encoding}, falling back to o200k_base`);

    // Try to get fallback from cache
    const fallback = encodingCache.get('o200k_base');
    if (fallback) {
      return fallback;
    }

    // Last resort: load fallback
    return await loadEncoding('o200k_base');
  }
}

// Start pre-loading encodings immediately (non-blocking)
preloadPromise = preloadEncodings().catch((error) => {
  logger.error('TokenCountService', `Error during encoding pre-load: ${error}`);
});

/**
 * Get tokenizer type from model ID
 */
function getTokenizerFromModel(modelId: string): string {
  const modelLower = modelId.toLowerCase();

  // Claude models use cl100k_base
  if (modelLower.startsWith('claude-') || modelLower.startsWith('anthropic--')) {
    return 'cl100k_base';
  }

  // GPT models use cl100k_base
  if (modelLower.startsWith('gpt-4') || modelLower.startsWith('gpt-3.5')) {
    return 'cl100k_base';
  }

  // Grok models use o200k_base
  if (modelLower.startsWith('grok-')) {
    return 'o200k_base';
  }

  // Default to o200k_base for newer models
  return 'o200k_base';
}

/**
 * Get model-specific constants for token calculation
 */
function getModelConstants(modelId: string): ModelConstants {
  const modelLower = modelId.toLowerCase();

  // GPT-3.5 and GPT-4 have slightly different constants
  if (modelLower.startsWith('gpt-3.5-turbo') || modelLower.startsWith('gpt-4')) {
    return {
      funcInit: 10,   // Tokens for function initialization
      propInit: 3,    // Tokens for properties initialization
      propKey: 3,     // Tokens per property key
      enumInit: -3,   // Tokens for enum initialization (negative = discount)
      enumItem: 3,    // Tokens per enum item
      funcEnd: 12,    // Tokens for function end
    };
  }

  // Default constants for other models (Claude, Grok, etc.)
  return {
    funcInit: 7,
    propInit: 3,
    propKey: 3,
    enumInit: -3,
    enumItem: 3,
    funcEnd: 12,
  };
}

/**
 * Main token counting function (async to support non-blocking encoding loads)
 */
export async function getTokenCount(
  payload: ChatCompletionsPayload,
  modelId: string
): Promise<TokenCountResult> {
  const tokenizer = getTokenizerFromModel(modelId);
  const encoder = await getEncoder(tokenizer);

  const simplifiedMessages = payload.messages;
  const inputMessages = simplifiedMessages.filter(
    (msg) => msg.role !== 'assistant'
  );
  const outputMessages = simplifiedMessages.filter(
    (msg) => msg.role === 'assistant'
  );

  const constants = getModelConstants(modelId);
  let inputTokens = calculateTokens(inputMessages, encoder, constants);
  if (payload.tools && payload.tools.length > 0) {
    inputTokens += numTokensForTools(payload.tools, encoder, constants);
  }
  const outputTokens = calculateTokens(outputMessages, encoder, constants);

  return { input: inputTokens, output: outputTokens };
}

/**
 * Calculate tokens for an array of messages
 */
function calculateTokens(
  messages: Message[],
  encoder: Encoder,
  constants: ModelConstants
): number {
  if (messages.length === 0) return 0;

  let numTokens = 0;
  for (const message of messages) {
    numTokens += calculateMessageTokens(message, encoder, constants);
  }
  // Every reply is primed with <|start|>assistant<|message|>
  numTokens += 3;
  return numTokens;
}

/**
 * Calculate tokens for a single message
 */
function calculateMessageTokens(
  message: Message,
  encoder: Encoder,
  constants: ModelConstants
): number {
  const tokensPerMessage = 3;
  const tokensPerName = 1;
  let tokens = tokensPerMessage;

  for (const [key, value] of Object.entries(message)) {
    if (typeof value === 'string') {
      tokens += encoder.encode(value).length;
    }
    if (key === 'name') {
      tokens += tokensPerName;
    }
    if (key === 'tool_calls') {
      tokens += calculateToolCallsTokens(
        value as ToolCall[],
        encoder,
        constants
      );
    }
    if (key === 'content' && Array.isArray(value)) {
      tokens += calculateContentPartsTokens(
        value as ContentPart[],
        encoder
      );
    }
  }
  return tokens;
}

/**
 * Calculate tokens for tool calls in a message
 */
function calculateToolCallsTokens(
  toolCalls: ToolCall[],
  encoder: Encoder,
  constants: ModelConstants
): number {
  let tokens = 0;
  for (const toolCall of toolCalls) {
    tokens += constants.funcInit;
    tokens += encoder.encode(JSON.stringify(toolCall)).length;
  }
  tokens += constants.funcEnd;
  return tokens;
}

/**
 * Calculate tokens for content parts (text/images)
 */
function calculateContentPartsTokens(
  contentParts: ContentPart[],
  encoder: Encoder
): number {
  let tokens = 0;
  for (const part of contentParts) {
    if (part.type === 'image_url' && part.image_url) {
      // Image URL tokens + fixed overhead
      tokens += encoder.encode(part.image_url.url).length + 85;
    } else if (part.type === 'text' && part.text) {
      tokens += encoder.encode(part.text).length;
    }
  }
  return tokens;
}

/**
 * Calculate token count for all tools in the payload
 */
function numTokensForTools(
  tools: Tool[],
  encoder: Encoder,
  constants: ModelConstants
): number {
  let funcTokenCount = 0;
  for (const tool of tools) {
    funcTokenCount += calculateToolTokens(tool, encoder, constants);
  }
  funcTokenCount += constants.funcEnd;
  return funcTokenCount;
}

/**
 * Calculate tokens for a single tool definition
 */
function calculateToolTokens(
  tool: Tool,
  encoder: Encoder,
  constants: ModelConstants
): number {
  let tokens = constants.funcInit;
  const func = tool.function;
  const fName = func.name;
  let fDesc = func.description || '';
  if (fDesc.endsWith('.')) {
    fDesc = fDesc.slice(0, -1);
  }
  const line = fName + ':' + fDesc;
  tokens += encoder.encode(line).length;

  if (typeof func.parameters === 'object' && func.parameters !== null) {
    tokens += calculateParametersTokens(func.parameters, encoder, constants);
  }
  return tokens;
}

/**
 * Calculate tokens for function parameters (recursive)
 */
function calculateParametersTokens(
  parameters: unknown,
  encoder: Encoder,
  constants: ModelConstants
): number {
  if (!parameters || typeof parameters !== 'object') return 0;

  const params = parameters as Record<string, unknown>;
  let tokens = 0;

  for (const [key, value] of Object.entries(params)) {
    if (key === 'properties') {
      const properties = value as Record<string, unknown>;
      if (Object.keys(properties).length > 0) {
        tokens += constants.propInit;
        for (const propKey of Object.keys(properties)) {
          tokens += calculateParameterTokens(propKey, properties[propKey], {
            encoder,
            constants,
          });
        }
      }
    } else {
      const paramText =
        typeof value === 'string' ? value : JSON.stringify(value);
      tokens += encoder.encode(`${key}:${paramText}`).length;
    }
  }

  return tokens;
}

/**
 * Calculate tokens for a single parameter
 */
function calculateParameterTokens(
  key: string,
  prop: unknown,
  context: {
    encoder: Encoder;
    constants: ModelConstants;
  }
): number {
  const { encoder, constants } = context;
  let tokens = constants.propKey;

  if (typeof prop !== 'object' || prop === null) return tokens;

  const param = prop as {
    type?: string;
    description?: string;
    enum?: unknown[];
    [key: string]: unknown;
  };

  const paramName = key;
  const paramType = param.type || 'string';
  let paramDesc = param.description || '';

  // Handle enum values
  if (param.enum && Array.isArray(param.enum)) {
    tokens += constants.enumInit;
    for (const item of param.enum) {
      tokens += constants.enumItem;
      tokens += encoder.encode(String(item)).length;
    }
  }

  // Clean up description
  if (paramDesc.endsWith('.')) {
    paramDesc = paramDesc.slice(0, -1);
  }

  // Encode the main parameter line
  const line = `${paramName}:${paramType}:${paramDesc}`;
  tokens += encoder.encode(line).length;

  // Handle additional properties (excluding standard ones)
  const excludedKeys = new Set(['type', 'description', 'enum']);
  for (const propertyName of Object.keys(param)) {
    if (!excludedKeys.has(propertyName)) {
      const propertyValue = param[propertyName];
      const propertyText =
        typeof propertyValue === 'string'
          ? propertyValue
          : JSON.stringify(propertyValue);
      tokens += encoder.encode(`${propertyName}:${propertyText}`).length;
    }
  }

  return tokens;
}

/**
 * Wait for encodings to be pre-loaded (useful for testing)
 */
export async function waitForPreload(): Promise<void> {
  if (preloadPromise) {
    await preloadPromise;
  }
}

/**
 * Check if encodings are loaded (useful for health checks)
 */
export function isReady(): boolean {
  return encodingCache.size > 0;
}

export default {
  getTokenCount,
  waitForPreload,
  isReady,
};
