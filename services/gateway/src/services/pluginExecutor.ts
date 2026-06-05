/**
 * Service for executing plugin rules
 */
import { Request, Response } from 'express';
import pluginLoader from './pluginLoader';
import * as sseWriter from '../utils/sseWriter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Type definitions for plugin interfaces
interface PluginLogger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

interface SSEEvent {
  event: string;
  data: any;
}

interface PluginUtils {
  sseWriter?: (responseStream: Response, events: SSEEvent | SSEEvent[]) => Promise<void>;
  logger: PluginLogger;
}

interface PluginBeforeContext {
  req: Request;
  res: Response;
  utils: PluginUtils;
}

interface PluginAfterContext {
  req: Request;
  res: Response;
  upstreamResponse: any;
  utils: PluginUtils;
}

interface PluginStreamContext {
  req: Request;
  res: Response;
  chunk: Buffer;
  utils: PluginUtils;
}

interface PluginBeforeResult {
  stop: boolean;
  response?: any;
}

type HookMatch = string[] | { [key: string]: any; };

interface HookCallback {
  id: string;
}

interface HookRequest {
  match: HookMatch;
  callback: HookCallback;
}

interface Hook {
  request?: HookRequest;
}

type HookArray = Hook[];

interface PluginRule {
  handler: (context: any) => Promise<any>;
  strategy: string;
}

/**
 * Execute 'before' strategy plugins based on config hooks
 * @param req - Express request object
 * @param res - Express response object
 * @param hooks - Hook configuration(s) from api_config.json (single hook or array)
 * @returns Object with stop flag and optional response
 */
export async function executeBeforePlugins(
  req: Request, 
  res: Response, 
  hooks: Hook | HookArray
): Promise<PluginBeforeResult> {
  // Default response if no plugins match or execute
  const defaultResponse: PluginBeforeResult = { stop: false };

  // Normalize to array format
  const hookArray = Array.isArray(hooks) ? hooks : [hooks];
  
  // Execute hooks sequentially until one returns stop: true
  for (const hook of hookArray) {
    if (!hook || !hook.request || !hook.request.match || !hook.request.callback) {
      continue;
    }

    const { match, callback } = hook.request;

    // Check if all rules match - early exit if not
    const allMatch = pluginLoader.matchAll(req, match);
    if (!allMatch) {
      continue;
    }

    // Get the callback rule ID and lookup the plugin with 'before' strategy
    const ruleId = callback.id;
    const rule: PluginRule | null = pluginLoader.getRule(ruleId, 'before');

    if (!rule) {
      logger.warn('PluginExecutor', `Plugin rule '${ruleId}' with strategy 'before' not found`);
      continue;
    }

    // Execute the plugin handler
    try {
      logger.info('PluginExecutor', `Executing 'before' plugin: ${ruleId}`);

      // Create the logger object for the plugin
      const pluginLogger: PluginLogger = {
        error: (message: string, meta?: any) => logger.error(ruleId, message, meta),
        warn: (message: string, meta?: any) => logger.warn(ruleId, message, meta),
        info: (message: string, meta?: any) => logger.info(ruleId, message, meta),
        debug: (message: string, meta?: any) => logger.debug(ruleId, message, meta),
        trace: (message: string, meta?: any) => logger.trace(ruleId, message, meta)
      };

      // Create utilities object for the handler
      const utils: PluginUtils = {
        sseWriter: async (responseStream: Response, events: SSEEvent | SSEEvent[]) => {
          if (Array.isArray(events)) {
            for (const evt of events) {
              sseWriter.writeEventStream(responseStream, evt.event, evt.data);
            }
          } else {
            sseWriter.writeEventStream(responseStream, events.event, events.data);
          }
          if (rule.strategy === 'before' && responseStream.writable && !responseStream.destroyed) {
            responseStream.end();
            logger.debug('PluginExecutor', 'SSE stream ended by utils.sseWriter in BEFORE plugin', { component: ruleId });
          }
        },
        logger: pluginLogger
      };

      // Defensive check (for debugging, can be removed later)
      if (!utils.logger || typeof utils.logger.info !== 'function') {
        logger.error('PluginExecutor', `CRITICAL: utils.logger or utils.logger.info is not correctly defined before calling plugin ${ruleId}. utils.logger: ${JSON.stringify(utils.logger)}`);
        continue;
      }

      // Execute the plugin handler
      const context: PluginBeforeContext = { req, res, utils };
      const result: any = await rule.handler(context);

      // Handler must return { stop: true/false, response? }
      if (!result || typeof result !== 'object') {
        logger.error('PluginExecutor', `Plugin '${ruleId}' returned invalid result`);
        continue;
      }

      if (result.stop) {
        logger.info('PluginExecutor', `Plugin '${ruleId}' short-circuited request`);
        return result as PluginBeforeResult;
      }

      // Continue to next hook if this one didn't stop execution
    } catch (error: any) {
      // Log the full error object for more details, including stack
      logger.error('PluginExecutor', `Error executing plugin '${ruleId}': ${error.message}. Stack: ${error.stack}`);
      continue;
    }
  }
  
  return defaultResponse;
}

/**
 * Execute 'after' strategy plugins
 * @param req - Express request object
 * @param res - Express response object
 * @param upstreamResponse - Response from upstream service
 * @param hooks - Hook configuration(s) from api_config.json (single hook or array)
 * @returns Modified response object or original if no plugins match
 */
export async function executeAfterPlugins(
  req: Request, 
  res: Response, 
  upstreamResponse: any, 
  hooks: Hook | HookArray
): Promise<any> {
  let finalResponse = upstreamResponse;

  // Normalize to array format
  const hookArray = Array.isArray(hooks) ? hooks : [hooks];
  
  // Execute hooks sequentially, chaining responses
  for (const hook of hookArray) {
    if (!hook || !hook.request || !hook.request.match || !hook.request.callback) {
      continue;
    }

    const { match, callback } = hook.request;

    const allMatch = pluginLoader.matchAll(req, match);
    if (!allMatch) {
      continue;
    }

    const ruleId = callback.id;
    const rule: PluginRule | null = pluginLoader.getRule(ruleId, 'after');

    if (!rule) {
      logger.warn('PluginExecutor', `Plugin rule '${ruleId}' with strategy 'after' not found`);
      continue;
    }

    try {
      logger.info('PluginExecutor', `Executing 'after' plugin: ${ruleId}`);

      const pluginLogger: PluginLogger = {
        error: (message: string, meta?: any) => logger.error(ruleId, message, meta),
        warn: (message: string, meta?: any) => logger.warn(ruleId, message, meta),
        info: (message: string, meta?: any) => logger.info(ruleId, message, meta),
        debug: (message: string, meta?: any) => logger.debug(ruleId, message, meta),
        trace: (message: string, meta?: any) => logger.trace(ruleId, message, meta)
      };

      const utils: PluginUtils = {
        sseWriter: async (responseStream: Response, events: SSEEvent | SSEEvent[]) => {
          if (Array.isArray(events)) {
            for (const evt of events) {
              sseWriter.writeEventStream(responseStream, evt.event, evt.data);
            }
          } else {
            sseWriter.writeEventStream(responseStream, events.event, events.data);
          }
        },
        logger: pluginLogger
      };

      if (!utils.logger || typeof utils.logger.info !== 'function') {
        logger.error('PluginExecutor', `CRITICAL: utils.logger or utils.logger.info is not correctly defined before calling plugin ${ruleId} (after strategy). utils.logger: ${JSON.stringify(utils.logger)}`);
        continue;
      }

      const context: PluginAfterContext = { req, res, upstreamResponse: finalResponse, utils };
      const result: any = await rule.handler(context);

      if (result === undefined) {
        logger.error('PluginExecutor', `Plugin '${ruleId}' returned undefined`);
        continue;
      }

      logger.info('PluginExecutor', `Plugin '${ruleId}' modified response`);
      finalResponse = result; // Chain the response for next plugin
    } catch (error: any) {
      logger.error('PluginExecutor', `Error executing plugin '${ruleId}': ${error.message}. Stack: ${error.stack}`);
      continue;
    }
  }
  
  return finalResponse;
}

/**
 * Execute 'stream' strategy plugins for streaming responses
 * @param req - Express request object
 * @param res - Express response object
 * @param chunk - Stream chunk
 * @param hooks - Hook configuration(s) from api_config.json (single hook or array)
 * @returns Modified or original chunk
 */
export async function executeStreamPlugins(
  req: Request, 
  res: Response, 
  chunk: Buffer, 
  hooks: Hook | HookArray
): Promise<Buffer> {
  logger.debug('PluginExecutor', `executeStreamPlugins called with chunk size: ${chunk ? chunk.length : 'undefined'}`);
  
  let finalChunk = chunk;
  
  // Normalize to array format
  const hookArray = Array.isArray(hooks) ? hooks : [hooks];
  
  // Execute hooks sequentially, chaining chunk modifications
  for (const hook of hookArray) {
    if (!hook || !hook.request || !hook.request.match || !hook.request.callback) {
      continue;
    }

    const { match, callback } = hook.request;

    const allMatch = pluginLoader.matchAll(req, match);
    if (!allMatch) {
      continue;
    }

    const ruleId = callback.id;
    const rule: PluginRule | null = pluginLoader.getRule(ruleId, 'stream');

    if (!rule) {
      logger.debug('PluginExecutor', `Plugin rule '${ruleId}' with strategy 'stream' not found`);
      continue;
    }

    try {
      logger.debug('PluginExecutor', `Executing 'stream' plugin: ${ruleId}`);

      const pluginLogger: PluginLogger = {
        error: (message: string, meta?: any) => logger.error(ruleId, message, meta),
        warn: (message: string, meta?: any) => logger.warn(ruleId, message, meta),
        info: (message: string, meta?: any) => logger.info(ruleId, message, meta),
        debug: (message: string, meta?: any) => logger.debug(ruleId, message, meta),
        trace: (message: string, meta?: any) => logger.trace(ruleId, message, meta)
      };

      const utils: PluginUtils = {
        logger: pluginLogger
      };

      const context: PluginStreamContext = { req, res, chunk: finalChunk, utils };
      const result: any = await rule.handler(context);
      
      // Handle enhanced return format from stream plugins
      if (result && typeof result === 'object' && result.chunk !== undefined) {
        // Plugin returned enhanced format with captured events
        if (result.capturedEvents && Array.isArray(result.capturedEvents) && result.capturedEvents.length > 0) {
          // Initialize req.capturedEvents if not already present (without mutating in plugin)
          if (!(req as any).capturedEvents) {
            (req as any).capturedEvents = [];
          }
          // Add captured events to req.capturedEvents for service consumption
          (req as any).capturedEvents.push(...result.capturedEvents);
          logger.debug('PluginExecutor', `Added ${result.capturedEvents.length} captured events to req, total: ${(req as any).capturedEvents.length}`);
        }
        finalChunk = result.chunk;
      } else {
        finalChunk = result || finalChunk;
      }
    } catch (error: any) {
      logger.error('PluginExecutor', `Error executing stream plugin '${ruleId}': ${error.message}`);
      continue;
    }
  }
  
  return finalChunk;
}

export const pluginExecutor = {
  executeBeforePlugins,
  executeAfterPlugins,
  executeStreamPlugins
};

export default pluginExecutor;