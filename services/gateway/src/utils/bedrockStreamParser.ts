import { createParser, EventSourceMessage } from 'eventsource-parser';
import * as sseWriter from './sseWriter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { Response } from 'express';

// Output format type: 'anthropic' for clean Anthropic API format, 'bedrock' for native Bedrock format
export type OutputFormat = 'anthropic' | 'bedrock';

interface StreamState {
  messageId: string | null;
  emittedTextContentStartIndices: Set<number>;
  emittedToolUseContentStartIndices: Set<number>;
  finalInputTokens: number;
  finalOutputTokens: number;
  finalCacheCreationTokens: number;
  finalCacheReadTokens: number;
  finalLatencyMs: number;
  finalFirstByteLatency: number | null;
  toolFragmentBuffers: Map<number, string[]>;
  processedFragmentCount: number;
}

interface BedrockEvent {
  messageStart?: {
    role?: string;
  };
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: {
      toolUse?: {
        toolUseId?: string;
        name?: string;
      };
      text?: any;
    };
  };
  contentBlockIndex?: number;
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: {
      text?: string;
      toolUse?: {
        input?: string;
      };
      partial_json?: string;
    };
  };
  contentBlockStop?: {
    contentBlockIndex?: number;
  };
  messageStop?: {
    stopReason?: string;
  };
  metadata?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheWriteInputTokenCount?: number;
      cacheReadInputTokenCount?: number;
    };
    metrics?: {
      latencyMs?: number;
      firstByteLatency?: number;
    };
  };
  // For messages that already contain amazon-bedrock-invocationMetrics
  'amazon-bedrock-invocationMetrics'?: {
    inputTokenCount?: number;
    outputTokenCount?: number;
    cacheWriteInputTokenCount?: number;
    cacheReadInputTokenCount?: number;
    invocationLatency?: number;
    firstByteLatency?: number;
  };
}

interface TransformedEvent {
  eventName: string;
  data: any;
}

/**
 * Handles streaming responses from AWS Bedrock, properly parsing SSE events and processing JSON fragments
 */
class BedrockStreamParser {
  private originalModelId: string;
  private streamState: StreamState;
  private parser: any;
  private res?: Response;
  private outputFormat: OutputFormat;

  constructor(originalModelId: string, _originalSubpath: string, outputFormat: OutputFormat = 'bedrock') {
    this.originalModelId = originalModelId;
    this.outputFormat = outputFormat;
    this.streamState = {
      messageId: null,
      emittedTextContentStartIndices: new Set(),
      emittedToolUseContentStartIndices: new Set(),
      finalInputTokens: 0,
      finalOutputTokens: 0,
      finalCacheCreationTokens: 0,
      finalCacheReadTokens: 0,
      finalLatencyMs: 0,
      finalFirstByteLatency: null,
      // Tool fragment buffering state
      toolFragmentBuffers: new Map(), // Map of contentBlockIndex -> array of fragments
      processedFragmentCount: 0
    };    
    
    // Create our event source parser with the correct v3.0.2 API
    this.parser = createParser({
      onEvent: (event: EventSourceMessage) => {
        // In v3, event is an EventSourceMessage with {id, name, data} properties
        logger.debug('BedrockStreamParser', `Received SSE event: ${JSON.stringify({
          id: event.id || 'none',
          name: (event as any).name || 'unnamed',
          dataPreview: typeof event.data === 'string' ? 
            event.data.substring(0, 100) + (event.data.length > 100 ? '...' : '') : 
            'non-string data'
        })}`);
        
        if ((event as any).name) {
          this.handleEvent((event as any).name, event.data);
        } else {
          this.handleData(event.data);
        }
      },
      onError: (error: any) => {
        logger.error('BedrockStreamParser', `Parser error: ${error}`);
      }
    });
  }

  /**
   * Process a chunk of data from the Bedrock response stream
   * @param chunk - The raw data chunk from the stream
   * @param res - Express response object to write SSE events to
   */
  processChunk(chunk: Buffer | string, res: Response): void {
    try {
      this.res = res;
      const chunkStr = chunk.toString();
      
      // Log chunk content for debugging
      logger.debug('BedrockStreamParser', `Received chunk (${chunkStr.length} bytes): ${chunkStr.substring(0, 200)}${chunkStr.length > 200 ? '...' : ''}`);
      
      // Check for empty chunks
      if (!chunkStr.trim()) {
        logger.debug('BedrockStreamParser', 'Received empty chunk, skipping');
        return;
      }
      
      // Check if this is an SSE data chunk
      const isSseFormat = chunkStr.startsWith('data:') || 
                          chunkStr.includes('\ndata:') || 
                          chunkStr.includes('event:') || 
                          chunkStr.startsWith(':');
      
      if (!isSseFormat) {
        logger.debug('BedrockStreamParser', 'Chunk doesn\'t look like SSE format, trying to handle as direct data');
        
        // Try to parse as JSON
        try {
          JSON.parse(chunkStr);
          logger.debug('BedrockStreamParser', 'Successfully parsed chunk as JSON, handling as data');
          this.handleData(chunkStr);
        } catch (jsonError) {
          // Not valid JSON, handle as raw text content
          logger.debug('BedrockStreamParser', 'Chunk is not valid JSON, sending as raw text content');
          
          // Create a synthetic message if needed
          if (!this.streamState.messageId) {
            this.streamState.messageId = `msg_bdrk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
            sseWriter.writeEventStream(this.res, 'message_start', JSON.stringify({
              type: 'message_start',
              message: {
                id: this.streamState.messageId,
                type: 'message',
                role: 'assistant',
                model: this.originalModelId,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            }));
          }
          
          // Emit content block start if needed
          if (!this.streamState.emittedTextContentStartIndices.has(0)) {
            sseWriter.writeEventStream(this.res, 'content_block_start', JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' }
            }));
            this.streamState.emittedTextContentStartIndices.add(0);
          }
          
          // Send raw text as content delta
          sseWriter.writeEventStream(this.res, 'content_block_delta', JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: typeof chunkStr === 'string' ? chunkStr : JSON.stringify(chunkStr) }
          }));
        }
        return;
      }
      
      // For AWS Bedrock single-quoted JSON in SSE data format, we need special handling
      if (chunkStr.includes("data: {'")) {
        // Extract the data part from SSE format
        const dataMatch = chunkStr.match(/data:\s*(.+?)(\n\n|\Z)/);
        if (dataMatch && dataMatch[1]) {
          const rawData = dataMatch[1].trim();
          logger.debug('BedrockStreamParser', `Extracted data from SSE: ${rawData}`);
          
          try {
            // Try to handle as single-quoted JSON
            const fixedJson = convertSingleQuotesToDoubleQuotes(rawData);
            const parsedData = JSON.parse(fixedJson);
            logger.debug('BedrockStreamParser', `Successfully parsed single-quoted JSON from SSE data`);
            
            // Process the parsed event
            const events = this.transformBedrockEvent(parsedData);
            
            if (events && events.length > 0) {
              events.forEach(event => {
                if (this.res && !this.res.writableEnded) {
                  logger.debug('BedrockStreamParser', `Emitting event ${event.eventName}: ${JSON.stringify(event.data).substring(0, 100)}...`);
                  sseWriter.writeEventStream(this.res, event.eventName, JSON.stringify(event.data));
                }
              });
              return; // Skip parsing with standard parser
            }
          } catch (parseError: any) {
            logger.warn('BedrockStreamParser', `Failed to parse single-quoted JSON: ${parseError.message}`);
            // Continue with standard parser
          }
        }
      }
      
      // Handle standard SSE formatted data - feed to the parser
      logger.debug('BedrockStreamParser', 'Feeding SSE formatted chunk to parser');
      this.parser.feed(chunkStr);
    } catch (error: any) {
      logger.error('BedrockStreamParser', `Error processing chunk: ${error}`);
      if (res && !res.writableEnded) {
        sseWriter.writeError(res, error);
      }
    }
  }

  /**
   * Handle a named SSE event from the parser
   */
  private handleEvent(eventName: string, data: string): void {
    logger.debug('BedrockStreamParser', `Received named event: ${eventName} with data: ${typeof data === 'string' ? data.substring(0, 100) : JSON.stringify(data).substring(0, 100)}...`);
    // For all named events, just pass to handleData
    this.handleData(data);
  }
  
  /**
   * Handle the data portion of an SSE event
   */
  private handleData(data: string | any): void {
    if (!data || !this.res) return;
    
    logger.debug('BedrockStreamParser', `Handling data: ${typeof data === 'string' ? data.substring(0, 100) : JSON.stringify(data).substring(0, 100)}${typeof data === 'string' && data.length > 100 ? '...' : ''}`);
    
    try {
      // Check for DONE marker
      if (data === '[DONE]') {
        this.handleDone();
        return;
      }

      // For pure text responses with no JSON structure, handle as text
      if (typeof data === 'string' && !data.startsWith('{') && !data.startsWith('[')) {
        logger.debug('BedrockStreamParser', 'Received text data, sending as content_block_delta');
        
        // Create a message_start event if we haven't yet
        if (!this.streamState.messageId) {
          this.createMessageStartEvent();
        }
        
        // Create content block start if needed
        if (!this.streamState.emittedTextContentStartIndices.has(0)) {
          this.createContentBlockStartEvent(0, 'text');
        }
        
        // Send text as delta
        sseWriter.writeEventStream(this.res, 'content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: data }
        }));
        return;
      }

      // Try to parse as JSON
      let bedrockEvent: BedrockEvent;
      try {
        // First try with regular parsing
        if (typeof data !== 'string') {
          bedrockEvent = data;
        } else if (data.startsWith('{\'') || data.includes('\':')) {
          // This looks like single-quoted JSON - convert it
          logger.debug('BedrockStreamParser', 'Detected single-quoted JSON, converting to double-quoted JSON');
          const fixedJson = convertSingleQuotesToDoubleQuotes(data);
          logger.debug('BedrockStreamParser', `Converted JSON: ${fixedJson.substring(0, 100)}${fixedJson.length > 100 ? '...' : ''}`);
          bedrockEvent = JSON.parse(fixedJson);
        } else {
          // Regular JSON parsing
          bedrockEvent = JSON.parse(data);
        }
      } catch (parseError: any) {
        logger.warn('BedrockStreamParser', `Failed to parse data as JSON: ${parseError.message}, data: ${data.substring(0, 50)}...`);
        
        // Try more aggressively to salvage the JSON by attempting conversion even if we don't detect single quotes
        try {
          const fixedJson = convertSingleQuotesToDoubleQuotes(data);
          bedrockEvent = JSON.parse(fixedJson);
          logger.debug('BedrockStreamParser', 'Successfully parsed data with quote conversion');
        } catch (secondError: any) {
          // If all parsing fails, treat as raw text
          logger.warn('BedrockStreamParser', `All JSON parsing attempts failed: ${secondError.message}`);
          
          // Create message_start event if needed
          if (!this.streamState.messageId) {
            this.createMessageStartEvent();
          }
          
          // Create content block start if needed
          if (!this.streamState.emittedTextContentStartIndices.has(0)) {
            this.createContentBlockStartEvent(0, 'text');
          }
          
          // Send as raw text
          sseWriter.writeChunk(this.res, data);
          return;
        }
      }
      
      // Transform the event
      const events = this.transformBedrockEvent(bedrockEvent);
      
      if (events && events.length > 0) {
        events.forEach(event => {
          if (this.res && !this.res.writableEnded) {
            logger.debug('BedrockStreamParser', `Emitting event ${event.eventName}: ${JSON.stringify(event.data).substring(0, 100)}...`);
            sseWriter.writeEventStream(this.res, event.eventName, JSON.stringify(event.data));
          }
        });
      } else {
        logger.debug('BedrockStreamParser', 'No events to emit from data, sending raw event');
        sseWriter.writeChunk(this.res, JSON.stringify(bedrockEvent));
      }
    } catch (error: any) {
      logger.error('BedrockStreamParser', `Error handling data: ${error}, Raw data: ${typeof data === 'string' ? data.substring(0, 100) : JSON.stringify(data).substring(0, 100)}`);
      // In case of error, try to send the raw data
      if (this.res && !this.res.writableEnded && data) {
        sseWriter.writeChunk(this.res, data);
      }
    }
  }
  
  /**
   * Helper to create a message_start event
   */
  private createMessageStartEvent(): void {
    this.streamState.messageId = `msg_bdrk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    sseWriter.writeEventStream(this.res!, 'message_start', JSON.stringify({
      type: 'message_start',
      message: {
        id: this.streamState.messageId,
        type: 'message',
        role: 'assistant',
        model: this.originalModelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }));
  }
  
  /**
   * Helper to create a content_block_start event
   */
  private createContentBlockStartEvent(index: number, blockType: 'text' | 'tool_use'): void {
    const contentBlock = blockType === 'text' 
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: `toolu_bdrk_${Date.now().toString(36)}`, name: 'unknown', input: {} };
    
    sseWriter.writeEventStream(this.res!, 'content_block_start', JSON.stringify({
      type: 'content_block_start',
      index: index,
      content_block: contentBlock
    }));
    
    if (blockType === 'text') {
      this.streamState.emittedTextContentStartIndices.add(index);
    } else {
      this.streamState.emittedToolUseContentStartIndices.add(index);
    }
  }

  /**
   * Handle end of stream
   */
  private handleDone(): void {
    // Process any remaining tool fragments in buffers
    this.processAllToolFragmentBuffers();

    // Send final message_stop if needed
    if (this.streamState.messageId && this.res && !this.res.writableEnded) {
      if (this.outputFormat === 'anthropic') {
        // Anthropic format: clean message_stop without Bedrock-specific metrics
        sseWriter.writeEventStream(this.res, 'message_stop', JSON.stringify({
          type: 'message_stop'
        }));
      } else {
        // Bedrock format: include amazon-bedrock-invocationMetrics
        sseWriter.writeEventStream(this.res, 'message_stop', JSON.stringify({
          type: 'message_stop',
          'amazon-bedrock-invocationMetrics': {
            inputTokenCount: this.streamState.finalInputTokens,
            outputTokenCount: this.streamState.finalOutputTokens,
            invocationLatency: this.streamState.finalLatencyMs,
            firstByteLatency: this.streamState.finalFirstByteLatency,
            cacheReadInputTokenCount: this.streamState.finalCacheReadTokens,
            cacheWriteInputTokenCount: this.streamState.finalCacheCreationTokens
          }
        }));
      }
    }
  }

  /**
   * Transform a Bedrock event into Anthropic-compatible events
   * @param bedrockEvent - The parsed Bedrock event
   * @returns Array of transformed events
   */
  private transformBedrockEvent(bedrockEvent: BedrockEvent): TransformedEvent[] {
    const events: TransformedEvent[] = [];
    
    logger.debug('BedrockStreamParser', `Transforming event: ${JSON.stringify(bedrockEvent).substring(0, 100)}...`);

    // Handle message start
    if (bedrockEvent.messageStart) {
      if (!this.streamState.messageId) {
        this.streamState.messageId = `msg_bdrk_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
      }
      events.push({
        eventName: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.streamState.messageId,
            type: 'message',
            role: bedrockEvent.messageStart.role || 'assistant',
            model: this.originalModelId,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.streamState.finalInputTokens || 0, output_tokens: 0 }
          }
        }
      });
    } 
    // Handle content block start
    else if (bedrockEvent.contentBlockStart) {
      const contentBlockIndex = bedrockEvent.contentBlockStart.contentBlockIndex || bedrockEvent.contentBlockIndex || 0;
      
      // Handle format seen in logs: {'contentBlockStart': {'start': {'toolUse': {'toolUseId': 'tooluse_...', 'name': 'get_weather'}}, 'contentBlockIndex': 1}}
      if (bedrockEvent.contentBlockStart.start && bedrockEvent.contentBlockStart.start.toolUse) {
        // Tool use content block start
        if (!this.streamState.emittedToolUseContentStartIndices.has(contentBlockIndex)) {
          const toolUse = bedrockEvent.contentBlockStart.start.toolUse;
          const toolUseId = toolUse.toolUseId || `tooluse_${Date.now().toString(36)}`;
          const toolUseName = toolUse.name || 'unknown_tool';
          
          events.push({
            eventName: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: `toolu_bdrk_${toolUseId.replace(/^tooluse_/, '')}`,
                name: toolUseName,
                input: {}
              }
            }
          });
          this.streamState.emittedToolUseContentStartIndices.add(contentBlockIndex);
        }
      } else if (bedrockEvent.contentBlockStart.start && bedrockEvent.contentBlockStart.start.text !== undefined) {
        // Text content block start
        if (!this.streamState.emittedTextContentStartIndices.has(contentBlockIndex)) {
          events.push({
            eventName: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' }
            }
          });
          this.streamState.emittedTextContentStartIndices.add(contentBlockIndex);
        }
      }
    } 
    // Handle content block delta
    else if (bedrockEvent.contentBlockDelta) {
      const contentBlockIndex = bedrockEvent.contentBlockDelta.contentBlockIndex || bedrockEvent.contentBlockIndex || 0;
      const delta = bedrockEvent.contentBlockDelta.delta;

      if (delta && delta.text !== undefined) {
        // Handle text delta
        // Ensure content block start was emitted first
        if (!this.streamState.emittedTextContentStartIndices.has(contentBlockIndex)) {
          events.push({
            eventName: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' }
            }
          });
          this.streamState.emittedTextContentStartIndices.add(contentBlockIndex);
        }
        
        // Send the text delta
        events.push({
          eventName: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'text_delta', text: typeof delta.text === 'string' ? delta.text : JSON.stringify(delta.text) }
          }
        });
      } 
      else if (delta && delta.toolUse && delta.toolUse.input !== undefined) {
        // Handle tool use input delta
        // Ensure content block start was emitted first (will be handled by contentBlockStart event)
        if (!this.streamState.emittedToolUseContentStartIndices.has(contentBlockIndex)) {
          logger.debug('BedrockStreamParser', `Tool use content block start not yet emitted for index ${contentBlockIndex}`);
        }
        
        // Send as input_json_delta
        events.push({
          eventName: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'input_json_delta', partial_json: delta.toolUse.input }
          }
        });
      }
      else if (delta && delta.partial_json !== undefined) {
        // Handle partial_json delta directly
        events.push({
          eventName: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'input_json_delta', partial_json: delta.partial_json }
          }
        });
      }
    }
    // Handle content block stop
    else if (bedrockEvent.contentBlockStop) {
      const contentBlockIndex = bedrockEvent.contentBlockStop.contentBlockIndex || bedrockEvent.contentBlockIndex || 0;
      
      // Send the stop event
      events.push({
        eventName: 'content_block_stop',
        data: {
          type: 'content_block_stop',
          index: contentBlockIndex
        }
      });
    }
    
    // Handle message stop
    else if (bedrockEvent.messageStop) {
      if (this.outputFormat === 'anthropic') {
        // Anthropic format: full usage in message_delta, clean message_stop
        events.push({
          eventName: 'message_delta',
          data: {
            type: 'message_delta',
            delta: {
              stop_reason: bedrockEvent.messageStop.stopReason,
              stop_sequence: null
            },
            usage: {
              input_tokens: this.streamState.finalInputTokens,
              output_tokens: this.streamState.finalOutputTokens,
              cache_creation_input_tokens: this.streamState.finalCacheCreationTokens,
              cache_read_input_tokens: this.streamState.finalCacheReadTokens
            }
          }
        });
        events.push({
          eventName: 'message_stop',
          data: {
            type: 'message_stop'
          }
        });
      } else {
        // Bedrock format: empty usage in message_delta, metrics in message_stop
        events.push({
          eventName: 'message_delta',
          data: {
            type: 'message_delta',
            delta: {
              stop_reason: bedrockEvent.messageStop.stopReason,
              stop_sequence: null
            },
            usage: {}
          }
        });
        events.push({
          eventName: 'message_stop',
          data: {
            type: 'message_stop',
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: this.streamState.finalInputTokens,
              outputTokenCount: this.streamState.finalOutputTokens,
              invocationLatency: this.streamState.finalLatencyMs,
              firstByteLatency: this.streamState.finalFirstByteLatency || 0,
              cacheReadInputTokenCount: this.streamState.finalCacheReadTokens,
              cacheWriteInputTokenCount: this.streamState.finalCacheCreationTokens
            }
          }
        });
      }
    }
    
    // Handle metadata/usage events
    else if (bedrockEvent.metadata) {
      const bedrockUsage = bedrockEvent.metadata.usage || {};
      const bedrockMetrics = bedrockEvent.metadata.metrics || {};

      this.streamState.finalInputTokens = bedrockUsage.inputTokens || 0;
      this.streamState.finalOutputTokens = bedrockUsage.outputTokens || 0;
      // Capture cache tokens from Bedrock format
      this.streamState.finalCacheCreationTokens = bedrockUsage.cacheWriteInputTokenCount || 0;
      this.streamState.finalCacheReadTokens = bedrockUsage.cacheReadInputTokenCount || 0;
      this.streamState.finalLatencyMs = bedrockMetrics.latencyMs || 0;
      this.streamState.finalFirstByteLatency = bedrockMetrics.firstByteLatency || 0;

      if (this.outputFormat === 'anthropic') {
        // Anthropic format: full usage info in message_delta
        events.push({
          eventName: 'message_delta',
          data: {
            type: 'message_delta',
            delta: {},
            usage: {
              input_tokens: this.streamState.finalInputTokens,
              output_tokens: this.streamState.finalOutputTokens,
              cache_creation_input_tokens: this.streamState.finalCacheCreationTokens,
              cache_read_input_tokens: this.streamState.finalCacheReadTokens
            }
          }
        });
      } else {
        // Bedrock format: only output_tokens in message_delta
        events.push({
          eventName: 'message_delta',
          data: {
            type: 'message_delta',
            delta: {},
            usage: { output_tokens: this.streamState.finalOutputTokens }
          }
        });
      }
    }
    // Handle already-formatted message_stop with amazon-bedrock-invocationMetrics
    else if (bedrockEvent['amazon-bedrock-invocationMetrics']) {
      const metrics = bedrockEvent['amazon-bedrock-invocationMetrics'];
      this.streamState.finalInputTokens = metrics.inputTokenCount || 0;
      this.streamState.finalOutputTokens = metrics.outputTokenCount || 0;
      this.streamState.finalCacheCreationTokens = metrics.cacheWriteInputTokenCount || 0;
      this.streamState.finalCacheReadTokens = metrics.cacheReadInputTokenCount || 0;
      this.streamState.finalLatencyMs = metrics.invocationLatency || 0;
      this.streamState.finalFirstByteLatency = metrics.firstByteLatency || 0;

      // Don't emit events here - this will be handled by messageStop or handleDone
    }

    return events;
  }


  /**
   * Process all fragment buffers - used when stream ends
   */
  private processAllToolFragmentBuffers(): void {
    let allEvents: TransformedEvent[] = [];
    
    // Process each buffer
    for (const contentBlockIndex of Array.from(this.streamState.toolFragmentBuffers.keys())) {
      const events = this.processToolFragmentsForIndex(contentBlockIndex, true);
      if (events.length) {
        allEvents = allEvents.concat(events);
      }
    }
    
    // Send all events
    if (allEvents.length > 0 && this.res && !this.res.writableEnded) {
      allEvents.forEach(event => {
        sseWriter.writeEventStream(this.res!, event.eventName, JSON.stringify(event.data));
      });
    }
  }

  /**
   * Process tool fragments for a specific content block index
   * @param contentBlockIndex - The content block index
   * @param forceProcess - Force processing even if fragments don't appear complete
   * @returns Array of events to send
   */
  private processToolFragmentsForIndex(contentBlockIndex: number, _forceProcess: boolean = false): TransformedEvent[] {
    const fragments = this.streamState.toolFragmentBuffers.get(contentBlockIndex) || [];
    if (fragments.length === 0) return [];
    
    // Ensure content block start was emitted
    if (!this.streamState.emittedToolUseContentStartIndices.has(contentBlockIndex)) {
      logger.warn('BedrockStreamParser', `Cannot process tool fragments for index ${contentBlockIndex} - no content_block_start was emitted.`);
      return [];
    }
    
    const events: TransformedEvent[] = [];
    
    // Send individual fragment deltas
    fragments.forEach(fragment => {
      events.push({
        eventName: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'input_json_delta', partial_json: fragment }
        }
      });
    });
    
    // Clear buffer after processing
    this.streamState.toolFragmentBuffers.delete(contentBlockIndex);
    
    return events;
  }
}

/**
 * Convert single-quoted JSON to valid double-quoted JSON 
 * AWS Bedrock sometimes sends JSON with single quotes which is not valid
 */
function convertSingleQuotesToDoubleQuotes(str: string): string {
  try {
    // Skip if already valid JSON
    try {
      JSON.parse(str);
      return str;
    } catch (e) {
      // Not valid JSON, try to fix it
    }

    // Replace single quotes with double quotes, but handle nested quotes properly
    // This is a simple implementation that handles most cases
    return str
      .replace(/'/g, '"')
      .replace(/"([^"]+)":/g, function(_match, p1) {
        // Fix double-quoted property names with escaped quotes inside
        return '"' + p1.replace(/\\"/g, "'") + '":';
      })
      .replace(/:\s*"([^"]+)"/g, function(_match, p1) {
        // Fix double-quoted values with escaped quotes inside
        return ': "' + p1.replace(/\\"/g, "'") + '"';
      });
  } catch (e: any) {
    logger.error('BedrockStreamParser', `Error converting quotes: ${e}`);
    return str; // Return original if conversion fails
  }
}

export default BedrockStreamParser;