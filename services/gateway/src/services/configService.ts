/**
 * Service to manage API provider configurations including model substitutions and streaming emulation
 */
import * as fs from 'fs';
import * as path from 'path';
import axios, { AxiosError } from 'axios';
import { ValidationTokenUtils } from '../../../../libs/aws-token-validation/validation-token';
import { adminServiceClient } from '../clients/adminServiceClient';
import pluginLoader from './pluginLoader';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { selectPluginCacheKeysToClear } from '../utils/pluginCacheSelector';
import { resolveUnsupportedParams } from '../utils/unsupportedParamFilter';
import { resolveMaxWebSearches, DEFAULT_MAX_WEB_SEARCHES } from '../plugins/webSearch/searchCap';
import { resolveResultCacheTtlSeconds, resolveResultCacheMaxEntries, DEFAULT_RESULT_CACHE_TTL_SECONDS, DEFAULT_RESULT_CACHE_MAX_ENTRIES } from '../plugins/hostedTool/resultCacheConfig';
import { resolveNamespaceToolMode, DEFAULT_NAMESPACE_TOOL_MODE, NamespaceToolMode } from '../plugins/namespaceTools/adapter';
import { CustomToolMode, resolveCustomToolMode, DEFAULT_CUSTOM_TOOL_MODE } from '../plugins/customTools/adapter';
import {
  ToolSearchMode, resolveToolSearchMode, DEFAULT_TOOL_SEARCH_MODE,
  resolveHoistDiscoveredTools, DEFAULT_HOIST_DISCOVERED_TOOLS,
} from '../plugins/toolSearch/adapter';

interface ModelSubstitution {
  from: string;
  to: string;
}

interface ProviderConfig {
  substitute_models?: ModelSubstitution[];
  emulate_streaming_for_models?: string[];
  anthropic_bedrock_version?: string;
  openai_deployment_api_version?: string;
}

interface TimeoutConfig {
  default?: number;
  streaming?: number;
}

interface ModelHooks {
  [subpath: string]: any;
}

interface CachePricing {
  cacheReadInputCostPer1K?: string;
  cacheCreationInputCostPer1K?: string;
}

interface ModelListChange {
  hooks?: ModelHooks;
  subpaths_native?: string[];
  subpaths_emulated?: string[];
  streamingSupported?: boolean;
  cachePricing?: CachePricing;
  [key: string]: any; // Allow additional properties
}

interface ModelListChanges {
  [modelId: string]: ModelListChange;
}

interface LoggingConfig {
  defaultLevel?: string;
  components?: Record<string, string>;
  log_folder_path?: string;
  payload_logging_enabled?: boolean;
}

interface ApiConfig {
  [provider: string]: any;
  model_list_changes?: ModelListChanges;
  timeouts?: TimeoutConfig;
  logging?: LoggingConfig;
  default_models?: {
    [provider: string]: string;
  };
}

interface Config {
  api_config: ApiConfig;
}

// Default configuration path
const CONFIG_FILE_PATH = process.env.CONFIG_FILE_PATH || path.join(process.cwd(), 'api_config.json');

// Backup configuration
const BACKUP_DIR = process.env.CONFIG_BACKUP_DIR || path.join(process.cwd(), 'config-backups');
const MAX_BACKUP_FILES = parseInt(process.env.MAX_CONFIG_BACKUPS || '10');
const BACKUP_RETENTION_DAYS = parseInt(process.env.CONFIG_BACKUP_RETENTION_DAYS || '30');

// Admin Service configuration
const ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL || 'http://localhost:4004';
const ADMIN_SERVICE_TIMEOUT = parseInt(process.env.ADMIN_SERVICE_TIMEOUT || '10000');
const CONFIG_FETCH_RETRIES = parseInt(process.env.CONFIG_FETCH_RETRIES || '8');
const CONFIG_FETCH_INITIAL_DELAY = parseInt(process.env.CONFIG_FETCH_INITIAL_DELAY || '2000');
const CONFIG_FETCH_MAX_DELAY = parseInt(process.env.CONFIG_FETCH_MAX_DELAY || '30000');

// Valkey configuration for event-driven updates
const VALKEY_URL = process.env.VALKEY_URL;
let valkeySubscriber: any = null;
let valkeyPublisher: any = null;
let valkeyInitialized = false;

// Event channels
// Env-overridable so integration tests can isolate a spawned gateway on a
// test-scoped channel instead of broadcasting on the production channel (a
// test publishing here once wiped the live gateway's config mid-session —
// Valkey pub/sub channels are global, they are NOT scoped by database index).
const CONFIG_CHANGE_CHANNEL = process.env.CONFIG_CHANGE_CHANNEL || 'sap-llm-gateway:config-changed';
const MODEL_LIST_CHANNEL = 'sap-llm-gateway:model-list-updated';
const STARTUP_READY_CHANNEL = 'sap-llm-gateway:service-ready';

// Startup coordination
let configurationReceived = false;
let modelListPublished = false;
let startupEventHandlers: Array<() => void> = [];
// Set waiting flag immediately if we're in non-standalone mode with Valkey
let isWaitingForAdminEvents = !isStandaloneMode() && !!process.env.VALKEY_URL;

// Promise-based startup coordination
let configurationPromise: Promise<Config> | null = null;
let configurationResolve: ((config: Config) => void) | null = null;
let startupRequestSent = false; // Track if we've already sent the initial startup request

// Default configuration if file doesn't exist
const DEFAULT_CONFIG: Config = {
  api_config: {
    openai: {
      substitute_models: [
        { from: "GPT-4", to: "o1" },
        { from: "GPT-3.5", to: "GPT-4" }
      ],
      emulate_streaming_for_models: []
    },
    anthropic: {
      substitute_models: [
        { from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" },
        { from: "claude-3-7-sonnet-20250219", to: "anthropic--claude-3.7-sonnet" }
      ],
      emulate_streaming_for_models: ["anthropic--claude-3.7-sonnet"]
    }
  }
};

// In-memory cache of the configuration
let cachedConfig: Config | null = null;

/**
 * Ensure backup directory exists
 */
const ensureBackupDirectory = (): void => {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logger.info('ConfigService', `Created backup directory: ${BACKUP_DIR}`);
  }
};

/**
 * Generate backup filename with timestamp
 */
const generateBackupFilename = (): string => {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
  return `api_config_backup_${timestamp}.json`;
};

/**
 * Create backup of current configuration
 * @returns The path to the created backup file
 */
const createConfigBackup = (): string | null => {
  try {
    // Only create backup if main config file exists
    if (!fs.existsSync(CONFIG_FILE_PATH)) {
      logger.warn('ConfigService', 'No configuration file to backup');
      return null;
    }

    ensureBackupDirectory();
    
    const backupFilename = generateBackupFilename();
    const backupPath = path.join(BACKUP_DIR, backupFilename);
    
    // Copy current config to backup
    fs.copyFileSync(CONFIG_FILE_PATH, backupPath);
    
    logger.info('ConfigService', `Configuration backed up to: ${backupPath}`);
    return backupPath;
  } catch (error: any) {
    logger.error('ConfigService', `Failed to create backup: ${error.message}`);
    return null;
  }
};

/**
 * List available backup files
 * @returns Array of backup file information
 */
const listConfigBackups = (): Array<{filename: string, path: string, created: Date, size: number}> => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return [];
    }

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(file => file.startsWith('api_config_backup_') && file.endsWith('.json'))
      .map(filename => {
        const filePath = path.join(BACKUP_DIR, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          path: filePath,
          created: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => b.created.getTime() - a.created.getTime()); // Newest first

    return files;
  } catch (error: any) {
    logger.error('ConfigService', `Failed to list backups: ${error.message}`);
    return [];
  }
};

/**
 * Restore configuration from backup
 * @param backupFilename - The backup filename to restore from
 * @returns Whether restoration was successful
 */
const restoreConfigFromBackup = (backupFilename: string): boolean => {
  try {
    const backupPath = path.join(BACKUP_DIR, backupFilename);
    
    if (!fs.existsSync(backupPath)) {
      logger.error('ConfigService', `Backup file not found: ${backupPath}`);
      return false;
    }

    // Create backup of current config before restoration
    createConfigBackup();
    
    // Restore from backup
    fs.copyFileSync(backupPath, CONFIG_FILE_PATH);
    
    // Clear cache to force reload
    cachedConfig = null;
    
    // Reload configuration
    getConfig(true);
    
    logger.info('ConfigService', `Configuration restored from backup: ${backupFilename}`);
    return true;
  } catch (error: any) {
    logger.error('ConfigService', `Failed to restore from backup: ${error.message}`);
    return false;
  }
};

/**
 * Clean up old backup files based on retention policy
 */
const cleanupOldBackups = (): void => {
  try {
    const backups = listConfigBackups();
    
    // Remove excess files beyond MAX_BACKUP_FILES
    if (backups.length > MAX_BACKUP_FILES) {
      const filesToDelete = backups.slice(MAX_BACKUP_FILES);
      filesToDelete.forEach(backup => {
        fs.unlinkSync(backup.path);
        logger.info('ConfigService', `Removed excess backup: ${backup.filename}`);
      });
    }
    
    // Remove files older than retention period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - BACKUP_RETENTION_DAYS);
    
    const remainingBackups = listConfigBackups();
    const oldBackups = remainingBackups.filter(backup => backup.created < cutoffDate);
    
    oldBackups.forEach(backup => {
      fs.unlinkSync(backup.path);
      logger.info('ConfigService', `Removed old backup: ${backup.filename} (${backup.created.toISOString()})`);
    });
    
    if (oldBackups.length > 0) {
      logger.info('ConfigService', `Cleaned up ${oldBackups.length} old backup files`);
    }
  } catch (error: any) {
    logger.error('ConfigService', `Failed to cleanup old backups: ${error.message}`);
  }
};

/**
 * Create a promise that resolves when configuration is received from admin service
 */
const createConfigurationPromise = (): Promise<Config> => {
  if (configurationPromise) {
    return configurationPromise;
  }
  
  configurationPromise = new Promise<Config>((resolve) => {
    configurationResolve = resolve;
  });
  
  return configurationPromise;
};

/**
 * Initialize Valkey connections for event-driven configuration
 */
const initializeValkey = async (): Promise<void> => {
  if (!VALKEY_URL || isStandaloneMode()) {
    logger.info('ConfigService', 'Valkey disabled - running in standalone mode or no VALKEY_URL provided');
    return;
  }
  
  if (valkeyInitialized) {
    logger.debug('ConfigService', 'Valkey already initialized, skipping');
    return;
  }

  try {
    const Valkey = require('iovalkey');
    
    // Separate connections for pub/sub
    valkeySubscriber = new Valkey(VALKEY_URL, {
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
      lazyConnect: true
    });

    valkeyPublisher = new Valkey(VALKEY_URL, {
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
      lazyConnect: true
    });

    // An 'error' listener is NOT optional on an iovalkey client, and both of
    // these went without one. An unhandled error event is fatal at the node
    // level in production; in Jest it surfaces as `Connection is closed` raised
    // from iovalkey's close handler when the socket goes away at force-exit,
    // blamed on whichever suite happened to be loading in that worker — an
    // intermittent "Test suite failed to run" on a file unrelated to config.
    //
    // These are logged, not escalated: config still resolves from the local
    // file when valkey is unreachable (see getConfig's fallback), so losing the
    // event channel degrades freshness rather than breaking the gateway.
    valkeySubscriber.on('error', (error: any) => {
      logger.warn('ConfigService',
        `Valkey subscriber error (config still resolves from the local file): ${error?.message}`);
    });
    valkeyPublisher.on('error', (error: any) => {
      logger.warn('ConfigService',
        `Valkey publisher error (config still resolves from the local file): ${error?.message}`);
    });

    // Subscribe to configuration changes only (Gateway doesn't need to listen to startup events)
    await valkeySubscriber.subscribe(CONFIG_CHANGE_CHANNEL);
    valkeySubscriber.on('message', handleValkeyEvent);
    
    // Initial configuration request will be handled by getConfigAsync when needed
    // Don't make duplicate requests here
    
    valkeyInitialized = true;
    logger.info('ConfigService', 'Valkey connections established for configuration events');
  } catch (error: any) {
    logger.error('ConfigService', `Failed to initialize Valkey: ${error.message}`);
  }
};

/**
 * Closes the config event connections, if they were ever opened.
 *
 * Nothing closed them before: both clients were created once and left open for
 * the process's lifetime. Harmless for a real process exit, which tears the
 * sockets down anyway — but a test worker that force-exits with them still open
 * gets their close events after the run, and a repeated
 * initialize/teardown cycle accumulates a connection per round.
 *
 * Safe to call when valkey was never configured or never initialized, and safe
 * to call twice.
 */
export const closeValkeyConnections = async (): Promise<void> => {
  const clients = [valkeySubscriber, valkeyPublisher];
  valkeySubscriber = null;
  valkeyPublisher = null;
  valkeyInitialized = false;

  for (const client of clients) {
    if (!client) continue;
    try {
      // disconnect() rather than quit(): quit() round-trips a QUIT command and
      // can hang when the connection is already unusable, which is exactly the
      // state this is most often called in.
      // eslint-disable-next-line no-await-in-loop
      await client.disconnect();
    } catch {
      // best-effort cleanup; nothing to react to
    }
  }
};

/**
 * Handle all Valkey events (configuration changes, startup coordination)
 */
const handleValkeyEvent = async (channel: string, message: string): Promise<void> => {
  try {
    const event = JSON.parse(message);
    
    switch (channel) {
      case CONFIG_CHANGE_CHANNEL:
        await handleConfigChangeEvent(event);
        break;
      default:
        logger.debug('ConfigService', `Received unknown channel event: ${channel}`);
    }
  } catch (error: any) {
    logger.error('ConfigService', `Failed to handle Valkey event from channel ${channel}: ${error.message}`);
  }
};

/**
 * Handle configuration change events from Admin Service
 */
const handleConfigChangeEvent = async (configEvent: any): Promise<void> => {
  logger.info('ConfigService', 'Received configuration change event', {
    eventType: configEvent.eventType,
    configId: configEvent.configId,
    configName: configEvent.configName,
    version: configEvent.version
  });
  
  try {
    // Use configuration data from the event if available (event-driven approach)
    if (configEvent.configData) {
      // Use the configuration data directly from the event (already has api_config wrapper)
      cachedConfig = configEvent.configData;
      configurationReceived = true;
      
      logger.info('ConfigService', 'Configuration updated from Valkey event data', {
        configId: configEvent.configId,
        configName: configEvent.configName,
        version: configEvent.version,
        source: 'event-driven'
      });
    } else {
      // Fallback to HTTP fetch if event doesn't contain config data
      logger.info('ConfigService', 'Event missing configData, falling back to HTTP fetch');
      const newConfig = await fetchConfigurationFromAdmin(true);
      
      if (newConfig) {
        cachedConfig = newConfig;
        configurationReceived = true;
        logger.info('ConfigService', 'Configuration updated from Admin Service HTTP call');
      } else {
        logger.warn('ConfigService', 'Failed to get configuration from both event and HTTP');
        return;
      }
    }
    
    // Clear the waiting flag since we received configuration
    isWaitingForAdminEvents = false;
    
    // Resolve the configuration promise if someone is waiting for it
    if (configurationResolve && cachedConfig) {
      configurationResolve(cachedConfig);
      configurationResolve = null;
      configurationPromise = null;
    }
    
    // Trigger hot-reload mechanisms
    await triggerConfigurationReload();
    
    // Publish model list after configuration update (if not already published)
    await publishModelListAfterConfigUpdate();
    
  } catch (error: any) {
    logger.error('ConfigService', `Failed to handle config change event: ${error.message}`);
  }
};

/**
 * Request initial configuration from Admin Service during startup
 */
const requestInitialConfiguration = async (): Promise<void> => {
  if (isStandaloneMode() || startupRequestSent) {
    if (startupRequestSent) {
      logger.debug('ConfigService', 'Startup request already sent, skipping duplicate request');
    }
    return;
  }
  
  try {
    logger.info('ConfigService', 'Requesting initial configuration from Admin Service');
    
    // Send a startup request to Admin Service
    const startupRequest = {
      eventType: 'gateway-startup-request',
      service: 'gateway-service',
      timestamp: new Date().toISOString(),
      requestId: ValidationTokenUtils.generateRequestId()
    };
    
    if (valkeyPublisher) {
      await valkeyPublisher.publish(STARTUP_READY_CHANNEL, JSON.stringify(startupRequest));
      startupRequestSent = true; // Mark that we've sent the startup request
      logger.debug('ConfigService', 'Sent startup request to Admin Service');
      
      // When Valkey is available, primarily rely on event-driven configuration
      logger.info('ConfigService', 'Valkey available - waiting for event-driven configuration');
      
      // Check if we already received configuration via events (non-blocking)
      if (configurationReceived) {
        logger.info('ConfigService', 'Configuration already received via Valkey events - skipping HTTP fallback');
        return;
      }
      
      logger.info('ConfigService', 'No configuration received via events yet - will continue with HTTP as fallback');
    }
    
    // Do NOT make HTTP calls immediately - wait for Valkey events
    // HTTP fallback will only happen if events timeout in getConfigAsync()
  } catch (error: any) {
    logger.warn('ConfigService', `Failed to request initial configuration: ${error.message}`);
  }
};

/**
 * Reload plugin modules on a configuration change.
 *
 * Evicts ONLY the plugins subtree from require.cache (plugin entry files plus
 * their plugin-internal helper modules, e.g. plugins/pseudonymization/*), then
 * lets pluginLoader rebuild the registry. Gateway SERVICE modules are never
 * evicted: doing so caused split-brain state — Express handlers registered at
 * startup kept referencing the old module instances while later require()
 * calls created fresh ones with empty caches, and the two worlds disagreed
 * (observed as model substitution silently failing after a config-activation
 * event until a manual restart). Service code changes are picked up by nodemon
 * (dev) or a deploy restart (prod), never by config pushes.
 */
const reloadPluginModules = (): void => {
  try {
    const pluginsDirPrefix = path.join(__dirname, '..', 'plugins');
    const keys = selectPluginCacheKeysToClear(Object.keys(require.cache), pluginsDirPrefix);
    for (const key of keys) {
      delete require.cache[key];
    }
    if (keys.length > 0) {
      logger.info('ConfigService', `Cleared require cache for ${keys.length} plugin modules`);
    }
    const pluginLoader = require('./pluginLoader');
    pluginLoader.reloadAll('./src/plugins');
    logger.info('ConfigService', 'Plugins reloaded successfully');
  } catch (pluginError: any) {
    logger.error('ConfigService', `Error reloading plugins: ${pluginError.message}`);
  }
};

/**
 * Trigger configuration reload mechanisms (plugins, model service cache, etc.)
 */
const triggerConfigurationReload = async (): Promise<void> => {
  try {
    // Reinitialize logger to pick up new logging configuration
    if (logger && typeof (logger as any).reinitialize === 'function') {
      (logger as any).reinitialize();
      logger.info('ConfigService', 'Logger reinitialized with updated configuration');
    }
    
    // Reload PLUGIN modules to pick up plugin code/config changes.
    reloadPluginModules();

    // Clear model service caches to force reapplication of config
    try {
      const modelService = require('./modelService').default;
      modelService.clearAllCaches();
      logger.info('ConfigService', 'Model service caches cleared - will rebuild with new config');
    } catch (modelError: any) {
      logger.error('ConfigService', `Error clearing model caches: ${modelError.message}`);
    }

    // Execute any registered startup event handlers
    startupEventHandlers.forEach(handler => {
      try {
        handler();
      } catch (error: any) {
        logger.error('ConfigService', `Error executing startup event handler: ${error.message}`);
      }
    });
    
  } catch (error: any) {
    logger.error('ConfigService', `Error during configuration reload: ${error.message}`);
  }
};


/**
 * Fetch configuration from Admin Service using AdminServiceClient
 */
const fetchConfigurationFromAdmin = async (forceRefresh: boolean = false): Promise<Config | null> => {
  if (isStandaloneMode()) {
    return null;
  }
  
  if (!adminServiceClient) {
    logger.warn('ConfigService', 'AdminServiceClient not available - running in standalone mode');
    return null;
  }
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= CONFIG_FETCH_RETRIES; attempt++) {
    try {
      logger.debug('ConfigService', `Fetching configuration using AdminServiceClient (attempt ${attempt}/${CONFIG_FETCH_RETRIES})`);
      
      // Use AdminServiceClient which handles JWT authentication like unified auth
      const response = await adminServiceClient.getActiveConfiguration();
      
      if (response && response.success && response.config) {
        const configData = response.config;
        
        logger.info('ConfigService', 'Successfully fetched configuration using AdminServiceClient', {
          configId: response.config?.id,
          configName: response.config?.name,
          version: response.version
        });
        
        return configData as Config;
      } else {
        throw new Error('No configuration found in AdminServiceClient response');
      }
      
    } catch (error: any) {
      lastError = error;
      const isLastAttempt = attempt === CONFIG_FETCH_RETRIES;
      
      // Calculate exponential backoff delay with jitter
      const baseDelay = Math.min(CONFIG_FETCH_INITIAL_DELAY * Math.pow(2, attempt - 1), CONFIG_FETCH_MAX_DELAY);
      const jitter = Math.random() * 1000; // Add up to 1 second of jitter
      const delay = Math.floor(baseDelay + jitter);
      
      logger.warn('ConfigService', `AdminServiceClient request failed (attempt ${attempt}/${CONFIG_FETCH_RETRIES}): ${error.message}`, {
        willRetry: !isLastAttempt,
        nextRetryInMs: !isLastAttempt ? delay : 0
      });
      
      // Special handling for 404 - likely no active configuration yet
      if (error.message.includes('404') && attempt <= 3) {
        logger.info('ConfigService', 'No active configuration available yet - AdminService may still be initializing');
      }
      
      if (!isLastAttempt) {
        logger.debug('ConfigService', `Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  logger.error('ConfigService', 'Failed to fetch configuration using AdminServiceClient after all retries', lastError || undefined, {
    totalAttempts: CONFIG_FETCH_RETRIES,
    suggestion: 'AdminService may not have an active configuration yet, or service may be unavailable'
  });
  
  return null;
};

/**
 * Publish model list after configuration update (startup coordination)
 */
const publishModelListAfterConfigUpdate = async (): Promise<void> => {
  if (!configurationReceived || modelListPublished) {
    return;
  }
  
  try {
    // Get the model list from the model service
    const modelService = require('./modelService').default;
    const modelListResponse = await modelService.getModels();
    const modelList = modelListResponse.data;
    
    if (modelList && modelList.length > 0) {
      await publishModelList(modelList);
      modelListPublished = true;
      logger.info('ConfigService', 'Model list published after configuration update');
    }
  } catch (error: any) {
    logger.error('ConfigService', `Failed to publish model list after config update: ${error.message}`);
  }
};

/**
 * Publish model list to Admin Service via Valkey
 * Uses dual-write pattern: key/value storage + pub/sub event
 */
export const publishModelList = async (modelList: any[]): Promise<void> => {
  if (!valkeyPublisher || isStandaloneMode()) {
    logger.debug('ConfigService', 'Model list publishing disabled - standalone mode or no Valkey connection');
    return;
  }

  try {
    const modelListEvent = {
      eventType: 'model-list-updated',
      timestamp: new Date().toISOString(),
      source: 'gateway-service',
      modelCount: modelList.length,
      models: modelList,
      configurationReceived: configurationReceived
    };

    const eventJson = JSON.stringify(modelListEvent);

    // Store in Valkey key/value storage (persistent, 24h TTL)
    try {
      await valkeyPublisher.set('model-list:latest', eventJson, 'EX', 86400);
      logger.info('ConfigService', `Stored model list in Valkey storage: ${modelList.length} models`);
    } catch (storageError: any) {
      // Log warning but don't fail - pub/sub can still work
      logger.warn('ConfigService', `Failed to store model list in Valkey: ${storageError.message}`);
    }

    // Publish via pub/sub for real-time updates
    await valkeyPublisher.publish(MODEL_LIST_CHANNEL, eventJson);

    logger.info('ConfigService', `Published model list with ${modelList.length} models to Admin Service`);
  } catch (error: any) {
    logger.error('ConfigService', `Failed to publish model list: ${error.message}`);
  }
};

/**
 * Register event handler for startup coordination
 */
export const onConfigurationReady = (handler: () => void): void => {
  if (configurationReceived) {
    // Configuration already received, execute immediately
    handler();
  } else {
    // Add to handlers to execute when configuration is received
    startupEventHandlers.push(handler);
  }
};

/**
 * Check if configuration has been received from Admin Service
 */
export const isConfigurationReady = (): boolean => {
  return configurationReceived || isStandaloneMode();
};

/**
 * Load the configuration from disk or Admin Service
 * @param forceRefresh - Whether to force a refresh from source
 * @returns The configuration object
 */
export const getConfig = (forceRefresh: boolean = false): Config => {
  // Return cached config if available and not forcing refresh
  if (cachedConfig && !forceRefresh) {
    return cachedConfig;
  }
  
  // Initialize Valkey connections if not already done
  if (!valkeySubscriber && !isStandaloneMode()) {
    initializeValkey().catch(error => {
      logger.warn('ConfigService', `Failed to initialize Valkey during config load: ${error.message}`);
    });
  }
  
  // When Valkey is available, don't make HTTP calls during startup
  // Configuration will come via events
  if (!isStandaloneMode() && !VALKEY_URL) {
    try {
      logger.info('ConfigService', 'No Valkey - attempting to load configuration from Admin Service via HTTP');
      
      // Only make HTTP calls when Valkey is not available
      fetchConfigurationFromAdmin(forceRefresh).then(adminConfig => {
        if (adminConfig) {
          cachedConfig = adminConfig;
          logger.info('ConfigService', 'Using Admin Service for configuration - async fetch completed');
        }
      }).catch(error => {
        logger.warn('ConfigService', `Failed to fetch from Admin Service: ${error.message}`);
      });
    } catch (error: any) {
      logger.warn('ConfigService', `Failed to initiate Admin Service config fetch: ${error.message}`);
    }
  } else if (!isStandaloneMode() && VALKEY_URL) {
    logger.info('ConfigService', 'Valkey available - configuration will be loaded via events');
    
    // If we're actively waiting for admin events during startup, block synchronous calls
    if (isWaitingForAdminEvents) {
      logger.error('ConfigService', 'Synchronous getConfig() called during startup while waiting for admin events - this will cause startup issues');
      throw new Error('Cannot use synchronous getConfig() during startup while waiting for admin events. Services should be initialized after configuration is received.');
    }
    
    // When not in startup waiting mode, warn but allow minimal config
    logger.warn('ConfigService', 'Synchronous getConfig() called when async configuration is needed - use getConfigAsync() instead');
    
    // Return minimal config for now, but log the issue
    cachedConfig = DEFAULT_CONFIG;
    logger.info('ConfigService', 'Using minimal default configuration - consider using getConfigAsync() for proper event waiting');
    
    return cachedConfig;
  }
  
  try {
    // Load from local file as fallback or in standalone mode  
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      // Read and parse the config file
      const configData = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
      cachedConfig = JSON.parse(configData);
      
      const source = isStandaloneMode() ? 'local file (standalone mode)' : 'local file (fallback)';
      logger.info('ConfigService', `Loaded configuration from ${source}: ${CONFIG_FILE_PATH}`);
    } else if (isStandaloneMode()) {
      // Create the default config file if it doesn't exist (standalone mode only)
      cachedConfig = DEFAULT_CONFIG;
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(cachedConfig, null, 2));
      logger.info('ConfigService', `Created default configuration at ${CONFIG_FILE_PATH}`);
    } else {
      // In non-standalone mode without Valkey, use default config but don't write to disk
      cachedConfig = DEFAULT_CONFIG;
      logger.warn('ConfigService', 'Using default configuration - no local file and Admin Service unavailable');
    }
    
    // Load plugins
    try {
      pluginLoader.loadAll('./src/plugins');
      logger.info('ConfigService', 'Loaded plugins successfully');
    } catch (pluginError: any) {
      logger.error('ConfigService', `Error loading plugins: ${pluginError.message}`);
    }
    
    return cachedConfig!;
  } catch (error: any) {
    logger.error('ConfigService', `Error loading configuration: ${error.message}`);
    // Return default config as fallback
    return DEFAULT_CONFIG;
  }
};

/**
 * Async version of getConfig for better Admin Service integration
 */
export const getConfigAsync = async (forceRefresh: boolean = false): Promise<Config> => {
  logger.debug('ConfigService', 'getConfigAsync called', { 
    hasCachedConfig: !!cachedConfig, 
    forceRefresh, 
    configurationReceived,
    isStandalone: isStandaloneMode(),
    hasValkey: !!VALKEY_URL 
  });
  
  // In non-standalone mode with Valkey, always wait for proper admin configuration
  // Don't use cached config from synchronous calls during startup
  if (!isStandaloneMode() && VALKEY_URL && !configurationReceived) {
    logger.debug('ConfigService', 'Non-standalone mode with Valkey - waiting for admin events regardless of cached config');
    forceRefresh = true; // Force waiting for admin events
    
    // Clear any cached config from synchronous calls to force proper event waiting
    if (cachedConfig) {
      logger.debug('ConfigService', 'Clearing cached config from synchronous calls to wait for admin events');
      cachedConfig = null;
    }
  }
  
  // Return cached config if available and not forcing refresh
  if (cachedConfig && !forceRefresh) {
    logger.debug('ConfigService', 'getConfigAsync returning cached configuration');
    return cachedConfig;
  }
  
  logger.debug('ConfigService', 'getConfigAsync starting - will wait for admin configuration');
  
  // Initialize Valkey connections if not already done
  if (!valkeySubscriber && !isStandaloneMode()) {
    await initializeValkey();
  }
  
  // Try to load from Admin Service if not in standalone mode
  if (!isStandaloneMode()) {
    if (VALKEY_URL) {
      // When Valkey is available, wait for event-driven configuration
      logger.info('ConfigService', 'Waiting for configuration from Admin Service via Valkey events');
      
      // Only create and trigger request if we haven't done so already
      if (!configurationPromise) {
        // Create configuration promise and trigger request
        const configPromise = createConfigurationPromise();
        
        // Trigger initial configuration request (will send Valkey event)
        requestInitialConfiguration().catch(error => {
          logger.warn('ConfigService', `Failed to request initial configuration: ${error.message}`);
        });
        
        configurationPromise = configPromise;
      } else {
        logger.debug('ConfigService', 'Configuration request already in progress, waiting for existing promise');
      }
      
      try {
        // Wait for configuration event (with timeout)
        const timeoutPromise = new Promise<Config>((_, reject) => {
          setTimeout(() => reject(new Error('Configuration timeout after 10 seconds')), 10000);
        });
        
        cachedConfig = await Promise.race([configurationPromise, timeoutPromise]);
        logger.info('ConfigService', 'Successfully received configuration from Admin Service via events');
        
        // Plugin loading and other processing is already handled by the event handler
        // No need to duplicate it here
        
        return cachedConfig;
      } catch (error: any) {
        logger.warn('ConfigService', `Failed to receive configuration via events: ${error.message}, falling back to HTTP`);
      }
    }
    
    // Fallback to HTTP if Valkey unavailable or failed
    try {
      logger.info('ConfigService', 'Loading configuration from Admin Service via HTTP');
      const adminConfig = await fetchConfigurationFromAdmin(forceRefresh);
      
      if (adminConfig) {
        cachedConfig = adminConfig;
        configurationReceived = true;
        logger.info('ConfigService', 'Successfully loaded configuration from Admin Service via HTTP');
        
        // Trigger plugin reload and other processing
        await triggerConfigurationReload();
        
        return cachedConfig;
      }
    } catch (error: any) {
      logger.warn('ConfigService', `Failed to load from Admin Service via HTTP, falling back to local: ${error.message}`);
    }
  }
  
  // Fallback to synchronous local loading
  return getConfig(forceRefresh);
};

/**
 * Update the configuration
 * @param newConfig - The new configuration object
 * @returns The updated configuration
 */
export const updateConfig = (newConfig: Config): Config => {
  let backupPath: string | null = null;
  
  try {
    // Validate the config structure
    if (!newConfig.api_config) {
      throw new Error('Invalid configuration format: missing api_config');
    }
    
    // In non-standalone mode, don't write to disk
    if (!isStandaloneMode()) {
      logger.warn('ConfigService', 'Configuration update attempted in non-standalone mode - updates should go through Admin Service');
      throw new Error('Configuration updates in non-standalone mode must go through Admin Service');
    }
    
    // Create backup before updating (standalone mode only)
    backupPath = createConfigBackup();
    if (backupPath) {
      logger.info('ConfigService', `Created backup before update: ${path.basename(backupPath)}`);
    }
    
    // Write the new config to disk (standalone mode only)
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(newConfig, null, 2));
    
    // Update the cached config
    cachedConfig = newConfig;
    
    logger.info('ConfigService', `Updated configuration at ${CONFIG_FILE_PATH}`);
    
    // Reinitialize logger to pick up new logging configuration
    if (logger && typeof (logger as any).reinitialize === 'function') {
      (logger as any).reinitialize();
      logger.info('ConfigService', 'Logger reinitialized with updated configuration');
    }
    
    // Reload PLUGIN modules to pick up plugin code/config changes (services are
    // never evicted — see reloadPluginModules for the split-brain rationale).
    reloadPluginModules();

    // Clear model service caches to force reapplication of config
    try {
      const modelService = require('./modelService').default;
      modelService.clearAllCaches();
      logger.info('ConfigService', 'Model service caches cleared - will rebuild with new config');
    } catch (modelError: any) {
      logger.error('ConfigService', `Error clearing model caches: ${modelError.message}`);
    }
    
    // Cleanup old backups after successful update
    try {
      cleanupOldBackups();
    } catch (cleanupError: any) {
      logger.warn('ConfigService', `Error cleaning up old backups: ${cleanupError.message}`);
    }
    
    return cachedConfig;
  } catch (error: any) {
    logger.error('ConfigService', `Error updating configuration: ${error.message}`);
    throw error;
  }
};

/**
 * Patch specific parts of the configuration
 * @param patchData - The partial configuration to update
 * @returns The updated configuration
 */
export const patchConfig = async (patchData: Partial<Config>): Promise<Config> => {
  try {
    // Get the current config
    const currentConfig = getConfig();
    
    // Merge the patch into the current config
    const newConfig = deepMerge(currentConfig, patchData);
    
    // Write the updated config to disk
    return updateConfig(newConfig);
  } catch (error: any) {
    logger.error('ConfigService', `Error patching configuration: ${error.message}`);
    throw error;
  }
};

/**
 * Get the substituted model name based on configuration
 * @param provider - The provider (openai, anthropic, etc.)
 * @param modelName - The original model name
 * @returns The substituted model name or original if no substitution
 */
export const getSubstitutedModel = (provider: string, modelName: string): string => {
  try {
    const config = getConfig();
    
    // Check if provider exists in config
    if (!config.api_config || !config.api_config[provider]) {
      return modelName;
    }
    
    // Check for substitutions
    const substitutions = config.api_config[provider].substitute_models || [];
    const substitution = substitutions.find((sub: any) => sub.from === modelName);
    
    if (substitution) {
      logger.info('ConfigService', `Substituting model: ${modelName} -> ${substitution.to}`);
    }
    
    return substitution ? substitution.to : modelName;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting substituted model: ${error.message}`);
    return modelName;
  }
};

/**
 * Get the original model name by reversing substitution
 * @param provider - The provider (openai, anthropic, etc.)
 * @param substitutedModelName - The substituted model name
 * @returns The original model name or substituted if no reverse mapping found
 */
export const getOriginalModel = (provider: string, substitutedModelName: string): string => {
  try {
    const config = getConfig();
    
    // Check if provider exists in config
    if (!config.api_config || !config.api_config[provider]) {
      return substitutedModelName;
    }
    
    // Check for reverse substitutions
    const substitutions = config.api_config[provider].substitute_models || [];
    const reverseSubstitution = substitutions.find((sub: any) => sub.to === substitutedModelName);
    
    if (reverseSubstitution) {
      logger.info('ConfigService', `Reverse substituting model: ${substitutedModelName} -> ${reverseSubstitution.from}`);
    }
    
    return reverseSubstitution ? reverseSubstitution.from : substitutedModelName;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting original model: ${error.message}`);
    return substitutedModelName;
  }
};

/**
 * Check if streaming should be emulated for a model
 * @param provider - The provider (openai, anthropic, etc.)
 * @param modelName - The model name
 * @returns Whether streaming should be emulated
 */
export const shouldEmulateStreaming = (provider: string, modelName: string): boolean => {
  try {
    const config = getConfig();
    
    // Check if provider exists in config
    if (!config.api_config || !config.api_config[provider]) {
      return false;
    }
    
    // Check if model is in the emulation list
    const emulateList = config.api_config[provider].emulate_streaming_for_models || [];
    
    // Check for exact match or stripped version (remove provider prefix)
    if (emulateList.includes(modelName)) {
      logger.info('ConfigService', `Emulation enabled for model ${modelName} - exact match`);
      return true;
    }
    
    // Check for model without provider prefix (e.g., 'anthropic--claude-3.7-sonnet' -> 'claude-3.7-sonnet')
    const strippedModelName = modelName.replace(/^[^-]+--/, '');
    if (strippedModelName !== modelName && emulateList.includes(strippedModelName)) {
      logger.info('ConfigService', `Emulation enabled for model ${modelName} - matched stripped name ${strippedModelName}`);
      return true;
    }
    
    return false;
  } catch (error: any) {
    logger.error('ConfigService', `Error checking streaming emulation: ${error.message}`);
    return false;
  }
};

export const getAnthropicBedrockVersion = (): string => {
  try {
    const config = getConfig();
    return config?.api_config?.anthropic?.anthropic_bedrock_version || "bedrock-2023-05-31"; // Default if not found
  } catch (error: any) {
    logger.error('ConfigService', `Error getting Anthropic Bedrock version: ${error.message}`);
    return "bedrock-2023-05-31"; // Default on error
  }
};

/**
 * Get excluded beta headers for Anthropic requests to SAP AI Core
 * These beta features are not yet supported by SAP AI Core deployments
 * @returns Array of beta header values to filter out
 */
export const getExcludedBetaHeaders = (): string[] => {
  try {
    const config = getConfig();
    return config?.api_config?.anthropic?.excluded_beta_headers || [];
  } catch (error: any) {
    logger.error('ConfigService', `Error getting excluded beta headers: ${error.message}`);
    return [];
  }
};

/**
 * Get supported (allowlisted) beta headers for Anthropic requests to SAP AI Core.
 * When non-empty, only these beta flags are forwarded; the excluded_beta_headers
 * denylist is still applied on top. Empty/absent means no allowlist filtering.
 * @returns Array of allowlisted beta header values
 */
export const getSupportedBetaHeaders = (): string[] => {
  try {
    const config = getConfig();
    return config?.api_config?.anthropic?.supported_beta_headers || [];
  } catch (error: any) {
    logger.error('ConfigService', `Error getting supported beta headers: ${error.message}`);
    return [];
  }
};

/**
 * Get the request parameters a provider/model does not accept, so they can be
 * stripped before forwarding to SAP AI Core (which returns HTTP 400
 * "does not support parameters: [...]" otherwise, e.g. `tools` for Perplexity).
 *
 * Layered: a per-model `unsupported_params` list REPLACES the provider-level
 * list. Absent at both levels returns [] (nothing stripped).
 *
 * @param provider - lowercased provider key (from modelDetails.owned_by)
 * @param modelName - optional model id for a per-model override
 * @returns Array of parameter names to drop from the outbound payload
 */
export const getUnsupportedParams = (provider?: string, modelName?: string): string[] => {
  try {
    const config = getConfig();
    const providerList = provider
      ? config?.api_config?.[provider]?.unsupported_params
      : undefined;
    const modelOverride = modelName
      ? config?.api_config?.model_list_changes?.[modelName]?.unsupported_params
      : undefined;
    return resolveUnsupportedParams(providerList, modelOverride);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting unsupported params: ${error.message}`);
    return [];
  }
};

/**
 * Per-model / per-provider override for /openai/v1/responses eligibility.
 * Returns undefined when unset so the caller falls back to the family heuristic.
 */
export const getSupportsResponsesApi = (provider?: string, modelName?: string): boolean | undefined => {
  try {
    const config = getConfig();
    const m = modelName
      ? config?.api_config?.model_list_changes?.[modelName]?.supports_responses_api
      : undefined;
    if (typeof m === 'boolean') return m;
    const p = provider ? config?.api_config?.[provider]?.supports_responses_api : undefined;
    return typeof p === 'boolean' ? p : undefined;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting supports_responses_api: ${error.message}`);
    return undefined;
  }
};

/**
 * Per-model / per-provider override for Anthropic prompt caching (whether
 * `cache_control` breakpoints are applied to a model's requests).
 * Returns undefined when unset so the caller falls back to the
 * provider === 'anthropic' default in promptCachingSupport.
 */
export const getSupportsPromptCaching = (provider?: string, modelName?: string): boolean | undefined => {
  try {
    const config = getConfig();
    const m = modelName
      ? config?.api_config?.model_list_changes?.[modelName]?.supports_prompt_caching
      : undefined;
    if (typeof m === 'boolean') return m;
    const p = provider ? config?.api_config?.[provider]?.supports_prompt_caching : undefined;
    return typeof p === 'boolean' ? p : undefined;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting supports_prompt_caching: ${error.message}`);
    return undefined;
  }
};

/**
 * True when pseudonymization is force-enabled for an endpoint via
 * `defaultHooks[endpoint].pseudonymization.enabled` — the same source the
 * pseudonymization plugin reads for its per-endpoint force flag.
 *
 * Callers use this to fail closed when the force flag is on but the plugin hook
 * for their subpath is missing (an admin-activated configuration replaces the
 * file config wholesale, so a configuration older than a route has none of its
 * hook keys).
 *
 * @param endpoint - endpoint identifier, e.g. 'openai'
 */
export const isPseudonymizationForced = (endpoint: string): boolean => {
  try {
    const config = getConfig();
    return config?.api_config?.defaultHooks?.[endpoint]?.pseudonymization?.enabled === true;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting pseudonymization force flag: ${error.message}`);
    return false;
  }
};

/**
 * Cap on hosted web searches per request. Absent config yields the built-in default,
 * so installs whose api_config.json predates the key are unaffected.
 *
 * @see plugins/webSearch/searchCap.ts - the validation rules
 */
export const getWebSearchMaxSearches = (): number => {
  try {
    const config = getConfig();
    return resolveMaxWebSearches(config?.api_config?.web_search?.max_searches_per_request);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the web search cap: ${error.message}`);
    return DEFAULT_MAX_WEB_SEARCHES;
  }
};

/**
 * How long a hosted tool's results stay replayable, and how many are held at once. Absent
 * config yields the built-in defaults, so installs whose api_config.json predates these keys
 * are unaffected.
 *
 * @see plugins/hostedTool/resultCacheConfig.ts - the validation rules
 */
export const getHostedToolResultCacheTtlSeconds = (): number => {
  try {
    const config = getConfig();
    return resolveResultCacheTtlSeconds(config?.api_config?.hosted_tools?.result_cache_ttl_seconds);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the hosted-tool result cache TTL: ${error.message}`);
    return DEFAULT_RESULT_CACHE_TTL_SECONDS;
  }
};

export const getHostedToolResultCacheMaxEntries = (): number => {
  try {
    const config = getConfig();
    return resolveResultCacheMaxEntries(config?.api_config?.hosted_tools?.result_cache_max_entries);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the hosted-tool result cache size: ${error.message}`);
    return DEFAULT_RESULT_CACHE_MAX_ENTRIES;
  }
};

/**
 * How to handle Codex's `namespace` sub-agent wrapper, which SAP AI Core rejects.
 * Absent config yields `flatten`, so an install whose api_config.json predates this
 * key gets the working behavior rather than the 400.
 *
 * @see plugins/namespaceTools/adapter.ts - the validation rules
 */
export const getNamespaceToolMode = (): NamespaceToolMode => {
  try {
    return resolveNamespaceToolMode(getConfig()?.api_config?.namespace_tools?.mode);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the namespace tool mode: ${error.message}`);
    return DEFAULT_NAMESPACE_TOOL_MODE;
  }
};

export const getCustomToolMode = (): CustomToolMode => {
  try {
    return resolveCustomToolMode(getConfig()?.api_config?.custom_tools?.mode);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the custom tool mode: ${error.message}`);
    return DEFAULT_CUSTOM_TOOL_MODE;
  }
};

export const getToolSearchMode = (): ToolSearchMode => {
  try {
    return resolveToolSearchMode(getConfig()?.api_config?.tool_search?.mode);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the tool search mode: ${error.message}`);
    return DEFAULT_TOOL_SEARCH_MODE;
  }
};

export const getToolSearchHoistDiscoveredTools = (): boolean => {
  try {
    return resolveHoistDiscoveredTools(getConfig()?.api_config?.tool_search?.hoist_discovered_tools);
  } catch (error: any) {
    logger.error('ConfigService', `Error getting the tool search hoist setting: ${error.message}`);
    return DEFAULT_HOIST_DISCOVERED_TOOLS;
  }
};

export interface FileSearchConfig {
  enabled: boolean;
  embeddingModel: string;
  embeddingDimensions: number;
  rewriteQuery: boolean;
  /** Model used for the `rewrite_query` orchestration call (search.ts's
   *  queryRewriter.ts) — config-driven exactly like hybrid.rerank.model,
   *  since a model name that works on one SAP AI Core tenant's orchestration
   *  deployment is not guaranteed to work on another's. Verified live
   *  2026-07-30: 'gpt-35-turbo-16k' (this codebase's usual no-model-specified
   *  fallback elsewhere) returns HTTP 400 "Model name ... is not supported"
   *  on this tenant; 'gpt-4o-mini' is what was actually probed working. */
  rewriteQueryModel: string;
  hybrid: {
    rrfK: number;
    lexicalEnabled: boolean;
    candidates: number;
    rerank: { enabled: 'auto' | boolean; model: string };
  };
  chunking: { maxChunkSizeTokens: number; chunkOverlapTokens: number };
  limits: { maxFileBytes: number; maxTokensPerFile: number; maxFilesPerStore: number };
  ingestion: { concurrency: number; extractTimeoutMs: number; maxRetries: number };
  blobStorage: {
    backend: 'db' | 'local' | 's3';
    localPath: string;
    s3: { bucket: string; prefix: string; endpoint: string; region: string };
  };
}

export const FILE_SEARCH_DEFAULTS: FileSearchConfig = {
  enabled: true,
  embeddingModel: 'text-embedding-3-large',
  embeddingDimensions: 1536,
  rewriteQuery: false,
  rewriteQueryModel: 'gpt-4o-mini',
  hybrid: { rrfK: 60, lexicalEnabled: true, candidates: 50,
            rerank: { enabled: 'auto', model: 'cohere-reranker' } },
  chunking: { maxChunkSizeTokens: 800, chunkOverlapTokens: 400 },
  limits: { maxFileBytes: 33554432, maxTokensPerFile: 5000000, maxFilesPerStore: 10000 },
  ingestion: { concurrency: 4, extractTimeoutMs: 60000, maxRetries: 3 },
  blobStorage: { backend: 'db', localPath: '/var/lib/sail-proxy/blobs',
                 s3: { bucket: '', prefix: 'sail-proxy/blobs', endpoint: '', region: '' } },
};

/**
 * file_search (OpenAI-compatible document retrieval) configuration. Absent config
 * yields the shipped defaults, so an install whose api_config.json predates this
 * key gets a working, enabled feature rather than a crash.
 *
 * @see fileSearch/db.ts - consumes embeddingDimensions and enabled
 */
export const getFileSearchConfig = (): FileSearchConfig => {
  try {
    const f = getConfig()?.api_config?.file_search;
    if (!f) return FILE_SEARCH_DEFAULTS;
    const d = FILE_SEARCH_DEFAULTS;
    return {
      enabled: f.enabled ?? d.enabled,
      embeddingModel: f.embedding_model ?? d.embeddingModel,
      embeddingDimensions: f.embedding_dimensions ?? d.embeddingDimensions,
      rewriteQuery: f.rewrite_query ?? d.rewriteQuery,
      rewriteQueryModel: f.rewrite_query_model ?? d.rewriteQueryModel,
      hybrid: {
        rrfK: f.hybrid?.rrf_k ?? d.hybrid.rrfK,
        lexicalEnabled: f.hybrid?.lexical_enabled ?? d.hybrid.lexicalEnabled,
        candidates: f.hybrid?.candidates ?? d.hybrid.candidates,
        rerank: {
          enabled: f.hybrid?.rerank?.enabled ?? d.hybrid.rerank.enabled,
          model: f.hybrid?.rerank?.model ?? d.hybrid.rerank.model,
        },
      },
      chunking: {
        maxChunkSizeTokens: f.chunking?.max_chunk_size_tokens ?? d.chunking.maxChunkSizeTokens,
        chunkOverlapTokens: f.chunking?.chunk_overlap_tokens ?? d.chunking.chunkOverlapTokens,
      },
      limits: {
        maxFileBytes: f.limits?.max_file_bytes ?? d.limits.maxFileBytes,
        maxTokensPerFile: f.limits?.max_tokens_per_file ?? d.limits.maxTokensPerFile,
        maxFilesPerStore: f.limits?.max_files_per_store ?? d.limits.maxFilesPerStore,
      },
      ingestion: {
        concurrency: f.ingestion?.concurrency ?? d.ingestion.concurrency,
        extractTimeoutMs: f.ingestion?.extract_timeout_ms ?? d.ingestion.extractTimeoutMs,
        maxRetries: resolveMaxRetries(f.ingestion?.max_retries ?? d.ingestion.maxRetries),
      },
      blobStorage: {
        backend: f.blob_storage?.backend ?? d.blobStorage.backend,
        localPath: f.blob_storage?.local_path ?? d.blobStorage.localPath,
        s3: {
          bucket: f.blob_storage?.s3?.bucket ?? d.blobStorage.s3.bucket,
          prefix: f.blob_storage?.s3?.prefix ?? d.blobStorage.s3.prefix,
          endpoint: f.blob_storage?.s3?.endpoint ?? d.blobStorage.s3.endpoint,
          region: f.blob_storage?.s3?.region ?? d.blobStorage.s3.region,
        },
      },
    };
  } catch (error: any) {
    logger.error('ConfigService', `Error getting file_search config: ${error.message}`);
    return FILE_SEARCH_DEFAULTS;
  }
};

const MIN_MAX_RETRIES = 1;

// Distinct from `undefined`/`NaN` (both of which are themselves offending
// values this resolver must warn about), so the initial "nothing warned yet"
// state can never collide with a real configured value — see
// resolveMaxSearchesPerRequest below, which uses the same shape.
const RETRIES_CLAMP_UNWARNED = Symbol('retries-clamp-unwarned');
let retriesClampWarnedFor: unknown = RETRIES_CLAMP_UNWARNED;

/**
 * Resolves `file_search.ingestion.max_retries`. `0` reads as an operator's
 * "do not retry", but it actually breaks ingestion outright: `reapZombies`
 * (ingestWorker.ts) fires on `attempts >= maxRetries AND claimed_at IS
 * NULL`, which at 0 matches every freshly attached row, while `claimNext`'s
 * own `attempts < maxRetries` then matches none. Verified live: three
 * attached files, zero extractText/embed calls, all three rows `failed`
 * with `last_error.name` `'MaxRetriesExceededZombie'`, and the batch itself
 * reporting `completed` — so an SDK `createAndPoll` returns *successfully*
 * over a store with zero content. `0` is therefore clamped to 1 rather than
 * rejected outright: "no retries" still honestly means one attempt.
 *
 * Anything else that isn't a positive integer (a negative number, a float, a
 * non-numeric value) is treated as not configured and falls back to the
 * shipped default, the same way `resolveMaxSearchesPerRequest` and
 * `resolveMaxNumResultsDefault` treat garbage config as "absent" rather than
 * coercing it.
 *
 * Not silent — per this file's own `resolveMaxConcurrentWrites` and
 * test/fileSearch/teacherLoggingConfig.test.ts, "a silent override of a
 * tuning choice is its own defect." Warned at most once per distinct
 * offending value — this resolver runs on the ingestion claim path, which
 * polls continuously — using `Object.is` rather than `!==` so a repeated
 * `NaN` (which is `!== NaN` to itself) doesn't re-warn on every call.
 */
export const resolveMaxRetries = (configured: unknown): number => {
  const valid = typeof configured === 'number' && Number.isInteger(configured)
      && configured >= MIN_MAX_RETRIES;
  if (valid) return configured;

  const resolved = configured === 0 ? MIN_MAX_RETRIES : FILE_SEARCH_DEFAULTS.ingestion.maxRetries;
  if (!Object.is(retriesClampWarnedFor, configured)) {
    retriesClampWarnedFor = configured;
    logger.warn('ConfigService',
      `file_search.ingestion.max_retries is ${JSON.stringify(configured)}; ` +
      (configured === 0
        ? '0 reads as "do not retry" but silently disables ingestion outright — every freshly attached file ' +
          'is reaped as a retry-exhausted zombie before it can ever run; clamping to 1 so "no retries" still ' +
          'means one attempt.'
        : `not a valid positive integer; falling back to the default of ${resolved}.`));
  }
  return resolved;
};

export interface TeacherLoggingConfig {
  enabled: boolean;
  storeChunkText: boolean;
  sampleRate: number;
  source: string;
  maxConcurrentWrites: number;
}

export const TEACHER_LOGGING_DEFAULTS: TeacherLoggingConfig = {
  enabled: false,
  storeChunkText: false,
  sampleRate: 1.0,
  source: 'production',
  maxConcurrentWrites: 2,
};

// The file_search pg pool is built with `max: 10` (fileSearch/db.ts) and is
// shared with search, ingestion and the expiry sweeper. Above that many
// in-flight label writes the teacher logger's semaphore stops bounding
// anything: the surplus writes are no longer DROPPED, they wait inside pg's
// own connection queue — exactly the "logging starves the thing it observes"
// behaviour the bound exists to prevent. Measured on this pool: at 20, a
// concurrent query on the shared pool went 14ms → 86ms. The admin config
// schema asserts the same ceiling ("maximum": 10, api-config-schema.json),
// but that only validates edits made through the cockpit — a hand-edited
// api_config.json reaches this code unchecked, so the ceiling is enforced
// here too.
export const MAX_CONCURRENT_WRITES_CEILING = 10;

let clampWarnedFor: number | null = null;

/**
 * Clamps `max_concurrent_writes` to the pg pool size. Not silent — the log
 * names the configured value, the ceiling and the reason — but warned at most
 * once per offending value rather than on every call, because this resolver
 * runs on the search path. Re-warns if the configured value later changes to
 * a *different* over-limit number: teacher_logging is deliberately
 * runtime-flippable from the admin cockpit, so a later edit is a new decision
 * and deserves its own line in the log.
 */
export const resolveMaxConcurrentWrites = (configured: number): number => {
  if (!(configured > MAX_CONCURRENT_WRITES_CEILING)) return configured;
  if (clampWarnedFor !== configured) {
    clampWarnedFor = configured;
    logger.warn('ConfigService',
      `file_search.teacher_logging.max_concurrent_writes is ${configured}, above the ` +
      `${MAX_CONCURRENT_WRITES_CEILING}-connection file_search database pool it draws from; clamping to ` +
      `${MAX_CONCURRENT_WRITES_CEILING}. Beyond the pool size the limit stops dropping surplus teacher-label ` +
      'writes and starts queueing them inside the connection pool, delaying the searches it is meant to observe. ' +
      'Lower teacher_logging.sample_rate instead to reduce volume.');
  }
  return MAX_CONCURRENT_WRITES_CEILING;
};

/**
 * Teacher-label logging configuration for reranker evaluation/distillation.
 * Absent config yields the shipped defaults (both off), so an install whose
 * api_config.json predates this key never starts writing rows or persisting
 * chunk text. `enabled` and `storeChunkText` are deliberately independent:
 * turning on logging must never by itself start persisting document
 * contents.
 *
 * @see fileSearch/schema.sql.ts - reranker_search_events / reranker_candidate_labels
 */
export const getTeacherLoggingConfig = (): TeacherLoggingConfig => {
  try {
    const t = getConfig()?.api_config?.file_search?.teacher_logging;
    if (!t) return TEACHER_LOGGING_DEFAULTS;
    const d = TEACHER_LOGGING_DEFAULTS;
    return {
      enabled: t.enabled ?? d.enabled,
      storeChunkText: t.store_chunk_text ?? d.storeChunkText,
      sampleRate: t.sample_rate ?? d.sampleRate,
      source: t.source ?? d.source,
      maxConcurrentWrites: resolveMaxConcurrentWrites(t.max_concurrent_writes ?? d.maxConcurrentWrites),
    };
  } catch (error: any) {
    logger.error('ConfigService', `Error getting teacher_logging config: ${error.message}`);
    return TEACHER_LOGGING_DEFAULTS;
  }
};

export interface FileSearchToolConfig {
  enabled: boolean;
  maxSearchesPerRequest: number;
  maxNumResultsDefault: number;
}

const TOOL_DEFAULTS: FileSearchToolConfig = { enabled: true, maxSearchesPerRequest: 3, maxNumResultsDefault: 10 };
const MIN_SEARCHES = 1;
const MAX_SEARCHES = 10;
/**
 * The valid range for a `file_search` result count — both the configured
 * `tool.max_num_results_default` that `resolveMaxNumResultsDefault` below
 * clamps, and the per-request `max_num_results` a caller sends on the hosted
 * tool, which `plugins/fileSearch/descriptor.ts` validates against these same
 * two constants. Exported for exactly that reason: one bound, imported, rather
 * than a second pair of literals in the descriptor that agrees today and
 * drifts silently later. (OpenAI's own bound for the field is likewise [1, 50].)
 */
export const MIN_RESULTS_DEFAULT = 1;
export const MAX_RESULTS_DEFAULT = 50;

// Distinct from `undefined`/`NaN` (both of which are themselves offending
// values this resolver must warn about), so the initial "nothing warned yet"
// state can never collide with a real configured value.
const SEARCHES_CLAMP_UNWARNED = Symbol('searches-clamp-unwarned');
let searchesClampWarnedFor: unknown = SEARCHES_CLAMP_UNWARNED;

/**
 * Clamps `file_search.tool.max_searches_per_request` into [1, 10], falling back
 * to the default (rather than clamping to the nearer bound) on anything that
 * isn't a valid integer in range — garbage config (a string, a float, null,
 * NaN) is treated the same as "not configured" instead of being coerced.
 *
 * Not silent: a hand-edited api_config.json reaches this code unvalidated
 * (the admin schema only bounds cockpit-activated configs), and per this
 * codebase's own principle (see resolveMaxConcurrentWrites, and
 * test/fileSearch/teacherLoggingConfig.test.ts) "a silent override of a
 * tuning choice is its own defect." Warned at most once per distinct
 * offending value — this resolver runs on the search path — and re-warns if
 * the configured value later changes to a *different* offending value.
 * Uses `Object.is` rather than `!==` so a repeated `NaN` (which is `!== NaN`
 * to itself) doesn't re-warn on every call.
 */
export const resolveMaxSearchesPerRequest = (configured: unknown): number => {
  const valid = typeof configured === 'number' && Number.isInteger(configured)
      && configured >= MIN_SEARCHES && configured <= MAX_SEARCHES;
  if (valid) return configured as number;

  if (!Object.is(searchesClampWarnedFor, configured)) {
    searchesClampWarnedFor = configured;
    logger.warn('ConfigService',
      `file_search.tool.max_searches_per_request is ${JSON.stringify(configured)}, outside the valid ` +
      `range [${MIN_SEARCHES}, ${MAX_SEARCHES}] (or not an integer); falling back to the default of ` +
      `${TOOL_DEFAULTS.maxSearchesPerRequest}.`);
  }
  return TOOL_DEFAULTS.maxSearchesPerRequest;
};

/**
 * Clamps `file_search.tool.max_num_results_default` into [1, 50] the same way
 * `resolveMaxSearchesPerRequest` clamps its field: falls back to the default
 * rather than coercing to the nearer bound on anything that isn't a valid
 * in-range integer. A hand-edited api_config.json reaches this code
 * unvalidated (the admin schema only bounds cockpit-activated configs).
 */
export const resolveMaxNumResultsDefault = (configured: unknown): number => {
  if (typeof configured !== 'number' || !Number.isInteger(configured)
      || configured < MIN_RESULTS_DEFAULT || configured > MAX_RESULTS_DEFAULT) {
    return TOOL_DEFAULTS.maxNumResultsDefault;
  }
  return configured;
};

/**
 * Validates `file_search.tool.enabled`, falling back to the default for
 * anything that isn't a genuine boolean (a hand-edited `"true"` string, `1`,
 * etc. reach this code unvalidated the same way the numeric tool fields do).
 */
export const resolveToolEnabled = (configured: unknown): boolean => {
  return typeof configured === 'boolean' ? configured : TOOL_DEFAULTS.enabled;
};

/**
 * file_search tool-calling configuration (the Anthropic/OpenAI `file_search`
 * tool block, as opposed to the raw `/vector_stores/{id}/search` REST path
 * covered by `getFileSearchConfig`). Absent config — including an install
 * whose api_config.json predates this key entirely — yields the shipped
 * defaults, so upgrading installs get a working, enabled tool rather than a
 * crash.
 */
export const getFileSearchToolConfig = (): FileSearchToolConfig => {
  try {
    const t = getConfig()?.api_config?.file_search?.tool ?? {};
    return {
      enabled: resolveToolEnabled(t.enabled),
      maxSearchesPerRequest: resolveMaxSearchesPerRequest(t.max_searches_per_request),
      maxNumResultsDefault: resolveMaxNumResultsDefault(t.max_num_results_default),
    };
  } catch (error: any) {
    logger.error('ConfigService', `Error getting file_search tool config: ${error.message}`);
    return { ...TOOL_DEFAULTS };
  }
};

/**
 * Get parameter renames for a provider/model, e.g.
 * `{ "max_tokens": "max_completion_tokens" }` for newer OpenAI reasoning models
 * that reject `max_tokens`. Only needed on the direct-deployment path, which
 * forwards the raw client body (SAP orchestration normalizes params itself).
 *
 * Layered like getUnsupportedParams: a per-model map REPLACES the provider map.
 *
 * @param provider - lowercased provider key (from modelDetails.owned_by)
 * @param modelName - optional model id for a per-model override
 */
export const getParamRenames = (provider?: string, modelName?: string): Record<string, string> => {
  try {
    const config = getConfig();
    const modelOverride = modelName
      ? config?.api_config?.model_list_changes?.[modelName]?.param_renames
      : undefined;
    if (modelOverride && typeof modelOverride === 'object') {
      return modelOverride;
    }
    const providerMap = provider
      ? config?.api_config?.[provider]?.param_renames
      : undefined;
    return (providerMap && typeof providerMap === 'object') ? providerMap : {};
  } catch (error: any) {
    logger.error('ConfigService', `Error getting param renames: ${error.message}`);
    return {};
  }
};

export const getOpenAIDeploymentApiVersion = (): string | undefined => {
  try {
    const config = getConfig();
    return config?.api_config?.openai?.openai_deployment_api_version; // Can be undefined if not set
  } catch (error: any) {
    logger.error('ConfigService', `Error getting OpenAI deployment API version: ${error.message}`);
    return undefined;
  }
};

/**
 * Get all provider configurations
 * @returns The provider configurations
 */
export const getAllProviderConfigs = (): ApiConfig => {
  const config = getConfig();
  return config.api_config || {};
};

/**
 * Get model list changes
 * @returns The list of model changes
 */
export const getModelListChanges = (): ModelListChanges => {
  try {
    const config = getConfig(); // Assuming getConfig returns the whole parsed object
    return config?.api_config?.model_list_changes || {};
  } catch (error: any) {
    logger.error('ConfigService', `Error getting model_list_changes: ${error.message}`);
    return {};
  }
};

/**
 * Get cache pricing configuration for a specific model
 * @param modelId - The model ID to get cache pricing for
 * @returns Cache pricing configuration or null if not defined
 */
export const getCachePricingForModel = (modelId: string): CachePricing | null => {
  try {
    const modelListChanges = getModelListChanges();
    const modelConfig = modelListChanges[modelId];

    if (!modelConfig || !modelConfig.cachePricing) {
      return null;
    }

    return modelConfig.cachePricing;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting cache pricing for model ${modelId}: ${error.message}`);
    return null;
  }
};

/**
 * Get timeout configuration based on stream mode
 * @param isStreaming - Whether the request is streaming
 * @returns The timeout value in milliseconds
 */
export const getTimeout = (isStreaming: boolean = false): number => {
  try {
    const config = getConfig();
    const defaultTimeout = 120000; // Default 120 seconds
    
    if (!config?.api_config?.timeouts) {
      return isStreaming ? 240000 : defaultTimeout; // Default values if not configured
    }
    
    return isStreaming 
      ? (config.api_config.timeouts.streaming || 240000) // Default 240s for streaming
      : (config.api_config.timeouts.default || defaultTimeout); // Default 60s for non-streaming
  } catch (error: any) {
    logger.error('ConfigService', `Error getting timeout configuration: ${error.message}`);
    return isStreaming ? 240000 : 120000; // Default values on error
  }
};

/**
 * Get a specific part of the configuration by key.
 * @param key - The top-level key under api_config (e.g., 'openai', 'openrouter').
 * @returns The configuration for the specified key, or undefined if not found.
 */
export const get = (key: string): ProviderConfig | undefined => {
  try {
    const config = getConfig();
    return config?.api_config?.[key];
  } catch (error: any) {
    logger.error('ConfigService', `Error getting config for key '${key}': ${error.message}`);
    return undefined;
  }
};

/**
 * Get hook configuration for a specific model and subpath.
 * Falls back to per-endpoint defaultHooks when model has no explicit hooks.
 * @param modelId - The model ID
 * @param subpath - The requested subpath
 * @param endpoint - Optional endpoint identifier (e.g. 'anthropic', 'openai', 'aws-bedrock') for defaultHooks fallback
 * @returns Hook configuration or null if not found
 */
export const getHookConfig = (modelId: string, subpath: string, endpoint?: string): any => {
  try {
    const modelListChanges = getModelListChanges();
    const modelConfig = modelListChanges[modelId];

    if (modelConfig?.hooks?.[subpath]) {
      return modelConfig.hooks[subpath];
    }

    if (endpoint) {
      const config = getConfig();
      return config?.api_config?.defaultHooks?.[endpoint]?.[subpath] || null;
    }

    return null;
  } catch (error: any) {
    logger.error('ConfigService', `Error getting hook config: ${error.message}`);
    return null;
  }
};

/**
 * Deep merge two objects
 * @param target - The target object
 * @param source - The source object
 * @returns The merged object
 */
function deepMerge(target: any, source: any): any {
  const output = { ...target };
  
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  
  return output;
}

/**
 * Get SAP AI Core configuration
 * @returns SAP AI Core URL and resource group configuration
 */
export const getSAPAICoreConfig = () => {
  try {
    // During startup waiting, use environment variables only
    if (isWaitingForAdminEvents) {
      logger.debug('ConfigService', 'Using environment variables for SAP AI Core config during startup');
      return {
        url: process.env.SAP_AI_CORE_URL || getDefaultAICoreUrl(),
        resourceGroup: process.env.SAP_AI_RESOURCE_GROUP || 'default',
        deploymentId: process.env.SAP_AI_DEPLOYMENT_ID,
        autoDiscoverDeployment: process.env.SAP_AI_AUTO_DISCOVER_DEPLOYMENT?.toLowerCase() === 'true'
      };
    }
    
    const config = getConfig();
    const sapAIConfig = config?.api_config?.sap_ai_core;
    
    return {
      url: process.env.SAP_AI_CORE_URL || sapAIConfig?.url || getDefaultAICoreUrl(),
      resourceGroup: process.env.SAP_AI_RESOURCE_GROUP || sapAIConfig?.resource_group || 'default',
      deploymentId: process.env.SAP_AI_DEPLOYMENT_ID || sapAIConfig?.deployment_id,
      autoDiscoverDeployment: process.env.SAP_AI_AUTO_DISCOVER_DEPLOYMENT?.toLowerCase() === 'true'
    };
  } catch (error: any) {
    logger.error('ConfigService', `Error getting SAP AI Core config: ${error.message}`);
    return {
      url: process.env.SAP_AI_CORE_URL || getDefaultAICoreUrl(),
      resourceGroup: process.env.SAP_AI_RESOURCE_GROUP || 'default',
      deploymentId: process.env.SAP_AI_DEPLOYMENT_ID,
      autoDiscoverDeployment: process.env.SAP_AI_AUTO_DISCOVER_DEPLOYMENT?.toLowerCase() === 'true'
    };
  }
};

// Deployment ID cache to avoid repeated discovery
interface DeploymentIdCache {
  deploymentId: string | null;
  expiresAt: number;
  fromAutoDiscovery: boolean;
}

let deploymentIdCache: DeploymentIdCache | null = null;
const DEPLOYMENT_ID_CACHE_TTL_MS = 60000; // 1 minute cache for deployment ID resolution

/**
 * Get deployment ID with auto-discovery support and caching
 * @returns Promise<string | null> Deployment ID from config or auto-discovery
 */
export const getDeploymentId = async (): Promise<string | null> => {
  try {
    const sapConfig = getSAPAICoreConfig();
    
    // If deployment ID is explicitly configured, always use it (no caching needed)
    if (sapConfig.deploymentId) {
      logger.debug('ConfigService', `Using configured deployment ID: ${sapConfig.deploymentId}`);
      return sapConfig.deploymentId;
    }
    
    // If auto-discovery is enabled, check cache first
    if (sapConfig.autoDiscoverDeployment) {
      const now = Date.now();
      
      // Check if we have a valid cached deployment ID
      if (deploymentIdCache && deploymentIdCache.expiresAt > now && deploymentIdCache.fromAutoDiscovery) {
        logger.debug('ConfigService', `Using cached auto-discovered deployment ID: ${deploymentIdCache.deploymentId}`);
        return deploymentIdCache.deploymentId;
      }
      
      logger.debug('ConfigService', 'Auto-discovery enabled, attempting to find orchestration deployment');
      
      try {
        // Import deployment discovery service dynamically to avoid circular dependency
        const deploymentService = await import('./deploymentDiscoveryService');
        const discoveredId = await deploymentService.getPreferredOrchestrationDeploymentId();
        
        // Cache the result (including null results to prevent repeated failed attempts)
        deploymentIdCache = {
          deploymentId: discoveredId,
          expiresAt: now + DEPLOYMENT_ID_CACHE_TTL_MS,
          fromAutoDiscovery: true
        };
        
        if (discoveredId) {
          logger.info('ConfigService', `Auto-discovered deployment ID: ${discoveredId}`);
          return discoveredId;
        } else {
          logger.warn('ConfigService', 'Auto-discovery enabled but no suitable orchestration deployments found');
        }
      } catch (error: any) {
        logger.error('ConfigService', `Auto-discovery failed: ${error.message}`);
        
        // Cache the failure to prevent repeated attempts for a short time
        deploymentIdCache = {
          deploymentId: null,
          expiresAt: now + (DEPLOYMENT_ID_CACHE_TTL_MS / 4), // Shorter cache for failures
          fromAutoDiscovery: true
        };
      }
    }
    
    logger.debug('ConfigService', 'No deployment ID configured and auto-discovery disabled or failed');
    return null;
    
  } catch (error: any) {
    logger.error('ConfigService', `Error getting deployment ID: ${error.message}`);
    return null;
  }
};

/**
 * Clear the deployment ID cache (useful for testing or configuration changes)
 */
export const clearDeploymentIdCache = (): void => {
  deploymentIdCache = null;
  logger.debug('ConfigService', 'Deployment ID cache cleared');
};

/**
 * Get deployment ID cache status for debugging
 */
export const getDeploymentIdCacheStatus = () => {
  if (!deploymentIdCache) {
    return { cached: false };
  }
  
  const now = Date.now();
  return {
    cached: true,
    deploymentId: deploymentIdCache.deploymentId,
    expiresAt: deploymentIdCache.expiresAt,
    isExpired: deploymentIdCache.expiresAt <= now,
    fromAutoDiscovery: deploymentIdCache.fromAutoDiscovery,
    ttlMs: Math.max(0, deploymentIdCache.expiresAt - now)
  };
};

/**
 * Get access token for SAP AI Core
 * @returns Promise<string> Access token from OAuth flow (with proper caching and expiry handling)
 */
export const getAccessToken = async (): Promise<string> => {
  try {
    // Import modelService dynamically to avoid circular dependency
    const modelService = await import('./modelService');
    // modelService.getAuthToken() already handles token caching and expiry
    // It only makes a new OAuth request if the cached token is expired (60s buffer)
    return await modelService.getAuthToken();
  } catch (error: any) {
    logger.error('ConfigService', `Error getting access token from OAuth flow: ${error.message}`);
    throw error;
  }
};

/**
 * Get default SAP AI Core URL based on region
 * @returns Default AI Core URL
 */
function getDefaultAICoreUrl(): string {
  const aiRegion = process.env.SAP_AI_REGION || 'us-east-1';
  return `https://api.ai.${aiRegion}.aws.ml.hana.ondemand.com`;
}

/**
 * Check if value is an object
 * @param item - The item to check
 * @returns Whether the item is an object
 */
function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

export default {
  getConfig,
  getConfigAsync,
  updateConfig,
  patchConfig,
  getSubstitutedModel,
  getOriginalModel,
  shouldEmulateStreaming,
  getAnthropicBedrockVersion,
  getExcludedBetaHeaders,
  getSupportedBetaHeaders,
  getUnsupportedParams,
  getParamRenames,
  getSupportsResponsesApi,
  getSupportsPromptCaching,
  isPseudonymizationForced,
  getWebSearchMaxSearches,
  getHostedToolResultCacheTtlSeconds,
  getHostedToolResultCacheMaxEntries,
  getNamespaceToolMode,
  getCustomToolMode,
  getToolSearchMode,
  getToolSearchHoistDiscoveredTools,
  getFileSearchConfig,
  resolveMaxRetries,
  getTeacherLoggingConfig,
  closeValkeyConnections,
  getFileSearchToolConfig,
  resolveMaxSearchesPerRequest,
  resolveMaxNumResultsDefault,
  resolveToolEnabled,
  getOpenAIDeploymentApiVersion,
  getAllProviderConfigs,
  getModelListChanges,
  getCachePricingForModel,
  getTimeout,
  get,
  getHookConfig,
  getSAPAICoreConfig,
  getDeploymentId,
  clearDeploymentIdCache,
  getDeploymentIdCacheStatus,
  getAccessToken,
  publishModelList,
  onConfigurationReady,
  isConfigurationReady,
  listConfigBackups,
  restoreConfigFromBackup
};