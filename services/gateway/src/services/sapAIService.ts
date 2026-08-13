import axios, { AxiosResponse } from 'axios';
import { Request, Response } from 'express';
import configService from './configService';
import * as dotenv from 'dotenv';
import modelService from './modelService';
import { pluginExecutor } from './pluginExecutor';
import * as payloadLogger from '../utils/payloadLogger';
import { getDefaultLogger, createSafePreview } from '@libs/logger';
import type {
  SapV2CompletionRequest,
  SapV2CompletionResponse,
} from './sapOrchestrationTypes';
const logger = getDefaultLogger();

// Replace destinationService with centralized configuration
const getDestinationConfig = async () => {
  const sapConfig = configService.getSAPAICoreConfig();
  const accessToken = await configService.getAccessToken();
  
  return {
    url: sapConfig.url,
    authToken: `Bearer ${accessToken}`
  };
};

dotenv.config();

// Type definitions
interface DestinationConfig {
  url: string;
  token: string;
  authToken: string;
}

// V2 wire payload — see sapOrchestrationTypes.ts
type SAPPayload = SapV2CompletionRequest;

interface StreamingResponseMetadata {
  totalProcessedChunks: number;
  startTime: number;
  finishReason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  endTime: number | null;
  durationMs: number | null;
}

interface StreamingResponseData {
  allProcessedChunks: any[];
  fullText: string;
  metadata: StreamingResponseMetadata;
}

interface SSEBuffer {
  completeMessages: string[];
  remainingBuffer: string;
}

type StreamChunk = SapV2CompletionResponse & {
  // Gateway-internal flags layered on top of the V2 response shape:
  done?: boolean;
  error?: boolean;
  message?: string;
  canceled?: boolean;
  chunkNumber?: number;
  nonStreamingResponse?: any;
  useEmulatedStreaming?: boolean;
  clientReq?: CustomRequest;
};

interface CustomError extends Error {
  status?: number;
  details?: any;
  originalError?: Error;
  streamingNotSupported?: boolean;
  modelName?: string;
}

interface CustomRequest extends Request {
  aborted: boolean;
  useEmulatedStreaming?: boolean;
  debugRequestId?: string;
  res?: Response;
}

// const apiUrl = process.env.SAP_AI_API_URL || 'https://api.ai.internalsap.com/v1';
// const apiKey = process.env.SAP_AI_API_KEY;

/**
 * Complete a chat request (non-streaming)
 * @param payload - The request payload for SAP AI Core
 * @returns The response from SAP AI Core
 */
export const completeChat = async (payload: SAPPayload, debugRequestId?: string): Promise<any> => {
  try {
    // Get deployment ID with auto-discovery support
    const deploymentId = await configService.getDeploymentId();
    if (!deploymentId) {
      throw new Error('No SAP AI Core deployment ID available. Please set SAP_AI_DEPLOYMENT_ID or enable SAP_AI_AUTO_DISCOVER_DEPLOYMENT=true');
    }
    
    const destination = await getDestinationConfig() as DestinationConfig;
    const url = `${destination.url}/v2/inference/deployments/${deploymentId}/v2/completion`;
    const headers = {
      'AI-Resource-Group': 'default',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': destination.authToken
    };
    
    logger.info('SAPAIService', `Calling SAP AI Core at URL: ${url}`);
    
    logger.debug('SAPAIService', `[SAP AI Service - Non-Streaming] Sending payload to ${url}:\n` + createSafePreview(payload, 1000));
    
    // Log request payload if debug request ID is provided
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '02_sap_request_payload', payload);
    }
    
    // Strip the gateway-internal debugRequestId before posting the wire payload.
    const { debugRequestId: _drid, ...wirePayload } = payload;
    const response: AxiosResponse = await axios.post(url, wirePayload, { headers });
    
    // Only log the raw response in debug mode to avoid duplicate logging
    if (process.env.DEBUG === 'true') {
      logger.debug('SAPAIService', `SAP AI Core raw response: ${JSON.stringify(response.data, null, 2)}`);
    }
    
    // Log response payload if debug request ID is provided
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '03_sap_response_raw', response.data);
    }
    
    // Check if the response has the expected structure
    if (!response.data) {
      logger.error('SAPAIService', 'Empty response from SAP AI Core');
      throw new Error('Empty response from SAP AI Core');
    }
    
    return response.data;
  } catch (error: any) {
    const errorDetails = error.response ? { status: error.response.status, data: error.response.data } : { message: error.message };
    
    // Log error payload if debug request ID is provided
    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '97_sap_service_error_non_streaming', {
        message: `Error calling SAP AI Core: ${error.message}`,
        details: errorDetails,
        requestPayload: payload // Log the payload that caused the error
      });
    }
    
    logger.error('SAPAIService', `Error calling SAP AI Core: ${error.message}`);
    
    // Create a structured error object that includes the original error details
    const errorResponse = {
      message: error.message,
      status: error.response?.status || 500,
      details: error.response?.data || {}
    };
    
    // Log the detailed error information
    if (error.response) {
      logger.error('SAPAIService', `Response status: ${error.response.status}`);
      logger.error('SAPAIService', `Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    
    // Throw a custom error with the structured error response
    const enhancedError: CustomError = new Error(error.message);
    enhancedError.status = errorResponse.status;
    enhancedError.details = errorResponse.details;
    enhancedError.originalError = error;
    
    throw enhancedError;
  }
};

/**
 * Call SAP AI Core Orchestration API for chat completion (non-streaming)
 * @param payload - The payload for SAP AI Core
 * @param debugRequestId - Optional request ID for debug logging
 * @returns The response data from SAP AI Core
 */
export const callSAPAIOrchestration = async (payload: SAPPayload, debugRequestId?: string): Promise<any> => {
  // Get deployment ID with auto-discovery support
  const deploymentId = await configService.getDeploymentId();
  if (!deploymentId) {
    throw new Error('No SAP AI Core deployment ID available. Please set SAP_AI_DEPLOYMENT_ID or enable SAP_AI_AUTO_DISCOVER_DEPLOYMENT=true');
  }
  
  const destination = await getDestinationConfig() as DestinationConfig;
  const { url, authToken } = destination || { url: '', authToken: '' };
  const apiUrl = `${url}/v2/inference/deployments/${deploymentId}/v2/completion`;

  try {
    const { debugRequestId: _drid, ...wirePayload } = payload;
    const response: AxiosResponse = await axios.post(apiUrl, wirePayload, {
      headers: {
        'Authorization': authToken,
        'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
        'Content-Type': 'application/json'
      }
    });

    if (debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '03_sap_response_raw', response.data);
    }
    return response.data;
  } catch (error: any) {
    const errorDetails = error.response ? { status: error.response.status, data: error.response.data } : { message: error.message };
     if (debugRequestId) {
        payloadLogger.savePayload(debugRequestId, '97_sap_service_error_non_streaming', {
            message: `Error calling SAP AI Core: ${error.message}`,
            details: errorDetails,
            requestPayload: payload // Log the payload that caused the error
        });
    }
    logger.error('SAPAIService', `Error calling SAP AI Core: ${error.message}`);
    if (error.response) {
      logger.error('SAPAIService', `Response status: ${error.response.status}`);
      logger.error('SAPAIService', `Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    // Re-throw a structured error
    const serviceError: CustomError = new Error(`Error calling SAP AI Core: ${error.message}`);
    serviceError.status = error.response?.status || 500;
    serviceError.details = error.response?.data || { message: 'No response data from SAP AI Core' };
    throw serviceError;
  }
};

/**
 * The orchestration endpoint and headers, for callers that must POST it
 * themselves — the hosted-tool engine's continuation, which cannot go through
 * callSAPAIOrchestration because it owns its own axios call and response
 * handling. getDestinationConfig stays private; only this narrow view escapes.
 */
export const getOrchestrationEndpoint = async (): Promise<{ url: string; headers: Record<string, string> }> => {
  const deploymentId = await configService.getDeploymentId();
  if (!deploymentId) throw new Error('No SAP AI Core deployment ID available');
  const destination = await getDestinationConfig() as DestinationConfig;
  return {
    url: `${destination.url}/v2/inference/deployments/${deploymentId}/v2/completion`,
    headers: {
      Authorization: destination.authToken,
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
      'Content-Type': 'application/json',
    },
  };
};

/**
 * Streams chat completions from SAP AI Core
 * @param payload - The payload to send to SAP AI Core
 * @param onChunk - Callback for each chunk of data
 * @param abortSignal - Abort signal for canceling the request
 * @param clientReq - Express request object from client
 * @param hookConfig - Optional hook configuration for plugins
 * @returns Resolves when streaming is complete
 */
export const streamChatCompletion = async (
  payload: SAPPayload, 
  onChunk: (chunk: StreamChunk) => void | Promise<void>, 
  abortSignal?: AbortSignal, 
  clientReq?: CustomRequest, 
  hookConfig?: any
): Promise<void> => {
  // DEBUG: Log if this is emulated streaming request
  logger.trace('SAPAIService', `Stream request with stream=${payload.config?.stream?.enabled}, useEmulatedStreaming=${clientReq?.useEmulatedStreaming}`);
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  let isAborted = false;
  let destination: DestinationConfig | null = null;
  
  const debugEnabled = process.env.DEBUG === 'true';
  const debugRequestId = clientReq?.debugRequestId || (debugEnabled ? requestId : undefined); // Use debugRequestId from clientReq if available
  
  let streamingResponseData: StreamingResponseData | null = debugEnabled ? {
    allProcessedChunks: [], // Array to hold all processed JSON data chunks
    fullText: "",
    metadata: {
      totalProcessedChunks: 0,
      startTime: Date.now(),
      finishReason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      },
      endTime: null,
      durationMs: null
    }
  } : null;

  logger.trace('SAPAIService', `[SAP AI Service - Streaming PRE-CHECK ${requestId}] Stream: ${JSON.stringify(payload?.config?.stream)}`);

  // Ensure chunk_size is set (and at least 64) when streaming is enabled.
  // V2 schema: { config: { stream: { enabled, chunk_size, delimiters? } } }.
  if (payload.config && payload.config.stream && payload.config.stream.enabled === true) {
    const streamOpts = payload.config.stream;
    if (streamOpts.chunk_size === undefined) {
      logger.trace('SAPAIService', `[SAP AI Service - Streaming] Stream config for request ${requestId} is missing chunk_size, adding default (chunk_size: 800).`);
      streamOpts.chunk_size = 800;
    } else if (streamOpts.chunk_size < 64) {
      logger.trace('SAPAIService', `[SAP AI Service - Streaming] Overriding chunk_size to 800 for request ${requestId}. Original: ${streamOpts.chunk_size}`);
      streamOpts.chunk_size = 800;
    } else {
      logger.trace('SAPAIService', `[SAP AI Service - Streaming] Stream config for request ${requestId} already has chunk_size: ${streamOpts.chunk_size}`);
    }
  }

  logger.trace('SAPAIService', `[SAP AI Service - Streaming POST-CHECK ${requestId}] Stream: ${JSON.stringify(payload?.config?.stream)}`);
  
  // Check if client request already aborted before starting
  if (clientReq && clientReq.aborted) {
    logger.info('SAPAIService', `Client request was already aborted before streaming started (ID: ${requestId})`);
    if (onChunk) {
      onChunk({
        canceled: true,
        message: 'Client connection already aborted'
      });
    }
    return;
  }
  
  try {
    // Get deployment ID with auto-discovery support
    const deploymentId = await configService.getDeploymentId();
    if (!deploymentId) {
      throw new Error('No SAP AI Core deployment ID available. Please set SAP_AI_DEPLOYMENT_ID or enable SAP_AI_AUTO_DISCOVER_DEPLOYMENT=true');
    }
    
    destination = await getDestinationConfig() as any;
    const endpoint = `${destination!.url}/v2/inference/deployments/${deploymentId}/v2/completion`;
    // Strip the gateway-internal debugRequestId before posting the wire payload.
    const { debugRequestId: _drid, ...wirePayload } = payload;
    logger.debug('SAPAIService', `Making streaming request (ID: ${requestId}) to: ${endpoint}`);
    
    logger.trace('SAPAIService', `[SAP AI Service - Streaming] Sending payload to ${endpoint}:\n` + createSafePreview(payload, 1000));
    
    // If debugging is enabled, log the streaming request payload
    if (debugRequestId && debugEnabled) {
      payloadLogger.savePayload(debugRequestId, '02_streaming_request_payload', payload);
    }
    
    // Listen for abort events on the passed-in signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        logger.info('SAPAIService', `Abort signal received for request ${requestId} - gracefully stopping processing`);
        isAborted = true;
      });
    }
    
    // Make the streaming request using the passed abort signal directly
    // If this is an emulated streaming request, we need to handle it differently
    const emulatedStreaming = clientReq && clientReq.useEmulatedStreaming;
    
    if (emulatedStreaming) {
      logger.trace('SAPAIService', `[sapAIService] Handling emulated streaming request ${requestId} with useEmulatedStreaming=true`);
      try {
        // Make a non-streaming request when emulating
        const nonStreamingResponse: AxiosResponse = await axios.post(
          endpoint,
          wirePayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': destination!.authToken,
              'Accept': 'application/json', // Request JSON instead of SSE
              'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
              'X-Request-ID': requestId
            },
            responseType: 'json', // Get parsed JSON
            ...(abortSignal && { signal: abortSignal }),
            timeout: configService.getTimeout(false) // Use configurable timeout for non-streaming
          }
        );
        
        logger.debug('SAPAIService', `[sapAIService] Received non-streaming response for emulation, status: ${nonStreamingResponse.status}`);
        if (nonStreamingResponse.data) {
          logger.trace('SAPAIService', `[sapAIService] Response data keys: ${Object.keys(nonStreamingResponse.data).join(', ')}`);
          
          // Check if we have valid response data
          if (nonStreamingResponse.data.final_result || nonStreamingResponse.data.intermediate_results) {
            logger.debug('SAPAIService', `[sapAIService] Valid response data found, sending to emulation handler`);
            
            // Pass the non-streaming response to the callback and return
            if (onChunk) {
              logger.debug('SAPAIService', `[sapAIService] Passing non-streaming response to callback with useEmulatedStreaming flag`);
              const result = onChunk({ 
                nonStreamingResponse: nonStreamingResponse.data, 
                useEmulatedStreaming: true,
                clientReq: clientReq  // Pass the client request object for context
              });
              
              // Return whatever the callback returned (if anything)
              return result as any;
            }
            return;
          } else {
            logger.error('SAPAIService', `[sapAIService] Invalid response data structure, missing final_result or intermediate_results`);
          }
        } else {
          logger.error('SAPAIService', `[sapAIService] Empty response data received`);
        }
        
        // If we reach here, something is wrong with the response
        logger.error('SAPAIService', `[sapAIService] Non-streaming response received but not in expected format`);
        throw new Error('Invalid response format from SAP AI Core');
      } catch (error: any) {
        logger.error('SAPAIService', `[sapAIService] Error in emulated streaming request: ${error.message}`);
        throw error; // Let the outer catch block handle this
      }
    }
    
    // Regular streaming request handling
    const response: AxiosResponse = await axios.post(
      endpoint,
      wirePayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': destination!.authToken,
          'Accept': 'text/event-stream',
          'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default',
          'X-Request-ID': requestId
        },
        responseType: 'stream',
        ...(abortSignal && { signal: abortSignal }),
        timeout: configService.getTimeout(true) // Use configurable timeout for streaming
      }
    );
    
    logger.debug('SAPAIService', `SAP AI Core streaming response status for request ${requestId}: ${response.status}`);
    logger.trace('SAPAIService', `SAP AI Core streaming response headers for request ${requestId}: ${response.headers}`);
    
    // Process the streaming response
    const stream = response.data;
    
    // Set up error handler
    stream.on('error', (error: Error) => {
      // Don't log full error details for aborted requests, as they're expected
      if (isAborted || (abortSignal && abortSignal.aborted) || axios.isCancel(error)) {
        logger.debug('SAPAIService', `Stream ended due to client disconnect for request ${requestId}`);
      } else {
        logger.error('SAPAIService', `Stream error for request ${requestId}: ${(error as any).message}`);
      }
      
      // Only send error to client if not due to their own abort action
      if (onChunk && !(isAborted || (abortSignal && abortSignal.aborted) || axios.isCancel(error))) {
        onChunk({
          error: true,
          message: `Stream error: ${(error as any).message}`
        });
      }
    });
    
    // Handle cleanup on stream end and close
    stream.on('end', () => {
      logger.debug('SAPAIService', `Stream ended for request ${requestId}`);
    });
    
    stream.on('close', () => {
      logger.debug('SAPAIService', `Stream closed for request ${requestId}`);
    });
    
    // Process each chunk of data with explicit abort checking
    let chunkCount = 0; // This will now be the count of successfully parsed JSON data events
    let buffer = '';
    
    for await (const rawChunk of stream) { // Renamed 'chunk' to 'rawChunk' for clarity
      if (clientReq && clientReq.aborted) {
        logger.debug('SAPAIService', `Client connection is closed. Aborting stream processing for request ${requestId}`);
        if (onChunk) {
          onChunk({
            canceled: true,
            message: 'Client connection aborted'
          });
        }
        break;
      }
      
      // Check if request has been aborted via the abort signal
      if (isAborted || (abortSignal && abortSignal.aborted)) {
        logger.debug('SAPAIService', `Aborting stream processing for request ${requestId} - abort signal triggered`);
        if (onChunk) {
          onChunk({
            canceled: true,
            message: 'Request aborted by client'
          });
        }
        break;
      }
      
      try {
        // Execute stream plugins on the raw chunk first
        let processedRawChunk = rawChunk;
        if (hookConfig && clientReq && clientReq.res) {
          try {
            logger.trace('SAPAIService', `Executing stream plugins for request ${requestId}`);
            processedRawChunk = await pluginExecutor.executeStreamPlugins(clientReq as any, clientReq.res, rawChunk, hookConfig);
          } catch (pluginError: any) {
            logger.error('SAPAIService', `Error executing stream plugins for request ${requestId}: ${pluginError.message}`);
            // Continue with original chunk if plugin execution fails
            processedRawChunk = rawChunk;
          }
        }
        
        const rawDataString = processedRawChunk.toString('utf8');
        if (!rawDataString.trim()) continue;
        buffer += rawDataString;
        const { completeMessages, remainingBuffer } = processSSEBuffer(buffer);
        buffer = remainingBuffer;

        for (const message of completeMessages) {
          if (clientReq && clientReq.aborted) {
            logger.debug('SAPAIService', `Aborting message processing for request ${requestId} - client disconnected`);
            break;
          }
          if (message.startsWith('data:')) {
            const jsonDataString = message.replace(/^data: /, '').trim();
            if (jsonDataString === '[DONE]') {
              logger.debug('SAPAIService', `Streaming completed with [DONE] marker for request ${requestId}`);
              if (onChunk) {
                onChunk({ done: true });
              }
              if (debugEnabled && streamingResponseData) {
                // Log the [DONE] marker as a special chunk if needed
                // streamingResponseData.allProcessedChunks.push({ type: "DONE_MARKER" });
              }
              continue;
            }
            try {
              const parsedData = JSON.parse(jsonDataString);
              chunkCount++; // Increment for successfully parsed JSON data
              // logger.debug('SAPAIService', `Received and parsed chunk #${chunkCount} from SAP AI Core for request ${requestId}`);
              // logger.debug('SAPAIService', `Chunk data: ${JSON.stringify(parsedData, null, 2)}`);    
              
              if (debugEnabled && streamingResponseData) {
                streamingResponseData.metadata.totalProcessedChunks = chunkCount;
                streamingResponseData.allProcessedChunks.push(parsedData); // Store the actual parsed JSON object

                if (parsedData.final_result?.choices?.[0]?.delta?.content) {
                  streamingResponseData.fullText += parsedData.final_result.choices[0].delta.content;
                }

                if (parsedData.final_result?.usage) {
                  if (parsedData.final_result.usage.prompt_tokens) {
                    streamingResponseData.metadata.usage.input_tokens = parsedData.final_result.usage.prompt_tokens;
                  }
                  if (parsedData.final_result.usage.completion_tokens) {
                    // Assuming completion_tokens from SAP are cumulative for the stream summary
                    streamingResponseData.metadata.usage.output_tokens = parsedData.final_result.usage.completion_tokens;
                  }
                }

                if (parsedData.final_result?.choices?.[0]?.finish_reason) {
                  streamingResponseData.metadata.finishReason = parsedData.final_result.choices[0].finish_reason;
                }
              }
              
              // Pass the parsed data to the onChunk callback
              if (onChunk) {
                // Add chunkNumber for easier tracking in controller if needed
                // Handle plugin processing for 'after' strategy if applicable
                if (hookConfig) {
                  try {
                    // Execute 'after' strategy plugins on each chunk
                    // This is specifically for streaming case
                    const finalChunk = await pluginExecutor.executeAfterPlugins(clientReq!, clientReq!.res!, parsedData, hookConfig);
                    onChunk({ ...finalChunk, chunkNumber: chunkCount });
                  } catch (pluginError: any) {
                    logger.error('SAPAIService', `[sapAIService] Error executing plugin for chunk ${chunkCount}: ${pluginError.message}`);
                    onChunk({ ...parsedData, chunkNumber: chunkCount });
                  }
                } else {
                  // No plugins to process, pass data as-is
                  onChunk({ ...parsedData, chunkNumber: chunkCount }); 
                }
              }

            } catch (jsonError: any) {
              logger.error('SAPAIService', `Error parsing JSON for request ${requestId}: ${jsonError.message}`);
              logger.error('SAPAIService', `Problematic JSON data string: ${jsonDataString.substring(0, 200)}...`);
              if (debugEnabled && streamingResponseData) {
                // Log the problematic string if parsing fails
                streamingResponseData.allProcessedChunks.push({ error: "JSON_PARSE_ERROR", raw: jsonDataString });
              }
              // Decide if to notify client via onChunk about parsing error
            }
          }
        }
      } catch (chunkProcessingError: any) {
        logger.error('SAPAIService', `Error processing raw chunk for request ${requestId}: ${chunkProcessingError.message}`);
        if (onChunk) {
          onChunk({ error: true, message: `Error processing raw chunk: ${chunkProcessingError.message}` });
        }
      }
    }
    
    logger.debug('SAPAIService', `Streaming processing loop completed after ${chunkCount} parsed data chunks for request ${requestId}`);
    
    if (debugEnabled && debugRequestId && streamingResponseData) {
      streamingResponseData.metadata.endTime = Date.now();
      streamingResponseData.metadata.durationMs = streamingResponseData.metadata.endTime - streamingResponseData.metadata.startTime;
      
      payloadLogger.savePayload(debugRequestId, '03_sap_response_streaming', {
        metadata: streamingResponseData.metadata,
        fullText: streamingResponseData.fullText,
        allProcessedChunks: streamingResponseData.allProcessedChunks // Log all processed chunks
      });
    }
    
  } catch (error: any) {
    // AT THE VERY TOP of the catch block, collect the raw body:
    let rawBody = '';
    if (error.response && error.response.data) {
      if (error.response.data.pipe) {
        // This part tries to read the error stream.
        // It's important this doesn't interfere if the main stream was already read.
      } else {
        rawBody = typeof error.response.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response.data);
      }
    }

    let errorDetails: any = {
      status: error.response?.status,
      statusText: error.response?.statusText,
      message: error.message,
      code: error.code,
      body: null // Initialize body
    };
    
    if (error.response && error.response.data) {
      if (error.response.data.pipe) { // If error response is a stream
        try {
          const errorChunks: Buffer[] = [];
          for await (const errChunk of error.response.data) {
            if (isAborted || (abortSignal && abortSignal.aborted)) break; // Respect abort signal
            errorChunks.push(errChunk);
          }
          if (!(isAborted || (abortSignal && abortSignal.aborted))) { // Only process if not aborted
            const errorResponseBody = Buffer.concat(errorChunks).toString('utf8');
            errorDetails.body = errorResponseBody; // Store the read error body
            rawBody = errorResponseBody; // Update rawBody with the content from the error stream
            // logger.error('SAPAIService', `SAP AI Core error response body for request ${requestId}: ${errorResponseBody}`);
          }
        } catch (streamError: any) {
          // logger.error('SAPAIService', `Error reading error response stream for request ${requestId}: ${streamError.message}`);
        }
      } else { // If error response is not a stream
        errorDetails.body = error.response.data;
        
        // Check if this is actually a successful non-streaming response, not an error
        if (error.response.status === 200 && error.response.data &&
            (error.response.data.final_result || error.response.data.intermediate_results)) {
          logger.info('SAPAIService', `[SAP AI Service - Streaming] Received a successful non-streaming response for request ${requestId}`);
          
          // If client requested emulated streaming, handle this as a successful non-streaming response
          if (clientReq?.useEmulatedStreaming) {
            logger.info('SAPAIService', `[SAP AI Service - Streaming] Client requested emulated streaming, passing response to onChunk`);
            if (onChunk) {
              onChunk({ nonStreamingResponse: error.response.data, useEmulatedStreaming: true });
            }
            return; // Not a real error, just process as non-streaming data
          }
        }
        
        // rawBody is already set from above if error.response.data was not a stream
        // logger.error('SAPAIService', `SAP AI Core error response for request ${requestId}: ${error.response.data}`);
      }
    }
    
    // logger.debug('SAPAIService', `Raw error body for detection (after potential stream read): ${rawBody}`);

    if (rawBody && (
        rawBody.includes('Streaming is not supported for this model') || 
        rawBody.includes('streaming is not supported for this model') ||
        rawBody.includes('streaming not supported') ||
        rawBody.includes('Request Body: Streaming is not supported') ||
        rawBody.includes('does not support streaming') ||
        rawBody.includes('streaming is not') ||
        (rawBody.includes('streaming') && rawBody.includes('not supported'))
      )) {
      const modelName = payload.config?.modules?.prompt_templating?.model?.name || "unknown model";
      logger.warn('SAPAIService', `⚠️ Detected streaming not supported error for model ${modelName} from error body.`);
      modelService.markModelAsNonStreaming(modelName);
      const errStreamingNotSupported: CustomError = new Error('Streaming not supported for this model');
      errStreamingNotSupported.streamingNotSupported = true;
      errStreamingNotSupported.modelName = modelName;
      throw errStreamingNotSupported; // Throw this specific error
    }
    
    // Check if this was a successful non-streaming response with HTTP 200 status
    if (error.response?.status === 200 && error.response?.data &&
        (error.response.data.final_result || error.response.data.intermediate_results)) {
      logger.info('SAPAIService', `[SAP AI Service] Received successful non-streaming response (HTTP 200) but in error handler for ${requestId}`);
      
      // If client requested emulated streaming, don't treat this as an error
      if (clientReq?.useEmulatedStreaming) {
        logger.info('SAPAIService', `[SAP AI Service] Client requested emulated streaming, treating success as non-error`);
        if (onChunk) {
          onChunk({ nonStreamingResponse: error.response.data, useEmulatedStreaming: true });
        }
        return; // Exit the catch block without throwing
      }
    }

    if (debugEnabled && debugRequestId) {
      payloadLogger.savePayload(debugRequestId, '96_sap_streaming_service_error', { // Changed log key slightly for specificity
        message: error.message,
        status: error.response?.status,
        details: errorDetails, // This now includes the body if read
        stack: error.stack,
        requestPayload: payload, // Log the payload that caused the error
        timestamp: new Date().toISOString()
      });
    }
    // Re-throw the original error or a more structured one if preferred
    const serviceError: CustomError = new Error(`SAP AI Core streaming failed: ${error.message}`);
    serviceError.status = error.response?.status || 500;
    serviceError.details = errorDetails; // errorDetails now contains the body
    serviceError.originalError = error;
    throw serviceError;
  } finally {
    if (!isAborted && !(abortSignal && abortSignal.aborted)) {
      logger.debug('SAPAIService', `Stream completed normally, ensuring clean shutdown for request ${requestId}`);
    }
  }
};

function processSSEBuffer(buffer: string): SSEBuffer {
  const lines = buffer.split('\n');
  const completeMessages: string[] = [];
  let currentMessage = ''; // Stores the current 'data: ...' line being processed

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() || '';

    if (line.startsWith('data:')) {
      // If there was a previous 'data:' line being processed and this is a new one,
      // then the previous one is considered complete (even if it was partial JSON that failed to parse later).
      // This logic is more about segmenting SSE messages than validating JSON within them here.
      if (currentMessage) {
        completeMessages.push(currentMessage);
      }
      currentMessage = lines[i] || ''; // Store the full line "data: ..."
      
      // If this is the last line in the buffer, it might be incomplete, so don't add it yet.
      // It will become the start of the remainingBuffer.
      if (i === lines.length - 1) {
        // Do nothing here, currentMessage will be part of remainingBuffer
      } else {
        // This 'data:' line is followed by more lines, so consider it complete for now.
        completeMessages.push(currentMessage);
        currentMessage = ''; 
      }
    } else if (line === '') { // Empty line often separates SSE messages
      if (currentMessage) { // If we were processing a 'data:' line, it's now complete.
        completeMessages.push(currentMessage);
        currentMessage = '';
      }
    } else {
      // Non-empty, non-data line. Could be a comment (starts with ':') or unexpected.
      // If we were in a 'data:' message, and this isn't an empty line,
      // it might mean the 'data:' message was malformed or this is a multi-line data field
      // which is not standard for simple JSON SSE.
      // For now, if we have a currentMessage, we assume it ended before this unexpected line.
      if (currentMessage) {
        completeMessages.push(currentMessage);
        currentMessage = '';
      }
      // logger.warn('SAPAIService', `[SSE Parser] Encountered non-data, non-empty line: "${line}"`);
    }
  }

  // The 'currentMessage' at the end is what's left over, potentially an incomplete 'data:' line.
  return { 
    completeMessages, 
    remainingBuffer: currentMessage 
  };
}

/**
 * Create embedding using SAP AI Core v2 inference API
 */
const createEmbedding = async (sapRequest: any, modelId: string): Promise<any> => {
  const startTime = Date.now();
  
  try {
    const config = await getDestinationConfig();
    
    // Get deployment ID using the same pattern as chat completions
    const deploymentId = await configService.getDeploymentId();
    if (!deploymentId) {
      throw new Error('No SAP AI Core deployment ID available. Please set SAP_AI_DEPLOYMENT_ID or enable SAP_AI_AUTO_DISCOVER_DEPLOYMENT=true');
    }
    
    const url = `${config.url}/v2/inference/deployments/${deploymentId}/v2/embeddings`;
    
    const headers = {
      'Authorization': config.authToken,
      'Content-Type': 'application/json',
      'AI-Resource-Group': process.env.SAP_AI_RESOURCE_GROUP || 'default'
    };

    logger.debug('SAPAIService', `Creating embedding for model ${modelId} via deployment ${deploymentId}`);
    
    const response: AxiosResponse = await axios.post(url, sapRequest, { 
      headers,
      timeout: 60000 // 60 second timeout for embeddings
    });

    const endTime = Date.now();
    logger.info('SAPAIService', `Embedding created successfully in ${endTime - startTime}ms for model ${modelId}`);
    
    return response.data;
    
  } catch (error: any) {
    const endTime = Date.now();
    logger.error('SAPAIService', `Embedding creation failed after ${endTime - startTime}ms: ${error.message}`);
    
    if (error.response) {
      logger.error('SAPAIService', `SAP AI Core error response: ${JSON.stringify(error.response.data)}`);
      throw new Error(`SAP AI Core embedding error: ${error.response.data?.error?.message || error.response.statusText}`);
    }
    
    throw error;
  }
};

export const sapAIService = {
  completeChat,
  callSAPAIOrchestration,
  getOrchestrationEndpoint,
  streamChatCompletion,
  createEmbedding
};

export default sapAIService;