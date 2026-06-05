import crypto from 'crypto';

export interface ValidationToken {
  accessKeyId: string;
  signatureHash: string;
  requestMetadata: {
    timestamp: number;
    clientIp: string;
    endpoint: string;
    method: string;
    headers: Record<string, string>;
  };
  challengeNonce: string;
  expiresAt: number;
  version: string;
}

export interface ValidationRequest {
  token: ValidationToken;
  stringToSign: string;
  clientSignature: string;
  requestId: string;
}

export interface ValidationResponse {
  valid: boolean;
  credentialMetadata?: {
    credentialId: string;
    permissions: Array<{
      service: string;
      action: string;
      resource: string;
      effect: string;
    }>;
    region: string;
    sapAiRegion: string;
    userId: string;
    rateLimits: {
      requestsPerMinute: number;
      requestsPerHour: number;
      requestsPerDay: number;
    };
    ipRestrictions?: Array<{
      ipAddress?: string;
      ipRange?: string;
      isAllowed: boolean;
    }>;
  };
  validationToken: string;
  auditInfo: {
    requestId: string;
    validationTime: number;
    cacheHit: boolean;
    ipAllowed: boolean;
    signatureValid: boolean;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface CachedValidationResult {
  validationResponse: ValidationResponse;
  timestamp: number;
  expiresAt: number;
}

export class ValidationTokenUtils {
  private static readonly ALGORITHM = 'HS256';
  private static readonly TOKEN_VERSION = '1.0';
  private static readonly DEFAULT_TTL = 300000; // 5 minutes
  
  private static getSecretKey(): string {
    const secret = process.env.VALIDATION_TOKEN_SECRET || 'dev-secret-change-in-production';
    if (secret === 'dev-secret-change-in-production' && process.env.NODE_ENV === 'production') {
      throw new Error('VALIDATION_TOKEN_SECRET must be set in production');
    }
    return secret;
  }

  static createValidationToken(
    accessKeyId: string,
    clientSignature: string,
    requestMetadata: ValidationToken['requestMetadata'],
    ttl: number = ValidationTokenUtils.DEFAULT_TTL
  ): ValidationToken {
    const now = Date.now();
    const signatureHash = crypto
      .createHash('sha256')
      .update(clientSignature)
      .digest('hex');
    
    const challengeNonce = crypto.randomBytes(16).toString('hex');
    
    return {
      accessKeyId,
      signatureHash,
      requestMetadata,
      challengeNonce,
      expiresAt: now + ttl,
      version: ValidationTokenUtils.TOKEN_VERSION
    };
  }

  static createValidationJWT(
    validationToken: ValidationToken,
    requestId: string
  ): string {
    const payload = {
      ...validationToken,
      requestId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(validationToken.expiresAt / 1000)
    };

    const header = {
      alg: ValidationTokenUtils.ALGORITHM,
      typ: 'JWT'
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const signature = crypto
      .createHmac('sha256', ValidationTokenUtils.getSecretKey())
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  static verifyValidationJWT(jwt: string): ValidationToken & { requestId: string } {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      const [encodedHeader, encodedPayload, signature] = parts;
      
      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', ValidationTokenUtils.getSecretKey())
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        throw new Error('Invalid JWT signature');
      }

      // Decode payload
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
      
      // Check expiration
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('JWT expired');
      }

      // Validate structure
      if (!payload.accessKeyId || !payload.signatureHash || !payload.challengeNonce) {
        throw new Error('Invalid JWT payload structure');
      }

      return payload;
    } catch (error) {
      throw new Error(`JWT validation failed: ${(error as Error).message}`);
    }
  }

  static createCacheKey(accessKeyId: string, signatureHash: string): string {
    return `aws_validation:${accessKeyId}:${signatureHash.substring(0, 16)}`;
  }

  static isTokenExpired(token: ValidationToken): boolean {
    return Date.now() > token.expiresAt;
  }

  static isCacheExpired(cachedResult: CachedValidationResult): boolean {
    return Date.now() > cachedResult.expiresAt;
  }

  static hashRequestData(
    method: string,
    endpoint: string,
    headers: Record<string, string>,
    timestamp: number
  ): string {
    const canonicalRequest = [
      method.toUpperCase(),
      endpoint,
      JSON.stringify(headers),
      timestamp.toString()
    ].join('\n');

    return crypto
      .createHash('sha256')
      .update(canonicalRequest)
      .digest('hex');
  }

  static generateRequestId(): string {
    return `vt_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  static sanitizeForLogging(token: ValidationToken): any {
    return {
      accessKeyId: token.accessKeyId,
      signatureHash: token.signatureHash.substring(0, 16) + '...',
      challengeNonce: token.challengeNonce.substring(0, 8) + '...',
      requestMetadata: {
        ...token.requestMetadata,
        clientIp: token.requestMetadata.clientIp.split('.').slice(0, 3).join('.') + '.xxx'
      },
      expiresAt: new Date(token.expiresAt).toISOString(),
      version: token.version
    };
  }

  static createErrorResponse(
    code: string,
    message: string,
    requestId: string,
    details?: any
  ): ValidationResponse {
    return {
      valid: false,
      validationToken: '',
      auditInfo: {
        requestId,
        validationTime: 0,
        cacheHit: false,
        ipAllowed: false,
        signatureValid: false
      },
      error: {
        code,
        message,
        details
      }
    };
  }
}

export class ValidationCache {
  private cache: Map<string, CachedValidationResult> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor(cleanupIntervalMs: number = 60000) {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  set(key: string, response: ValidationResponse, ttl: number = 300000): void {
    const cachedResult: CachedValidationResult = {
      validationResponse: response,
      timestamp: Date.now(),
      expiresAt: Date.now() + ttl
    };
    this.cache.set(key, cachedResult);
  }

  get(key: string): ValidationResponse | null {
    const cached = this.cache.get(key);
    if (!cached || ValidationTokenUtils.isCacheExpired(cached)) {
      this.cache.delete(key);
      return null;
    }
    return cached.validationResponse;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, cached] of this.cache.entries()) {
      if (now > cached.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  getStats(): {
    size: number;
    expired: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    const now = Date.now();
    let expired = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const cached of this.cache.values()) {
      if (now > cached.expiresAt) {
        expired++;
      }
      
      if (oldest === null || cached.timestamp < oldest) {
        oldest = cached.timestamp;
      }
      
      if (newest === null || cached.timestamp > newest) {
        newest = cached.timestamp;
      }
    }

    return {
      size: this.cache.size,
      expired,
      oldestEntry: oldest,
      newestEntry: newest
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cache.clear();
  }
}