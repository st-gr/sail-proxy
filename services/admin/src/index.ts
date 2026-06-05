// Load polyfills before anything else
require('./polyfills/path-to-regexp-polyfill');

// Enhanced CDS server startup with multi-environment authentication
const cds = require('@sap/cds');
import { initializeAuthentication, setupUserContext, getAuthenticationMode } from './auth/authInit';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

async function startServer() {
  try {
    const authMode = getAuthenticationMode();
    const port = parseInt(process.env.PORT || '4004', 10);
    const deployTarget = process.env.DEPLOY_TARGET || 'development';
    
    logger.info('Server', `Starting SAP CAP Admin Service...`, {
      authMode,
      deployTarget,
      port,
      nodeEnv: process.env.NODE_ENV
    });

    // For docker deployment, use programmatic startup to enable custom auth middleware
    if (process.env.DEPLOY_TARGET === 'docker') {
      await startProgrammatically(port, authMode);
    } else {
      // Use CDS command for development
      await startWithCdsCommand(port);
    }

  } catch (error) {
    logger.error('Server', '❌ Failed to start CAP server:', error as Error);
    process.exit(1);
  }
}

async function startWithCdsCommand(port: number) {
  const { spawn } = require('child_process');
  
  // For CDS to find all models, we need to serve from the root with both db and srv
  logger.info('Server', `Starting CDS with command: npx cds serve --port ${port}`);
  
  const args = ['cds', 'serve', '--port', port.toString()];
  
  const server = spawn('npx', args, {
    stdio: 'inherit',
    shell: true,
    cwd: process.cwd(),
    env: process.env
  });

  server.on('error', (error: Error) => {
    logger.error('Server', '❌ Failed to start CAP server:', error);
    process.exit(1);
  });

  server.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      logger.error('Server', `❌ CAP server exited with code ${code}`);
      process.exit(code);
    }
  });
}

async function startProgrammatically(port: number, authMode: string) {
  const express = require('express');
  
  logger.info('Server', `Starting CDS programmatically with custom authentication (${authMode})`);
  
  // Create express app with custom middleware
  const app = express();
  
  // Add health check endpoint BEFORE authentication middleware
  // This ensures health checks work without authentication
  app.get('/api/health', async (req: any, res: any) => {
    try {
      // Simple health check without requiring database or auth
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'admin',
        deployTarget: process.env.DEPLOY_TARGET || 'unknown'
      });
    } catch (error) {
      logger.error('HealthCheck', 'Health check failed', error as Error);
      res.status(500).json({
        status: 'error',
        message: 'Health check failed'
      });
    }
  });
  
  logger.info('Server', '🏥 Health check endpoint registered at /api/health (no auth required)');
  
  // Add authentication middleware for docker deployment
  if (authMode === 'docker-jwt') {
    logger.info('Server', 'Setting up OAuth2-proxy authentication middleware');
    
    // Import and setup authentication middleware  
    const { createAuthMiddleware } = await import('./middleware/authMiddleware');
    
    // Enable detailed logging for debugging
    app.use((req: any, res: any, next: any) => {
      logger.debug('Server', `🔍 REQUEST: ${req.method} ${req.url}`, {
        headers: {
          'x-auth-request-user': req.headers['x-auth-request-user'],
          'x-auth-request-email': req.headers['x-auth-request-email'], 
          'x-auth-request-groups': req.headers['x-auth-request-groups'],
          'x-auth-request-preferred-username': req.headers['x-auth-request-preferred-username']
        }
      });
      next();
    });
    
    // Apply authentication middleware
    app.use(createAuthMiddleware());
    
    // Mount REST API routes BEFORE CDS middleware to avoid conflicts
    try {
      const configRestApi = await import('./srv/config-rest-api');
      app.use('/api', configRestApi.default || configRestApi);
      logger.info('Server', '🔌 REST API endpoints mounted at /api (before CDS)');
    } catch (error) {
      logger.error('Server', 'Failed to mount REST API endpoints', error as Error);
    }

    // Serve UI5 applications from built dist directories
    try {
      const path = require('path');
      
      // Define UI5 app paths - serve webapp content with resources from dist
      // Note: Nginx strips /admin prefix, so routes should start with /app/
      // In Docker, we need absolute paths since __dirname will be in dist/services/admin/src
      const isDocker = authMode === 'docker-jwt';
      
      // Determine the base path for UI5 apps based on environment
      let appBasePath: string;
      if (isDocker) {
        // Docker: absolute path
        appBasePath = '/app/services/admin/app';
      } else {
        // Local development: check if running from dist or src
        const isBuilt = __dirname.includes('dist/services/admin/src');
        if (isBuilt) {
          // Running from dist (after build)
          appBasePath = path.join(__dirname, '../../../../../services/admin/app');
        } else {
          // Running from src (ts-node)
          appBasePath = path.join(__dirname, '../../app');
        }
      }
      
      // In local development, UI5 resources are served via middleware
      // In Docker, we need to serve the SAPUI5 resources
      if (isDocker) {
        // Serve SAPUI5 resources that were downloaded during build
        // The UI5 build process with framework cache stores resources in the app's dist folder
        const resourcePaths = [
          path.join(appBasePath, 'shell/dist/resources'),
          path.join(appBasePath, 'api-keys-app/dist/resources'),
          // Add more apps as needed
        ];
        
        // Try to find and serve resources from the first app that has them
        for (const resourcePath of resourcePaths) {
          if (require('fs').existsSync(resourcePath)) {
            app.use('/resources', express.static(resourcePath, {
              maxAge: '1d',
              etag: true,
              setHeaders: (res: any, filePath: string) => {
                if (filePath.endsWith('.js')) {
                  res.setHeader('Content-Type', 'application/javascript');
                } else if (filePath.endsWith('.css')) {
                  res.setHeader('Content-Type', 'text/css');
                } else if (filePath.endsWith('.json')) {
                  res.setHeader('Content-Type', 'application/json');
                }
              }
            }));
            logger.info('Server', `📦 Serving SAPUI5 resources from ${resourcePath}`);
            break;
          }
        }
        
        // Serve sap-ui-version.json specifically from the app directory
        const versionFilePath = path.join(appBasePath, 'sap-ui-version.json');
        if (require('fs').existsSync(versionFilePath)) {
          app.get('/resources/sap-ui-version.json', (req: any, res: any) => {
            res.setHeader('Content-Type', 'application/json');
            res.sendFile(versionFilePath);
          });
          logger.info('Server', `📦 Serving sap-ui-version.json from ${versionFilePath}`);
        }
      } else {
        // In local development, also serve sap-ui-version.json
        const versionFilePath = path.join(appBasePath, 'sap-ui-version.json');
        if (require('fs').existsSync(versionFilePath)) {
          app.get('/resources/sap-ui-version.json', (req: any, res: any) => {
            res.setHeader('Content-Type', 'application/json');
            res.sendFile(versionFilePath);
          });
          logger.info('Server', `📦 Serving sap-ui-version.json from ${versionFilePath} (local dev)`);
        }
      }
      
      // Routes differ between Docker (with nginx prefix stripping) and local development
      const routePrefix = isDocker ? '/app' : '';
      
      const ui5Apps = [
        { 
          name: 'shell',
          route: `${routePrefix}/shell`, 
          webappPath: path.join(appBasePath, 'shell/webapp'),
          distPath: path.join(appBasePath, 'shell/dist')
        },
        { 
          name: 'api-keys-app',
          route: `${routePrefix}/api-keys-app`, 
          webappPath: path.join(appBasePath, 'api-keys-app/webapp'),
          distPath: path.join(appBasePath, 'api-keys-app/dist')
        },
        { 
          name: 'aws-credentials-app',
          route: `${routePrefix}/aws-credentials-app`, 
          webappPath: path.join(appBasePath, 'aws-credentials-app/webapp'),
          distPath: path.join(appBasePath, 'aws-credentials-app/dist')
        },
        { 
          name: 'config-app',
          route: `${routePrefix}/config-app`, 
          webappPath: path.join(appBasePath, 'config-app/webapp'),
          distPath: path.join(appBasePath, 'config-app/dist')
        },
        { 
          name: 'security-notifications-app',
          route: `${routePrefix}/security-notifications-app`, 
          webappPath: path.join(appBasePath, 'security-notifications-app/webapp'),
          distPath: path.join(appBasePath, 'security-notifications-app/dist')
        },
        { 
          name: 'usage-analytics-app',
          route: `${routePrefix}/usage-analytics-app`, 
          webappPath: path.join(appBasePath, 'usage-analytics-app/webapp'),
          distPath: path.join(appBasePath, 'usage-analytics-app/dist')
        }
      ];

      // Mount each UI5 app with proper static file handling
      ui5Apps.forEach(appConfig => {
        // Always serve from dist directory (built/transpiled version)
        app.use(appConfig.route, express.static(appConfig.distPath, {
          index: ['index.html'],
          fallthrough: true,
          setHeaders: (res: any, filePath: string) => {
            if (filePath.endsWith('.js')) {
              res.setHeader('Content-Type', 'application/javascript');
            } else if (filePath.endsWith('.css')) {
              res.setHeader('Content-Type', 'text/css');
            } else if (filePath.endsWith('.html')) {
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
            } else if (filePath.endsWith('.json')) {
              res.setHeader('Content-Type', 'application/json');
            }
          }
        }));

        logger.info('Server', `📱 UI5 app mounted: ${appConfig.name} at ${appConfig.route}`);
        logger.info('Server', `   📦 Built app served from: ${appConfig.distPath}`);
      });

      // Default app route redirects to shell app
      if (isDocker) {
        app.get('/app/', (req: any, res: any) => {
          res.redirect('/app/shell/');
        });
      }
      
      // Log path information for debugging
      logger.debug('Server', `UI5 app base path: ${appBasePath}`);
      logger.debug('Server', `__dirname: ${__dirname}`);
      logger.debug('Server', `isDocker: ${isDocker}, isBuilt: ${__dirname.includes('dist/services/admin/src')}`);

      logger.info('Server', '✅ UI5 applications mounted successfully');
    } catch (error) {
      logger.error('Server', 'Failed to mount UI5 applications', error as Error);
    }
  }
  
  // In Docker mode, we need to explicitly set the implementation paths BEFORE loading the model
  if (authMode === 'docker-jwt') {
    // Set CDS root to the admin service directory
    cds.root = '/app/services/admin';
    
    // IMPORTANT: Do NOT set cds.env.folders as it can trigger model recompilation
    // We will load from pre-compiled CSN only
    
    // Set custom auth configuration for Docker mode
    cds.env.requires = cds.env.requires || {};
    cds.env.requires.auth = {
      kind: 'custom',
      impl: cds.root + '/dist/services/admin/src/auth/cds-auth-adapter.js'
    };
    
    logger.info('Server', 'Set CDS configuration for Docker mode', { 
      cdsRoot: cds.root,
      authImpl: cds.env.requires.auth?.impl
    });
  }
  
  // Load model and compile it properly
  try {
    logger.info('Server', 'Loading and compiling CDS model...');
    
    if (authMode === 'docker-jwt') {
      // CRITICAL: Set feature flags BEFORE loading/compiling model
      // This ensures draft navigation properties are included in OData projection
      cds.env.features = cds.env.features || {};
      cds.env.features.serve_on_root = true;
      cds.env.features.drafts = true; // Enable draft OData projection
      
      // Enable lean draft for PostgreSQL compatibility
      // This is mandatory for proper draft handling with @cap-js/postgres
      cds.env.fiori = cds.env.fiori || {};
      cds.env.fiori.lean_draft = true;
      
      logger.info('Server', 'Feature flags set:', { 
        features: cds.env.features,
        fiori: cds.env.fiori
      });
      
      // In Docker, compile at runtime to get draft projections
      const path = require('path');
      const fs = require('fs');
      
      try {
        logger.info('Server', 'Compiling model at runtime for Docker with draft support...');
        
        // According to the research, we need to load from CDS files only, not CSN
        // Set cds.env.folders to ensure CAP loads from the right directories
        cds.env.folders = {
          db: 'dist/db',
          srv: 'dist/srv', 
          app: 'app'
        };
        
        // For Docker, we use a hybrid approach:
        // 1. Load model from source for draft support
        // 2. Merge annotations from pre-built CSN
        const path = require('path');
        const fs = require('fs');
        
        // Load model files (without app directory to avoid duplicate definitions)
        const modelFiles = [
          'dist/db/**/*.cds',
          'dist/srv/admin-service.cds',
          'dist/srv/validation-service.cds'  // Exclude csn.json by being specific
        ];
        
        logger.info('Server', 'Loading model for draft support...');
        const runtimeCsn = await cds.load(modelFiles, { from: cds.root });
        
        // Helper function to deeply merge annotations
        function mergeAnnotationsDeep(targetDef: any, sourceDef: any) {
          // Copy definition-level annotations
          for (const [k, v] of Object.entries(sourceDef)) {
            if (k.startsWith('@')) targetDef[k] = v;
          }
          
          // Copy element-level annotations
          if (sourceDef.elements) {
            targetDef.elements ??= {};
            for (const [eln, el] of Object.entries<any>(sourceDef.elements)) {
              targetDef.elements[eln] ??= {};
              for (const [k, v] of Object.entries(el)) {
                if (k.startsWith('@')) targetDef.elements[eln][k] = v;
              }
            }
          }
          
          // Copy action-level annotations and their parameters
          if (sourceDef.actions) {
            targetDef.actions ??= {};
            for (const [an, act] of Object.entries<any>(sourceDef.actions)) {
              targetDef.actions[an] ??= {};
              for (const [k, v] of Object.entries(act)) {
                if (k.startsWith('@')) targetDef.actions[an][k] = v;
              }
              
              // Copy action parameter annotations
              if (act.params) {
                targetDef.actions[an].params ??= {};
                for (const [pn, p] of Object.entries<any>(act.params)) {
                  targetDef.actions[an].params[pn] ??= {};
                  for (const [k, v] of Object.entries(p)) {
                    if (k.startsWith('@')) targetDef.actions[an].params[pn][k] = v;
                  }
                }
              }
            }
          }
        }

        // Load pre-built CSN to get annotations
        const csnPath = path.join(cds.root, 'dist/srv/csn.json');
        if (fs.existsSync(csnPath)) {
          logger.info('Server', 'Merging annotations from pre-built CSN...');
          const builtCsn = JSON.parse(fs.readFileSync(csnPath, 'utf-8'));
          
          // Deep merge annotations from built CSN into runtime CSN
          for (const [name, srcDef] of Object.entries<any>(builtCsn.definitions ?? {})) {
            const tgtDef = (runtimeCsn.definitions ?? {})[name];
            if (tgtDef) {
              mergeAnnotationsDeep(tgtDef, srcDef);
            }
          }
          
          logger.info('Server', 'Annotations merged successfully');
        } else {
          logger.warn('Server', 'Pre-built CSN not found, annotations may be missing');
        }
        
        // Compile the merged model - this generates draft projections
        cds.model = cds.compile.for.nodejs(runtimeCsn);
        
        logger.info('Server', 'Model compiled from source with draft support');
        
        // Log draft entity count and details for verification
        // In lean draft mode, draft entities are properties of the main entity, not separate definitions
        const entitiesWithDrafts = Object.keys(cds.model.definitions).filter(name => {
          const def = cds.model.definitions[name];
          return def.kind === 'entity' && def.drafts;
        });
        logger.info('Server', `Model loaded with ${entitiesWithDrafts.length} entities having draft support`);
        
        // Log specific draft entities for debugging
        if (entitiesWithDrafts.length > 0) {
          logger.info('Server', 'Entities with draft support:', entitiesWithDrafts.slice(0, 5)); // Log first 5
          // Check if AdminService.ApiKeys has drafts
          const apiKeys = cds.model.definitions['AdminService.ApiKeys'];
          if (apiKeys?.drafts) {
            logger.info('Server', 'AdminService.ApiKeys has draft support enabled');
          }
        } else {
          logger.warn('Server', 'No entities with draft support found! This may cause issues with Fiori Elements apps.');
          // Log all services and entities for debugging
          const services = Object.keys(cds.model.definitions).filter(name => cds.model.definitions[name].kind === 'service');
          const entities = Object.keys(cds.model.definitions).filter(name => cds.model.definitions[name].kind === 'entity');
          logger.info('Server', 'Available services:', services);
          logger.info('Server', 'Available entities (first 10):', entities.slice(0, 10));
        }
        
      } catch (error) {
        logger.error('Server', 'Failed to compile model', error as Error);
        throw error;
      }
    } else {
      // Development mode can use wildcard
      const csn = await cds.load('*');
      cds.model = cds.compile.for.nodejs(csn);
    }
    logger.info('Server', '✅ CDS model compiled successfully', {
      entities: Object.keys(cds.model.definitions).filter(name => cds.model.definitions[name].kind === 'entity'),
      services: Object.keys(cds.model.definitions).filter(name => cds.model.definitions[name].kind === 'service')
    });
    
    // Diagnostic: Dump runtime EDMX to verify draft and operations are present
    if (authMode === 'docker-jwt' && process.env.DEBUG_METADATA) {
      try {
        const edmxResult = cds.compile.to.edm(cds.model, { 
          service: 'AdminService', 
          version: 'v4' 
        });
        const edmx = edmxResult.AdminService || edmxResult;
        require('fs').writeFileSync('/tmp/AdminService.runtime.xml', edmx);
        logger.info('Server', 'Runtime EDMX written to /tmp/AdminService.runtime.xml for debugging');
      } catch (err) {
        logger.warn('Server', 'Failed to write debug EDMX:', err);
      }
    }
  } catch (error) {
    logger.error('Server', '❌ Failed to load CDS model', error as Error);
    throw error;
  }
  
  // Initialize database connection after model is loaded
  try {
    logger.info('Server', 'Initializing database connection...');
    await cds.connect.to('db');
    logger.info('Server', '✅ Database connection initialized successfully');
  } catch (error) {
    logger.error('Server', '❌ Failed to initialize database connection', error as Error);
    throw error;
  }
  
  
  // Initialize and mount CDS services with explicit implementation loading
  let serviceImplementations = {};
  
  if (authMode === 'docker-jwt') {
    // Use absolute paths for Docker
    serviceImplementations = {
      AdminService: '/app/services/admin/dist/srv/admin-service.js',
      ValidationService: '/app/services/admin/dist/srv/validation-service.js'
    };
  } else {
    // Use relative paths for development
    serviceImplementations = {
      AdminService: 'srv/admin-service.js',
      ValidationService: 'srv/validation-service.js'
    };
  }
  
  logger.info('Server', 'Serving CDS with implementations:', serviceImplementations);
  
  const cdsServer = await cds.serve('all', {
    impl: serviceImplementations
  }).in(app);
  
  // IMPORTANT: Re-mount UI5 apps after CDS initialization to ensure they're not overridden
  // This is necessary because CDS.serve might interfere with existing Express routes
  if (authMode === 'docker-jwt') {
    // Add a middleware to log all incoming requests for debugging
    app.use((req: any, res: any, next: any) => {
      if (req.path.startsWith('/app/')) {
        logger.debug('Server', `UI5 app request: ${req.method} ${req.path}`);
      }
      next();
    });
  }
  
  // Log available services after CDS initialization
  if (authMode === 'docker-jwt') {
    logger.info('Server', `Available CDS services: ${Object.keys(cds.services || {})}`);
    
    // Log service implementation status
    const adminService = cds.services.AdminService;
    const validationService = cds.services.ValidationService;
    
    logger.info('Server', 'Service implementation status:', {
      adminService: {
        exists: !!adminService,
        hasImpl: adminService ? !!adminService._handlers : false,
        handlers: adminService ? Object.keys(adminService._handlers || {}).length : 0
      },
      validationService: {
        exists: !!validationService,
        hasImpl: validationService ? !!validationService._handlers : false,
        handlers: validationService ? Object.keys(validationService._handlers || {}).length : 0
      }
    });
  }
  
  // Add a test endpoint to verify UI5 apps are accessible
  app.get('/app/test', (req: any, res: any) => {
    res.json({ 
      message: 'UI5 apps test endpoint working',
      authMode,
      ui5AppsConfigured: true
    });
  });
  
  // Start the server
  const server = app.listen(port, () => {
    logger.info('Server', `✅ CAP Admin Service listening on port ${port} with ${authMode} authentication`);
  });
  
  // Setup graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info('Server', `Received ${signal}, shutting down gracefully`);
    
    try {
      // Close HTTP server first
      await new Promise<void>((resolve) => {
        server.close(() => {
          logger.info('Server', 'HTTP server closed');
          resolve();
        });
      });
      
      // Close database connections gracefully
      if (cds.db) {
        logger.info('Server', 'Closing database connections...');
        try {
          // Handle database-specific cleanup
          const dbKind = cds.db.kind || cds.env.requires?.db?.kind;
          
          if (dbKind === 'sqlite') {
            // SQLite: Force WAL checkpoint before closing
            await cds.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
            logger.debug('Server', 'SQLite WAL checkpoint completed');
          } else if (dbKind === 'postgres' || dbKind === 'postgresql') {
            // PostgreSQL: Ensure any pending transactions are committed
            logger.debug('Server', 'PostgreSQL: ensuring clean connection closure');
          }
          
          // Universal connection cleanup
          await cds.db.disconnect();
          logger.info('Server', '✅ Database connections closed');
        } catch (error) {
          logger.warn('Server', 'Error closing database connections:', error);
        }
      }
      
      logger.info('Server', 'Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Server', 'Error during graceful shutdown', error as Error);
      process.exit(1);
    }
  };
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  return server;
}

// Handle process termination gracefully (global handlers)
process.on('SIGINT', () => {
  logger.info('Server', 'Received SIGINT, initiating graceful shutdown');
  process.emit('SIGTERM'); // Reuse SIGTERM handler
});

process.on('uncaughtException', (error) => {
  logger.error('Server', 'Uncaught exception, shutting down', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Server', 'Unhandled rejection', new Error(`Unhandled rejection at: ${promise}, reason: ${reason}`));
  process.exit(1);
});

startServer();
