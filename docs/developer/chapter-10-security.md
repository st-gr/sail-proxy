---
title: SAIL-PROXY Developer Guide - Chapter 10
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-9-testing-strategy.md) | [Content Table](README.md) | [Next Chapter >>](chapter-11-debugging.md)

---

## Security Implementation

### Cryptographic Key Management (adapted from `/CRYPTOGRAPHIC_KEY_GENERATION.md`)

#### Required Security Keys

SAIL-PROXY requires three 256-bit cryptographic keys for secure operations:

1. **VALIDATION_TOKEN_SECRET** (256-bit): JWT signing and validation
2. **METADATA_ENCRYPTION_KEY** (256-bit): Metadata encryption at rest
3. **AWS_SECRET_ENCRYPTION_KEY** (256-bit): AWS credential encryption

#### Key Generation

**Generate secure keys**:
```bash
# Generate all three keys
node -e "console.log('VALIDATION_TOKEN_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('METADATA_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('AWS_SECRET_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

# Example output:
# VALIDATION_TOKEN_SECRET=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
# METADATA_ENCRYPTION_KEY=b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456a1
# AWS_SECRET_ENCRYPTION_KEY=c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456a1b2
```

**Key Storage Security**:
```bash
# Environment variables (recommended)
export VALIDATION_TOKEN_SECRET=your-256-bit-secret
export METADATA_ENCRYPTION_KEY=your-256-bit-key
export AWS_SECRET_ENCRYPTION_KEY=your-256-bit-key

# Docker secrets (production)
docker secret create validation_token_secret /path/to/secret/file

# Kubernetes secrets (production)
kubectl create secret generic sail-proxy-keys \
  --from-literal=validation-token-secret=your-secret \
  --from-literal=metadata-encryption-key=your-key \
  --from-literal=aws-secret-encryption-key=your-key
```

#### Key Management Implementation

**Security Manager Class**:
```typescript
// services/gateway/src/security/SecurityManager.ts
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export class SecurityManager {
  private validationTokenSecret: Buffer;
  private metadataEncryptionKey: Buffer;
  private awsSecretEncryptionKey: Buffer;
  
  constructor() {
    this.validationTokenSecret = this.loadKey('VALIDATION_TOKEN_SECRET');
    this.metadataEncryptionKey = this.loadKey('METADATA_ENCRYPTION_KEY');
    this.awsSecretEncryptionKey = this.loadKey('AWS_SECRET_ENCRYPTION_KEY');
  }
  
  private loadKey(envVar: string): Buffer {
    const key = process.env[envVar];
    if (!key) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
    
    if (key.length !== 64) { // 32 bytes = 64 hex characters
      throw new Error(`Invalid key length for ${envVar}. Expected 64 hex characters (256 bits)`);
    }
    
    return Buffer.from(key, 'hex');
  }
  
  // JWT Token Management
  generateJWT(payload: any, expiresIn: string = '1h'): string {
    return jwt.sign(payload, this.validationTokenSecret, {
      expiresIn,
      algorithm: 'HS256',
      issuer: 'sail-proxy',
      audience: 'sail-proxy-clients'
    });
  }
  
  verifyJWT(token: string): any {
    try {
      return jwt.verify(token, this.validationTokenSecret, {
        algorithms: ['HS256'],
        issuer: 'sail-proxy',
        audience: 'sail-proxy-clients'
      });
    } catch (error) {
      throw new SecurityError('Invalid or expired token');
    }
  }
  
  // Metadata Encryption
  encryptMetadata(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher('aes-256-gcm', this.metadataEncryptionKey);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Format: iv:authTag:encryptedData
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  }
  
  decryptMetadata(ciphertext: string): string {
    const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
    
    if (!ivHex || !authTagHex || !encryptedHex) {
      throw new SecurityError('Invalid encrypted metadata format');
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    
    const decipher = crypto.createDecipher('aes-256-gcm', this.metadataEncryptionKey);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  // AWS Credential Encryption
  encryptAWSSecret(secret: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher('aes-256-cbc', this.awsSecretEncryptionKey);
    
    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }
  
  decryptAWSSecret(encryptedSecret: string): string {
    const [ivHex, encryptedHex] = encryptedSecret.split(':');
    
    if (!ivHex || !encryptedHex) {
      throw new SecurityError('Invalid encrypted AWS secret format');
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    
    const decipher = crypto.createDecipher('aes-256-cbc', this.awsSecretEncryptionKey);
    
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}
```

### Authentication Systems

#### API Key Authentication

**API Key Format and Validation**:
```typescript
// API Key format: sp-proj-{64-character-hex-string}
const API_KEY_PATTERN = /^sp-proj-[a-f0-9]{64}$/;

export class APIKeyValidator {
  static validateFormat(apiKey: string): boolean {
    return API_KEY_PATTERN.test(apiKey);
  }
  
  static generateAPIKey(): string {
    const randomBytes = crypto.randomBytes(32);
    return 'sp-proj-' + randomBytes.toString('hex');
  }
  
  async validateAPIKey(token: string): Promise<ValidationResult> {
    // Format validation
    if (!this.validateFormat(token)) {
      return { valid: false, error: 'Invalid API key format' };
    }
    
    // Database lookup
    const apiKey = await this.apiKeyRepository.findByToken(token);
    if (!apiKey) {
      return { valid: false, error: 'API key not found' };
    }
    
    // Status check
    if (apiKey.status !== 'active') {
      return { valid: false, error: 'API key is not active' };
    }
    
    // Expiration check
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
      return { valid: false, error: 'API key has expired' };
    }
    
    // IP restriction check
    if (apiKey.ipRestrictions.length > 0) {
      const clientIP = this.getClientIP();
      if (!this.isIPAllowed(clientIP, apiKey.ipRestrictions)) {
        return { valid: false, error: 'IP address not allowed' };
      }
    }
    
    return {
      valid: true,
      apiKey,
      user: await this.userRepository.findById(apiKey.userId)
    };
  }
}
```

#### AWS Signature V4 Authentication

**SigV4 Validation Implementation**:
```typescript
export class AWSSignatureV4Validator {
  async validateSignature(req: Request): Promise<ValidationResult> {
    const authHeader = req.headers.authorization as string;
    
    if (!authHeader?.startsWith('AWS4-HMAC-SHA256')) {
      return { valid: false, error: 'Invalid AWS signature format' };
    }
    
    // Parse authorization header
    const signature = this.parseAuthHeader(authHeader);
    
    // Retrieve AWS credentials
    const awsCredentials = await this.awsCredentialRepository.findByAccessKey(
      signature.accessKeyId
    );
    
    if (!awsCredentials || awsCredentials.status !== 'active') {
      return { valid: false, error: 'AWS credentials not found or inactive' };
    }
    
    // Decrypt secret key
    const secretKey = this.securityManager.decryptAWSSecret(
      awsCredentials.encryptedSecretKey
    );
    
    // Validate signature
    const isValid = this.verifySignature(req, signature, secretKey);
    
    if (!isValid) {
      return { valid: false, error: 'Invalid AWS signature' };
    }
    
    return {
      valid: true,
      awsCredentials,
      user: await this.userRepository.findById(awsCredentials.userId)
    };
  }
  
  private verifySignature(
    req: Request, 
    signature: ParsedSignature, 
    secretKey: string
  ): boolean {
    // Reconstruct canonical request
    const canonicalRequest = this.buildCanonicalRequest(req);
    
    // Create string to sign
    const stringToSign = this.buildStringToSign(
      signature.timestamp,
      signature.credentialScope,
      canonicalRequest
    );
    
    // Calculate signature
    const calculatedSignature = this.calculateSignature(
      secretKey,
      signature.timestamp,
      signature.region,
      signature.service,
      stringToSign
    );
    
    return crypto.timingSafeEqual(
      Buffer.from(signature.signature, 'hex'),
      Buffer.from(calculatedSignature, 'hex')
    );
  }
}
```

### Authorization and RBAC

#### Role-Based Access Control

**Permission System**:
```typescript
interface Permission {
  resource: string;  // e.g., 'api-keys', 'users', 'analytics'
  action: string;    // e.g., 'read', 'write', 'delete', 'admin'
  conditions?: Record<string, any>; // Optional conditions
}

interface Role {
  id: string;
  name: string;
  permissions: Permission[];
  inherits?: string[]; // Role inheritance
}

// Predefined roles
const ROLES: Record<string, Role> = {
  admin: {
    id: 'admin',
    name: 'Administrator',
    permissions: [
      { resource: '*', action: '*' } // Full access
    ]
  },
  
  api_key_manager: {
    id: 'api_key_manager',
    name: 'API Key Manager',
    permissions: [
      { resource: 'api-keys', action: '*' },
      { resource: 'users', action: 'read' },
      { resource: 'analytics', action: 'read' },
      { resource: 'security-events', action: 'read' }
    ]
  },
  
  power_user: {
    id: 'power_user',
    name: 'Power User',
    permissions: [
      { resource: 'api-keys', action: 'read', conditions: { owner: true } },
      { resource: 'api-keys', action: 'write', conditions: { owner: true } },
      { resource: 'analytics', action: 'read', conditions: { scope: 'personal' } }
    ]
  },
  
  regular_user: {
    id: 'regular_user',
    name: 'Regular User',
    permissions: [
      { resource: 'api-keys', action: 'read', conditions: { owner: true, limit: 5 } },
      { resource: 'models', action: 'read' }
    ]
  }
};
```

**Authorization Service**:
```typescript
export class AuthorizationService {
  async authorize(
    user: User, 
    resource: string, 
    action: string, 
    context?: any
  ): Promise<boolean> {
    const role = ROLES[user.role];
    if (!role) {
      return false;
    }
    
    // Check direct permissions
    for (const permission of role.permissions) {
      if (this.matchesPermission(permission, resource, action)) {
        // Check conditions if present
        if (permission.conditions) {
          return this.evaluateConditions(permission.conditions, user, context);
        }
        return true;
      }
    }
    
    // Check inherited permissions
    if (role.inherits) {
      for (const inheritedRoleId of role.inherits) {
        const inheritedRole = ROLES[inheritedRoleId];
        if (inheritedRole) {
          const tempUser = { ...user, role: inheritedRoleId };
          if (await this.authorize(tempUser, resource, action, context)) {
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  private matchesPermission(
    permission: Permission, 
    resource: string, 
    action: string
  ): boolean {
    const resourceMatch = permission.resource === '*' || permission.resource === resource;
    const actionMatch = permission.action === '*' || permission.action === action;
    return resourceMatch && actionMatch;
  }
  
  private evaluateConditions(
    conditions: Record<string, any>,
    user: User,
    context: any
  ): boolean {
    // Owner condition
    if (conditions.owner && context?.resourceOwnerId !== user.id) {
      return false;
    }
    
    // Limit condition
    if (conditions.limit && context?.count >= conditions.limit) {
      return false;
    }
    
    // Scope condition
    if (conditions.scope && context?.scope !== conditions.scope) {
      return false;
    }
    
    return true;
  }
}
```

### Security Events and Monitoring (adapted from `/SECURITY_EVENTS.md`)

#### Security Event Types

```typescript
interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  userId?: string;
  apiKeyId?: string;
  ipAddress: string;
  userAgent: string;
  endpoint: string;
  metadata: Record<string, any>;
  timestamp: Date;
}

enum SecurityEventType {
  AUTHENTICATION_FAILURE = 'auth_failure',
  AUTHORIZATION_FAILURE = 'authz_failure',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  API_KEY_CREATED = 'api_key_created',
  API_KEY_REVOKED = 'api_key_revoked',
  CONFIGURATION_CHANGED = 'config_changed',
  UNUSUAL_USAGE_PATTERN = 'unusual_usage',
  IP_RESTRICTION_VIOLATION = 'ip_restriction_violation'
}
```

#### Event Detection and Logging

**Security Event Manager**:
```typescript
export class SecurityEventManager {
  private redis: Redis;
  private eventQueue: Queue<SecurityEvent>;
  
  async logSecurityEvent(event: Omit<SecurityEvent, 'id' | 'timestamp'>): Promise<void> {
    const fullEvent: SecurityEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...event
    };
    
    // Immediate alerting for critical events
    if (event.severity === 'critical') {
      await this.sendImmediateAlert(fullEvent);
    }
    
    // Store in Redis for real-time monitoring
    await this.redis.lpush('security_events', JSON.stringify(fullEvent));
    await this.redis.ltrim('security_events', 0, 10000); // Keep last 10k events
    
    // Queue for database persistence
    await this.eventQueue.add('persist_security_event', fullEvent);
    
    // Update security metrics
    await this.updateSecurityMetrics(fullEvent);
  }
  
  async detectSuspiciousActivity(userId: string, activity: any): Promise<void> {
    const recentEvents = await this.getRecentEvents(userId, '1h');
    
    // Detect patterns
    const patterns = [
      this.detectRapidRequests(recentEvents),
      this.detectUnusualEndpoints(recentEvents),
      this.detectGeolocationAnomalies(recentEvents),
      this.detectModelAccessAnomalies(recentEvents)
    ];
    
    for (const pattern of patterns) {
      if (pattern.detected) {
        await this.logSecurityEvent({
          type: SecurityEventType.SUSPICIOUS_ACTIVITY,
          severity: pattern.severity,
          userId,
          ipAddress: activity.ipAddress,
          userAgent: activity.userAgent,
          endpoint: activity.endpoint,
          metadata: {
            pattern: pattern.type,
            details: pattern.details,
            confidence: pattern.confidence
          }
        });
      }
    }
  }
  
  private detectRapidRequests(events: SecurityEvent[]): PatternDetectionResult {
    const requestCounts = events
      .filter(e => e.timestamp > new Date(Date.now() - 60000)) // Last minute
      .length;
    
    if (requestCounts > 100) { // More than 100 requests per minute
      return {
        detected: true,
        type: 'rapid_requests',
        severity: 'high',
        confidence: 0.9,
        details: { requestCount: requestCounts, timeWindow: '1min' }
      };
    }
    
    return { detected: false };
  }
}
```

### Input Validation and Sanitization

#### Request Validation

**Input Validation Middleware**:
```typescript
import { z } from 'zod';

// Schema definitions
const openAIRequestSchema = z.object({
  model: z.string().min(1).max(100),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(100000) // Limit message content
  })).min(1).max(100),
  max_tokens: z.number().positive().max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional()
});

// Validation middleware
export const validateOpenAIRequest = (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedBody = openAIRequestSchema.parse(req.body);
    req.body = validatedBody; // Use validated and sanitized data
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: {
          message: 'Invalid request format',
          type: 'invalid_request_error',
          details: error.errors
        }
      });
    }
    next(error);
  }
};
```

#### SQL Injection Prevention

**Parameterized Queries**:
```typescript
// GOOD: Parameterized query
async function getAPIKeyByToken(token: string): Promise<APIKey | null> {
  const result = await db.query(
    'SELECT * FROM api_keys WHERE token = $1 AND status = $2',
    [token, 'active']
  );
  return result.rows[0] || null;
}

// BAD: String concatenation (vulnerable to SQL injection)
// async function getAPIKeyByToken(token: string): Promise<APIKey | null> {
//   const result = await db.query(
//     `SELECT * FROM api_keys WHERE token = '${token}' AND status = 'active'`
//   );
//   return result.rows[0] || null;
// }
```

### Rate Limiting and DDoS Protection

#### Adaptive Rate Limiting

```typescript
export class AdaptiveRateLimiter {
  private redis: Redis;
  
  async checkRateLimit(
    identifier: string, 
    baseLimit: RateLimit,
    adaptiveFactors: AdaptiveFactors
  ): Promise<RateLimitResult> {
    // Calculate adaptive limit based on factors
    const adaptedLimit = this.calculateAdaptiveLimit(baseLimit, adaptiveFactors);
    
    // Apply sliding window rate limiting
    const result = await this.slidingWindowLimit(identifier, adaptedLimit);
    
    // Update adaptive factors based on result
    if (!result.allowed) {
      await this.updateAdaptiveFactors(identifier, adaptiveFactors);
    }
    
    return result;
  }
  
  private calculateAdaptiveLimit(
    baseLimit: RateLimit, 
    factors: AdaptiveFactors
  ): RateLimit {
    let multiplier = 1.0;
    
    // User reputation factor
    if (factors.userReputation < 0.5) {
      multiplier *= 0.5; // Reduce limit for low reputation users
    } else if (factors.userReputation > 0.8) {
      multiplier *= 1.5; // Increase limit for high reputation users
    }
    
    // System load factor
    if (factors.systemLoad > 0.8) {
      multiplier *= 0.7; // Reduce limits under high system load
    }
    
    // Time-based factor (e.g., business hours vs off-hours)
    if (factors.isBusinessHours) {
      multiplier *= 0.9; // Slightly reduce limits during peak hours
    }
    
    return {
      requests: Math.floor(baseLimit.requests * multiplier),
      windowMs: baseLimit.windowMs
    };
  }
}
```

### Secure Communication

#### TLS Configuration

**Nginx TLS Configuration** (production):
```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    # SSL Configuration
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # SSL Security
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    
    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
}
```

---

*Next: Master [Debugging & Troubleshooting](chapter-11-debugging.md) techniques for development and production.*