/**
 * Strip Cache Control Scope Plugin
 *
 * Removes the 'scope' field from cache_control objects in requests.
 *
 * Background:
 * Claude Code 2.1.92+ sends cache_control with scope: "global" on system messages
 * when the prompt-caching-scope-2026-01-05 beta feature is enabled. SAP AI Core
 * rejects this with: "system.2.cache_control.ephemeral.scope: Extra inputs are not permitted"
 *
 * This plugin strips the scope field before forwarding to SAP AI Core, while the
 * beta header itself is filtered separately via api_config.json excluded_beta_headers.
 *
 * Applied to: Claude 4.5 Sonnet/Opus, Claude 4.6 Sonnet/Opus (via api_config.json hooks)
 * Strategy: before (modifies request before sending upstream)
 *
 * @see api_config.json - Hook configuration and excluded_beta_headers
 * @see chapter-13-plugin-system.md - Plugin system documentation
 */

import { Request, Response } from 'express';

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
 * Recursively removes 'scope' from any cache_control object in the payload
 */
function stripScopeFromCacheControl(obj: any, path: string, logger: Logger): number {
  let count = 0;

  if (obj === null || typeof obj !== 'object') {
    return count;
  }

  // If this object has a cache_control property with a scope, remove the scope
  if (obj.cache_control && typeof obj.cache_control === 'object' && 'scope' in obj.cache_control) {
    logger.debug(`Removing scope="${obj.cache_control.scope}" from cache_control at ${path}`);
    delete obj.cache_control.scope;
    count++;
  }

  // Recurse into arrays
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      count += stripScopeFromCacheControl(item, `${path}[${index}]`, logger);
    });
  } else {
    // Recurse into object properties
    for (const key of Object.keys(obj)) {
      if (key !== 'cache_control') { // Already handled above
        count += stripScopeFromCacheControl(obj[key], `${path}.${key}`, logger);
      }
    }
  }

  return count;
}

async function beforeHandler({ req, utils }: PluginContext): Promise<PluginResult> {
  const logger = utils.logger;

  try {
    if (!req.body) {
      logger.debug('No request body found');
      return { stop: false };
    }

    const requestBody = req.body as any;
    let totalRemoved = 0;

    // Strip scope from system array
    if (Array.isArray(requestBody.system)) {
      totalRemoved += stripScopeFromCacheControl(requestBody.system, 'system', logger);
    }

    // Strip scope from messages array
    if (Array.isArray(requestBody.messages)) {
      totalRemoved += stripScopeFromCacheControl(requestBody.messages, 'messages', logger);
    }

    // Strip scope from tools array (tool definitions can have cache_control)
    if (Array.isArray(requestBody.tools)) {
      totalRemoved += stripScopeFromCacheControl(requestBody.tools, 'tools', logger);
    }

    if (totalRemoved > 0) {
      logger.info(`Removed 'scope' from ${totalRemoved} cache_control object(s)`);
    } else {
      logger.debug('No cache_control.scope fields found to remove');
    }

    return { stop: false };

  } catch (error: any) {
    logger.error(`Error in stripCacheControlScope plugin: ${error.message}`, {
      stack: error.stack
    });
    return { stop: false };
  }
}

const pluginRules = [
  {
    id: "stripCacheControlScope",
    match: [],
    strategy: "before",
    handler: beforeHandler
  }
];

export = pluginRules;
