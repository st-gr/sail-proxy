import 'dotenv/config';
import { ConfigLoader } from '../../../libs/config';
import { getDefaultLogger } from '../../../libs/logger';
import { createApp } from './app';
import { connectionRegistry } from './connections/connectionRegistry';
import { adminConnectionBackend } from './connections/adminBackend';
import { connectionsFilePath, fileConnectionBackend } from './connections/fileBackend';
import { startSapTargetSync } from './sap/sapTargetSync';
import { setLastKnownStore } from './sap/lastKnownTarget';
import { bootSyncPlugins, setPluginStatusStore, startPluginWatch, stopPluginWatch } from './pluginInstall/runtime';

const logger = getDefaultLogger();

// Route imports
import { runMigration } from './fileSearch/db';
import { startIngestWorker, stopIngestWorker } from './fileSearch/ingestWorker';
import { startExpirySweeper, stopExpirySweeper } from './fileSearch/expirySweeper';
import { startJobSweeper, stopJobSweeper } from './fileSearch/jobSweeper';
import { startBlobSweeper, stopBlobSweeper } from './fileSearch/blob/blobSweeper';
import { startBlobMigrationWorker, stopBlobMigrationWorker } from './fileSearch/blob/blobMigrationQueue';

// Middleware imports
import { installUnhandledRejectionLogger } from './utils/processGuards';
import { attachRealtimeUpgrade } from './realtime/realtimeUpgrade';
import { CLOSE_GOING_AWAY, REASON_SERVER_SHUTDOWN } from './realtime/closeCodes';

const configLoader = new ConfigLoader('gateway');
const config = configLoader.loadConfig();

// A rejected async handler must not take the process down (see utils/processGuards.ts).
installUnhandledRejectionLogger(logger);

const { app, deploymentsMounted, groundingMounted } = createApp(config);

// Initialize usage event system
import usageEmitter from './services/usageEventEmitter';
import securityEventEmitter from './services/securityEventEmitter';
import Redis from 'iovalkey';
import { isStandaloneMode, shouldEnableDistributedCaching } from './config/unifiedAuthConfig';
import { configureQuotaEnforcement } from './middlewares/quotaEnforcement';

// Initialize cache invalidation system
import { gatewayCacheInvalidationService } from './services/gatewayCacheInvalidationService';
import { unifiedValidationCache } from './services/unifiedValidationCache';

async function initializeUsageTracking() {
  try {
    if (shouldEnableDistributedCaching()) {
      logger.info('Gateway Service', 'Initializing Valkey client for usage tracking');
      const valkeyClient = new Redis(process.env.VALKEY_URL!);
      
      valkeyClient.on('error', (err: any) => {
        logger.warn('Usage Tracking', 'Valkey client error:', err.message);
      });
      
      valkeyClient.on('connect', () => {
        logger.info('Usage Tracking', 'Connected to Valkey for usage events');
      });
      
      usageEmitter.setValkeyClient(valkeyClient);
      cleanupResources.valkeyClients.push(valkeyClient); // Track for cleanup
      logger.info('Usage Tracking', 'Usage event system initialized with Valkey');
    } else {
      const mode = isStandaloneMode() ? 'standalone mode' : 'distributed mode with Valkey unavailable';
      logger.info('Usage Tracking', `Usage event system initialized with memory fallback (${mode})`);
      
      // Set up periodic flush to admin service when not in standalone mode
      if (!isStandaloneMode()) {
        const usageInterval = setInterval(async () => {
          try {
            await usageEmitter.flushToAdminService();
          } catch (error) {
            // Errors are already logged in flushToAdminService
          }
        }, 60000); // Flush every 60 seconds
        cleanupResources.intervals.push(usageInterval); // Track for cleanup
        logger.info('Usage Tracking', 'Periodic flush to admin service initialized (60s interval)');
      } else {
        logger.info('Usage Tracking', 'Standalone mode - usage tracking will use local memory only');
      }
    }
  } catch (error) {
    logger.warn('Usage Tracking', 'Failed to initialize Valkey for usage tracking, using memory fallback:', 
      error instanceof Error ? error.message : 'Unknown error');
    // Set up fallback flush even if Valkey initialization failed (only if not standalone)
    if (!isStandaloneMode()) {
      const fallbackUsageInterval = setInterval(async () => {
        try {
          await usageEmitter.flushToAdminService();
        } catch (error) {
          // Errors are already logged in flushToAdminService
        }
      }, 60000);
      cleanupResources.intervals.push(fallbackUsageInterval); // Track for cleanup
    }
  }
}

async function initializeSecurityEventSystem() {
  try {
    if (shouldEnableDistributedCaching()) {
      logger.info('Gateway Service', 'Initializing Valkey client for security events');
      const valkeyClient = new Redis(process.env.VALKEY_URL!);
      
      valkeyClient.on('error', (err: any) => {
        logger.warn('Security Events', 'Valkey client error:', err.message);
      });
      
      valkeyClient.on('connect', () => {
        logger.info('Security Events', 'Connected to Valkey for security events');
      });
      
      securityEventEmitter.setValkeyClient(valkeyClient);
      cleanupResources.valkeyClients.push(valkeyClient); // Track for cleanup
      logger.info('Security Events', 'Security event system initialized with Valkey');
    } else {
      const mode = isStandaloneMode() ? 'standalone mode' : 'distributed mode with Valkey unavailable';
      logger.info('Security Events', `Security event system initialized with memory fallback (${mode})`);
      
      // Set up periodic flush to admin service when not in standalone mode
      if (!isStandaloneMode()) {
        const securityInterval = setInterval(async () => {
          try {
            await securityEventEmitter.flushToAdminService();
          } catch (error) {
            // Errors are already logged in flushToAdminService
          }
        }, 30000); // Flush every 30 seconds (more frequent than usage events)
        cleanupResources.intervals.push(securityInterval); // Track for cleanup
        logger.info('Security Events', 'Periodic flush to admin service initialized (30s interval)');
      } else {
        logger.info('Security Events', 'Standalone mode - security events will use local memory only');
      }
    }
  } catch (error) {
    logger.warn('Security Events', 'Failed to initialize Valkey for security events, using memory fallback:', 
      error instanceof Error ? error.message : 'Unknown error');
    // Set up fallback flush even if Valkey initialization failed (only if not standalone)
    if (!isStandaloneMode()) {
      const fallbackSecurityInterval = setInterval(async () => {
        try {
          await securityEventEmitter.flushToAdminService();
        } catch (error) {
          // Errors are already logged in flushToAdminService
        }
      }, 30000);
      cleanupResources.intervals.push(fallbackSecurityInterval); // Track for cleanup
    }
  }
}

async function initializeQuotaEnforcement() {
  if (!shouldEnableDistributedCaching()) {
    logger.info('Quota Enforcement', `Using per-pod memory buckets (${isStandaloneMode() ? 'standalone mode' : 'Valkey not configured'})`);
    return;
  }
  // Short command timeout and no offline queue: a Valkey outage must fail the decision fast (the
  // middleware then falls back to memory buckets), never stall the request behind a reconnect.
  const valkeyClient = new Redis(process.env.VALKEY_URL!, { enableOfflineQueue: false, commandTimeout: 500, maxRetriesPerRequest: 1 });
  valkeyClient.on('error', (err: any) => logger.warn('Quota Enforcement', 'Valkey client error:', err.message));
  valkeyClient.on('connect', () => logger.info('Quota Enforcement', 'Connected to Valkey for rate-limit counters'));
  configureQuotaEnforcement({ valkeyClient });
  cleanupResources.valkeyClients.push(valkeyClient);
}

async function initializeCacheInvalidation() {
  try {
    // Initialize cache invalidation service
    await gatewayCacheInvalidationService.initialize();
    
    // Register cache services for invalidation
    gatewayCacheInvalidationService.registerCacheService({
      name: 'UnifiedValidationCache',
      clearByCredentialId: (credentialId: string, authType: 'api_key' | 'aws_credential') => 
        unifiedValidationCache.clearByCredentialId(credentialId, authType),
      clearByPattern: (pattern: string) => 
        unifiedValidationCache.clearByPattern(pattern)
    });
    
    logger.info('Gateway Service', 'Cache invalidation system initialized successfully');
  } catch (error) {
    logger.warn('Gateway Service', 'Failed to initialize cache invalidation system:', 
      error instanceof Error ? error.message : 'Unknown error');
  }
}

async function initializeGatewayService(): Promise<void> {
  // Initialize configuration service and wait for admin events only when not in standalone mode and Valkey is available
  const configService = require('./services/configService').default;

  // Installed plugins: unpack first, so the first plugin load below finds them (spec 2026-11-04 §5).
  await bootSyncPlugins();
  
  if (!isStandaloneMode() && process.env.VALKEY_URL) {
    logger.info('Gateway Service', 'Non-standalone mode with Valkey available - waiting for configuration from Admin Service before starting server...');
    
    try {
      // Wait for configuration to be received from admin service via Valkey events
      await configService.getConfigAsync();
      logger.info('Gateway Service', 'Configuration received from Admin Service via Valkey events - proceeding with startup');
    } catch (error) {
      logger.error('Gateway Service', 'Failed to receive configuration from Admin Service via events, falling back to HTTP/local config:', 
        error instanceof Error ? error : new Error('Unknown error'));
    }
  } else if (!isStandaloneMode() && !process.env.VALKEY_URL) {
    logger.info('Gateway Service', 'Non-standalone mode but no Valkey available - will use HTTP fallback for configuration');
  } else {
    logger.info('Gateway Service', 'Running in standalone mode - using local configuration');

    // Refuse to start on a pre-restructure config file. In standalone there is
    // no Admin Service and no UI to notice through: an old-shape file parses,
    // caches, and silently disengages observability.siem,
    // observability.pseudonymization and platform.security while the operator
    // believes they are on. Failing here - before the listener binds - is the
    // only place that cannot be missed.
    const legacyShape = configService.getConfigFileLegacyShapeError();
    if (legacyShape) {
      logger.error('Gateway Service', legacyShape.message);
      // Also on stderr directly: logger transports can be buffered, and this
      // message is the entire value of exiting rather than serving.
      console.error(`\nFATAL: ${legacyShape.message}\n`);
      process.exit(1);
    }
  }
  
  // Initialize systems after configuration is ready
  await initializeUsageTracking();
  await initializeSecurityEventSystem();
  await initializeQuotaEnforcement();
  await initializeCacheInvalidation();

  // Connections (spec 2026-10-23 §4.2): refetch the snapshot on the admin's change marker, and pull
  // the first one now. The SAP AI Core target follows the active sap-ai-core connection (spec
  // 2026-10-25 §5): startup waits briefly for the admin's answer, else installs the last-known
  // target from Valkey, so the first requests do not go to an environment key a move made stale.
  if (!isStandaloneMode() && process.env.ADMIN_SERVICE_URL) {
    if (shouldEnableDistributedCaching()) {
      const valkeyClient = new Redis(process.env.VALKEY_URL!, { commandTimeout: 1000, maxRetriesPerRequest: 1 });
      valkeyClient.on('error', (err: any) => logger.warn('SapTarget', 'Valkey client error:', err.message));
      setLastKnownStore({
        get: (key) => valkeyClient.get(key),
        set: (key, value) => valkeyClient.set(key, value),
        del: (key) => valkeyClient.del(key),
      });
      setPluginStatusStore(valkeyClient);
      cleanupResources.valkeyClients.push(valkeyClient);
    }
    connectionRegistry.setBackend(adminConnectionBackend);
    // Refetch at once, not on the next request: an idle gateway also switches its SAP target.
    configService.setConnectionsChangedHandler(() => { connectionRegistry.markStale(); void connectionRegistry.ensureFresh(); });
    await startSapTargetSync(connectionRegistry);
  }
  startPluginWatch();

  // Standalone: no admin, so the snapshot comes from connections.json (no SAP target sync: the
  // standalone SAP key stays in .env).
  if (isStandaloneMode()) {
    const connectionsFile = connectionsFilePath(process.env);
    if (connectionsFile) connectionRegistry.setBackend(fileConnectionBackend(connectionsFile));
  }

  // file_search: apply the schema migration (a no-op that logs and returns
  // when no database is configured — the normal state for a standalone
  // install) before starting the ingestion worker, which itself also
  // no-ops cleanly when file_search is unavailable.
  await runMigration();
  startIngestWorker();
  startExpirySweeper();
  startJobSweeper();
  startBlobSweeper();
  startBlobMigrationWorker();
}

// Global cleanup tracking
const cleanupResources = {
  server: null as any,
  intervals: [] as NodeJS.Timeout[],
  valkeyClients: [] as any[],
  realtime: null as null | { closeAll(code: number, reason: string): void }
};

// Enhanced graceful shutdown handler
function gracefulShutdown(signal: string): void {
  logger.info('Gateway Service', `Received ${signal}, initiating graceful shutdown...`);
  
  const shutdownTimeout = setTimeout(() => {
    logger.error('Gateway Service', 'Graceful shutdown timeout, forcing exit');
    process.exit(1);
  }, 10000); // 10 second timeout
  
  Promise.resolve().then(async () => {
    // Clear all intervals first
    cleanupResources.intervals.forEach(interval => {
      clearInterval(interval);
    });
    logger.info('Gateway Service', `Cleared ${cleanupResources.intervals.length} intervals`);

    // Stop the file_search ingestion worker, letting any in-flight job
    // finish first (see fileSearch/ingestWorker.ts's stopIngestWorker).
    try {
      await stopIngestWorker();
      logger.info('Gateway Service', 'file_search ingestion worker stopped');
    } catch (error) {
      logger.warn('Gateway Service', 'Error stopping file_search ingestion worker:',
        error instanceof Error ? error.message : 'Unknown error');
    }
    // The blob migration loop: an item in flight finishes or rolls back first.
    try {
      await stopBlobMigrationWorker();
    } catch (error) {
      logger.warn('Gateway Service', 'Error stopping the file_search blob migration worker:',
        error instanceof Error ? error.message : 'Unknown error');
    }

    // Stop the file_search expiry sweeper (just clears its interval timer --
    // see fileSearch/expirySweeper.ts's stopExpirySweeper).
    stopExpirySweeper();
    stopJobSweeper();
    stopBlobSweeper();

    // Close the config event connections. These are NOT in
    // cleanupResources.valkeyClients — that registry only holds the clients
    // this file creates — so nothing closed them until now; configService
    // opened a subscriber and a publisher once and left both open for the
    // process's lifetime.
    try {
      await require('./services/configService').closeValkeyConnections();
      logger.info('Gateway Service', 'Config event Valkey connections closed');
    } catch (error) {
      logger.warn('Gateway Service', 'Error closing config event Valkey connections:',
        error instanceof Error ? error.message : 'Unknown error');
    }

    // End the open Realtime WebSocket sessions before the quota store goes away: an upgraded
    // socket also keeps the HTTP server open, so without this server.close() below never calls
    // back and the shutdown timeout kills the process (clients would see a 1006).
    cleanupResources.realtime?.closeAll(CLOSE_GOING_AWAY, REASON_SERVER_SHUTDOWN);

    // Remove this instance's plugin status while its Valkey client is still open, so the Plugins
    // app stops listing a stopped gateway at once instead of after the status key's TTL.
    try {
      await stopPluginWatch();
    } catch (error) {
      logger.warn('Gateway Service', 'Error removing the plugin status:',
        error instanceof Error ? error.message : 'Unknown error');
    }

    // Close Valkey connections
    const valkeyClosePromises = cleanupResources.valkeyClients.map(async (client, index) => {
      try {
        if (client && typeof client.disconnect === 'function') {
          await client.disconnect();
          logger.info('Gateway Service', `Valkey client ${index + 1} disconnected`);
        }
      } catch (error) {
        logger.warn('Gateway Service', `Error disconnecting Valkey client ${index + 1}:`, 
          error instanceof Error ? error.message : 'Unknown error');
      }
    });
    
    await Promise.all(valkeyClosePromises);
    
    // Close HTTP server
    if (cleanupResources.server) {
      return new Promise<void>((resolve) => {
        cleanupResources.server.close((err: any) => {
          if (err) {
            logger.error('Gateway Service', 'Error closing HTTP server:', err.message);
          } else {
            logger.info('Gateway Service', 'HTTP server closed');
          }
          resolve();
        });
      });
    }
  }).then(() => {
    clearTimeout(shutdownTimeout);
    logger.info('Gateway Service', 'Graceful shutdown completed');
    process.exit(0);
  }).catch((error) => {
    clearTimeout(shutdownTimeout);
    logger.error('Gateway Service', 'Error during graceful shutdown', 
      error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  });
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Initialize the gateway service and then start the HTTP server
initializeGatewayService().then(() => {
  const server = app.listen(config.port, config.host, () => {
    logger.info('Gateway Service', `Server listening on ${config.host}:${config.port} (${config.deployTarget})`);
    logger.info('Gateway Service', `Health check: http://${config.host}:${config.port}/health`);
    logger.info('Gateway Service', `Service info: http://${config.host}:${config.port}/`);
    // Keep this list in step with the app.use() mounts above — it is what operators read first.
    const base = `http://${config.host}:${config.port}`;
    logger.info('Gateway Service', 'API endpoints available at:');
    logger.info('Gateway Service', `- Available Models: ${base}/v1/models and ${base}/openai/v1/models`);
    logger.info('Gateway Service', `- OpenAI Chat Completions: ${base}/openai/v1/chat/completions`);
    logger.info('Gateway Service', `- OpenAI Embeddings: ${base}/openai/v1/embeddings`);
    logger.info('Gateway Service', `- OpenAI Responses: ${base}/openai/v1/responses`);
    logger.info('Gateway Service', `- OpenAI Images: ${base}/openai/v1/images/generations and ${base}/openai/v1/images/edits`);
    logger.info('Gateway Service', `- OpenAI Files (file_search): ${base}/openai/v1/files`);
    logger.info('Gateway Service', `- OpenAI Vector Stores (file_search): ${base}/openai/v1/vector_stores`);
    logger.info('Gateway Service', `- OpenAI Realtime (WebSocket): ws://${config.host}:${config.port}/openai/v1/realtime and ws://${config.host}:${config.port}/v1/realtime`);
    logger.info('Gateway Service', `  (every HTTP /openai/v1 path is also served under ${base}/openai/api/v1)`);
    logger.info('Gateway Service', `- Anthropic Messages: ${base}/anthropic/v1/messages (also /messages/count_tokens, /complete)`);
    logger.info('Gateway Service', `- Google Gemini: ${base}/google/v1beta/models/{model}:{generateContent|streamGenerateContent|embedContent} (also /google/v1)`);
    logger.info('Gateway Service', `- AWS Bedrock Invoke: ${base}/aws-bedrock/model/{modelId}/invoke`);
    logger.info('Gateway Service', `- AWS Bedrock Invoke Stream: ${base}/aws-bedrock/model/{modelId}/invoke-with-response-stream`);
    logger.info('Gateway Service', `- AWS Bedrock Converse: ${base}/aws-bedrock/model/{modelId}/converse`);
    logger.info('Gateway Service', `- AWS Bedrock Converse Stream: ${base}/aws-bedrock/model/{modelId}/converse-stream`);
    logger.info('Gateway Service', `- OpenRouter Chat: ${base}/openrouter/api/v1/chat/completions`);
    logger.info('Gateway Service', `- OpenRouter Completions: ${base}/openrouter/api/v1/completions`);
    logger.info('Gateway Service', `- OpenRouter Responses: ${base}/openrouter/api/v1/responses`);
    logger.info('Gateway Service', `- OpenRouter Models: ${base}/openrouter/api/v1/models (also /models/{author}/{slug}/endpoints, /generation, /credits)`);
    logger.info('Gateway Service', `- OpenRouter Files / Vector Stores: ${base}/openrouter/api/v1/files and ${base}/openrouter/api/v1/vector_stores`);
    logger.info('Gateway Service', `- AWS Credentials Management: ${base}/aws/api-keys`);
    logger.info('Gateway Service', `- Admin API Keys: ${base}/api/admin/api-keys`);
    logger.info('Gateway Service', `- Admin API Config: ${base}/api/admin/api-config`);
    if (deploymentsMounted) logger.info('Gateway Service', `- Admin Deployments: ${base}/api/admin/deployments`);
    if (groundingMounted) logger.info('Gateway Service', `- Admin Grounding: ${base}/api/admin/grounding`);
    logger.info('Gateway Service', '');
    logger.info('Gateway Service', 'Authentication Methods:');
    logger.info('Gateway Service', '- Models, OpenAI, Anthropic, Google Gemini, OpenRouter, Realtime: Unified Token Auth (API Key + fallback to legacy)');
    logger.info('Gateway Service', '- AWS Bedrock: AWS SigV4 or Unified Token Auth (API Key + AWS credentials)');
    logger.info('Gateway Service', '- Admin API Keys, AWS Credentials Management: standalone mode only');
    logger.info('Gateway Service', '- Admin API Config, Admin Deployments: standalone mode or admin service key');
    if (groundingMounted) logger.info('Gateway Service', '- Admin Grounding: admin service key only');
    logger.info('Gateway Service', '');
    logger.info('Gateway Service', '💡 Press Ctrl+C to gracefully shutdown the service');
  });

  // The Realtime API arrives as a WebSocket upgrade, which never enters Express. The handle lets
  // gracefulShutdown close the live sessions.
  cleanupResources.realtime = attachRealtimeUpgrade(server);

  // Fail loudly if the port is taken: otherwise a stale gateway instance keeps serving
  // requests while this (newer) process dies quietly — old code masquerades as the
  // current build, which makes debugging almost impossible.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error('Gateway Service',
        `FATAL: ${config.host}:${config.port} is already in use — ANOTHER gateway instance is running. ` +
        `Requests are being served by THAT process (possibly stale code), not this one. ` +
        `Find it with: lsof -nP -iTCP:${config.port} -sTCP:LISTEN`);
    } else {
      logger.error('Gateway Service', 'HTTP server error:',
        error instanceof Error ? error : new Error(String(error)));
    }
    process.exit(1);
  });

  // Store server reference for cleanup
  cleanupResources.server = server;

}).catch((error) => {
  logger.error('Gateway Service', 'Failed to initialize Gateway Service:', 
    error instanceof Error ? error : new Error('Unknown error'));
  process.exit(1);
});
