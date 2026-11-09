/**
 * Repair Tool Blocks Plugin
 *
 * Fixes tool_use and tool_result content blocks that are missing required fields
 * (id, name, tool_use_id) due to Claude Code CLI context compression.
 *
 * Background:
 * Claude Code CLI applies context compression in long conversations, which can strip
 * `id` and `name` fields from older `tool_use` content blocks and `tool_use_id` from
 * corresponding `tool_result` blocks. The native Anthropic API tolerates this, but
 * SAP AI Core / AWS Bedrock does not, returning:
 *   400: messages.N.content.M.tool_use.id: Field required
 *
 * This plugin detects and repairs these blocks before forwarding to SAP AI Core:
 * - Adds synthetic `id` (toolu_placeholder_XXXX) to tool_use blocks missing it
 * - Adds `name: "unknown_tool"` to tool_use blocks missing it
 * - Links orphaned tool_result blocks to the repaired tool_use blocks by position
 *
 * Two-phase design for performance:
 * - Phase 1: Fast pre-scan — checks for broken blocks with minimal overhead
 * - Phase 2: Repair — only runs if Phase 1 detects problems
 *
 * Applied to: Claude 4.5/4.6 models (via api_config.json hooks, matched on header:x-app=cli)
 * Strategy: before (modifies request before sending upstream)
 *
 * @see api_config.json - Hook configuration
 * @see chapter-13-plugin-system.md - Plugin system documentation
 */

import { Request, Response } from 'express';
import * as crypto from 'crypto';

interface PluginContext {
  req: Request;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: any;
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
 * Phase 1: Fast pre-scan — returns true if any tool_use block is missing `id`
 */
function hasBrokenToolBlocks(messages: any[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j].type === 'tool_use' && !msg.content[j].id) {
        return true;
      }
    }
  }
  return false;
}

async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const logger = utils.logger;

  try {
    if (!req.body || !Array.isArray((req.body as any).messages)) {
      logger.debug('No messages array found in request body');
      return { stop: false };
    }

    const messages = (req.body as any).messages;

    // Phase 1: Fast pre-scan
    if (!hasBrokenToolBlocks(messages)) {
      logger.debug('No broken tool blocks found');
      return { stop: false };
    }

    // Phase 2: Repair
    let repairedToolUseCount = 0;
    let repairedToolResultCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      // Track synthetic IDs by tool_use ordinal position within this message
      const syntheticIds: Map<number, string> = new Map();
      let toolUseIndex = 0;

      for (let j = 0; j < message.content.length; j++) {
        const block = message.content[j];
        if (block.type !== 'tool_use') continue;

        if (!block.id) {
          const syntheticId = `toolu_placeholder_${crypto.randomBytes(6).toString('hex')}`;
          block.id = syntheticId;
          syntheticIds.set(toolUseIndex, syntheticId);
          repairedToolUseCount++;
          logger.info(`Repaired tool_use at messages[${i}].content[${j}]: added id="${syntheticId}"`);
        }
        if (!block.name) {
          block.name = 'unknown_tool';
          logger.info(`Repaired tool_use at messages[${i}].content[${j}]: added name="unknown_tool"`);
        }
        toolUseIndex++;
      }

      // Link orphaned tool_result blocks in the next message
      if (syntheticIds.size > 0 && i + 1 < messages.length) {
        const nextMessage = messages[i + 1];
        if (Array.isArray(nextMessage.content)) {
          let toolResultIndex = 0;
          for (let k = 0; k < nextMessage.content.length; k++) {
            const block = nextMessage.content[k];
            if (block.type !== 'tool_result') continue;

            if (!block.tool_use_id) {
              const matchingId = syntheticIds.get(toolResultIndex);
              if (matchingId) {
                block.tool_use_id = matchingId;
                repairedToolResultCount++;
                logger.info(`Repaired tool_result at messages[${i + 1}].content[${k}]: linked to tool_use_id="${matchingId}"`);
              }
            }
            toolResultIndex++;
          }
        }
      }
    }

    logger.info(`Repaired ${repairedToolUseCount} tool_use block(s) and ${repairedToolResultCount} tool_result block(s)`);
    return { stop: false };

  } catch (error: any) {
    logger.error(`Error in repairToolBlocks plugin: ${error.message}`, {
      stack: error.stack
    });
    return { stop: false };
  }
}

const pluginRules = [
  {
    id: "repairToolBlocks",
    match: [],
    strategy: "before",
    handler: beforeHandler
  }
];

export = pluginRules;
