import { anthropicAdapter } from './anthropic';
import { openaiChatAdapter } from './openaiChat';
import { responsesAdapter } from './responses';
import { geminiAdapter } from './gemini';
import { bedrockAdapter } from './bedrock';
import type { ToolAdapter } from './types';

export { anthropicAdapter, openaiChatAdapter, responsesAdapter, geminiAdapter, bedrockAdapter };
export type { ToolAdapter } from './types';

const BY_FAMILY: Record<ToolAdapter['family'], ToolAdapter> = {
  anthropic: anthropicAdapter, openaiChat: openaiChatAdapter, responses: responsesAdapter, gemini: geminiAdapter, bedrock: bedrockAdapter
};
export function adapterFor(family: ToolAdapter['family']): ToolAdapter { return BY_FAMILY[family]; }
