import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import { ConfigLoader } from '../../../libs/config';
import { getDefaultLogger } from '../../../libs/logger';
import type { RequestContext } from '../../../libs/types';
import { getClientIp } from './utils/clientIp';
import { getTrustForwardedFor } from './services/configService';

const logger = getDefaultLogger();

// Route imports
import { createHealthHandler } from './routes/healthRoutes';
import modelRoutes from './routes/modelRoutes';
import chatRoutes from './routes/chatRoutes';
import embeddingRoutes from './routes/embeddingRoutes';
import responsesRoutes from './routes/responsesRoutes';
import imagesRoutes from './routes/imagesRoutes';
import filesRoutes from './routes/filesRoutes';
import vectorStoresRoutes from './routes/vectorStoresRoutes';
import { runMigration } from './fileSearch/db';
import { startIngestWorker, stopIngestWorker } from './fileSearch/ingestWorker';
import { startExpirySweeper, stopExpirySweeper } from './fileSearch/expirySweeper';
import anthropicRoutes from './routes/anthropicRoutes';
import googleRoutes from './routes/googleRoutes';
import sapRptRoutes from './routes/sapRptRoutes';
import awsBedrockRoutes from './routes/awsBedrockRoutes';
import awsCredentialsRoutes from './routes/awsCredentialsRoutes';
import apiKeyRoutes from './routes/apiKeyRoutes';
import configRoutes from './routes/configRoutes';
import { mountDeploymentRoutes } from './routes/deploymentRoutes';
import openRouterRoutes from './routes/openRouterRoutes';

// Middleware imports
import awsSigV4Auth from './middlewares/awsSigV4Auth';
import errorHandler from './middlewares/errorHandler';
import { nulByteGuard } from './middlewares/nulByteGuard';
import { installUnhandledRejectionLogger } from './utils/processGuards';
import { attachRealtimeUpgrade } from './realtime/realtimeUpgrade';
import { CLOSE_GOING_AWAY, REASON_SERVER_SHUTDOWN } from './realtime/closeCodes';

const configLoader = new ConfigLoader('gateway');
const config = configLoader.loadConfig();

// A rejected async handler must not take the process down (see utils/processGuards.ts).
installUnhandledRejectionLogger(logger);

const app = express();

// Number of proxies in front of this service, not `true`. `true` trusts the entire
// forwarded chain, which is itself spoofable. The value is a deployment property —
// see docs; verify it with the check below rather than assuming.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));

// Basic middleware setup
app.use(bodyParser.json({ 
  limit: config.maxRequestSize,
  verify: (req: any, _res: any, buf: any, _encoding: any) => {
    if (req.url && req.url.startsWith('/aws-bedrock')) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));

app.use(bodyParser.urlencoded({ limit: config.maxRequestSize, extended: true }));

// Morgan HTTP logging with shared logger
app.use(morgan('combined', {
  stream: {
    write: (message: string) => {
      logger.info('HTTP', message.trim());
    }
  }
}));

// Request context middleware
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  const requestContext: RequestContext = {
    requestId: `gateway-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    userAgent: req.get('User-Agent'),
    clientIp: getClientIp(req, getTrustForwardedFor()),
    apiKey: req.get('x-api-key'),
    service: 'gateway'
  };
  
  logger.setRequestContext(requestContext);
  
  // Set debugRequestId for usage tracking consistency
  (req as any).debugRequestId = requestContext.requestId;
  
  next();
});

// CORS middleware
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

// Health check endpoint
app.get('/health', createHealthHandler(config.deployTarget));

// Model Routes
app.use('/v1/models', modelRoutes);
app.use('/openai/v1/models', modelRoutes);

// OpenAI Chat Routes
app.use('/openai/api/v1/chat/completions', chatRoutes);
app.use('/openai/v1/chat/completions', chatRoutes);

// OpenAI Embedding Routes
app.use('/openai/api/v1/embeddings', embeddingRoutes);
app.use('/openai/v1/embeddings', embeddingRoutes);

// OpenAI Responses Routes
app.use('/openai/api/v1/responses', responsesRoutes);
app.use('/openai/v1/responses', responsesRoutes);

// OpenAI Images Routes (generations, edits) — served by Gemini image deployments
app.use('/openai/api/v1/images', imagesRoutes);
app.use('/openai/v1/images', imagesRoutes);

// NUL-byte guard (file_search identifiers/cursors only) — mounted ahead of
// the Files and Vector Store handlers, after body parsing. See
// src/middlewares/nulByteGuard.ts for why this exists.
//
// The /openrouter entries are not optional: openRouterRoutes re-declares the
// Files and Vector Store paths, so the same NUL reaches Postgres from there.
// Its `router.param` registrations cover path params only; ?after/?before and
// the body identifier fields are covered here or nowhere.
app.use(
  [
    '/openai/api/v1/files',
    '/openai/v1/files',
    '/openai/api/v1/vector_stores',
    '/openai/v1/vector_stores',
    '/openrouter/api/v1/files',
    '/openrouter/api/v1/vector_stores',
  ],
  nulByteGuard,
);

// OpenAI Files Routes (file_search)
app.use('/openai/api/v1/files', filesRoutes);
app.use('/openai/v1/files', filesRoutes);

// OpenAI Vector Store Routes (file_search)
app.use('/openai/api/v1/vector_stores', vectorStoresRoutes);
app.use('/openai/v1/vector_stores', vectorStoresRoutes);

// Anthropic Routes
app.use('/anthropic/v1', anthropicRoutes);

// Google Gemini Routes - both API versions the @google/genai SDK builds URLs for
app.use('/google/v1beta', googleRoutes);
app.use('/google/v1', googleRoutes);

// SAP-RPT Tabular Prediction Routes
app.use('/sap/v1/rpt', sapRptRoutes);

// AWS Bedrock Routes
app.use('/aws-bedrock', awsBedrockRoutes);

// AWS Credentials Management Routes
app.use('/aws/api-keys', awsCredentialsRoutes);

// Admin Routes (temporary - will move to admin service later)
app.use('/api/admin/api-keys', apiKeyRoutes);
app.use('/api/admin/api-config', configRoutes);
const deploymentsMounted = mountDeploymentRoutes(app);   // skipped in standalone mode - see routes/deploymentRoutes.ts

// OpenRouter Routes
app.use('/openrouter/api/v1', openRouterRoutes);

// Root endpoint
app.get('/', (_req: express.Request, res: express.Response) => {
  res.json({
    message: 'SAP AI Core Multi-Provider Gateway',
    version: '1.0.0',
    service: 'gateway',
    deployTarget: config.deployTarget,
    status: 'Service is running with all API routes restored',
    endpoints: {
      health: '/health',
      models: ['/v1/models', '/openai/v1/models'],
      chat: ['/openai/api/v1/chat/completions', '/openai/v1/chat/completions'],
      embeddings: ['/openai/api/v1/embeddings', '/openai/v1/embeddings'],
      anthropic: '/anthropic/v1',
      google: ['/google/v1beta', '/google/v1'],
      awsBedrock: '/aws-bedrock',
      awsCredentials: '/aws/api-keys',
      admin: ['/api/admin/api-keys', '/api/admin/api-config', '/api/admin/deployments'],
      openRouter: '/openrouter/api/v1'
    },
    availableFiles: {
      controllers: 'Available',
      routes: 'Available', 
      middlewares: 'Available',
      services: 'Available',
      utils: 'Available',
      plugins: 'Available'
    }
  });
});

// Global error handler
app.use(errorHandler);

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

  // file_search: apply the schema migration (a no-op that logs and returns
  // when no database is configured — the normal state for a standalone
  // install) before starting the ingestion worker, which itself also
  // no-ops cleanly when file_search is unavailable.
  await runMigration();
  startIngestWorker();
  startExpirySweeper();
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

    // Stop the file_search expiry sweeper (just clears its interval timer --
    // see fileSearch/expirySweeper.ts's stopExpirySweeper).
    stopExpirySweeper();

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
    logger.info('Gateway Service', '');
    logger.info('Gateway Service', 'Authentication Methods:');
    logger.info('Gateway Service', '- Models, OpenAI, Anthropic, Google Gemini, OpenRouter, Realtime: Unified Token Auth (API Key + fallback to legacy)');
    logger.info('Gateway Service', '- AWS Bedrock: AWS SigV4 or Unified Token Auth (API Key + AWS credentials)');
    logger.info('Gateway Service', '- Admin API Keys, AWS Credentials Management: standalone mode only');
    logger.info('Gateway Service', '- Admin API Config, Admin Deployments: standalone mode or admin service key');
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
