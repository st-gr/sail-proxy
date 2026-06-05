// Service for Anthropic message processing

// Type definitions for Anthropic message formats
interface AnthropicMessage {
  role?: string;
  content: string | ContentBlock[] | object | null | undefined;
  [key: string]: any;
}

interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  [key: string]: any;
}

interface ProcessedMessage {
  role: string;
  content: string;
  has_image?: boolean;
  has_tools?: boolean;
}

/**
 * Process and normalize Anthropic message format
 * @param messages - Messages in Anthropic format
 * @returns Normalized messages for SAP AI Core
 */
export function processAnthropicMessages(messages: AnthropicMessage[]): ProcessedMessage[] {
  if (!Array.isArray(messages)) {
    console.warn("Expected messages to be an array, got:", typeof messages);
    return [];
  }

  return messages.map(msg => {
    if (!msg || typeof msg !== 'object') {
      console.warn("Invalid message format:", msg);
      return { role: 'user', content: '' }; // Default to user role with empty content
    }

    const role = msg.role || 'user'; // Default to 'user' if role is missing

    // For string content, just use it directly
    if (typeof msg.content === 'string') {
      return { role, content: msg.content };
    }

    // For array content (multimodal), extract text and handle images/tools
    if (Array.isArray(msg.content)) {
      let textContent = '';
      let hasImages = false;
      let imageCount = 0;
      let toolUseCount = 0;
      let toolResultCount = 0;

      // Process each content block
      msg.content.forEach((block: ContentBlock) => {
        if (block.type === 'text') {
          textContent += (textContent.length > 0 ? '\n' : '') + (block.text || '');
        } else if (block.type === 'image') {
          hasImages = true;
          imageCount++;
          // Placeholder for image data if needed in the future
          // For now, we just note its presence
        } else if (block.type === 'tool_use') {
          toolUseCount++;
          // Placeholder for tool use data
        } else if (block.type === 'tool_result') {
          toolResultCount++;
          // Placeholder for tool result data
        }
      });

      // Construct the message object
      const processedMsg: ProcessedMessage = { role, content: textContent };
      if (hasImages) processedMsg.has_image = true; // Mark if images were present
      if (toolUseCount > 0 || toolResultCount > 0) processedMsg.has_tools = true; // Mark if tools were present

      return processedMsg;
    }

    // Handle object content (not an array but some complex structure)
    // This might be an edge case or a format not fully supported yet
    if (typeof msg.content === 'object' && msg.content !== null) {
      // Attempt to stringify or extract meaningful text
      // This is a basic fallback; specific handling might be needed
      try {
        const contentString = JSON.stringify(msg.content);
        console.warn(`Message content is an object, using stringified version: ${contentString.substring(0,100)}...`);
        return { role, content: contentString };
      } catch (e) {
        console.error('Error stringifying complex message content:', e);
        return { role, content: '[Unsupported complex content]' };
      }
    }

    // Fallback for any other format (e.g. number, boolean - though unlikely)
    return { role, content: String(msg.content || '') }; // Ensure content is always a string
  });
}

export default {
  processAnthropicMessages,
};