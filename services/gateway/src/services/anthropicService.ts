/**
 * This service handles the transformation of Anthropic API requests to SAP AI Core format and vice versa.
 */
import { Request, Response } from 'express';
import { sapAIService } from './sapAIService';
import { getModelDetails } from './modelService';
import { getConfig, getSubstitutedModel, getHookConfig } from './configService';
import { pluginExecutor } from './pluginExecutor';
import { processAnthropicMessages } from './anthropicMessageService';
import { transformToolsToSAPFormat, transformToolChoiceToSAPFormat } from './anthropicToolsService';
import { extractSystemPromptText } from './anthropicUtils';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { transformSAPChunkToAnthropic, transformSAPResponseToAnthropic } from './anthropicResponseService';
import type { SapV2CompletionRequest } from './sapOrchestrationTypes';

// Type definitions for Anthropic API structures
interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
  [key: string]: any;
}

interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | any[];
  max_tokens?: number;
  temperature?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: any[];
  tool_choice?: any;
  stream?: boolean;
  [key: string]: any;
}

// V2 wire payload — see sapOrchestrationTypes.ts
type SAPPayload = SapV2CompletionRequest;

interface ModelDetails {
  owned_by?: string;
  [key: string]: any;
}

interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: any[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

/**
 * Transforms Anthropic API request format to SAP AI Core format
 * @param anthropicReq - Request in Anthropic API format
 * @param debugRequestId - Optional request ID for debug logging
 * @returns Request in SAP AI Core format
 */
export const transformRequestToSAPFormat = async (
  anthropicReq: AnthropicRequest, 
  debugRequestId?: string
): Promise<SAPPayload> => {
  const config = await import('./configService').then(m => m.getConfigAsync());
  const originalModelName = anthropicReq.model || (config as any).api_config?.default_models?.anthropic || "claude-3-5-haiku-20241022";
  const substitutedModelName = getSubstitutedModel('anthropic', originalModelName);

  // Determine originalProvider
  let originalProvider = 'unknown';
  try {
    const originalModelDetails: ModelDetails | null = await getModelDetails(originalModelName);
    if (originalModelDetails && originalModelDetails.owned_by) {
      originalProvider = originalModelDetails.owned_by.toLowerCase();
    } else if (originalModelName.startsWith('claude-')) { // Heuristic
      originalProvider = 'anthropic';
    }
    logger.info('AnthropicService', `Determined originalProvider: ${originalProvider} for model: ${originalModelName}`);
  } catch (e: any) {
    logger.warn('AnthropicService', `Error getting details for originalModel ${originalModelName}, provider defaults to 'unknown'. Error: ${e.message}`);
  }

  // Determine substitutedProvider
  let substitutedProvider = 'unknown';
  try {
    const substitutedModelDetails: ModelDetails | null = await getModelDetails(substitutedModelName);
    if (substitutedModelDetails && substitutedModelDetails.owned_by) {
      substitutedProvider = substitutedModelDetails.owned_by.toLowerCase();
    } else if (substitutedModelName.startsWith('gpt-')) { // Heuristic
        substitutedProvider = 'openai';
    } else if (substitutedModelName.startsWith('anthropic.')) { // SAP AI Core specific prefix
        substitutedProvider = 'anthropic';
    } else if (substitutedModelName.startsWith('azure-openai.')) { // SAP AI Core specific prefix
        substitutedProvider = 'openai';
    }
    logger.info('AnthropicService', `Determined substitutedProvider: ${substitutedProvider} for model: ${substitutedModelName}`);
  } catch (e: any) {
    logger.warn('AnthropicService', `Error getting details for substitutedModel ${substitutedModelName}, provider defaults to 'unknown'. Error: ${e.message}`);
  }

  // Prepare parameters
  let maxTokens: number | undefined;
  if (anthropicReq.max_tokens !== undefined) {
    maxTokens = anthropicReq.max_tokens;
  }
  // Adjust maxTokens if originalProvider === 'anthropic' && substitutedProvider === 'openai'
  if (originalProvider === 'anthropic' && substitutedProvider === 'openai') {
    if (maxTokens && maxTokens > 4000 && substitutedModelName.includes('gpt-3')) {
      logger.warn('AnthropicService', `High max_tokens (${maxTokens}) requested for Anthropic model, but substituting to an OpenAI model (${substitutedModelName}). SAP AI Core will handle actual limits, but be aware of potential truncation if it exceeds the target model's capacity.`);
    }
  }

  const sapMessages: any[] = [];
  const systemPromptText = extractSystemPromptText(anthropicReq.system);
  if (systemPromptText) {
    sapMessages.push({ role: 'system', content: systemPromptText });
  }

  const processedUserAssistantMessages = processAnthropicMessages(anthropicReq.messages);
  sapMessages.push(...processedUserAssistantMessages);

  // Remove has_tools property from messages before sending to SAP AI Core
  const messagesForSAPTemplate = sapMessages.map(message => {
    const { has_tools, ...rest } = message; // Destructure to remove has_tools
    return rest;
  });

  if (debugRequestId) {
    payloadLogger.savePayload(debugRequestId, '02a_messages_for_sap_template', messagesForSAPTemplate);
  }

  const modelParams: Record<string, any> = {}; // Initialize an empty object

  if (anthropicReq.temperature !== undefined) {
    modelParams.temperature = anthropicReq.temperature;
  }
  
  // Only add max_tokens if it was defined in the request AND the substituted model is NOT from OpenAI
  if (maxTokens !== undefined) {
    if (substitutedProvider.toLowerCase() !== 'openai') {
      logger.info('AnthropicService', `Including max_tokens=${maxTokens} from request for non-OpenAI provider: ${substitutedProvider}`);
      modelParams.max_tokens = maxTokens;
    } else {
      logger.info('AnthropicService', `Omitting max_tokens parameter (from request) for OpenAI provider (model: ${substitutedModelName})`);
    }
  }
  
  // Only add these parameters if the destination model is NOT an Anthropic model AND they are in the request
  if (substitutedProvider !== 'anthropic') {
    if (anthropicReq.frequency_penalty !== undefined) {
      modelParams.frequency_penalty = anthropicReq.frequency_penalty;
    }
    if (anthropicReq.presence_penalty !== undefined) {
      modelParams.presence_penalty = anthropicReq.presence_penalty;
    }
  }
  
  if (anthropicReq.top_p !== undefined) modelParams.top_p = anthropicReq.top_p;
  if (anthropicReq.top_k !== undefined) modelParams.top_k = anthropicReq.top_k;
  if (anthropicReq.stop_sequences && anthropicReq.stop_sequences.length > 0) {
    modelParams.stop = anthropicReq.stop_sequences;
  }

  // V2 prompt envelope — `tools` and `response_format` live on the prompt;
  // `tool_choice` is OpenAI-style and lives in model.params (which V2 schema
  // declares as Record<string, any>).
  const promptTemplate: any = {
    template: messagesForSAPTemplate, // Use the cleaned messages without has_tools
  };

  const tools = transformToolsToSAPFormat(anthropicReq.tools);
  if (tools) {
    promptTemplate.tools = tools;
    const toolChoice = transformToolChoiceToSAPFormat(anthropicReq.tool_choice);
    if (toolChoice) {
      modelParams.tool_choice = toolChoice;
    }
  }

  // Construct the final V2 payload
  const payload: SAPPayload = {
    config: {
      modules: {
        prompt_templating: {
          prompt: promptTemplate,
          model: {
            name: substitutedModelName,
            version: 'latest',
            params: modelParams,
          },
        },
      },
    },
    placeholder_values: {},
    messages_history: [],
  };

  if (anthropicReq.stream === true) {
    payload.config.stream = { enabled: true };
  }

  return payload;
};

/**
 * Handles the full lifecycle of an Anthropic request:
 * 1. Transforms the Anthropic request to SAP AI Core format.
 * 2. Sends the request to SAP AI Core.
 * 3. Transforms the SAP AI Core response back to Anthropic format.
 * @param anthropicReq - The original request in Anthropic API format.
 * @param res - Express response object for streaming.
 * @param isStreaming - Indicates if the request is for streaming.
 * @param debugRequestId - Optional request ID for debug logging
 * @param abortSignal - Optional abort signal for request cancellation
 * @param clientReq - Original client request object
 * @returns The response in Anthropic API format if not streaming, or undefined if streaming.
 */
export const handleAnthropicRequest = async (
  anthropicReq: AnthropicRequest, 
  res: Response, 
  isStreaming: boolean, 
  debugRequestId?: string, 
  abortSignal?: AbortSignal, 
  clientReq?: Request
): Promise<any | undefined> => {
  try {
    // Pass debugRequestId to transformRequestToSAPFormat if it needs to do sub-logging,
    // but for the 02_transformed_sap_request log, we do it after this call.
    const sapPayload = await transformRequestToSAPFormat(anthropicReq, debugRequestId); // Pass if needed by transformRequestToSAPFormat internally
    const originalModelName = anthropicReq.model || "claude-3-5-haiku-20241022";

    if (debugRequestId && sapPayload) { // Ensure sapPayload exists
      sapPayload.debugRequestId = debugRequestId; // Add debugRequestId to payload for sapAIService
    }

    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '02_transformed_sap_request', sapPayload);
    }

    if (isStreaming) {
      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders(); // Flush the headers to establish the connection

      // Initial message_start event
      const messageStartEvent: MessageStartEvent = {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`, // Generate a unique ID
          type: "message",
          role: "assistant",
          model: sapPayload.config.modules.prompt_templating.model.name,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 } // Placeholder, will be updated
        }
      };
      res.write(`data: ${JSON.stringify(messageStartEvent)}\n\n`);

      let accumulatedText = "";
      // let toolCalls: any[] = [];
      let finalUsage = { input_tokens: 0, output_tokens: 0 };
      // let finalStopReason: string | null = null;
      // let contentBlockIndex = 0; // To manage multiple content blocks (text, tools)

      // Pass debugRequestId to callSAPAIOrchestrationStream
      // Note: Logging raw SAP stream response per chunk is too verbose.
      // Logging mapped client stream response per chunk is also too verbose for single files.
      // We will rely on emulated streaming path for full SAP response logging.
      // Assuming callSAPAIOrchestrationStream is effectively streamChatCompletion
      
      // Determine subPath for hook config based on streaming flag
      const subPath = anthropicReq.stream === true ? 'invoke-with-response-stream' : 'invoke';
      
      // Get hook configuration for this model+subpath
      const hookConfig = getHookConfig(originalModelName, subPath);
      
      await sapAIService.streamChatCompletion(sapPayload, async (chunk: any) => { // Changed to streamChatCompletion and pass correct params
        try {
            // Pass originalModelName, not the full anthropicReq. And await the async transform.
            const anthropicChunk = await transformSAPChunkToAnthropic(chunk); // Added await
            if (anthropicChunk) {
                logger.debug('AnthropicService', `Anthropic chunk for request ${debugRequestId || 'N/A'}: ${JSON.stringify(anthropicChunk).substring(0,100)}...`);
                res.write(`data: ${JSON.stringify(anthropicChunk)}\n\n`);

                // Accumulate data for the final message_stop event
                // Handle case where anthropicChunk is a ChunkTransformResult with event property
                if (anthropicChunk.event) {
                    const events = Array.isArray(anthropicChunk.event) ? anthropicChunk.event : [anthropicChunk.event];
                    for (const event of events) {
                        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                            accumulatedText += event.delta.text;
                        }
                        if (event.type === 'message_delta' && event.usage) {
                            finalUsage.output_tokens = event.usage.output_tokens;
                        }
                        if (event.type === 'message_start' && event.message?.usage) {
                            finalUsage.input_tokens = event.message.usage.input_tokens;
                        }
                    }
                }
                // Handle case where anthropicChunk is directly an Anthropic event (backward compatibility)
                else if ((anthropicChunk as any).type === 'content_block_delta' && (anthropicChunk as any).delta?.type === 'text_delta') {
                    accumulatedText += (anthropicChunk as any).delta.text;
                }
                else if ((anthropicChunk as any).type === 'message_delta' && (anthropicChunk as any).usage) {
                    finalUsage.output_tokens = (anthropicChunk as any).usage.output_tokens;
                }
                else if ((anthropicChunk as any).type === 'message_start' && (anthropicChunk as any).message && (anthropicChunk as any).message.usage) {
                    finalUsage.input_tokens = (anthropicChunk as any).message.usage.input_tokens; // Capture input tokens from message_start
                }
                // TODO: Accumulate tool call information if SAP AI Core streams them in a way that needs reassembly
                // For now, assume transformSAPChunkToAnthropic handles tool parts correctly for Anthropic's protocol.
            }
        } catch (transformError: any) {
            logger.error('AnthropicService', `Error transforming SAP chunk for ${debugRequestId || 'N/A'}: ${transformError.message}`);
            const errorEvent = { type: "error", error: { type: "internal_server_error", message: "Error transforming stream data." } };
            res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        }
      }, abortSignal, clientReq as any, hookConfig); // Pass abortSignal, clientReq, and hookConfig

      // After the stream ends, send the message_stop event
      // Get final stop reason and usage from the last relevant chunk or overall state
      // This part needs to be robust based on how `transformSAPChunkToAnthropic` signals the end.
      // For now, we assume the last chunk from SAP AI might contain finish_reason and final usage.
      // This is a simplified placeholder; a more robust solution would track state.
      
      // The `transformSAPChunkToAnthropic` should ideally return a `message_stop` type event as the last meaningful event.
      // If it does, we might not need to construct another one here, or we ensure this one is the *very* last.
      // Let's assume `transformSAPChunkToAnthropic` sends all necessary events including `message_stop`.
      // If not, we would construct and send it here.
      // For example, if the last chunk from SAP was just a "done" marker, we'd need this:
      // const finalStopReason = "end_turn"; // Or determine from last chunk
      // const messageStopEvent = {
      //   type: "message_stop",
      //   "amazon-bedrock-invocationMetrics": { // Example, adjust as needed
      //     "inputTokenCount": finalUsage.input_tokens,
      //     "outputTokenCount": finalUsage.output_tokens,
      //     "invocationLatency": 0, 
      //     "firstByteLatency": 0 
      //   }
      // };
      // res.write(`data: ${JSON.stringify(messageStopEvent)}\\n\\n`);
      
      // Consider moving res.end() to after all events (e.g., message_stop) are confirmed sent
      if (!res.writableEnded) {
        res.end();
      }
    } else {
      // Non-streaming request
      // Pass debugRequestId to callSAPAIOrchestration
      const sapResponse = await sapAIService.callSAPAIOrchestration(sapPayload, debugRequestId);
      // sapAIService.callSAPAIOrchestration will log '03_sap_response_raw'

      const anthropicResponse = await transformSAPResponseToAnthropic(sapResponse, false, originalModelName); // Added await
      
      if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '04_transformed_client_response', anthropicResponse);
      }
      
      // Determine subPath for hook config (non-streaming case)
      const subPath = 'invoke';
      
      // Get hook configuration for this model+subpath
      const hookConfig = getHookConfig(originalModelName, subPath);
      
      // Execute any 'after' strategy plugins
      let finalResponse = anthropicResponse;
      if (hookConfig) {
        logger.info('AnthropicService', `Executing after plugins for model ${originalModelName}, subpath ${subPath}`);
        finalResponse = await pluginExecutor.executeAfterPlugins(clientReq as any, res, anthropicResponse, hookConfig);
        
        if (debugRequestId && finalResponse !== anthropicResponse) {
          payloadLogger.savePayload(debugRequestId, '05_after_plugin_modified_response', finalResponse);
        }
      }
      
      return finalResponse;
    }
  } catch (error: any) {
    logger.error('AnthropicService', `Error in request handling for ${debugRequestId || 'N/A'}: ${error}`);
    if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '98_anthropic_service_error', { 
            message: error.message, 
            stack: error.stack,
            status: error.status,
            details: error.details 
        });
    }
    // ... existing error re-throwing/handling ...
    if (isStreaming && res && !res.headersSent) {
      res.status(500).json({ error: 'Failed to process Anthropic request due to an internal error.' });
    } else if (isStreaming && res && res.writableEnded === false) {
      const errorEvent = { type: "error", error: { type: "api_error", message: error.message || "An internal error occurred." } };
      try {
        if (res.writable && !res.writableEnded) { // Check if stream is still writable
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          res.end();
        }
      } catch (sseError: any) {
        logger.error('AnthropicService', `Failed to send SSE error event: ${sseError}`);
        if (res.writable && !res.writableEnded) res.end();
      }
    } else if (!isStreaming) {
      throw error; 
    }
  }
};

export default {
  transformRequestToSAPFormat,
  handleAnthropicRequest
};