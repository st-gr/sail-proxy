/**
 * Service for loading and managing plugins
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { Request } from 'express';

interface PluginRule {
  id: string;
  match: any[];
  strategy: 'before' | 'after' | 'stream' | 'error';
  handler: (context: any) => Promise<any>;
}

interface HookDefinition {
  type: 'header' | 'json-path' | 'json-path-regex' | 'url-regex';
  name?: string;
  path?: string;
  equals?: any;
  from?: number;
  to?: number;
  regex?: string;
  flags?: string;
}

// Global plugin registry with performance caching
declare global {
  var pluginRegistry: Record<string, PluginRule>;
  var matcherCache: Map<string, HookDefinition>;
  var compiledRegexCache: Map<string, RegExp>;
}

global.pluginRegistry = global.pluginRegistry || {};
global.matcherCache = global.matcherCache || new Map();
global.compiledRegexCache = global.compiledRegexCache || new Map();

/**
 * Validates a plugin rule object structure
 * @param rule - Plugin rule object to validate
 * @returns Whether the rule is valid
 */
function validateRule(rule: any): rule is PluginRule {
  if (!rule || typeof rule !== 'object') {
    logger.error('PluginLoader', `Invalid rule: not an object`);
    return false;
  }

  // Check required fields
  if (!rule.id || typeof rule.id !== 'string') {
    logger.error('PluginLoader', `Invalid rule: missing or invalid 'id'`);
    return false;
  }

  if (!Array.isArray(rule.match)) {
    logger.error('PluginLoader', `Invalid rule '${rule.id}': 'match' must be an array`);
    return false;
  }

  if (!['before', 'after', 'stream', 'error'].includes(rule.strategy)) {
    logger.error('PluginLoader', `Invalid rule '${rule.id}': 'strategy' must be 'before', 'after', 'stream', or 'error'`);
    return false;
  }

  if (typeof rule.handler !== 'function') {
    logger.error('PluginLoader', `Invalid rule '${rule.id}': 'handler' must be a function`);
    return false;
  }

  return true;
}

/**
 * Load a single plugin file
 * @param filePath - Full path to plugin file
 * @returns Array of valid rule objects from the plugin
 */
function loadPlugin(filePath: string): PluginRule[] {
  try {
    logger.info('PluginLoader', `Loading plugin from ${filePath}`);
    
    // Load both .js and .ts files in development, .js files in production
    const ext = path.extname(filePath);
    if (ext !== '.js' && ext !== '.ts') {
      logger.debug('PluginLoader', `Skipping non-JavaScript/TypeScript file: ${filePath}`);
      return [];
    }
    
    // Skip .d.ts files and .js.map files
    if (filePath.endsWith('.d.ts') || filePath.endsWith('.js.map')) {
      logger.debug('PluginLoader', `Skipping definition/map file: ${filePath}`);
      return [];
    }
    
    // In production (when running from dist), prefer .js files
    // In development, prefer .ts files if both exist
    const isProduction = process.env.NODE_ENV === 'production' || filePath.includes('/dist/');
    const baseName = path.basename(filePath, ext);
    const dirPath = path.dirname(filePath);
    
    if (!isProduction && ext === '.js') {
      // Check if .ts version exists and prefer it in development
      const tsVersion = path.join(dirPath, baseName + '.ts');
      if (fs.existsSync(tsVersion)) {
        logger.debug('PluginLoader', `Skipping ${filePath} in favor of TypeScript version: ${tsVersion}`);
        return [];
      }
    }

    // Clear require cache to ensure fresh load
    delete require.cache[require.resolve(filePath)];
    
    // Load the plugin (handle both .js and .ts files)
    let plugin;
    if (ext === '.ts') {
      // Use ts-node to load TypeScript files directly
      try {
        // Check if ts-node is available
        try {
          require.resolve('ts-node/register');
        } catch (resolveError) {
          logger.warn('PluginLoader', `ts-node not available, cannot load TypeScript plugin: ${filePath}`);
          return [];
        }
        
        // Register ts-node if not already registered
        if (!process.env.TS_NODE_DEV && !require.extensions['.ts']) {
          process.env.TS_NODE_TRANSPILE_ONLY = 'true';
          require('ts-node/register');
          logger.debug('PluginLoader', 'Registered ts-node for TypeScript plugin loading');
        }
        
        plugin = require(filePath);
        logger.debug('PluginLoader', `Successfully loaded TypeScript plugin: ${filePath}`);
      } catch (tsError: any) {
        logger.warn('PluginLoader', `Failed to load TypeScript plugin ${filePath}: ${tsError.message}`);
        return [];
      }
    } else {
      plugin = require(filePath);
    }
    
    // Validate plugin exports array of rules
    if (!Array.isArray(plugin)) {
      logger.error('PluginLoader', `Plugin must export an array of rules: ${filePath} (got ${typeof plugin})`);
      return [];
    }
    
    // Validate each rule and filter out invalid ones
    const validRules = plugin.filter((rule: any) => validateRule(rule));
    
    logger.info('PluginLoader', `Loaded ${validRules.length} valid rules from ${filePath}`);
    return validRules;
  } catch (error: any) {
    logger.error('PluginLoader', `Error loading plugin ${filePath}: ${error.message}`);
    return [];
  }
}

/**
 * Load all plugins from a directory
 * @param pluginsDir - Path to plugins directory
 * @returns Map of rule IDs to rule objects
 */
export const loadAll = function(pluginsDir: string): Record<string, PluginRule> {
  try {
    // Ensure absolute path
    const absolutePluginsDir = path.isAbsolute(pluginsDir) 
      ? pluginsDir 
      : path.join(process.cwd(), pluginsDir);
    
    logger.info('PluginLoader', `Loading plugins from ${absolutePluginsDir}`);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(absolutePluginsDir)) {
      logger.info('PluginLoader', `Creating plugins directory: ${absolutePluginsDir}`);
      fs.mkdirSync(absolutePluginsDir, { recursive: true });
    }
    
    // Reset global caches for fresh load
    global.pluginRegistry = {};
    global.matcherCache.clear();
    global.compiledRegexCache.clear();
    
    // Read all files in the directory
    const files = fs.readdirSync(absolutePluginsDir);
    
    // Load each JavaScript file and collect all rules
    const allRules: PluginRule[] = [];
    files.forEach(file => {
      const filePath = path.join(absolutePluginsDir, file);
      const rules = loadPlugin(filePath);
      allRules.push(...rules);
    });
    
    // Register rules in the global registry, allowing multiple rules with same ID but different strategies
    allRules.forEach((rule, index) => {
      const uniqueKey = `${rule.id}_${rule.strategy}_${index}`;
      global.pluginRegistry[uniqueKey] = rule;
    });
    
    logger.info('PluginLoader', `Registered ${Object.keys(global.pluginRegistry).length} plugin rules`);
    return global.pluginRegistry;
  } catch (error: any) {
    logger.error('PluginLoader', `Error loading plugins: ${error.message}`);
    return {};
  }
};

/**
 * Get a plugin rule by ID and strategy
 * @param ruleId - Rule ID to look up
 * @param strategy - Strategy to filter by (optional)
 * @returns Rule object or null if not found
 */
export const getRule = function(ruleId: string, strategy: string | null = null): PluginRule | null {
  const rules = Object.values(global.pluginRegistry).filter(rule => rule.id === ruleId);
  
  if (rules.length === 0) {
    return null;
  }
  
  if (strategy) {
    const filteredRules = rules.filter(rule => rule.strategy === strategy);
    return filteredRules.length > 0 ? filteredRules[0] || null : null;
  }
  
  // If no strategy specified, return the first rule (backward compatibility)
  return rules[0] || null;
};

/**
 * Get all plugin rules by ID (for debugging/inspection)
 * @param ruleId - Rule ID to look up
 * @returns Array of rule objects with that ID
 */
export const getAllRulesById = function(ruleId: string): PluginRule[] {
  return Object.values(global.pluginRegistry).filter(rule => rule.id === ruleId);
};

/**
 * Match all rule IDs against the request with performance optimizations
 * @param req - Express request object
 * @param ruleIds - Array of rule IDs to match
 * @returns Whether all rules match
 */
export const matchAll = function(req: Request, ruleIds: string[] | any): boolean {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
    return false;
  }
  
  try {
    // Import configService when needed
    const configService = require('./configService');
    const config = configService.getConfig();
    const hookDefinitions = config?.api_config?.hookDefinitions || {};
    
    // All rules must match for success - early exit optimization
    for (const ruleId of ruleIds) {
      // Check cache first
      let hookDef = global.matcherCache.get(ruleId);
      
      if (!hookDef) {
        hookDef = hookDefinitions[ruleId];
        if (!hookDef) {
          logger.warn('PluginLoader', `Rule '${ruleId}' not found in hookDefinitions`);
          return false;
        }
        // Cache the hook definition
        global.matcherCache.set(ruleId, hookDef);
      }
      
      const matched = matchRuleOptimized(req, hookDef, ruleId);
      if (!matched) {
        return false; // Early exit on first non-match
      }
    }
    
    return true;
  } catch (error: any) {
    logger.error('PluginLoader', `Error matching rules: ${error.message}`);
    return false;
  }
};

/**
 * Match a single rule against the request with caching
 * @param req - Express request object
 * @param hookDef - Hook definition from config
 * @param ruleId - Rule ID for caching purposes
 * @returns Whether the rule matches
 */
function matchRuleOptimized(req: Request, hookDef: HookDefinition, ruleId: string): boolean {
  try {
    switch (hookDef.type) {
      case 'header':
        return matchHeader(req, hookDef);
      case 'json-path':
        return matchJsonPath(req, hookDef);
      case 'json-path-regex':
        return matchJsonPathRegexOptimized(req, hookDef, ruleId);
      case 'url-regex':
        return matchUrlRegexOptimized(req, hookDef, ruleId);
      default:
        logger.warn('PluginLoader', `Unknown hook type: ${hookDef.type}`);
        return false;
    }
  } catch (error: any) {
    logger.error('PluginLoader', `Error matching rule: ${error.message}`);
    return false;
  }
}


/**
 * Match header rule
 * @param req - Express request object
 * @param hookDef - Hook definition
 * @returns Whether the rule matches
 */
function matchHeader(req: Request, hookDef: HookDefinition): boolean {
  if (!hookDef.name) return false;
  
  const headerName = hookDef.name.toLowerCase();
  const headerValue = req.headers[headerName];
  
  if (headerValue === undefined) {
    return false;
  }
  
  if (hookDef.equals !== undefined) {
    return headerValue === hookDef.equals;
  }
  
  if (hookDef.from !== undefined && hookDef.to !== undefined) {
    const numValue = parseInt(String(headerValue), 10);
    return !isNaN(numValue) && numValue >= hookDef.from && numValue <= hookDef.to;
  }
  
  return true;
}

/**
 * Match JSON path rule
 * @param req - Express request object
 * @param hookDef - Hook definition
 * @returns Whether the rule matches
 */
function matchJsonPath(req: Request, hookDef: HookDefinition): boolean {
  if (!req.body || !hookDef.path) {
    return false;
  }
  
  const path = hookDef.path;
  let value: any = req.body;
  
  // Simple dot notation path resolution
  const segments = path.replace(/^\$\./, '').split('.');
  for (const segment of segments) {
    if (value === undefined) {
      return false;
    }
    value = value[segment];
  }
  
  if (value === undefined) {
    return false;
  }
  
  if (hookDef.equals !== undefined) {
    return value === hookDef.equals;
  }
  
  return true;
}

/**
 * Match JSON path regex rule with regex caching
 * @param req - Express request object
 * @param hookDef - Hook definition
 * @param ruleId - Rule ID for caching
 * @returns Whether the rule matches
 */
function matchJsonPathRegexOptimized(req: Request, hookDef: HookDefinition, ruleId: string): boolean {
  if (!req.body || !hookDef.path || !hookDef.regex) {
    return false;
  }
  
  const path = hookDef.path;
  let value: any = req.body;
  
  // Simple dot notation path resolution
  const segments = path.replace(/^\$\./, '').split('.');
  for (const segment of segments) {
    if (value === undefined) {
      return false;
    }
    
    if (Array.isArray(value)) {
      // If we encounter an array and the next segment is numeric, use it as index
      if (!isNaN(parseInt(segment, 10))) {
        value = value[parseInt(segment, 10)];
      } else {
        // Otherwise check each array element
        for (let i = 0; i < value.length; i++) {
          const element = value[i];
          if (element && element[segment] !== undefined) {
            value = element[segment];
            break;
          }
        }
      }
    } else if (typeof value === 'object') {
      value = value[segment];
    } else {
      return false;
    }
  }
  
  // Use cached regex for performance
  const regexKey = `${ruleId}_${hookDef.regex}_${hookDef.flags || ''}`;
  let regex = global.compiledRegexCache.get(regexKey);

  if (!regex) {
    regex = new RegExp(hookDef.regex, hookDef.flags || '');
    global.compiledRegexCache.set(regexKey, regex);
  }

  // Handle different value types
  if (typeof value === 'string') {
    return regex.test(value);
  }

  // For arrays, check each element individually (early exit on first match)
  // This avoids stringifying the entire array which would be slow for large arrays
  if (Array.isArray(value)) {
    for (const element of value) {
      if (element === null || element === undefined) continue;

      // For objects in the array, stringify just this one element
      if (typeof element === 'object') {
        try {
          if (regex.test(JSON.stringify(element))) {
            return true;
          }
        } catch (e) {
          continue;
        }
      } else if (typeof element === 'string') {
        if (regex.test(element)) {
          return true;
        }
      }
    }
    return false;
  }

  // For single objects, stringify just that object
  if (typeof value === 'object' && value !== null) {
    try {
      return regex.test(JSON.stringify(value));
    } catch (e) {
      return false;
    }
  }

  return false;
}


/**
 * Match URL regex rule with regex caching
 * @param req - Express request object
 * @param hookDef - Hook definition
 * @param ruleId - Rule ID for caching
 * @returns Whether the rule matches
 */
function matchUrlRegexOptimized(req: Request, hookDef: HookDefinition, ruleId: string): boolean {
  if (!hookDef.regex) {
    return false;
  }
  
  const url = req.url || '';
  
  // Use cached regex for performance
  const regexKey = `${ruleId}_url_${hookDef.regex}_${hookDef.flags || ''}`;
  let regex = global.compiledRegexCache.get(regexKey);
  
  if (!regex) {
    regex = new RegExp(hookDef.regex, hookDef.flags || '');
    global.compiledRegexCache.set(regexKey, regex);
  }
  
  return regex.test(url);
}

/**
 * Reload all plugins - clears caches and loads fresh
 * Used when configuration is updated to ensure fresh plugin rules
 * @param pluginsDir - Directory to load plugins from
 */
export const reloadAll = function(pluginsDir: string = './plugins'): void {
  logger.info('PluginLoader', 'Reloading plugins due to config update');
  
  // Clear all global caches for fresh load
  global.pluginRegistry = {};
  global.matcherCache.clear();
  global.compiledRegexCache.clear();
  
  // Load fresh plugins with updated configuration
  loadAll(pluginsDir);
  
  const ruleCount = Object.keys(global.pluginRegistry).length;
  logger.info('PluginLoader', `Plugins reloaded successfully: ${ruleCount} rules loaded`);
};

export default {
  loadAll,
  getRule,
  getAllRulesById,
  matchAll,
  validateRule,
  reloadAll
};