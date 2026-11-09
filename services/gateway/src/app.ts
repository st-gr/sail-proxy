import express from 'express';
import bodyParser from 'body-parser';
import { accessLogMiddleware } from './utils/accessLog';
import type { ConfigOptions } from '../../../libs/config/types';
import { getDefaultLogger } from '../../../libs/logger';
import type { RequestContext } from '../../../libs/types';
import { getClientIp } from './utils/clientIp';
import { getTrustForwardedFor } from './services/configService';

import { createHealthHandler } from './routes/healthRoutes';
import { mountApiDocs } from './routes/apiDocsRoutes';
import modelRoutes from './routes/modelRoutes';
import chatRoutes from './routes/chatRoutes';
import embeddingRoutes from './routes/embeddingRoutes';
import responsesRoutes from './routes/responsesRoutes';
import imagesRoutes from './routes/imagesRoutes';
import filesRoutes from './routes/filesRoutes';
import uploadsRoutes from './routes/uploadsRoutes';
import vectorStoresRoutes from './routes/vectorStoresRoutes';
import anthropicRoutes from './routes/anthropicRoutes';
import googleRoutes from './routes/googleRoutes';
import sapRptRoutes from './routes/sapRptRoutes';
import awsBedrockRoutes from './routes/awsBedrockRoutes';
import awsCredentialsRoutes from './routes/awsCredentialsRoutes';
import apiKeyRoutes from './routes/apiKeyRoutes';
import configRoutes from './routes/configRoutes';
import { mountDeploymentRoutes } from './routes/deploymentRoutes';
import { mountConnectionAdminRoutes } from './routes/connectionAdminRoutes';
import { mountGroundingRoutes } from './routes/groundingRoutes';
import openRouterRoutes from './routes/openRouterRoutes';
import errorHandler from './middlewares/errorHandler';
import { isAwsSigV4Request } from './utils/sigv4Verifier';
import { nulByteGuard } from './middlewares/nulByteGuard';
import { sapTenantMiddleware } from './sap/sapTarget';

const logger = getDefaultLogger();

/**
 * Builds the Express app: every middleware and route mount, in order, without
 * listening or starting any worker. index.ts owns start-up and shutdown.
 */
export function createApp(config: ConfigOptions): { app: express.Express; deploymentsMounted: boolean; groundingMounted: boolean } {
  const app = express();

  // Number of proxies in front of this service, not `true`. `true` trusts the entire
  // forwarded chain, which is itself spoofable. The value is a deployment property —
  // see docs; verify it with the check below rather than assuming.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));

  // Basic middleware setup
  app.use(bodyParser.json({ 
    limit: config.maxRequestSize,
    verify: (req: any, _res: any, buf: any, _encoding: any) => {
      // The raw body is the payload a SigV4 signature covers (utils/sigv4Verifier.ts).
      if ((req.url && req.url.startsWith('/aws-bedrock')) || isAwsSigV4Request(req.headers.authorization)) {
        req.rawBody = buf.toString('utf8');
      }
    }
  }));

  app.use(bodyParser.urlencoded({ limit: config.maxRequestSize, extended: true }));

  // Morgan HTTP logging with shared logger
  app.use(accessLogMiddleware((message) => logger.info('HTTP', message)));

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

  // The SAP AI Core tenant serving this request, for its usage event
  app.use(sapTenantMiddleware);

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

  // The npm gateway's own API reference; only on the local target while listening on loopback.
  mountApiDocs(app, config);

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
      '/openai/api/v1/uploads',
      '/openai/v1/uploads',
      '/openai/api/v1/vector_stores',
      '/openai/v1/vector_stores',
      '/openrouter/api/v1/files',
      '/openrouter/api/v1/uploads',
      '/openrouter/api/v1/vector_stores',
    ],
    nulByteGuard,
  );

  // OpenAI Files Routes (file_search)
  app.use('/openai/api/v1/files', filesRoutes);
  app.use('/openai/v1/files', filesRoutes);

  // OpenAI Uploads Routes (file_search): large files in parts, completed into a file
  app.use('/openai/api/v1/uploads', uploadsRoutes);
  app.use('/openai/v1/uploads', uploadsRoutes);

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
  mountConnectionAdminRoutes(app);   // standalone mode serves it behind the standalone-only auth - see routes/connectionAdminRoutes.ts
  const groundingMounted = mountGroundingRoutes(app);       // skipped in standalone mode - see routes/groundingRoutes.ts

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

  return { app, deploymentsMounted, groundingMounted };
}
