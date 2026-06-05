/**
 * Unified Authentication Proxy Service Integration
 * 
 * Demonstrates integration of unified authentication with existing proxy services.
 * Provides examples of how to use unified tokens with existing routes and controllers.
 */

import { Request, Response, NextFunction } from 'express';
import { UnifiedAuthRequest } from '../middlewares/unifiedTokenAuth';
import { getCachedUnifiedAuthConfig } from '../config/unifiedAuthConfig';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

export interface UnifiedProxyRequest extends UnifiedAuthRequest {
  proxyTarget?: {
    service: string;
    baseUrl: string;
    path: string;
    method: string;
    headers: Record<string, string>;
  };
}

export interface ProxyServiceOptions {
  serviceName: string;
  baseUrl: string;
  requireAuth: boolean;
  enableUnifiedAuth: boolean;
  fallbackToLegacy: boolean;
  rateLimiting?: {
    requestsPerMinute: number;
    requestsPerHour: number;
  };
}

/**
 * Unified Authentication Proxy Service
 * 
 * Provides integration patterns for existing services to use unified authentication
 */
export class UnifiedAuthProxyService {
  private config = getCachedUnifiedAuthConfig();

  /**
   * Create middleware for service-specific unified authentication
   */
  createServiceAuthMiddleware(options: ProxyServiceOptions) {
    return async (req: UnifiedProxyRequest, res: Response, next: NextFunction): Promise<void> => {
      const startTime = Date.now();
      
      try {
        logger.trace('UnifiedAuthProxyService', 'Processing service authentication', {
          service: options.serviceName,
          method: req.method,
          url: req.originalUrl,
          unifiedAuthEnabled: options.enableUnifiedAuth
        });

        // Skip auth if not required
        if (!options.requireAuth) {
          return next();
        }

        // Check if unified auth is available and enabled
        if (options.enableUnifiedAuth && req.unifiedAuth) {
          // Use unified authentication data
          if (req.unifiedAuth.valid) {
            await this.handleUnifiedAuth(req, options);
            return next();
          } else {
            return this.sendAuthError(res, 'Unified authentication failed', req.unifiedAuth.auditInfo);
          }
        }

        // Fall back to legacy authentication if enabled
        if (options.fallbackToLegacy) {
          if (req.apiKey && req.apiKeyInfo?.active) {
            await this.handleLegacyApiKeyAuth(req, options);
            return next();
          }
          
          if (req.awsAuth) {
            await this.handleLegacyAwsAuth(req, options);
            return next();
          }
        }

        // No valid authentication found
        return this.sendAuthError(res, 'Authentication required', { 
          requestId: this.generateRequestId(),
          validationTime: Date.now(),
          responseTime: Date.now() - startTime 
        });

      } catch (error) {
        const responseTime = Date.now() - startTime;
        logger.error('UnifiedAuthProxyService', 'Service authentication error', undefined, {});

        res.status(500).json({
          error: {
            message: 'Internal authentication error',
            type: 'server_error',
            service: options.serviceName
          }
        });
        return;
      }
    };
  }

  /**
   * Create rate limiting middleware using unified auth data
   */
  createUnifiedRateLimitMiddleware(options: ProxyServiceOptions) {
    return async (req: UnifiedProxyRequest, res: Response, next: NextFunction): Promise<void> => {
      if (!options.rateLimiting) {
        return next();
      }

      try {
        const rateLimits = this.extractRateLimits(req);
        if (!rateLimits) {
          // No rate limits found, use service defaults
          return next();
        }

        // Apply rate limiting based on auth data
        const allowed = await this.checkRateLimit(req, rateLimits, options);
        if (!allowed) {
          res.status(429).json({
            error: {
              message: 'Rate limit exceeded',
              type: 'rate_limit_error',
              service: options.serviceName,
              limits: rateLimits
            }
          });
          return;
        }

        return next();

      } catch (error) {
        logger.error('UnifiedAuthProxyService', 'Rate limiting error', undefined, {});
        
        // Continue on rate limiting error to avoid blocking valid requests
        return next();
      }
    };
  }

  /**
   * Create proxy target configuration based on auth data
   */
  createProxyTargetMiddleware(options: ProxyServiceOptions) {
    return async (req: UnifiedProxyRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Set up proxy target configuration
        req.proxyTarget = {
          service: options.serviceName,
          baseUrl: options.baseUrl,
          path: this.buildTargetPath(req, options),
          method: req.method,
          headers: this.buildProxyHeaders(req, options)
        };

        logger.trace('UnifiedAuthProxyService', 'Proxy target configured', {
          service: options.serviceName,
          targetPath: req.proxyTarget.path,
          headersCount: Object.keys(req.proxyTarget.headers).length
        });

        return next();

      } catch (error) {
        logger.error('UnifiedAuthProxyService', 'Proxy target configuration error', undefined, {});

        res.status(500).json({
          error: {
            message: 'Proxy configuration error',
            type: 'proxy_error',
            service: options.serviceName
          }
        });
        return;
      }
    };
  }

  /**
   * Handle unified authentication
   */
  private async handleUnifiedAuth(req: UnifiedProxyRequest, options: ProxyServiceOptions): Promise<void> {
    if (!req.unifiedAuth) return;

    logger.trace('UnifiedAuthProxyService', 'Processing unified authentication', {
      service: options.serviceName,
      authType: req.unifiedAuth.authType,
      source: req.unifiedAuth.auditInfo.source,
      cacheHit: req.unifiedAuth.auditInfo.cacheHit
    });

    // Set headers for downstream services
    req.headers['x-unified-auth-type'] = req.unifiedAuth.authType;
    req.headers['x-unified-auth-valid'] = 'true';
    req.headers['x-unified-request-id'] = req.unifiedAuth.auditInfo.requestId;

    if (req.unifiedAuth.token) {
      req.headers['x-unified-auth-token'] = req.unifiedAuth.token;
    }

    // Add service-specific headers based on auth type
    if (req.unifiedAuth.authType === 'api_key' && req.unifiedAuth.data) {
      const apiKeyData = req.unifiedAuth.data as any;
      req.headers['x-api-key-id'] = apiKeyData.keyId || '';
      req.headers['x-api-key-name'] = apiKeyData.name || '';
    }
  }

  /**
   * Handle legacy API key authentication
   */
  private async handleLegacyApiKeyAuth(req: UnifiedProxyRequest, options: ProxyServiceOptions): Promise<void> {
    logger.trace('UnifiedAuthProxyService', 'Processing legacy API key authentication', {
      service: options.serviceName,
      keyId: req.apiKey?.id || 'unknown'
    });

    // Set legacy auth headers
    req.headers['x-legacy-auth-type'] = 'api_key';
    req.headers['x-api-key-active'] = req.apiKeyInfo?.active ? 'true' : 'false';
    
    if (req.apiKey?.id) {
      req.headers['x-api-key-id'] = req.apiKey.id;
    }
  }

  /**
   * Handle legacy AWS authentication
   */
  private async handleLegacyAwsAuth(req: UnifiedProxyRequest, options: ProxyServiceOptions): Promise<void> {
    logger.trace('UnifiedAuthProxyService', 'Processing legacy AWS authentication', {
      service: options.serviceName
    });

    // Set legacy AWS auth headers
    req.headers['x-legacy-auth-type'] = 'aws_credential';
    req.headers['x-aws-auth-valid'] = 'true';
  }

  /**
   * Extract rate limits from auth data
   */
  private extractRateLimits(req: UnifiedProxyRequest): any {
    if (req.unifiedAuth?.data) {
      const data = req.unifiedAuth.data as any;
      if (data.rateLimits) {
        return data.rateLimits;
      }
    }

    // No rate limits found in auth data
    return null;
  }

  /**
   * Check rate limit (placeholder implementation)
   */
  private async checkRateLimit(
    req: UnifiedProxyRequest, 
    rateLimits: any, 
    options: ProxyServiceOptions
  ): Promise<boolean> {
    // Placeholder implementation - in production, implement actual rate limiting
    // Could use Redis-based rate limiting, token bucket, etc.
    
    logger.trace('UnifiedAuthProxyService', 'Rate limit check', {
      service: options.serviceName,
      limits: rateLimits,
      authType: req.unifiedAuth?.authType
    });

    // For now, always allow (rate limiting implementation would go here)
    return true;
  }

  /**
   * Build target path for proxy
   */
  private buildTargetPath(req: UnifiedProxyRequest, options: ProxyServiceOptions): string {
    // Remove service prefix from path if present
    let targetPath = req.path;
    const servicePrefix = `/${options.serviceName}`;
    
    if (targetPath.startsWith(servicePrefix)) {
      targetPath = targetPath.substring(servicePrefix.length);
    }

    return targetPath || '/';
  }

  /**
   * Build proxy headers
   */
  private buildProxyHeaders(req: UnifiedProxyRequest, options: ProxyServiceOptions): Record<string, string> {
    const headers: Record<string, string> = {
      'x-forwarded-for': this.getClientIp(req),
      'x-forwarded-proto': req.protocol,
      'x-forwarded-host': req.get('host') || '',
      'x-proxy-service': options.serviceName
    };

    // Copy important headers
    const importantHeaders = [
      'content-type',
      'accept',
      'user-agent',
      'authorization'
    ];

    for (const header of importantHeaders) {
      const value = req.get(header);
      if (value) {
        headers[header] = value;
      }
    }

    return headers;
  }

  /**
   * Get client IP address
   */
  private getClientIp(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
           (req.headers['x-real-ip'] as string) ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           '127.0.0.1';
  }

  /**
   * Send authentication error response
   */
  private sendAuthError(res: Response, message: string, auditInfo?: any): void {
    res.status(401).json({
      error: {
        message,
        type: 'authentication_error',
        audit: auditInfo
      }
    });
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `proxy-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Get service metrics
   */
  getMetrics(): {
    config: {
      enabled: boolean;
      adminServiceUrl: string;
    };
  } {
    return {
      config: {
        enabled: this.config.enabled,
        adminServiceUrl: this.config.adminServiceUrl
      }
    };
  }
}

/**
 * Example service configurations
 */
export const serviceConfigurations = {
  anthropic: {
    serviceName: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requireAuth: true,
    enableUnifiedAuth: true,
    fallbackToLegacy: true,
    rateLimiting: {
      requestsPerMinute: 60,
      requestsPerHour: 1000
    }
  },
  openrouter: {
    serviceName: 'openrouter',
    baseUrl: 'https://openrouter.ai/api',
    requireAuth: true,
    enableUnifiedAuth: true,
    fallbackToLegacy: true,
    rateLimiting: {
      requestsPerMinute: 100,
      requestsPerHour: 2000
    }
  },
  bedrock: {
    serviceName: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    requireAuth: true,
    enableUnifiedAuth: true,
    fallbackToLegacy: true,
    rateLimiting: {
      requestsPerMinute: 200,
      requestsPerHour: 5000
    }
  },
  openai: {
    serviceName: 'openai',
    baseUrl: 'https://api.openai.com',
    requireAuth: true,
    enableUnifiedAuth: true,
    fallbackToLegacy: true,
    rateLimiting: {
      requestsPerMinute: 60,
      requestsPerHour: 1000
    }
  }
} as const;

// Export singleton instance
export const unifiedAuthProxyService = new UnifiedAuthProxyService();

export default UnifiedAuthProxyService;