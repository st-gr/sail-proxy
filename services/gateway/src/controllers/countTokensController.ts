/**
 * Controller for Anthropic token counting endpoint
 * POST /v1/messages/count_tokens
 */
import { Request, Response, NextFunction } from 'express';
import { getDefaultLogger } from '@libs/logger';
import tokenCountService from '../services/tokenCountService';
import anthropicTranslationService, { AnthropicMessagesPayload, AnthropicTool } from '../services/anthropicTranslationService';
import configService from '../services/configService';

const logger = getDefaultLogger();

interface ExtendedRequest extends Request {
  body: AnthropicMessagesPayload;
  headers: Record<string, string | string[] | undefined>;
}

interface CountTokensResponse {
  input_tokens: number;
}

/**
 * Handle POST /v1/messages/count_tokens
 * Counts tokens for an Anthropic Messages API request
 */
export const handleCountTokens = async (
  req: ExtendedRequest,
  res: Response,
  _next: NextFunction
): Promise<void> => {
  logger.info('CountTokensController', `Received count_tokens request for model: ${req.body?.model || 'unknown'}`);

  try {
    const anthropicBeta = req.header('anthropic-beta');
    const anthropicPayload = req.body;

    // Validate required fields
    if (!anthropicPayload.model) {
      logger.warn('CountTokensController', 'Missing model in request');
      res.json({ input_tokens: 1 } as CountTokensResponse);
      return;
    }

    if (!anthropicPayload.messages || !Array.isArray(anthropicPayload.messages)) {
      logger.warn('CountTokensController', 'Missing or invalid messages in request');
      res.json({ input_tokens: 1 } as CountTokensResponse);
      return;
    }

    // Apply model substitution (consistent with /messages endpoint behavior)
    const originalModel = anthropicPayload.model;
    const substitutedModel = configService.getSubstitutedModel('anthropic', originalModel);

    if (substitutedModel !== originalModel) {
      logger.info('CountTokensController', `Model substitution applied: ${originalModel} → ${substitutedModel}`);
    }

    // Translate Anthropic format to OpenAI format for token counting
    const openAIPayload = anthropicTranslationService.translateAnthropicToOpenAI(anthropicPayload);

    // Count tokens using substituted model (async to avoid blocking event loop)
    const tokenCount = await tokenCountService.getTokenCount(openAIPayload, substitutedModel);

    // Start with combined input and output tokens
    let finalTokenCount = tokenCount.input + tokenCount.output;

    // Apply tool overhead adjustments
    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false;

      // Check for MCP tools with claude-code beta header
      if (anthropicBeta?.startsWith('claude-code')) {
        mcpToolExist = anthropicPayload.tools.some((tool: AnthropicTool) =>
          tool.name?.startsWith('mcp__')
        );
      }

      // Only apply tool overhead if not MCP tools
      if (!mcpToolExist) {
        if (substitutedModel.startsWith('claude') || substitutedModel.startsWith('anthropic--')) {
          // Claude tool overhead: +346 tokens (per Anthropic docs)
          finalTokenCount += 346;
          logger.debug('CountTokensController', `Applied Claude tool overhead: +346 tokens`);
        } else if (substitutedModel.startsWith('grok')) {
          // Grok tool overhead: +480 tokens
          finalTokenCount += 480;
          logger.debug('CountTokensController', `Applied Grok tool overhead: +480 tokens`);
        }
      }
    }

    // Apply model-specific multipliers for accuracy adjustment
    if (substitutedModel.startsWith('claude') || substitutedModel.startsWith('anthropic--')) {
      finalTokenCount = Math.round(finalTokenCount * 1.15);
      logger.debug('CountTokensController', `Applied Claude multiplier: x1.15`);
    } else if (substitutedModel.startsWith('grok')) {
      finalTokenCount = Math.round(finalTokenCount * 1.03);
      logger.debug('CountTokensController', `Applied Grok multiplier: x1.03`);
    }

    logger.info('CountTokensController', `Token count for model ${originalModel}${substitutedModel !== originalModel ? ` (substituted to ${substitutedModel})` : ''}: ${finalTokenCount} (input: ${tokenCount.input}, output: ${tokenCount.output})`);

    res.json({ input_tokens: finalTokenCount } as CountTokensResponse);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('CountTokensController', `Error counting tokens: ${errorMessage}`);

    // On any error, return a minimal token count
    res.json({ input_tokens: 1 } as CountTokensResponse);
  }
};

export default {
  handleCountTokens,
};
