import { Request, Response, NextFunction } from 'express';
import apiKeyService from '../services/apiKeyService';
import securityEventEmitter from '../services/securityEventEmitter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface AuthenticatedRequest extends Request {
  apiKey?: {
    key: string;
    [key: string]: any;
  };
  apiKeyInfo?: {
    active: boolean;
    [key: string]: any;
  };
}

/**
 * Middleware to authenticate requests using API keys
 */
const apiKeyAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Get API key from header or query param
    let apiKey = req.headers['x-api-key'] || req.headers['x-stainless-key'] || req.query.api_key;
    
    // Handle array values from headers
    if (Array.isArray(apiKey)) {
      apiKey = apiKey[0];
    }
    
    // Debug mode: show more extensive header information for troubleshooting
    if (process.env.DEBUG === 'true') {
      // Log all headers with safe values (hide sensitive info)
      const safeHeaders: Record<string, any> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === 'authorization') {
          // Only show type and format of auth header, not the value
          const authType = (value as string)?.split(' ')[0] || 'unknown';
          safeHeaders[key] = `${authType} ...`;
        } else if (key === 'x-api-key' || key === 'x-stainless-key') {
          // Show part of API key if present
          if (typeof value === 'string') {
            safeHeaders[key] = value ? `${value.substring(0, 3)}...${value.substring(value.length - 3)}` : undefined;
          } else if (Array.isArray(value) && value.length > 0) {
            const firstValue = value[0];
            safeHeaders[key] = firstValue ? `${firstValue.substring(0, 3)}...${firstValue.substring(firstValue.length - 3)} (array)` : undefined;
          } else {
            safeHeaders[key] = value;
          }
        } else {
          // Format array values for better readability
          if (Array.isArray(value)) {
            safeHeaders[key] = value.map(v => String(v)).join(', ');
          } else {
            // Include other headers as-is
            safeHeaders[key] = value;
          }
        }
      }
      
      // Ensure headers are properly formatted for logging
      logger.debug('ApiKeyAuth', 'DEBUG - Request headers:', { headers: safeHeaders });
      logger.debug('ApiKeyAuth', `DEBUG - URL: ${req.method} ${req.originalUrl}`);
      
      // Log body sample for debugging payload format
      if (req.body && Object.keys(req.body).length > 0) {
        const sanitizedBody = { ...req.body };
        
        // Sanitize sensitive content
        if (sanitizedBody.messages && Array.isArray(sanitizedBody.messages)) {
          sanitizedBody.messages = sanitizedBody.messages.map((m: any) => ({
            ...m,
            content: '[CONTENT REDACTED]'
          }));
        } else if (sanitizedBody.messages && !Array.isArray(sanitizedBody.messages)) {
          // Handle non-array messages without using map
          sanitizedBody.messages = { content: '[CONTENT REDACTED]' };
        }
        if (sanitizedBody.prompt) {
          sanitizedBody.prompt = '[CONTENT REDACTED]';
        }
        
        logger.debug('ApiKeyAuth', 'DEBUG - Request body sample:', { body: sanitizedBody });
      }
    }

    // Minimal logging for OpenRouter endpoints - only log the URL path
    if (req.originalUrl && req.originalUrl.startsWith('/openrouter/')) {
      logger.info('ApiKeyAuth', `OpenRouter request: ${req.method} ${req.originalUrl}`);
    }
      
    // Standard extraction of API key from authorization header if it uses Bearer format
    if (!apiKey && req.headers['authorization']) {
      const authHeader = req.headers['authorization'] as string;
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        
        // If token looks like an API key (starts with 'sk-'), use it
        if (token.startsWith('sk-')) {
          apiKey = token;
          if (process.env.DEBUG === 'true') {
            logger.debug('ApiKeyAuth', 'DEBUG - Extracted API key from Authorization Bearer header');
          }
        }
      }
    }

    // Check if API key is provided
    if (!apiKey) {
      // Special handling for OpenRouter models endpoint - no authentication required
      if (req.method === 'GET' && req.originalUrl && req.originalUrl.startsWith('/openrouter/api/v1/models')) {
        logger.info('ApiKeyAuth', `Allowing unauthenticated access to models endpoint: ${req.method} ${req.originalUrl}`);
        
        // Create a temporary API key object for this request
        req.apiKey = { 
          key: 'public-models-access',
          name: 'Public Models Access',
          active: true
        };
        req.apiKeyInfo = { active: true };
        return next();
      }
      
      // Special handling for GitHub Copilot Chat requests
      if (req.originalUrl && req.originalUrl.startsWith('/openrouter/') && 
          req.headers['user-agent'] && (req.headers['user-agent'] as string).includes('GitHubCopilot')) {
        
        logger.info('ApiKeyAuth', `GitHub Copilot Chat request detected: ${req.method} ${req.originalUrl}`);
        
        // For endpoints like model endpoints, allow unauthenticated access
        if (req.method === 'GET' && req.originalUrl.includes('/endpoints')) {
          logger.info('ApiKeyAuth', 'Allowing unauthenticated access for GitHub Copilot Chat read operation');
          
          // Create a temporary API key object for this request
          req.apiKey = { 
            key: 'github-copilot',
            name: 'GitHub Copilot Chat',
            active: true
          };
          req.apiKeyInfo = { active: true };
          return next();
        }
      }
      
      // Log additional info for other OpenRouter endpoints with missing auth
      if (req.originalUrl && req.originalUrl.startsWith('/openrouter/')) {
        logger.warn('ApiKeyAuth', `Authentication failed for OpenRouter request: ${req.method} ${req.originalUrl}`);
        logger.warn('ApiKeyAuth', 'OpenRouter requires proper authentication. Please provide a valid API key.');
      }
      
      if (process.env.DEBUG === 'true') {
        logger.error('ApiKeyAuth', 'Authentication failed: No API key provided');
        
        if (req.headers['authorization']) {
          const authHeader = req.headers['authorization'] as string;
          logger.debug('ApiKeyAuth', `DEBUG - Authorization header type: ${authHeader.split(' ')[0]}`);
          
          // If it's AWS SigV4, show helpful message
          if (req.headers['x-amz-date'] && req.headers['x-amz-content-sha256']) {
            logger.debug('ApiKeyAuth', 'DEBUG - Client is using AWS SigV4 authentication format');
            logger.debug('ApiKeyAuth', 'DEBUG - This proxy requires a simple API key in x-api-key header!');
            logger.debug('ApiKeyAuth', `DEBUG - Client appears to be: ${req.headers['user-agent'] || 'Unknown'}`);
            
            // If using Claude CLI, show how to fix
            if ((req.headers['user-agent'] as string)?.includes('claude-cli')) {
              logger.info('ApiKeyAuth', 'HINT - For claude-cli, use: claude api <command> --api-key YOUR_API_KEY');
            }
          }
        }
      }
      
      // Emit security event for missing API key
      await securityEventEmitter.emitFailedAuth({
        credentialId: 'missing',
        authType: 'api_key',
        reason: 'No API key provided',
        clientIP: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        endpoint: req.originalUrl,
        method: req.method,
        requestId: (req as any).debugRequestId,
        statusCode: 401
      });

      res.status(401).json({
        error: {
          message: 'API key is required. Please provide it in the x-api-key header.',
          type: 'authentication_error',
          help: 'This proxy requires an API key in the x-api-key header.'
        }
      });
      return;
    }

    // Validate API key
    const validKey = await apiKeyService.validateApiKey(apiKey as string);
    
    if (!validKey) {
      if (process.env.DEBUG === 'true') {
        logger.error('ApiKeyAuth', 'Authentication failed: Invalid API key provided');
        if ((req.headers['user-agent'] as string)?.includes('GitHubCopilot')) {
          // There is an issue with GitHub Copilot Chat where it sends an old API key
          logger.debug('ApiKeyAuth', `DEBUG - GitHub Copilot Chat detected, but invalid API key provided: ${apiKey} - use PATCH /api/admin/api-keys/{{id}} to set it`);
        }
        logger.debug('ApiKeyAuth', `DEBUG - API key format: ${(apiKey as string).substring(0, 3)}...${(apiKey as string).substring((apiKey as string).length - 3)}`);
        
        // Log all registered keys (just prefixes) for debugging
        const allKeys = await apiKeyService.listApiKeys();
        if (allKeys.length === 0) {
          logger.debug('ApiKeyAuth', 'DEBUG - No API keys registered in the system!');
          logger.debug('ApiKeyAuth', 'DEBUG - Create an API key first with: POST /api/admin/api-keys');
        } else {
          logger.debug('ApiKeyAuth', `DEBUG - ${allKeys.length} registered API keys:`);
          const keyFormats = allKeys.map(k => ({ 
            prefix: k.key.substring(0, 3) + '...' + k.key.substring(k.key.length - 3), 
            active: k.isActive,
            created: k.createdAt
          }));
          logger.debug('ApiKeyAuth', 'Registered API keys:', keyFormats);
        }
      }

      // Emit security event for invalid API key (only if not already emitted by unified auth)
      if (!(req as any).unifiedAuthAttempted) {
        await securityEventEmitter.emitFailedAuth({
          credentialId: apiKey as string,
          authType: 'api_key',
          reason: 'Invalid API key provided',
          clientIP: req.ip || req.connection.remoteAddress,
          userAgent: req.get('User-Agent'),
          endpoint: req.originalUrl,
          method: req.method,
          requestId: (req as any).debugRequestId,
          statusCode: 401
        });
      }
      
      res.status(401).json({
        error: {
          message: 'Invalid API key',
          type: 'authentication_error'
        }
      });
      return;
    }

    // Store API key info in request object for later use
    req.apiKey = { 
      key: apiKey as string,  // Store the actual key string
      ...validKey   // Include the rest of the validation info
    };

    // Also keep the original property for backward compatibility
    req.apiKeyInfo = validKey;
    
    // Continue to next middleware
    next();
  } catch (error: any) {
    logger.error('ApiKeyAuth', 'Error during authentication:', error);
    
    if (process.env.DEBUG === 'true') {
      logger.debug('ApiKeyAuth', 'Error details:', {
        message: error.message,
        stack: error.stack
      });
    }
    
    res.status(500).json({
      error: {
        message: 'Authentication error',
        type: 'server_error'
      }
    });
  }
};

export default apiKeyAuth;