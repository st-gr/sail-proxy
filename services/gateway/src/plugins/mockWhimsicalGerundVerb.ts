/**
 * Plugin that mocks a whimsical gerund verb response
 * Can run in 'before' mode (replacing the LLM call) or 'after' mode (modifying the response)
 */

import { Request, Response } from 'express';

// Type definitions
interface PluginRequest extends Request {
  bypassRateLimit?: boolean;
  [key: string]: any;
}

interface PluginUtils {
  logger: {
    info: (message: string) => void;
    debug: (message: string) => void;
    error: (message: string) => void;
  };
  sseWriter: (res: Response, events: SSEEvent[]) => Promise<void>;
}

interface PluginHandlerParams {
  req: PluginRequest;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: AnthropicResponse;
}

interface PluginResult {
  stop: boolean;
}

interface SSEEvent {
  event: string;
  data: any;
}


interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}

interface AnthropicResponse {
  content?: ContentBlock[];
  [key: string]: any;
}

interface PluginRule {
  id: string;
  match: string[];
  strategy: 'before' | 'after' | 'stream';
  handler: (params: PluginHandlerParams) => Promise<PluginResult | AnthropicResponse>;
}

// Array of whimsical gerund verbs
const words: string[] = [
  "Bubbling",
  "Sparkling",
  "Fluttering",
  "Whirling",
  "Gleefying", 
  "Jubilating",
  "Zestifying",
  "Glittering",
  "Vibing",
  "Clauding",
  "Accomplishing",
  "Herding",
  "Cooking",
  "Refactoring",
  "Bitflipping",
  "Bytecrunching",
  "Debugging",
  "Hotfixing",
  "Forking",
  "Compiling",
  "Pixelating",
  "Hashing",
  "Algorithmizing",
  "Puzzlesolving",
  "Wishwashing"
];

// Generate a random whimsical verb from the array
function getRandomWhimsicalVerb(): string {
  const idx = Math.floor(Math.random() * words.length);
  const word = words[idx];
  if (!word) {
    return 'Processing'; // fallback if array access fails
  }
  // Move the chosen word to the end of the array (if not already last)
  if (idx !== words.length - 1) {
    words.splice(idx, 1);
    words.push(word);
  }
  return word;
}

// 'before' strategy handler - replaces the LLM call with a SSE stream
async function beforeHandler({ req, res, utils }: PluginHandlerParams): Promise<PluginResult> {
  // Use the logger provided by pluginExecutor
  utils.logger.info('Executing in BEFORE mode');
  
  // Select a random word
  const word = getRandomWhimsicalVerb();
  utils.logger.debug(`Selected word: ${word}`);
  
  // Generate a message_id for the response
  const messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 7)}`;
  
  // Flag request as bypassing rate limiter
  if (req) {
    req.bypassRateLimit = true;
  }

  // Add a delay to avoid too quick responses triggering rate limit concerns
  // even when bypassing the actual rate limiter
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Send a Bedrock-style streaming SSE response
  await utils.sseWriter(res, [
    { 
      event: "message_start", 
      data: { 
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: "anthropic--claude-3-haiku--deployed",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 1
          }
        },
        type: "message_start"
      }
    },
    { 
      event: "content_block_start", 
      data: {
        index: 0,
        content_block: {
          type: "text",
          text: ""
        },
        type: "content_block_start"
      }
    },
    { 
      event: "ping", 
      data: { type: "ping" }
    },
    { 
      event: "content_block_delta", 
      data: {
        index: 0,
        delta: {
          type: "text_delta",
          text: word
        },
        type: "content_block_delta"
      }
    },
    { 
      event: "content_block_stop", 
      data: {
        index: 0,
        type: "content_block_stop"
      }
    },
    { 
      event: "message_delta", 
      data: {
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null
        },
        usage: {
          output_tokens: 1
        },
        type: "message_delta"
      }
    },
    { 
      event: "message_stop", 
      data: {
        type: "message_stop"
      }
    }
  ]);
  
  // Signal that we're short-circuiting and not calling the upstream LLM
  return { stop: true };
}

// 'after' strategy handler - modifies the response from the LLM
async function afterHandler({ req: _req, res: _res, upstreamResponse, utils }: PluginHandlerParams): Promise<AnthropicResponse> {
  // Use the logger provided by pluginExecutor
  utils.logger.info('Executing in AFTER mode');
  
  // If there's no upstream response, return a default response
  if (!upstreamResponse) {
    return { content: [] } as AnthropicResponse;
  }
  
  try {
    // For simplicity, we'll assume streaming has already completed
    // In a real implementation, you might intercept the stream events
    
    // Get a random word
    const word = getRandomWhimsicalVerb();
    utils.logger.debug(`Selected word for prefix: ${word}`);
    
    // If this is a non-streaming response, add the word to the text
    if (upstreamResponse && upstreamResponse.content && Array.isArray(upstreamResponse.content)) {
      for (let i = 0; i < upstreamResponse.content.length; i++) {
        const block = upstreamResponse.content[i];
        if (block && block.type === 'text' && upstreamResponse.content[i]) {
          // Prepend the whimsical verb and an emoji to the text content
          upstreamResponse.content[i]!.text = `🎉 ${word}... ${block.text || ''}`;
          break; // Only modify the first text block
        }
      }
    }
    
    return upstreamResponse;
  } catch (error: any) {
    utils.logger.error(`Error in after handler: ${error}`);
    return upstreamResponse as AnthropicResponse; // Return original response in case of error
  }
}

// Export the plugin rules (match conditions now centralized in api_config.json)
const pluginRules: PluginRule[] = [
  {
    id: "mockWhimsicalGerundVerb",
    match: [], // Match rules moved to api_config.json
    strategy: "before",
    handler: beforeHandler
  },
  {
    id: "mockWhimsicalGerundVerbAfter",
    match: [], // Match rules moved to api_config.json
    strategy: "after",
    handler: afterHandler
  }
];

export = pluginRules;
