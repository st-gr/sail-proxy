/**
 * The client's own prompt-caching breakpoints on /anthropic/v1/messages, carried into the SAP
 * orchestration payload.
 *
 * The builder used to flatten system prompts and text blocks into plain strings, which dropped
 * every `cache_control` and so nothing was ever cached on the orchestration path. Orchestration
 * honours a breakpoint on a content block of a template message — a message whose content is an
 * array of `{type:'text', text, cache_control}` blocks (test/fixtures/orchestration/
 * cache-probe-result.md). So a message keeps its blocks only when the client marked one of them;
 * anything unmarked stays the string it always was, and the payload of a request that marks
 * nothing is unchanged.
 *
 * Caching on /anthropic is opt-in, as on Anthropic's own API: no breakpoint is ever invented here
 * (unlike the Responses bridge, cacheBreakpoints.ts, which inserts them for codex). Tools are not
 * marked: no capture shows orchestration forwarding a breakpoint on prompt.tools.
 */
import { getDefaultLogger } from '@libs/logger';
import { extractSystemPromptText } from './anthropicUtils';

const logger = getDefaultLogger();

/** Anthropic's hard limit on breakpoints per request. */
export const MAX_BREAKPOINTS = 4;

export type OrchestrationCacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' };

export interface MarkedTextBlock {
  type: 'text';
  text: string;
  cache_control?: OrchestrationCacheControl;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object';

/** True when any block carries a `cache_control` object. */
export function hasCacheControl(blocks: unknown): boolean {
  return Array.isArray(blocks) && blocks.some((b) => isObject(b) && isObject(b.cache_control));
}

/**
 * The breakpoint orchestration receives: always `{type:'ephemeral'}` (the default 5-minute TTL).
 * `scope` and anything else are dropped, and so is `ttl`: orchestration would honour '1h'
 * (test/fixtures/orchestration/anthropic-cache-live-result.md, arm C), but the cost path books
 * every cache write at one rate and Anthropic bills 1h writes higher, so they would be
 * under-reported. Forward it once usage pricing distinguishes the two.
 */
export function toCacheControl(_raw: any): OrchestrationCacheControl {
  return { type: 'ephemeral' };
}

/** True when the request's system prompt or any message block (tool_result content included) is marked. */
export function requestHasCacheControl(req: { system?: unknown; messages?: unknown }): boolean {
  if (hasCacheControl(req.system)) return true;
  if (!Array.isArray(req.messages)) return false;
  return req.messages.some((m: any) => Array.isArray(m?.content)
    && (hasCacheControl(m.content) || m.content.some((b: any) => isObject(b) && hasCacheControl(b.content))));
}

/** The request with every `cache_control` removed from system and message blocks; nothing else changes. */
export function withoutCacheControl<T extends { system?: any; messages?: any }>(req: T): T {
  const strip = (blocks: any): any => (Array.isArray(blocks)
    ? blocks.map((b: any) => {
      if (!isObject(b)) return b;
      const { cache_control, ...rest } = b;
      return Array.isArray(rest.content) ? { ...rest, content: strip(rest.content) } : rest;
    })
    : blocks);
  return {
    ...req,
    system: strip(req.system),
    messages: Array.isArray(req.messages)
      ? req.messages.map((m: any) => (isObject(m) && Array.isArray(m.content) ? { ...m, content: strip(m.content) } : m))
      : req.messages,
  };
}

/**
 * Anthropic refuses empty text blocks, which the flattened string used to hide. In a marked turn's
 * blocks, drop empty text blocks; an empty block's breakpoint moves to the nearest earlier text
 * block, or is dropped when there is none.
 */
export function dropEmptyTextBlocks(blocks: any[]): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    if (!(isObject(b) && b.type === 'text' && !b.text)) { out.push(b); continue; }
    if (!isObject(b.cache_control)) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]?.type === 'text') { out[i] = { ...out[i], cache_control: b.cache_control }; break; }
    }
  }
  return out;
}

/** One text block per Anthropic text block, in order, keeping its breakpoint; other blocks skipped. */
export function markedTextBlock(block: Record<string, any>): MarkedTextBlock {
  const out: MarkedTextBlock = { type: 'text', text: typeof block.text === 'string' ? block.text : '' };
  if (isObject(block.cache_control)) out.cache_control = toCacheControl(block.cache_control);
  return out;
}

export function markedTextBlocks(blocks: any[]): MarkedTextBlock[] {
  return dropEmptyTextBlocks(blocks.filter((b) => isObject(b) && b.type === 'text').map(markedTextBlock));
}

/** The system message's content: the flattened string unless the client marked a system block. */
export function systemContent(system: Parameters<typeof extractSystemPromptText>[0]): string | MarkedTextBlock[] {
  if (Array.isArray(system) && hasCacheControl(system)) return markedTextBlocks(system);
  return extractSystemPromptText(system);
}

/**
 * Move a breakpoint the client put on a tool result (template[fromIndex], a `tool` message) to the
 * last non-empty text of the nearest earlier message that is not a `tool` message. Orchestration
 * refuses array content on `tool` messages (anthropic-cache-live-result.md, arms B/B2) but takes
 * marked text blocks on user, system and assistant turns, tool_calls included (arms A, D, E). The
 * cached prefix then ends earlier than the client asked — in a tool loop whose assistant turns
 * hold only tool calls, at the turn that started the loop; with no such message the breakpoint is
 * dropped.
 */
export function relocateBreakpoint(template: any[], fromIndex: number, cacheControl: OrchestrationCacheControl): any[] {
  for (let j = fromIndex - 1; j >= 0; j--) {
    const msg = template[j];
    if (!msg || msg.role === 'tool') continue;
    if (typeof msg.content === 'string') {
      if (!msg.content) continue;
      const next = [...template];
      next[j] = { ...msg, content: [{ type: 'text', text: msg.content, cache_control: cacheControl }] };
      return next;
    }
    if (Array.isArray(msg.content)) {
      const k = msg.content.map((b: any) => isObject(b) && b.type === 'text' && !!b.text).lastIndexOf(true);
      if (k < 0) continue;
      const next = [...template];
      next[j] = { ...msg, content: msg.content.map((b: any, i: number) => (i === k ? { ...b, cache_control: cacheControl } : b)) };
      return next;
    }
  }
  logger.debug('AnthropicCacheBreakpoints', 'Dropped a tool_result cache breakpoint: no earlier message can hold it');
  return template;
}

/**
 * At most `max` breakpoints across the template, in message order. Extra ones are removed from the
 * earliest: a later breakpoint covers a longer prefix, and Anthropic refuses more than four.
 */
export function capBreakpoints(template: any[], max = MAX_BREAKPOINTS): any[] {
  const marked: Array<{ m: number; b: number }> = [];
  template.forEach((msg, m) => {
    if (!Array.isArray(msg?.content)) return;
    msg.content.forEach((block: any, b: number) => { if (isObject(block?.cache_control)) marked.push({ m, b }); });
  });
  if (marked.length <= max) return template;
  logger.warn('AnthropicCacheBreakpoints', `Client sent ${marked.length} cache breakpoints; keeping the last ${max}`);
  const drop = new Set(marked.slice(0, marked.length - max).map(({ m, b }) => `${m}:${b}`));
  return template.map((msg, m) => {
    if (!Array.isArray(msg?.content) || !msg.content.some((_: any, b: number) => drop.has(`${m}:${b}`))) return msg;
    return {
      ...msg,
      content: msg.content.map((block: any, b: number) => {
        if (!drop.has(`${m}:${b}`)) return block;
        const { cache_control, ...rest } = block;
        return rest;
      }),
    };
  });
}
