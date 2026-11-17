/**
 * Where thinking sits in a conversation: Anthropic `{ type: 'thinking', thinking, signature }`
 * content blocks and Bedrock Converse `{ reasoningContent: { reasoningText: { text, signature } } }`.
 * The text is signed by the model, so the masking passes treat these blocks apart from other text
 * (thinkingRoundTrip.ts).
 */

/** One thinking text: `holder[textKey]` is the text, `holder.signature` its signature (if any). */
export interface ThinkingRef {
  holder: any;
  textKey: 'thinking' | 'text';
}

/** The thinking texts of one `content` array. */
export function thinkingRefsOfContent(content: unknown): ThinkingRef[] {
  const refs: ThinkingRef[] = [];
  if (!Array.isArray(content)) return refs;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') refs.push({ holder: block, textKey: 'thinking' });
    const reasoning = block.reasoningContent?.reasoningText;
    if (reasoning && typeof reasoning === 'object' && typeof reasoning.text === 'string') refs.push({ holder: reasoning, textKey: 'text' });
  }
  return refs;
}

/** The thinking texts of a request's `messages`. */
export function thinkingRefsOfMessages(messages: unknown): ThinkingRef[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => thinkingRefsOfContent(message?.content));
}

/**
 * The objects of a request's `messages` that hold model-signed thinking and nothing else: thinking
 * and redacted_thinking blocks, and Converse `reasoningContent`. A pass that rewrites every string
 * of the request leaves these alone: text, signature and encrypted data must stay as they are.
 */
export function signedThinkingHolders(messages: unknown): Set<object> {
  const holders = new Set<object>();
  if (!Array.isArray(messages)) return holders;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' || block.type === 'redacted_thinking') holders.add(block);
      if (block.reasoningContent && typeof block.reasoningContent === 'object') holders.add(block.reasoningContent);
    }
  }
  return holders;
}
