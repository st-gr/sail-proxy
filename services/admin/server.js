// Enhanced CAP server with proper middleware integration and debugging
const cds = require('@sap/cds');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');

// Import custom middleware and auth components with environment-aware paths
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.DEPLOY_TARGET === 'development';
const fs = require('fs');

// Smart path resolution for development vs production
function resolveModulePath(devPath, prodPath) {
  if (isDevelopment && fs.existsSync(devPath + '.ts')) {
    // In development, try TypeScript source first
    try {
      return require(devPath);
    } catch (e) {
      // Fallback to compiled version
      return require(prodPath);
    }
  }
  // In production or if TypeScript source doesn't exist, use compiled version
  return require(prodPath);
}

const { createAuthMiddleware } = resolveModulePath('./src/middleware/authMiddleware', './dist/services/admin/src/middleware/authMiddleware');
const cdsAuthAdapter = require('./cds-auth-adapter-simple');
const { getDefaultLogger } = require('@libs/logger');

const logger = getDefaultLogger();

// Global uncaught exception handler to prevent service crashes
process.on('uncaughtException', (error) => {
  if (error.message && error.message.includes('Unexpected token')) {
    logger.warn('Server', 'Caught JSON parsing error - service remains stable', {
      error: error.message,
      stack: error.stack
    });
    // Don't crash the service for JSON parsing errors
    return;
  }
  // For other uncaught exceptions, log and exit gracefully
  logger.error('Server', 'Uncaught exception - shutting down', error);
  process.exit(1);
});

async function startServer() {
  try {
    const port = parseInt(process.env.PORT || '4004', 10);
    const deployTarget = process.env.DEPLOY_TARGET || 'development';
    
    logger.info('Server', `Starting SAP CAP Admin Service with enhanced authentication debugging...`, {
      deployTarget,
      port,
      nodeEnv: process.env.NODE_ENV,
      authHeaders: {
        userHeader: process.env.X_AUTH_REQUEST_USER_HEADER || 'x-auth-request-user',
        emailHeader: process.env.X_AUTH_REQUEST_EMAIL_HEADER || 'x-auth-request-email',
        groupsHeader: process.env.X_AUTH_REQUEST_GROUPS_HEADER || 'x-auth-request-groups',
        accessTokenHeader: process.env.X_AUTH_REQUEST_ACCESS_TOKEN_HEADER || 'x-auth-request-access-token'
      }
    });

    // Create Express app
    const app = express();
    
    // ========================================
    // SESSION MIDDLEWARE - For Development Authentication Persistence
    // ========================================
    if (deployTarget === 'development') {
      const DEV_SECRET = process.env.DEV_SESSION_SECRET || 'dev-unsafe-secret';
      
      app.use(cookieParser(DEV_SECRET));
      app.use(session({
        secret: DEV_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { 
          httpOnly: true, 
          sameSite: 'lax', 
          secure: false, // Set to true if using HTTPS
          maxAge: 24 * 60 * 60 * 1000 // 24 hours
        },
        name: 'cap.sid' // Custom session cookie name
      }));
      
      logger.info('Server', '🍪 Session middleware initialized for development mode');
    }
    
    // ========================================
    // DEBUG MIDDLEWARE - Log ALL Headers
    // ========================================
    app.use((req, res, next) => {
      if (!req.url.includes('/health') && !req.url.includes('/favicon')) {
        logger.info('HeaderDebug', `🔍 REQUEST: ${req.method} ${req.url}`, {
          allHeaders: req.headers,
          authHeaders: {
            'x-auth-request-user': req.headers['x-auth-request-user'],
            'x-auth-request-email': req.headers['x-auth-request-email'],
            'x-auth-request-groups': req.headers['x-auth-request-groups'],
            'x-auth-request-preferred-username': req.headers['x-auth-request-preferred-username'],
            'x-auth-request-access-token': req.headers['x-auth-request-access-token'],
            'authorization': req.headers['authorization']
          },
          userAgent: req.headers['user-agent'],
          origin: req.headers['origin'],
          referer: req.headers['referer']
        });
      }
      next();
    });

    // ========================================
    // Authentication Middleware Setup
    // ========================================
    if (deployTarget === 'docker') {
      logger.info('Server', '🔐 Applying Docker JWT authentication middleware');
      
      // Apply custom auth middleware that handles oauth2-proxy headers
      app.use(createAuthMiddleware());
      
      // Apply CDS auth adapter to transform our user context to CAP format
      app.use(cdsAuthAdapter);
      
      logger.info('Server', '✅ Docker JWT authentication middleware applied');
    } else {
      logger.info('Server', `🔓 Setting up development authentication with session persistence`);
      
      // Add session middleware for development
      const DEV_SECRET = process.env.DEV_SESSION_SECRET || 'dev-unsafe-secret';
      
      app.use(cookieParser(DEV_SECRET));
      app.use(session({
        secret: DEV_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { 
          httpOnly: true, 
          sameSite: 'lax', 
          secure: false,
          maxAge: 24 * 60 * 60 * 1000
        },
        name: 'cap.sid'
      }));
      
      // Session-based authentication for development - store user after Basic Auth
      app.use((req, res, next) => {
        // Skip session processing for static resources and UI files
        if (req.url.includes('/resources/') || 
            req.url.includes('/shell/') ||
            req.url.includes('.js') ||
            req.url.includes('.css') ||
            req.url.includes('.map') ||
            req.url.includes('/favicon') ||
            req.url.includes('/assets/')) {
          return next();
        }
        
        const isODataRequest = req.url.includes('/odata/') || req.url.includes('$batch');
        
        // If we don't have a user in session, try to authenticate via Basic Auth
        if (!req.session.user) {
          const authHeader = req.headers.authorization;
          if (authHeader && authHeader.startsWith('Basic ')) {
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
            const [email] = credentials.split(':');
            
            // Map email to user context and store in session
            let user = null;
            if (email === 'admin@test.com') {
              user = {
                id: 'admin@test.com',
                email: 'admin@test.com',
                roles: ['admin', 'user', 'gateway'],
                attr: {}
              };
            } else if (email === 'admin@example.com') {
              user = {
                id: 'admin@example.com',
                email: 'admin@example.com',
                roles: ['admin', 'user', 'gateway'],
                attr: {}
              };
            } else if (email === 'user@test.com') {
              user = {
                id: 'user@test.com',
                email: 'user@test.com', 
                roles: ['user'],
                attr: {}
              };
            } else if (email === 'gateway@test.com') {
              user = {
                id: 'gateway@test.com',
                email: 'gateway@test.com', 
                roles: ['gateway'],
                attr: {}
              };
            }
            
            if (user) {
              req.session.user = user;
              logger.trace('SessionAuth', 'User authenticated and stored in session', {
                email,
                roles: user.roles,
                sessionId: req.session.id
              });
            }
          }
        }
        
        // Set req.user from session for this request
        if (req.session.user) {
          req.user = req.session.user;
          
          // Only log for OData requests to reduce noise
          if (isODataRequest) {
            logger.trace('SessionAuth', 'Set req.user from session for OData request', {
              email: req.session.user.email,
              roles: req.session.user.roles,
              url: req.url,
              method: req.method
            });
          }
        }
        
        next();
      });
      
      // Apply CDS auth adapter to transform our user context to CAP format
      logger.trace('Server', 'Applying CDS auth adapter');
      try {
        app.use(cdsAuthAdapter);
        logger.trace('Server', 'CDS auth adapter applied successfully');
      } catch (error) {
        logger.error('Server', 'Failed to apply CDS auth adapter', error);
      }
      
      logger.info('Server', '🍪 Session-based development authentication initialized');
    }

    // ========================================
    // Authentication Middleware - Ensure Basic auth for UI apps
    // ========================================
    app.use(['/shell', '/api-keys', '/aws-credentials', '/security-notifications'], (req, res, next) => {
      // Require authentication for UI app access (to establish browser credentials)
      if (!req.headers.authorization) {
        res.setHeader('WWW-Authenticate', 'Basic realm="CAP Development - use admin@test.com:admin"');
        return res.status(401).send('Authentication required for UI access');
      }
      next();
    });


    // ========================================
    // User Context Debug Middleware
    // ========================================
    app.use((req, res, next) => {
      if (req.user && !req.url.includes('/health') && !req.url.includes('/favicon')) {
        logger.info('UserContextDebug', '👤 User context after authentication:', {
          id: req.user.id,
          email: req.user.email,
          roles: req.user.roles,
          scope: req.user.scope,
          attr: req.user.attr,
          isAnonymous: req.user.constructor.name === 'AnonymousUser',
          isPrivileged: req.user.constructor.name === 'PrivilegedUser'
        });
      }
      next();
    });

    // ========================================
    // $batch Authentication Fix - BEFORE CAP services are mounted
    // ========================================
    app.use('*', (req, res, next) => {
      if (req.originalUrl.includes('$batch')) {
        console.log('[AUTH DEBUG] $batch request BEFORE CAP:', {
          method: req.method,
          originalUrl: req.originalUrl,
          hasAuthz: !!req.headers.authorization,
          cookie: (req.headers.cookie || '').includes('cds-auth') ? 'present' : 'none'
        });
        
        // If no authorization header is present, inject Basic auth for dev
        if (!req.headers.authorization && deployTarget === 'development') {
          const credentials = Buffer.from('admin@test.com:admin').toString('base64');
          req.headers.authorization = `Basic ${credentials}`;
          console.log('[AUTH DEBUG] Injected Basic auth for $batch request');
        }
      }
      next();
    });

    // ========================================
    // Initialize CAP Application
    // ========================================
    logger.info('Server', '🚀 Initializing CAP application');
    
    // Mount CAP services on the Express app with full authentication support
    await cds.serve('all').in(app);
    
    // Enable a simple authentication endpoint for development
    if (deployTarget === 'development') {
      // Create a simple login endpoint that sets up Basic auth
      app.get('/-/login', (req, res) => {
        // Send a simple form that triggers Basic auth
        res.setHeader('WWW-Authenticate', 'Basic realm="CAP Development"');
        res.status(401).send(`
          <html>
            <head><title>CAP Development Login</title></head>
            <body>
              <h2>CAP Development Authentication</h2>
              <p>Please use one of these credentials:</p>
              <ul>
                <li><strong>admin@test.com</strong> / <strong>admin</strong> (admin, user, gateway roles)</li>
                <li><strong>user@test.com</strong> / <strong>user</strong> (user role)</li>
              </ul>
              <script>
                // Automatically trigger authentication challenge
                fetch('/odata/v4/admin/ApiKeys?$top=1', {
                  credentials: 'include'
                }).then(response => {
                  if (response.ok) {
                    window.location.href = '/shell/';
                  }
                }).catch(() => {
                  // Auth failed, stay on this page
                });
              </script>
            </body>
          </html>
        `);
      });
      
      // CSRF token endpoint for UI5 OData V4 model
      app.head(/^\/odata\/v4\/[^/]+\/?$/, (req, res) => {
        res.set({
          'x-csrf-token': 'dev-token-' + Date.now(),
          'cache-control': 'no-store, no-cache, must-revalidate'
        });
        res.status(200).end();
      });

      // Debug endpoint to check session status
      app.get('/-/auth/status', (req, res) => {
        res.json({
          authenticated: !!req.session.user,
          user: req.session.user || null,
          sessionId: req.session.id,
          cdsUser: cds.context?.user ? {
            id: cds.context.user.id,
            roles: cds.context.user.roles,
            isAnonymous: cds.context.user.is('anonymous')
          } : null
        });
      });

      // Logout endpoint for development
      app.post('/-/auth/logout', (req, res) => {
        req.session.destroy((err) => {
          if (err) {
            logger.error('Server', '❌ Failed to destroy session:', err);
            return res.status(500).json({ error: 'Failed to logout' });
          }
          res.clearCookie('cap.sid');
          res.json({ message: 'Logged out successfully' });
        });
      });
      
      logger.info('Server', '🔐 Development endpoints enabled: /-/login, /-/auth/status, /-/auth/logout');
      logger.info('Server', '🛡️ CSRF token support enabled for OData services');
    }
    
    // ========================================
    // Enhanced Error Handler
    // ========================================
    app.use((error, req, res, next) => {
      logger.error('Server', '❌ Request failed:', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        user: req.user?.id || 'anonymous',
        headers: req.headers
      });
      
      // Send structured error response
      if (!res.headersSent) {
        res.status(error.code || 500).json({
          error: error.message || 'Internal Server Error',
          timestamp: new Date().toISOString(),
          requestId: req.headers['x-request-id'] || 'unknown'
        });
      }
    });

    // ========================================
    // Start Server
    // ========================================
    const server = app.listen(port, '0.0.0.0', () => {
      logger.info('Server', `✅ SAP CAP Admin Service listening on port ${port}`, {
        environment: deployTarget,
        authentication: deployTarget === 'docker' ? 'custom-jwt' : 'cap-native',
        endpoints: {
          odata: `http://localhost:${port}/odata/v4/AdminService`,
          health: `http://localhost:${port}/health`,
          metadata: `http://localhost:${port}/odata/v4/AdminService/$metadata`
        }
      });
    });

    // ========================================
    // Graceful Shutdown
    // ========================================
    const gracefulShutdown = (signal) => {
      logger.info('Server', `Received ${signal}, shutting down gracefully`);
      server.close((err) => {
        if (err) {
          logger.error('Server', 'Error during graceful shutdown:', err);
          process.exit(1);
        }
        logger.info('Server', 'Server closed successfully');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    return server;

  } catch (error) {
    logger.error('Server', '❌ Failed to start CAP server:', error);
    process.exit(1);
  }
}

// ========================================
// Development Mode - Batching Disabled for Simplicity
// ========================================
// Note: Added groupId: "$direct" to manifest.json to disable $batch requests
// This eliminates CSRF complexity in development while maintaining functionality

// Export for CDS development mode, or start directly in production
if (require.main === module) {
  // Called directly (production)
  startServer();
} else {
  // Required by CDS (development) - use bootstrap pattern
  const cds = require('@sap/cds');
  
  cds.on('bootstrap', async (app) => {
    logger.trace('CDSBootstrap', 'Initializing session middleware for development');
    
    // Apply all our middleware to the CAP app
    const session = require('express-session');
    const cookieParser = require('cookie-parser');
    
    const deployTarget = process.env.DEPLOY_TARGET || 'development';
    
    if (deployTarget === 'development') {
      const DEV_SECRET = process.env.DEV_SESSION_SECRET || 'dev-unsafe-secret';
      
      logger.trace('CDSBootstrap', 'Applying session middleware with configuration', {
        hasSecret: !!DEV_SECRET,
        cookieName: 'cap.sid',
        maxAge: '24 hours'
      });
      
      app.use(cookieParser(DEV_SECRET));
      app.use(session({
        secret: DEV_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { 
          httpOnly: true, 
          sameSite: 'lax', 
          secure: false,
          maxAge: 24 * 60 * 60 * 1000
        },
        name: 'cap.sid'
      }));
      
      // Session-based authentication middleware
      app.use((req, res, next) => {
        // Skip session processing for static resources and UI files
        if (req.url.includes('/resources/') || 
            req.url.includes('/shell/') ||
            req.url.includes('.js') ||
            req.url.includes('.css') ||
            req.url.includes('.map') ||
            req.url.includes('/favicon') ||
            req.url.includes('/assets/')) {
          return next();
        }
        
        const isODataRequest = req.url.includes('/odata/') || req.url.includes('$batch');
        
        if (!req.session.user) {
          const authHeader = req.headers.authorization;
          if (authHeader && authHeader.startsWith('Basic ')) {
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
            const [email] = credentials.split(':');
            
            let user = null;
            if (email === 'admin@test.com') {
              user = { id: 'admin@test.com', email: 'admin@test.com', roles: ['admin', 'user', 'gateway'], attr: {} };
            } else if (email === 'admin@example.com') {
              user = { id: 'admin@example.com', email: 'admin@example.com', roles: ['admin', 'user', 'gateway'], attr: {} };
            } else if (email === 'user@test.com') {
              user = { id: 'user@test.com', email: 'user@test.com', roles: ['user'], attr: {} };
            } else if (email === 'gateway@test.com') {
              user = { id: 'gateway@test.com', email: 'gateway@test.com', roles: ['gateway'], attr: {} };
            }
            
            if (user) {
              req.session.user = user;
              logger.trace('SessionAuth', 'User authenticated and stored in session', {
                email,
                roles: user.roles,
                sessionId: req.session.id
              });
            }
          }
        }
        
        // Set req.user from session for this request - only log for OData requests
        if (req.session.user) {
          req.user = req.session.user;
          
          // Only log for OData requests to reduce noise
          if (isODataRequest) {
            logger.trace('SessionAuth', 'Set req.user from session for OData request', {
              email: req.session.user.email,
              roles: req.session.user.roles,
              url: req.url,
              method: req.method
            });
          }
        }
        
        next();
      });
      
      // Apply CDS auth adapter
      logger.trace('CDSBootstrap', 'Applying CDS auth adapter');
      try {
        app.use(cdsAuthAdapter);
        logger.trace('CDSBootstrap', 'CDS auth adapter applied successfully');
      } catch (error) {
        logger.error('CDSBootstrap', 'Failed to apply CDS auth adapter', error);
      }
      
      // Add JSON body parsing for REST endpoints with malformed JSON error handling
      app.use(express.json({
        // Add error handling for malformed JSON
        // This prevents service crashes from malformed JSON attacks
        verify: (req, res, buf, encoding) => {
          try {
            JSON.parse(buf);
          } catch (e) {
            // Don't throw here, let the main parser handle it gracefully
            req.malformedJson = true;
          }
        }
      }));
      
      // Global error handler for JSON parsing errors
      app.use((error, req, res, next) => {
        if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
          logger.warn('Server', 'Malformed JSON request detected and handled gracefully', {
            url: req.url,
            method: req.method,
            error: error.message,
            body: error.body?.substring(0, 100) // Log first 100 chars for debugging
          });
          
          return res.status(400).json({
            error: {
              code: 'INVALID_JSON',
              message: 'Invalid JSON format in request body',
              details: 'The request body contains malformed JSON syntax'
            }
          });
        }
        next(error);
      });
      
      app.use(express.urlencoded({ extended: false }));
      
      // Mount Admin REST API in bootstrap path (critical for cds watch/dev mode)
      try {
        const adminRestApi = require('./dist/services/admin/src/srv/config-rest-api');
        app.use('/admin', adminRestApi);
        console.log('[CDS-BOOTSTRAP] 📡 Admin REST API mounted at /admin (includes /logout)');
      } catch (error) {
        console.error('[CDS-BOOTSTRAP] ❌ Failed to mount Admin REST API:', error);
      }
      
      // CSRF token endpoint
      app.head(/^\/odata\/v4\/[^/]+\/?$/, (req, res) => {
        res.set({
          'x-csrf-token': 'dev-token-' + Date.now(),
          'cache-control': 'no-store, no-cache, must-revalidate'
        });
        res.status(200).end();
      });

      // Debug endpoints
      app.get('/-/auth/status', (req, res) => {
        res.json({
          authenticated: !!req.session.user,
          user: req.session.user || null,
          sessionId: req.session.id,
          cdsUser: cds.context?.user ? {
            id: cds.context.user.id,
            roles: cds.context.user.roles,
            isAnonymous: cds.context.user.is('anonymous')
          } : null
        });
      });

      app.post('/-/auth/logout', (req, res) => {
        req.session.destroy((err) => {
          if (err) return res.status(500).json({ error: 'Failed to logout' });
          res.clearCookie('cap.sid');
          res.json({ message: 'Logged out successfully' });
        });
      });
      
      console.log('[CDS-BOOTSTRAP] Session-based authentication initialized for development');
    }
  });
  
  module.exports = cds.server;
}