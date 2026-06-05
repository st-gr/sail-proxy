/**
 * Anthropic to OpenAI format translation service
 * Converts Anthropic Messages API format to OpenAI chat completions format
 * for token counting purposes
 */

// Anthropic Input Types
interface AnthropicMessagesPayload {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  metadata?: {
    user_id?: string;
  };
  stop_sequences?: string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none';
    name?: string;
  };
  thinking?: {
    type: 'enabled';
    budget_tokens?: number;
  };
  service_tier?: 'auto' | 'standard_only';
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
}

type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock;

type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock;

interface AnthropicUserMessage {
  role: 'user';
  content: string | AnthropicUserContentBlock[];
}

interface AnthropicAssistantMessage {
  role: 'assistant';
  content: string | AnthropicAssistantContentBlock[];
}

type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

// OpenAI/Internal Types (after translation)
interface ChatCompletionsPayload {
  messages: Message[];
  model: string;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  stop?: string | string[] | null;
  stream?: boolean | null;
  tools?: Tool[] | null;
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | null;
  user?: string | null;
  [key: string]: unknown; // Allow additional properties for compatibility
}

interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

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

type ContentPart = TextPart | ImagePart;

interface TextPart {
  type: 'text';
  text: string;
}

interface ImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

/**
 * Main translation function: Anthropic → OpenAI format
 */
export function translateAnthropicToOpenAI(
  payload: AnthropicMessagesPayload
): ChatCompletionsPayload {
  return {
    model: translateModelName(payload.model),
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
  };
}

/**
 * Handle versioned model names (e.g., claude-sonnet-4-20241022 → claude-sonnet-4)
 */
function translateModelName(model: string): string {
  // Handle versioned Claude model names
  if (model.startsWith('claude-sonnet-4-')) {
    return model.replace(/^claude-sonnet-4-.*/, 'claude-sonnet-4');
  } else if (model.startsWith('claude-opus-4-')) {
    return model.replace(/^claude-opus-4-.*/, 'claude-opus-4');
  } else if (model.startsWith('claude-3-5-sonnet-')) {
    return model.replace(/^claude-3-5-sonnet-.*/, 'claude-3-5-sonnet');
  } else if (model.startsWith('claude-3-5-haiku-')) {
    return model.replace(/^claude-3-5-haiku-.*/, 'claude-3-5-haiku');
  } else if (model.startsWith('claude-3-opus-')) {
    return model.replace(/^claude-3-opus-.*/, 'claude-3-opus');
  } else if (model.startsWith('claude-3-sonnet-')) {
    return model.replace(/^claude-3-sonnet-.*/, 'claude-3-sonnet');
  } else if (model.startsWith('claude-3-haiku-')) {
    return model.replace(/^claude-3-haiku-.*/, 'claude-3-haiku');
  }
  return model;
}

/**
 * Convert Anthropic messages array to OpenAI format
 */
function translateAnthropicMessagesToOpenAI(
  anthropicMessages: AnthropicMessage[],
  system: string | AnthropicTextBlock[] | undefined
): Message[] {
  const systemMessages = handleSystemPrompt(system);
  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === 'user'
      ? handleUserMessage(message)
      : handleAssistantMessage(message)
  );
  return [...systemMessages, ...otherMessages];
}

/**
 * Convert system prompt to OpenAI system message format
 */
function handleSystemPrompt(
  system: string | AnthropicTextBlock[] | undefined
): Message[] {
  if (!system) return [];
  if (typeof system === 'string') {
    return [{ role: 'system', content: system }];
  } else {
    const systemText = system.map((block) => block.text).join('\n\n');
    return [{ role: 'system', content: systemText }];
  }
}

/**
 * Convert Anthropic user message to OpenAI format
 * Handles tool_result blocks as separate "tool" role messages
 */
function handleUserMessage(message: AnthropicUserMessage): Message[] {
  const newMessages: Message[] = [];

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === 'tool_result'
    );
    const otherBlocks = message.content.filter(
      (block) => block.type !== 'tool_result'
    );

    // Tool results become separate "tool" role messages
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: mapContentToString(block.content),
      });
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: 'user',
        content: mapContent(otherBlocks as (AnthropicTextBlock | AnthropicImageBlock)[]),
      });
    }
  } else {
    newMessages.push({
      role: 'user',
      content: mapContentToString(message.content),
    });
  }

  return newMessages;
}

/**
 * Convert Anthropic assistant message to OpenAI format
 * Handles tool_use blocks as tool_calls and thinking blocks as text
 */
function handleAssistantMessage(
  message: AnthropicAssistantMessage
): Message[] {
  if (!Array.isArray(message.content)) {
    return [{ role: 'assistant', content: mapContentToString(message.content) }];
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === 'tool_use'
  );
  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === 'text'
  );
  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === 'thinking'
  );

  // Combine text and thinking blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join('\n\n');

  if (toolUseBlocks.length > 0) {
    return [
      {
        role: 'assistant',
        content: allTextContent || null,
        tool_calls: toolUseBlocks.map((toolUse) => ({
          id: toolUse.id,
          type: 'function' as const,
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input),
          },
        })),
      },
    ];
  }
  return [{ role: 'assistant', content: mapContent(message.content as AnthropicAssistantContentBlock[]) }];
}

/**
 * Convert content to string (for simple content)
 */
function mapContentToString(content: string | unknown): string | null {
  if (typeof content === 'string') return content;
  return null;
}

/**
 * Convert content blocks to OpenAI format
 * Handles text, images, and thinking blocks
 */
function mapContent(
  content: (AnthropicTextBlock | AnthropicImageBlock | AnthropicAssistantContentBlock)[]
): string | ContentPart[] | null {
  if (!Array.isArray(content)) return null;

  const hasImage = content.some((block) => block.type === 'image');
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === 'text' || block.type === 'thinking'
      )
      .map((block) => (block.type === 'text' ? block.text : (block as AnthropicThinkingBlock).thinking))
      .join('\n\n');
  }

  // Handle mixed content with images
  const contentParts: ContentPart[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        contentParts.push({ type: 'text', text: (block as AnthropicTextBlock).text });
        break;
      case 'thinking':
        contentParts.push({ type: 'text', text: (block as AnthropicThinkingBlock).thinking });
        break;
      case 'image':
        const imageBlock = block as AnthropicImageBlock;
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
          },
        });
        break;
    }
  }
  return contentParts;
}

/**
 * Convert Anthropic tools to OpenAI function format
 */
function translateAnthropicToolsToOpenAI(
  anthropicTools: AnthropicTool[] | undefined
): Tool[] | undefined {
  if (!anthropicTools) return undefined;
  return anthropicTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * Convert Anthropic tool_choice to OpenAI format
 */
function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload['tool_choice']
): ChatCompletionsPayload['tool_choice'] {
  if (!anthropicToolChoice) return undefined;

  switch (anthropicToolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      if (anthropicToolChoice.name) {
        return { type: 'function', function: { name: anthropicToolChoice.name } };
      }
      return undefined;
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

// Export types for use by other modules
export type { AnthropicMessagesPayload, AnthropicTool, ChatCompletionsPayload };

export default {
  translateAnthropicToOpenAI,
};
