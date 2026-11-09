// Utility functions for Anthropic services
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Type definitions for system prompt formats
type SystemPromptParam = string | SystemPromptBlock[] | SystemPromptObject | TextOnlyObject | null | undefined;

interface SystemPromptBlock {
  type: string;
  text?: string;
  [key: string]: any;
}

interface SystemPromptObject {
  type: 'text';
  text: string;
  [key: string]: any;
}

interface TextOnlyObject {
  text: string;
}

interface InputSchema {
  [key: string]: any;
}

/**
 * Extracts system prompt text from the system parameter.
 * Handles string, array of content blocks, or simple object with a text property.
 * @param systemPromptParam - The system prompt parameter from the request.
 * @returns The extracted system prompt text.
 */
export function extractSystemPromptText(systemPromptParam: SystemPromptParam): string {
  if (!systemPromptParam) return '';
  
  if (typeof systemPromptParam === 'string') {
    return systemPromptParam;
  }
  
  if (Array.isArray(systemPromptParam)) {
    return systemPromptParam
      .filter((block): block is SystemPromptBlock => 
        block && block.type === 'text' && typeof block.text === 'string'
      )
      .map(block => block.text!)
      .join('\n'); // Join multiple text blocks with newlines
  }
  
  // Handling for a simple object like { type: "text", text: "..." }
  if (typeof systemPromptParam === 'object' && 
      'type' in systemPromptParam && systemPromptParam.type === 'text' && 
      'text' in systemPromptParam && typeof systemPromptParam.text === 'string') {
    return systemPromptParam.text;
  }
  
  // Handling for just { text: "..." } if that's a possible format
  if (typeof systemPromptParam === 'object' && 
      'text' in systemPromptParam && 
      typeof systemPromptParam.text === 'string' && 
      Object.keys(systemPromptParam).length === 1) {
    return systemPromptParam.text;
  }

  logger.warn('AnthropicUtils', `Unrecognized system prompt format: ${JSON.stringify(systemPromptParam).substring(0,100)}... Defaulting to empty string.`);
  return '';
}

/**
 * Logs information about a single tool.
 * @param toolName - The name of the tool.
 * @param inputSchema - The input schema for the tool.
 * @param description - The description of the tool.
 */
export function logToolInfo(toolName: string, inputSchema: InputSchema, description?: string): void {
  logger.debug('AnthropicUtils', `Tool Info - Name: ${toolName}`);
  if (description) {
    logger.debug('AnthropicUtils', `  Description: ${description}`);
  }
  if (inputSchema && Object.keys(inputSchema).length > 0) {
    logger.debug('AnthropicUtils', `  Input Schema: ${JSON.stringify(inputSchema, null, 2)}`);
  } else {
    logger.debug('AnthropicUtils', `  Input Schema: (No input schema or empty)`);
  }
}

export default {
  logToolInfo,
  extractSystemPromptText,
};