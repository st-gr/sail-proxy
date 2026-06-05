// Service for Anthropic response transformation
import modelService from './modelService';
import configService from './configService';
import { getDefaultLogger } from '@libs/logger';
import type { SapV2CompletionResponse } from './sapOrchestrationTypes';
const logger = getDefaultLogger();

// Type definitions for SAP AI Core response structures
interface SAPUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface SAPChoice {
  message?: {
    content?: string;
    tool_calls?: SAPToolCall[];
  };
  delta?: {
    content?: string;
    tool_calls?: SAPToolCall[];
  };
  finish_reason?: string | null;
  index?: number;
}

interface SAPToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  index?: number;
}

// V2 wire response — augmented with gateway-internal stream-end markers.
type SAPResponse = SapV2CompletionResponse & {
  done?: boolean;
};

interface SAPChunk extends SAPResponse {
  chunkNumber?: number;
  nonStreamingResponse?: any;
  useEmulatedStreaming?: boolean;
}

// Type definitions for Anthropic response structures
interface AnthropicUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: any;
}


interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: (AnthropicContentBlock | AnthropicToolUse)[];
  stop_reason: string;
  stop_sequence?: string | null;
  usage: AnthropicUsage;
}

interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'error';
  message?: any;
  content_block?: any;
  delta?: any;
  usage?: any;
  error?: {
    type: string;
    message: string;
  };
}

interface ModelDetails {
  owned_by?: string;
  [key: string]: any;
}

interface ModelProviderResult {
  modelForLookup: string;
  provider: string;
}

interface StreamState {
  openTextBlockAnthropicIndex: number | null;
  nextAnthropicBlockIndex: number;
  pendingTools: Record<string, any>;
  sapIndexToToolId: Record<string, string>;
}

interface ChunkTransformResult {
  event: AnthropicStreamEvent | AnthropicStreamEvent[] | null;
  finishReason: string | null;
  usage: AnthropicUsage | null;
  state: StreamState;
}

/**
 * Helper function to determine the actual model used and its provider.
 * It considers the model name from SAP's response/chunk, and the original model from the request.
 * It prioritizes the proxy's configured substitution for the original request model.
 * @param sapModelName - Model name from SAP AI Core response/chunk (could be substituted name).
 * @param originalModelFromRequest - The original model name from the client's request (pre-substitution).
 * @returns Object containing { modelForLookup, provider }
 */
async function determineActualModelAndProvider(
  sapModelName?: string, 
  originalModelFromRequest?: string
): Promise<ModelProviderResult> {
  let modelForLookup: string;
  let provider = 'unknown';

  if (!originalModelFromRequest) {
    // If no original model from request, rely on sapModelName or default to unknown
    modelForLookup = sapModelName || 'unknown_model_no_original';
    if (!sapModelName) {
        logger.error('AnthropicResponseService', "Cannot determine model for provider lookup: No originalModelFromRequest, and SAP response/chunk also has no model_name.");
    }
  } else {
    // originalModelFromRequest is present, check for configured substitutions
    const configuredSubstitutedModel = configService.getSubstitutedModel('anthropic', originalModelFromRequest);

    if (configuredSubstitutedModel && configuredSubstitutedModel !== originalModelFromRequest) {
      // A substitution rule was defined and resulted in a different model name
      modelForLookup = configuredSubstitutedModel;
      if (sapModelName && sapModelName !== modelForLookup) {
        logger.warn('AnthropicResponseService', `Using configured substitution '${modelForLookup}' (from original '${originalModelFromRequest}') for provider lookup. SAP response/chunk indicated a different model: '${sapModelName}'.`);
      } else if (!sapModelName) {
        logger.info('AnthropicResponseService', `Using configured substitution '${modelForLookup}' (from original '${originalModelFromRequest}') for provider lookup. SAP response/chunk did not specify model_name.`);
      } else { // sapModelName === modelForLookup
        logger.info('AnthropicResponseService', `Using configured substitution '${modelForLookup}' (from original '${originalModelFromRequest}') for provider lookup. SAP response model_name matches.`);
      }
    } else {
      // No substitution rule changed the originalModelFromRequest, or no rule existed.
      // Use sapModelName if available, otherwise fall back to originalModelFromRequest.
      modelForLookup = sapModelName || originalModelFromRequest;
      if (sapModelName && sapModelName !== originalModelFromRequest) {
         logger.info('AnthropicResponseService', `No specific substitution rule changed '${originalModelFromRequest}'. Using model_name from SAP response/chunk '${sapModelName}' for provider lookup.`);
      } else if (!sapModelName) {
         logger.info('AnthropicResponseService', `No substitution for '${originalModelFromRequest}' and SAP response/chunk did not specify model_name. Using original model '${originalModelFromRequest}' for provider lookup.`);
      } else { // sapModelName === originalModelFromRequest
         logger.info('AnthropicResponseService', `No substitution for '${originalModelFromRequest}'. Using this model for provider lookup (matches SAP response).`);
      }
    }
  }

  // Ensure modelForLookup has a definite value before proceeding
  if (!modelForLookup) {
      modelForLookup = 'unknown_model_fallback'; // Should ideally be caught by earlier logic
      logger.error('AnthropicResponseService', "Critical: modelForLookup is undefined before fetching details. This indicates a logic flaw.");
  }

  try {
    const modelDetails: ModelDetails | null = await modelService.getModelDetails(modelForLookup);
    if (modelDetails && modelDetails.owned_by) {
      provider = modelDetails.owned_by.toLowerCase();
    } else {
      logger.warn('AnthropicResponseService', `Could not determine provider for model '${modelForLookup}' (OriginalReq: '${originalModelFromRequest}', SAPModelInResp: '${sapModelName || 'N/A'}') from modelService. Defaulting to 'unknown'.`);
    }
  } catch (error: any) {
    logger.error('AnthropicResponseService', `Error fetching details for model \'${modelForLookup}\' (derived from SAP: \'${sapModelName}\', OriginalReq: \'${originalModelFromRequest}\'): ${error.message}. Defaulting provider to \'unknown\'.`);
  }
  
  return { modelForLookup, provider };
}

/**
 * Transform SAP AI Core response to Anthropic format
 * @param sapResponse - Response from SAP AI Core
 * @param isStreaming - Whether this is a streaming response
 * @param originalModel - The original model name (before substitution) from the initial request
 * @param originalRequestContentFormatType - 'string' or 'array', indicating original req.messages[0].content type
 * @param latencyMs - Optional: The latency of the SAP AI Core call, for converse format
 * @returns Response in Anthropic API format
 */
export async function transformSAPResponseToAnthropic(
  sapResponse: SAPResponse, 
  isStreaming: boolean, 
  originalModel?: string, 
  originalRequestContentFormatType?: string, 
  latencyMs?: number
): Promise<AnthropicResponse | {}> {
  if (isStreaming) {
    logger.info('AnthropicResponseService', "transformSAPResponseToAnthropic called for a streaming response. Returning {} early.");
    return {};
  }

  logger.info('AnthropicResponseService', `Transforming non-streaming SAP Response. Original request model: ${originalModel}, Original request content format type: ${originalRequestContentFormatType}, Latency: ${latencyMs}ms`);

  const sapModelNameInResponse = sapResponse.final_result?.model;
  const { modelForLookup, provider: modelProvider } = await determineActualModelAndProvider(sapModelNameInResponse, originalModel);
  
  logger.debug('AnthropicResponseService', `Non-streaming (post-determine): OriginalReqModel: ${originalModel}, SAPModelInResp: ${sapModelNameInResponse}, EffectiveModelForLookup: ${modelForLookup}, Provider: ${modelProvider}`);

  const sapUsage = sapResponse.final_result?.usage || {};
  const sapInputTokens = sapUsage.prompt_tokens || 0;
  const sapOutputTokens = sapUsage.completion_tokens || 0;
  const sapTotalTokens = sapUsage.total_tokens || (sapInputTokens + sapOutputTokens);
  
  // Add detailed logging for SAP token extraction
  logger.info('UsageTrackingService', 'SAP response token extraction', {
    hasSapResponse: !!sapResponse,
    hasFinalResult: !!sapResponse.final_result,
    hasUsage: !!sapResponse.final_result?.usage,
    sapUsage: sapUsage,
    extractedTokens: {
      prompt_tokens: sapUsage.prompt_tokens,
      completion_tokens: sapUsage.completion_tokens,
      total_tokens: sapUsage.total_tokens,
      sapInputTokens: sapInputTokens,
      sapOutputTokens: sapOutputTokens,
      sapTotalTokens: sapTotalTokens
    }
  });
  const sapId = sapResponse.final_result?.id || sapResponse.request_id || `msg_${Date.now().toString(36)}`;
  
  let choice: SAPChoice | null = null;
  if (sapResponse.final_result && sapResponse.final_result.choices && sapResponse.final_result.choices.length > 0) {
    choice = sapResponse.final_result.choices[0] || null;
  }

  let responseText = "";
  if (choice && choice.message && typeof choice.message.content === 'string') {
    responseText = choice.message.content;
  } else if (sapResponse.error) {
    responseText = `Error: ${sapResponse.error.message}`;
  }

  let stopReason = "end_turn"; // Default Anthropic stop_reason
  if (choice && choice.finish_reason) {
    const sapFinishReason = choice.finish_reason;
    if (sapFinishReason === "length") {
      stopReason = "max_tokens"; // Map SAP 'length' to Anthropic 'max_tokens'
    } else if (sapFinishReason === "stop_sequences") {
      stopReason = "stop_sequence";
    } else if (sapFinishReason === "tool_calls" || sapFinishReason === "tool_use") {
      stopReason = "tool_use";
    } else if (sapFinishReason === "end_turn" || sapFinishReason === "stop") { // SAP might use 'stop'
        stopReason = "end_turn";
    } else {
        stopReason = sapFinishReason; // Use as is if not specifically mapped
    }
  }

  const content: (AnthropicContentBlock | AnthropicToolUse)[] = [];
  
  if (responseText) {
    content.push({
      type: 'text',
      text: responseText
    });
  }

  // Handle tool calls if present
  if (choice && choice.message && choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      if (toolCall.id && toolCall.function) {
        let toolInput: any = {};
        if (toolCall.function.arguments) {
          try {
            toolInput = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            logger.warn('AnthropicResponseService', `Failed to parse tool arguments: ${toolCall.function.arguments}`);
            toolInput = { raw_arguments: toolCall.function.arguments };
          }
        } else {
          logger.warn('AnthropicResponseService', `Tool call '${toolCall.function.name}' (id: ${toolCall.id}) has no arguments — input will be empty {}`);
        }

        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name || 'unknown_tool',
          input: toolInput
        });
      }
    }
  }

  // Check if we need to return converse format (array content in original request)
  if (originalRequestContentFormatType === 'array') {
    // Construct in "converse" format (array content in request)
    // Desired order: metrics, output, stopReason, usage
    const converseResponse: any = {}; // Initialize empty object to control key order

    if (typeof latencyMs === 'number') {
      converseResponse.metrics = { latencyMs: latencyMs };
    }
    
    converseResponse.output = {
      message: {
        content: content.map(block => {
          if (block.type === 'text') return { text: block.text };
          return block; 
        }),
        role: "assistant",
      },
    };
    
    converseResponse.stopReason = stopReason; // Already mapped (e.g. max_tokens, end_turn, tool_calls, stop_sequence)
    
    converseResponse.usage = {
      cacheReadInputTokenCount: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokenCount: 0,
      cacheWriteInputTokens: 0,
      inputTokens: sapInputTokens,
      outputTokens: sapOutputTokens,
      totalTokens: sapTotalTokens,
    };

    logger.info('AnthropicResponseService', 'Returning converse format:', { responsePreview: converseResponse });
    return converseResponse;
  }

  const anthropicResponse: AnthropicResponse = {
    id: sapId,
    type: 'message',
    role: 'assistant',
    model: modelForLookup || originalModel || 'unknown', // Prioritize actual model from response over original request model
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: sapInputTokens,
      output_tokens: sapOutputTokens
    }
  };

  return anthropicResponse;
}

/**
 * Transform SAP AI Core streaming chunk to Anthropic format
 * @param chunk - Streaming chunk from SAP AI Core
 * @param state - State object for tracking tool call processing across chunks
 * @returns Object containing transformed event data and updated state
 */
export async function transformSAPChunkToAnthropic(
  chunk: SAPChunk, 
  state: StreamState | null = null
): Promise<ChunkTransformResult> {
  if (!state) {
    // Initialize state if null (should be provided by controller)
    state = {
      openTextBlockAnthropicIndex: null,
      nextAnthropicBlockIndex: 0,
      pendingTools: {},
      sapIndexToToolId: {},
    };
    logger.warn('AnthropicResponseService', "State object was null, reinitialized. This may impact stream correctness.");
  }

  if (chunk.intermediate_results && chunk.intermediate_results.templating) {
    return { event: null, finishReason: null, usage: null, state };
  }
  
  if (chunk.error) {
    logger.error('AnthropicResponseService', `Error chunk received from SAP AI Core: ${chunk.error}`);
    return { 
      event: { 
        type: "error", 
        error: { 
          type: chunk.error.code || "api_error", 
          message: chunk.error.message || "An error occurred during streaming." 
        } 
      },
      finishReason: null, 
      usage: null, 
      state
    };
  }

  if (chunk.done === true && (!chunk.final_result || Object.keys(chunk.final_result).length === 0)) {
      return { event: null, finishReason: null, usage: null, state };
  }

  let anthropicEvents: AnthropicStreamEvent[] = [];
  let extractedFinishReason: string | null = null;
  let extractedUsage: AnthropicUsage | null = null;

  if (chunk.final_result) {
    // const sapModelInChunk = chunk.final_result.model;
    
    if (chunk.final_result.choices && chunk.final_result.choices[0]) {
      const choice = chunk.final_result.choices[0];
      const delta = choice.delta;
      extractedFinishReason = choice.finish_reason || null;
      
      if (chunk.final_result.usage) {
        const usage = chunk.final_result.usage;
        extractedUsage = {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          cache_creation_input_tokens: (usage as any).cache_creation_input_tokens || 0,
          cache_read_input_tokens: (usage as any).cache_read_input_tokens || 0
        };
      }

      if (delta) {
        // Handle text content
        if (delta.content && typeof delta.content === 'string') {
          if (state.openTextBlockAnthropicIndex === null) {
            // Start new text block
            anthropicEvents.push({
              type: 'content_block_start',
              content_block: {
                type: 'text',
                text: ''
              }
            });
            state.openTextBlockAnthropicIndex = state.nextAnthropicBlockIndex++;
          }

          // Add text delta
          anthropicEvents.push({
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: delta.content
            }
          });
        }

        // Handle tool calls - simplified implementation
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.id && toolCall.function && toolCall.function.name) {
              // Tool use start
              anthropicEvents.push({
                type: 'content_block_start',
                content_block: {
                  type: 'tool_use',
                  id: toolCall.id,
                  name: toolCall.function.name,
                  input: {}
                }
              });
            }
          }
        }
      }
    }
  }

  return {
    event: anthropicEvents.length > 0 ? anthropicEvents : null,
    finishReason: extractedFinishReason,
    usage: extractedUsage,
    state
  };
}

/**
 * Escape string for Anthropic partial JSON
 * @param str - String to escape
 * @returns Escaped string
 */
// Unused function
function escapeStringForAnthropicPartialJson(str: any): string {
  // Ensure the input is treated as a string, but do not add further JSON escaping.
  if (typeof str !== 'string') {
    return String(str); // Convert non-strings (like numbers, booleans from SAP) to string
  }
  return str; // Return the string fragment as is
}

export default {
  transformSAPResponseToAnthropic,
  transformSAPChunkToAnthropic,
  determineActualModelAndProvider,
  escapeStringForAnthropicPartialJson
};