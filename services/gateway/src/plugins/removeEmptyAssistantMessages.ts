/**
 * Remove Empty Assistant Messages Plugin
 * 
 * This plugin removes assistant messages with empty content arrays from requests
 * to prevent SAP AI Core from rejecting them with "text content blocks must contain non-whitespace text"
 */

import { Request, Response } from 'express';

interface PluginContext {
  req: Request;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: any;
}

interface Message {
  role: string;
  content: any[] | string;
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

/**
 * Before handler - removes empty assistant messages
 */
async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const logger = utils.logger;
  
  try {
    // Check if we have messages in the request body
    if (!req.body || !Array.isArray((req.body as any).messages)) {
      logger.debug('No messages array found in request body');
      return { stop: false };
    }
    
    const requestBody = req.body as any;
    const originalMessages = requestBody.messages;
    let removedCount = 0;
    
    // Filter out assistant messages with empty content
    const filteredMessages = originalMessages.filter((message: Message, index: number) => {
      // Check if this is an assistant message with empty content
      if (message.role === 'assistant') {
        let isEmpty = false;
        
        // Handle both array and string content
        if (Array.isArray(message.content)) {
          // Check if array is empty
          if (message.content.length === 0) {
            isEmpty = true;
          } else {
            // Check if array contains only empty/whitespace content
            isEmpty = message.content.every(item => {
              if (typeof item === 'string') {
                return item.trim() === '';
              } else if (typeof item === 'object' && item !== null) {
                // Check for text content blocks
                if (item.text !== undefined) {
                  return typeof item.text === 'string' && item.text.trim() === '';
                }
                // Check for objects without meaningful content
                if (item.type === 'text' && (!item.text || item.text.trim() === '')) {
                  return true;
                }
              }
              return false; // Non-empty content blocks (like tool use, etc.)
            });
          }
        } else if (typeof message.content === 'string') {
          // Empty or whitespace-only string
          isEmpty = message.content.trim() === '';
        }
        
        if (isEmpty) {
          removedCount++;
          logger.info(`Removing empty assistant message at index ${index}: ${JSON.stringify(message.content)}`);
          return false; // Filter out this message
        }
      }
      
      return true; // Keep this message
    });
    
    // Update the request body if we removed any messages
    if (removedCount > 0) {
      requestBody.messages = filteredMessages;
      logger.info(`Removed ${removedCount} empty assistant message(s). Original count: ${originalMessages.length}, New count: ${filteredMessages.length}`);
      
      // Log the cleaned messages for debugging
      logger.debug('Cleaned messages:', {
        originalCount: originalMessages.length,
        newCount: filteredMessages.length,
        removedCount,
        remainingRoles: filteredMessages.map((m: Message) => m.role)
      });
    } else {
      logger.debug('No empty assistant messages found to remove');
    }
    
    return { stop: false };
    
  } catch (error: any) {
    logger.error(`Error in removeEmptyAssistantMessages plugin: ${error.message}`, { 
      stack: error.stack,
      requestUrl: (req as any).originalUrl || req.url,
      hasMessages: !!(req.body && (req.body as any).messages)
    });
    
    // Don't stop the request on plugin errors - just log and continue
    return { stop: false };
  }
}

/**
 * After handler - dummy handler that passes through the response unchanged
 */
async function afterHandler({ upstreamResponse, utils }: PluginContext): Promise<any> {
  const logger = utils.logger;
  
  logger.debug('removeEmptyAssistantMessages after handler called - passing through response unchanged');
  
  // Handle the case where upstreamResponse might be undefined
  if (upstreamResponse === undefined) {
    logger.debug('upstreamResponse is undefined, returning empty object to avoid undefined return');
    return {}; // Return empty object instead of undefined to avoid plugin executor error
  }
  
  // Return the upstream response unchanged
  return upstreamResponse;
}

// Export the plugin rules
const pluginRules = [
  {
    id: "removeEmptyAssistantMessages",
    match: [], // Match rules defined in api_config.json
    strategy: "before",
    handler: beforeHandler
  },
  {
    id: "removeEmptyAssistantMessages", 
    match: [], // Match rules defined in api_config.json
    strategy: "after",
    handler: afterHandler
  }
];

export = pluginRules;