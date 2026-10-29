// Service for Anthropic message processing
import { hasCacheControl, markedTextBlock, markedTextBlocks, dropEmptyTextBlocks, toCacheControl, OrchestrationCacheControl } from './anthropicCacheBreakpoints';

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
  content: string | any[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  has_image?: boolean;
  has_tools?: boolean;
  /** A breakpoint the client put on this tool result; the builder moves it (relocateBreakpoint). */
  cache_breakpoint?: OrchestrationCacheControl;
}

const isMarked = (b: any): boolean => !!b && typeof b === 'object' && !!b.cache_control && typeof b.cache_control === 'object';

/** A tool_result's content as the plain string orchestration requires for a `tool` message. */
function toolResultText(block: ContentBlock): string {
  const content = block.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n')
      : content == null ? '' : JSON.stringify(content);
  return block.is_error ? `Error: ${text}` : text;
}

/**
 * A message carrying tool blocks, in the shape SAP orchestration takes (the OpenAI one): an
 * assistant turn's tool_use blocks become `tool_calls` (content '' when it has no text), a user
 * turn's tool_result blocks become one `tool` message each, followed by whatever text the user
 * added. Without this the blocks were dropped and SAP refused the turn as empty.
 */
function processToolMessage(role: string, blocks: ContentBlock[]): ProcessedMessage[] {
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  if (role === 'assistant') {
    const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
    const textBlocks = blocks.filter((b) => b.type === 'text');
    const content = hasCacheControl(textBlocks) ? markedTextBlocks(textBlocks) : text;
    return [{ role, content, tool_calls: toolCalls, has_tools: true }];
  }
  const results: ProcessedMessage[] = blocks.filter((b) => b.type === 'tool_result')
    .map((b) => {
      const tool: ProcessedMessage = { role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b), has_tools: true };
      const marked = isMarked(b) ? b.cache_control : Array.isArray(b.content) ? b.content.find(isMarked)?.cache_control : undefined;
      if (marked) tool.cache_breakpoint = toCacheControl(marked);
      return tool;
    });
  const rest = blocks.filter((b) => b.type !== 'tool_result');
  const content = userContent(rest);
  return content.length > 0 ? [...results, { role, content }] : results;
}

/** An Anthropic image block as orchestration's image_url block; undefined for a source it cannot take. */
function imageUrlBlock(block: ContentBlock): { type: 'image_url'; image_url: { url: string } } | undefined {
  const src = block.source;
  if (src?.type === 'base64' && typeof src.data === 'string') {
    return { type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } };
  }
  if (src?.type === 'url' && typeof src.url === 'string') return { type: 'image_url', image_url: { url: src.url } };
  return undefined;
}

/**
 * A user turn's text and images: plain text stays a string (what orchestration got before); with
 * images, or with a text block the client marked for caching, it becomes content blocks in their
 * original order, text as {type:'text'} keeping its breakpoint (anthropicCacheBreakpoints.ts).
 */
function userContent(blocks: ContentBlock[]): string | any[] {
  if (!blocks.some((b) => b.type === 'image' && imageUrlBlock(b)) && !hasCacheControl(blocks)) {
    return blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  }
  const out = blocks.flatMap((b): any[] => {
    if (b.type === 'text') return [markedTextBlock(b)];
    const image = b.type === 'image' ? imageUrlBlock(b) : undefined;
    return image ? [image] : [];
  });
  return hasCacheControl(blocks) ? dropEmptyTextBlocks(out) : out;
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

  return messages.flatMap((msg): ProcessedMessage | ProcessedMessage[] => {
    if (!msg || typeof msg !== 'object') {
      console.warn("Invalid message format:", msg);
      return { role: 'user', content: '' }; // Default to user role with empty content
    }

    const role = msg.role || 'user'; // Default to 'user' if role is missing

    // For string content, just use it directly
    if (typeof msg.content === 'string') {
      return { role, content: msg.content };
    }

    // Tool calls and results map onto orchestration's tool_calls / tool messages.
    if (Array.isArray(msg.content)
        && msg.content.some((block: ContentBlock) => block?.type === 'tool_use' || block?.type === 'tool_result')) {
      return processToolMessage(role, msg.content as ContentBlock[]);
    }

    // For array content (multimodal), extract text and handle images
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
      // Images travel as image_url blocks; without them the text stays the plain string it always was.
      const marked = hasCacheControl(msg.content);
      const processedMsg: ProcessedMessage = { role, content: hasImages || marked ? userContent(msg.content as ContentBlock[]) : textContent };
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