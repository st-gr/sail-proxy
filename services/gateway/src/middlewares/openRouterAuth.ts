import { Request, Response, NextFunction } from 'express';

// Use require for CommonJS module
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Extend Request interface to include apiKey property
interface AuthenticatedRequest extends Request {
  apiKey?: {
    key: string;
    name: string;
    active: boolean;
  };
}

/**
 * Simplified authentication middleware for OpenRouter API
 * For testing purposes
 */
const openRouterAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
  try {
    logger.info('OpenRouterAuth', `Authenticating request to ${req.originalUrl}`);
    
    // Get API key from header or authorization
    const apiKey = req.headers['x-api-key'] as string || 
                  (req.headers['authorization'] && (req.headers['authorization'] as string).startsWith('Bearer ') 
                    ? (req.headers['authorization'] as string).substring(7) 
                    : null);
    
    // Log what we're working with
    logger.debug('OpenRouterAuth', `API Key format: ${apiKey ? apiKey.substring(0, 3) + '...' : 'missing'}`);
    
    // For testing purposes, accept any API key or allow no authentication
    if (!apiKey) {
      logger.warn('OpenRouterAuth', 'No API key provided, continuing anyway for testing');
    } else {
      logger.info('OpenRouterAuth', 'API key provided, accepting without validation for testing');
      // Store API key info in request object
      req.apiKey = { 
        key: apiKey,
        name: 'Test Key',
        active: true
      };
    }
    
    // Continue to next middleware
    next();
  } catch (error: any) {
    logger.error('OpenRouterAuth', `Error during authentication: ${error.message}`);
    next(error);
  }
};

export default openRouterAuth;