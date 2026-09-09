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

#### Credential Lifecycle

API keys and AWS credentials share one set of lifecycle rules, held as pure functions in
`services/admin/src/services/credentialLifecycle.ts` so they are unit-testable without a server.

**Admin-only fields.** `isActive`, `expiresAt` and `neverExpires` may only be changed by an
administrator — not by the credential's owner. `lifecycleChangeViolation()` compares the incoming
payload against the stored row and is enforced in `beforeUpdateApiKeyActive` /
`beforeUpdateAwsCredentialsActive`. Draft activation resends the whole row, so a value equal to the
stored one is not treated as a change. The Fiori apps get matching field control (`isActiveFC` /
`expiresAtFC` / `neverExpiresFC`) from the after-READ handler, so they never provoke the 403. A
non-admin's draft edit of any of the three is dropped in the `.drafts` before-UPDATE handler, so
activation carries the stored values through unchanged — which is the path the apps actually take,
since lean draft answers a direct PATCH of an active row with 501 before any handler runs.

**Preset on create.** `before('NEW', '<Entity>.drafts')` prefills a create draft with
`expiresAt = now + the configured period`, plus `neverExpires = false`, `isActive`, `usageCount`
and — for a non-admin — the caller's own identity. It must be registered on the *draft* entity with `before`: an
`on('NEW', '<Entity>')` handler never fires under lean draft, which is why Expires At used to come
back empty.

**No past dates.** `expiresAtInPast()` guards every write path — both create handlers, the
`createAwsCredentials` action, and both update handlers (after the admin-only guard, and only when
the value actually differs from the stored one, so a row that is already past its date stays
editable). Rejection is `400 Expires At must be in the future`. The guard is skipped when the write
leaves the credential flagged `neverExpires`, since such a row stores no date at all.

**A refresh extends.** `rotationPolicy()` returns a fresh `expiresAt` for every permitted rotation,
owner or administrator alike — a refresh always moves the date forward, except on a credential
flagged `neverExpires`, which is returned `expiresAt: null` so the refresh does not quietly
reintroduce an expiration the flag exists to suppress. An owner is still refused
on an inactive or already-expired credential (`{ allowed: false, reason: 'inactive' | 'expired' }`),
so a refresh can extend a live credential but never resurrect a dead one. This resurrection differs
by entity: an administrator can rotate an inactive or expired API key directly (`rotateApiKey` reads
the row regardless of `isActive`, and `rotationPolicy()` then allows the admin case). AWS credentials
go further — `rotateAwsCredentials` looks the row up filtered on `isActive = true`, so an inactive
credential is refused before `rotationPolicy()` is even reached; an administrator must re-enable it
first, then rotate it.

**Enforcement.** `credentialExpired(row)` is checked on every validation path — `validateApiKey`, the unified
`validateUnifiedAuthByToken` for both credential types, and the legacy
`validateAwsCredentialsByToken` — each of which rejects the credential and auto-locks it
(`isActive = false`) so a lapsed credential stops being presented rather than failing open. In
practice this means an expired credential is rejected the next time it is presented on any of these
routes once any cached validation result for it has lapsed (a few minutes at most); an
administrator's `isActive`/`expiresAt` change takes effect immediately, since the handlers that make
it (disable/enable/rotate) broadcast a cache invalidation of their own rather than waiting on a
validation call to discover the new state. The auto-lock itself is idempotent: only the request that
actually flips the row clears the caches and broadcasts the invalidation, so a repeatedly presented
expired credential does not re-broadcast. Adding a validation path means adding this check to it.
`expiresAt = null` still means "never expires", so a row that somehow has neither is not rejected.

**The never-expires flag.** `neverExpires` is an admin-only Boolean on both entities that makes
"this credential does not expire" an explicit, stored property instead of an implicit null date.
`credentialExpired(row)` short-circuits to `false` when it is set, so a flagged row is valid on
every validation path even if it still carries a stale date from before it was flagged, and it is
excluded from the `ExpiredAwsCredentials` view and admitted by `ActiveApiKeys`. `normalizeLifecycle()`
keeps the pair consistent on every write: setting the flag clears `expiresAt`, and clearing it
without supplying a date assigns the standard period rather than leaving the credential dateless.
`afterReadLifecycleFieldControl` reports `expiresAtFC = 1` (read-only) on a flagged row for every
role — on AWS credentials the field is otherwise `7` (Mandatory) for administrators, which would
leave the object page demanding a value the flag suppresses.

Rows that predate the column are migrated once, at admin startup:
`backfillNeverExpires()` (`src/db/data/never-expires-backfill.ts`, invoked from
`initializeNeverExpiresBackfill` beside the SapCapacityUnitPrice seed) flags every API key and AWS
credential with no `expiresAt`. It is idempotent — the `WHERE` clause matches nothing on a second
run — so it is safe on every boot and on every target: Postgres gets the column itself from
`schema_evolution: auto`, local SQLite dev databases need the column added by hand first.

**Configuration.** One platform parameter, `platform.security.credentialExpirationDays`, governs
both credential types on creation and on refresh. It defaults to 90 days and falls back to 90 when
absent or not an integer >= 1. Note that `api_config.json` is byte-identical between
`services/admin` and `services/gateway`; change both.

**Admin detection.** `isAdmin()` matches a role exactly (`admin`, `Admin`) or as an xsuaa scope
suffix (`.admin`). The substring match it used to do would let a scope such as `non-admin` or
`admin-readonly` pass the admin-only lifecycle guards. On Kyma this means a scope must be named so
that it ends in `.admin` to grant administrator rights — a bare custom scope name that merely
contains "admin" no longer qualifies.

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
  IP_RESTRICTION_VIOLATION = 'ip_restriction_violation',
  QUOTA_EXCEEDED = 'quota_exceeded',
  QUOTA_UNENFORCED = 'quota_unenforced'
}
```

**Client-IP trust.** Every event's `ipAddress` goes through one derivation
(`services/gateway/src/utils/clientIp.ts`), gated by the `trust_forwarded_for` platform setting
(default `false`). On Docker, nginx sets `X-Real-IP` and appends the real peer to
`X-Forwarded-For`, so `trust_forwarded_for: true` yields the real caller address. On Kyma, the
Istio ingress appends to `X-Forwarded-For` and may not set `X-Real-IP`, so the last hop of that
header is used instead. With the shipped default of `false`, the socket peer — the proxy in front
of the gateway, not the caller — is recorded, on purpose: an unconditionally trusted forwarding
header would let any client dictate the IP recorded against its own security events. IPv4-mapped
IPv6 addresses (`::ffff:203.0.113.7`) are normalised to their IPv4 form. The IP is personal data
and is written only into security and audit events.

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

#### Rate Limiting and Quota Enforcement

Rate limiting is not adaptive or reputation-based: it is the fixed, per-key and per-user
enforcement in `quotaEnforcement` (`services/gateway/src/middlewares/quotaEnforcement.ts`) — see
[Quota enforcement](chapter-3-gateway.md#quota-enforcement) for the full mechanism. In short:
Valkey-backed requests-per-minute/hour/day counters per credential and per user
(`rl:key:<id>:*`, `rl:user:<sha256(email)>:*`), spend and token admission per day/week/month
against the per-user state document the admin publishes (`quota:user:<sha256(email)>`), a `429`
naming the scope, dimension, window, limit, usage and reset time, and fail-open to per-pod memory
counters — with a throttled `quota_unenforced` security event — when Valkey is unreachable.
Standalone mode (no admin configured) falls back to an in-memory per-key requests-per-minute limit
only (`RATE_LIMIT_RPM`), with no user scope. There is no separate DDoS-specific layer: these
per-key and per-user limits are what bound request volume from any one caller.

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