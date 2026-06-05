import jwt from 'jsonwebtoken';
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

export interface JWTClaims {
  sub: string;
  email?: string;
  groups?: string[];
  scope?: string[];
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
}

export interface AuthConfig {
  deployTarget: string;
  roleMapping: Record<string, string>;
  jwtSecret?: string;
  oidcIssuerUrl?: string;
}

export class AuthMiddleware {
  private config: AuthConfig;
  private jwksCache: any = null;
  private jwksCacheExpiry: number = 0;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  /**
   * Main authentication middleware that routes to appropriate auth strategy
   */
  async authenticate(req: any, res: any, next: any): Promise<void> {
    try {
      // Skip authentication for health checks and non-protected endpoints
      if (this.shouldSkipAuth(req)) {
        return next();
      }

      // Route to appropriate authentication strategy based on environment
      switch (this.config.deployTarget) {
        case 'docker':
          await this.handleDockerJwtAuth(req, res, next);
          break;
        case 'xsuaa':
        case 'btp':
          await this.handleXsuaaAuth(req, res, next);
          break;
        case 'xsa':
          await this.handleXsaAuth(req, res, next);
          break;
        case 'development':
        default:
          // Let CAP handle mocked authentication
          next();
          break;
      }
    } catch (error) {
      logger.error('AuthMiddleware', 'Authentication failed', error as Error);
      res.status(401).json({ 
        error: 'Authentication failed',
        message: 'Invalid or missing authentication credentials'
      });
    }
  }

  /**
   * Handle Docker deployment with oauth2-proxy headers authentication
   */
  private async handleDockerJwtAuth(req: any, res: any, next: any): Promise<void> {
    // ========================================
    // ENHANCED DEBUGGING - Log all potential auth headers
    // ========================================
    const allAuthHeaders = {
      'x-auth-request-user': req.headers['x-auth-request-user'],
      'x-auth-request-email': req.headers['x-auth-request-email'],
      'x-auth-request-groups': req.headers['x-auth-request-groups'],
      'x-auth-request-preferred-username': req.headers['x-auth-request-preferred-username'],
      'x-auth-request-access-token': req.headers['x-auth-request-access-token'],
      'x-forwarded-user': req.headers['x-forwarded-user'],
      'x-forwarded-email': req.headers['x-forwarded-email'],
      'authorization': req.headers['authorization'],
      'x-original-uri': req.headers['x-original-uri'],
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-real-ip': req.headers['x-real-ip']
    };

    logger.trace('AuthMiddleware', '🔍 DOCKER AUTH DEBUG - All authentication headers:', {
      url: req.url,
      method: req.method,
      allAuthHeaders,
      hasAnyAuthHeader: Object.values(allAuthHeaders).some(v => v !== undefined),
      headerCount: Object.keys(req.headers).length,
      userAgent: req.headers['user-agent']
    });

    // Check for oauth2-proxy headers first (forwarded by nginx)
    const userEmail = req.headers['x-auth-request-email'];
    const userGroups = req.headers['x-auth-request-groups'];
    const userName = req.headers['x-auth-request-user'];
    const preferredUsername = req.headers['x-auth-request-preferred-username'];
    const userAccess = req.headers['x-auth-request-access-token'];
    
    logger.trace('AuthMiddleware', '🔐 Processing OAuth2-proxy headers:', {
      userEmail,
      userGroups,
      userName,
      preferredUsername,
      hasAccessToken: !!userAccess,
      accessTokenLength: userAccess ? userAccess.length : 0
    });
    
    if (userEmail) {
      // OAuth2-proxy authentication via headers
      logger.info('AuthMiddleware', '✅ OAuth2-proxy header authentication detected', {
        email: userEmail,
        groups: userGroups,
        user: userName,
        preferredUsername
      });
      
      // Parse groups from header (comma-separated string)
      let groups: string[] = [];
      if (userGroups) {
        // Handle different group formats
        if (typeof userGroups === 'string') {
          // Try both comma and space separation
          groups = userGroups.includes(',') 
            ? userGroups.split(',').map((g: string) => g.trim())
            : userGroups.split(' ').map((g: string) => g.trim()).filter(g => g.length > 0);
        } else if (Array.isArray(userGroups)) {
          groups = userGroups;
        }
      }
      
      logger.info('AuthMiddleware', '👥 Parsed groups:', {
        rawGroups: userGroups,
        parsedGroups: groups,
        groupCount: groups.length
      });
      
      // Handle local provider email-to-role mapping when groups are empty
      let mappedRoles: string[] = [];
      const identityProvider = process.env.IDENTITY_PROVIDER || 'local';
      
      if (identityProvider === 'local' && groups.length === 0) {
        // For local provider, map email directly to role using LOCAL_USER_MAPPING
        logger.info('AuthMiddleware', '🏠 Local provider detected with empty groups - using email-to-role mapping');
        mappedRoles = this.mapEmailToRolesForLocal(userEmail);
        
        logger.info('AuthMiddleware', '📧 Email-to-role mapping result:', {
          email: userEmail,
          mappedRoles,
          localUserMapping: process.env.LOCAL_USER_MAPPING
        });
      } else {
        // Map groups to CAP roles for external providers or when groups exist
        mappedRoles = this.mapGroupsToRoles(groups);
        
        logger.info('AuthMiddleware', '🎭 Group-to-role mapping result:', {
          originalGroups: groups,
          mappedRoles,
          roleMapping: this.config.roleMapping
        });
      }
      
      // Create CAP-compatible user context
      req.user = {
        id: userEmail,
        email: userEmail,
        roles: mappedRoles,
        scope: mappedRoles, // For compatibility
        attr: {
          email: userEmail,
          groups: groups,
          user: userName,
          preferredUsername,
          identityProvider
        },
        // CDS-specific user context properties
        tenant: 'default',
        locale: 'en',
        is: (role: string) => mappedRoles.includes(role),
        _roles: mappedRoles
      };

      logger.info('AuthMiddleware', '🎉 OAuth2-proxy authentication successful', {
        user: userEmail,
        groups: groups,
        mappedRoles,
        identityProvider,
        userContextCreated: true
      });

      return next();
    } else {
      logger.trace('AuthMiddleware', '⚠️  No x-auth-request-email header found', {
        availableHeaders: Object.keys(req.headers),
        authRelatedHeaders: Object.keys(allAuthHeaders).filter(key => (allAuthHeaders as any)[key] !== undefined)
      });
    }
    
    // Fallback to JWT authentication (for gateway service or legacy tokens)
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Missing authentication - no OAuth2-proxy headers or Authorization header');
    }

    const token = authHeader.substring(7);
    
    // Determine if this is a gateway service token or a user token
    let claims: JWTClaims;
    try {
      // First try to decode JWT to check issuer
      const decodedHeader = this.decodeJwtHeader(token);
      const decodedPayload = this.decodeJwtPayload(token);
      
      if (decodedPayload.iss === 'gateway-service' || decodedPayload.service === 'gateway') {
        // This is a gateway service token - verify with shared secret (HS256)
        logger.debug('AuthMiddleware', 'Verifying gateway service JWT token');
        claims = await this.verifyGatewayJwt(token);
      } else {
        // This is a user token - verify against Dex JWKS (RS256)
        logger.debug('AuthMiddleware', 'Verifying user JWT token against Dex JWKS');
        claims = await this.verifyDexJwt(token);
      }
    } catch (error) {
      logger.warn('AuthMiddleware', 'Failed to decode JWT payload, trying Dex verification', error as Error);
      // Fallback to Dex verification
      claims = await this.verifyDexJwt(token);
    }
    
    // Map groups/scopes to CAP roles
    const mappedRoles = this.mapGroupsToRoles(claims.groups || claims.scope || []);
    
    // Create CAP-compatible user context  
    req.user = {
      id: claims.email || claims.sub,
      email: claims.email,
      roles: mappedRoles,
      scope: mappedRoles, // For compatibility
      attr: {
        email: claims.email,
        groups: claims.groups || claims.scope || []
      },
      // CDS-specific user context properties
      tenant: 'default',
      locale: 'en',
      is: (role: string) => mappedRoles.includes(role),
      _roles: mappedRoles
    };

    logger.debug('AuthMiddleware', 'Docker JWT authentication successful', {
      user: claims.email || claims.sub,
      groups: claims.groups,
      mappedRoles
    });

    next();
  }

  /**
   * Handle SAP BTP XSUAA authentication (delegate to CAP)
   */
  private async handleXsuaaAuth(req: any, res: any, next: any): Promise<void> {
    // For XSUAA deployments, let CAP handle JWT validation natively
    // The CAP framework will automatically validate XSUAA JWTs
    // Our custom middleware should not interfere with native CAP JWT processing
    
    logger.debug('AuthMiddleware', 'Delegating to native CAP XSUAA authentication');
    
    // Simply pass through - CAP will populate req.user from XSUAA JWT
    // No custom processing needed for standard XSUAA flows
    next();
  }

  /**
   * Handle HANA XSA authentication (delegate to CAP)
   */
  private async handleXsaAuth(req: any, res: any, next: any): Promise<void> {
    // For XSA deployments, let CAP handle XS authentication natively
    // The CAP framework will automatically validate XS tokens
    // Our custom middleware should not interfere with native CAP XS processing
    
    logger.debug('AuthMiddleware', 'Delegating to native CAP XSA authentication');
    
    // Simply pass through - CAP will handle XS token validation
    next();
  }

  /**
   * Verify JWT token against Dex JWKS endpoint
   */
  private async verifyDexJwt(token: string): Promise<JWTClaims> {
    try {
      // Get JWKS from Dex
      const jwks = await this.getDexJwks();
      
      // Decode token header to get kid
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') {
        throw new Error('Invalid JWT token structure');
      }

      // Find matching key in JWKS
      const key = jwks.keys.find((k: any) => k.kid === decoded.header.kid);
      if (!key) {
        logger.error('AuthMiddleware', `JWT key not found in JWKS. Looking for kid: ${decoded.header.kid}, Available keys: ${JSON.stringify(jwks.keys.map((k: any) => k.kid))}`);
        throw new Error('JWT key not found in JWKS');
      }

      // Convert JWK to PEM format for verification
      const publicKey = this.jwkToPem(key);
      
      // Verify and decode JWT
      const claims = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: this.config.oidcIssuerUrl || 'http://dex:5556/dex'
      }) as JWTClaims;

      return claims;
    } catch (error) {
      logger.error('AuthMiddleware', 'JWT verification failed', error as Error);
      throw new Error(`JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Verify gateway service JWT token with shared secret (HS256)
   */
  private async verifyGatewayJwt(token: string): Promise<JWTClaims> {
    try {
      const secret = process.env.VALIDATION_TOKEN_SECRET || 'dev-secret-change-in-production';
      
      // Verify JWT with HMAC SHA256
      const claims = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: 'gateway-service'
      }) as JWTClaims;

      logger.trace('AuthMiddleware', 'Gateway JWT verification successful', {
        sub: claims.sub,
        service: (claims as any).service,
        scope: claims.scope
      });

      return claims;
    } catch (error) {
      logger.error('AuthMiddleware', 'Gateway JWT verification failed', error as Error);
      throw new Error(`Gateway JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decode JWT header without verification
   */
  private decodeJwtHeader(token: string): any {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    
    try {
      return JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    } catch (error) {
      throw new Error('Failed to decode JWT header');
    }
  }

  /**
   * Decode JWT payload without verification
   */
  private decodeJwtPayload(token: string): any {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch (error) {
      throw new Error('Failed to decode JWT payload');
    }
  }

  /**
   * Fetch JWKS from Dex with caching
   */
  private async getDexJwks(): Promise<any> {
    const now = Date.now();
    
    // Return cached JWKS if still valid (cache for 1 hour)
    if (this.jwksCache && now < this.jwksCacheExpiry) {
      return this.jwksCache;
    }

    try {
      const issuerUrl = this.config.oidcIssuerUrl || 'http://dex:5556/dex';
      const jwksUrl = `${issuerUrl}/keys`;
      
      logger.debug('AuthMiddleware', `Fetching JWKS from ${jwksUrl}`);
      
      const response = await axios.get(jwksUrl, {
        timeout: 5000,
        headers: { 'Accept': 'application/json' }
      });

      this.jwksCache = response.data;
      this.jwksCacheExpiry = now + (60 * 60 * 1000); // Cache for 1 hour
      
      logger.debug('AuthMiddleware', 'JWKS fetched and cached successfully');
      return this.jwksCache;
    } catch (error) {
      logger.error('AuthMiddleware', 'Failed to fetch JWKS', error as Error);
      throw new Error(`Failed to fetch JWKS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Convert JWK to PEM format for JWT verification
   */
  private jwkToPem(jwk: any): string {
    // Simple RSA key conversion (for production, use a proper JWK library)
    // This is a simplified implementation for the specific use case
    if (jwk.kty !== 'RSA') {
      throw new Error('Only RSA keys are supported');
    }

    // For production, use 'jwk-to-pem' library or similar
    // This is a basic implementation that works with Dex
    const crypto = require('crypto');
    
    try {
      // Create public key from n and e components
      const keyObject = crypto.createPublicKey({
        key: {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e
        },
        format: 'jwk'
      });
      
      return keyObject.export({ type: 'spki', format: 'pem' });
    } catch (error) {
      logger.error('AuthMiddleware', 'Failed to convert JWK to PEM', error as Error);
      throw new Error('Failed to convert JWK to PEM format');
    }
  }

  /**
   * Map email to roles for local identity provider (development only)
   */
  private mapEmailToRolesForLocal(email: string): string[] {
    const localUserMapping = process.env.LOCAL_USER_MAPPING;
    
    if (!localUserMapping) {
      logger.warn('AuthMiddleware', 'LOCAL_USER_MAPPING not configured for local provider');
      return ['user']; // Default fallback
    }
    
    try {
      const mapping = JSON.parse(localUserMapping);
      const role = mapping[email];
      
      if (role) {
        logger.debug('AuthMiddleware', `Mapped email "${email}" to role "${role}"`);
        return [role];
      } else {
        logger.debug('AuthMiddleware', `No role mapping found for email "${email}"`);
        return ['user']; // Default fallback
      }
    } catch (error) {
      logger.error('AuthMiddleware', 'Failed to parse LOCAL_USER_MAPPING', error as Error);
      return ['user']; // Default fallback
    }
  }

  /**
   * Map Dex groups to CAP roles using environment configuration
   */
  private mapGroupsToRoles(groups: string[]): string[] {
    const mappedRoles: string[] = [];
    
    for (const group of groups) {
      const role = this.config.roleMapping[group];
      if (role) {
        mappedRoles.push(role);
        logger.trace('AuthMiddleware', `Mapped group "${group}" to role "${role}"`);
      } else {
        logger.debug('AuthMiddleware', `No role mapping found for group "${group}"`);
      }
    }

    // Ensure at least 'user' role if no mappings found
    if (mappedRoles.length === 0) {
      mappedRoles.push('user');
      logger.debug('AuthMiddleware', 'No roles mapped, defaulting to "user" role');
    }

    return mappedRoles;
  }

  /**
   * Check if authentication should be skipped for certain endpoints
   */
  private shouldSkipAuth(req: any): boolean {
    const path = req.path || req.url;
    
    // Skip auth for health checks and non-protected endpoints
    const skipPaths = [
      '/health',
      '/ping',
      '/metrics',
      '/$metadata',
      '/favicon.ico'
    ];

    return skipPaths.some(skipPath => path.startsWith(skipPath));
  }

  /**
   * Static factory method to create middleware based on environment
   */
  static create(): AuthMiddleware {
    const deployTarget = process.env.DEPLOY_TARGET || 'development';
    const roleMapping = AuthMiddleware.parseRoleMapping();
    
    const config: AuthConfig = {
      deployTarget,
      roleMapping,
      jwtSecret: process.env.VALIDATION_TOKEN_SECRET,
      oidcIssuerUrl: process.env.OAUTH2_PROXY_OIDC_ISSUER_URL || 'http://dex:5556/dex'
    };

    logger.info('AuthMiddleware', `Initializing authentication middleware for deployment target: ${deployTarget}`, {
      roleMapping: Object.keys(roleMapping),
      oidcIssuerUrl: config.oidcIssuerUrl
    });

    return new AuthMiddleware(config);
  }

  /**
   * Parse role mapping from environment variable
   */
  private static parseRoleMapping(): Record<string, string> {
    const roleMappingEnv = process.env.ROLE_MAPPING;
    
    if (!roleMappingEnv) {
      // Default role mapping for both prefixed and simple group names
      return {
        'sap-llm-gateway-admin': 'admin',
        'sap-llm-gateway-user': 'user',
        'admin': 'admin',
        'user': 'user',
        'gateway': 'service'
      };
    }

    try {
      const parsed = JSON.parse(roleMappingEnv);
      
      // Enhance parsed mapping with fallbacks for simple group names
      const enhanced = {
        ...parsed,
        // Add direct mappings for common simple group names
        'admin': 'admin',
        'user': 'user', 
        'gateway': 'service'
      };
      
      logger.info('AuthMiddleware', 'Role mapping loaded from environment', enhanced);
      return enhanced;
    } catch (error) {
      logger.warn('AuthMiddleware', 'Failed to parse ROLE_MAPPING environment variable, using defaults', error as Error);
      return {
        'sap-llm-gateway-admin': 'admin',
        'sap-llm-gateway-user': 'user',
        'admin': 'admin',
        'user': 'user',
        'gateway': 'service'
      };
    }
  }
}

/**
 * Express middleware function for easy integration
 */
export function createAuthMiddleware() {
  const authMiddleware = AuthMiddleware.create();
  
  return (req: any, res: any, next: any) => {
    authMiddleware.authenticate(req, res, next);
  };
}
