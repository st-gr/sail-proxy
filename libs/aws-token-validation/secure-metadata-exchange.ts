import crypto from 'crypto';
import { promisify } from 'util';

export interface EncryptedMetadata {
  encryptedData: string;
  iv: string;
  tag: string;
  timestamp: number;
  version: string;
}

export interface SecureExchangeConfig {
  encryptionKey: string;
  algorithm: string;
  keyDerivationRounds: number;
  maxAge: number;
}

export interface CredentialMetadata {
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
  expiresAt?: Date;
  lastUsed?: Date;
}

export class SecureMetadataExchange {
  private config: SecureExchangeConfig;
  private derivedKeys: Map<string, { key: Buffer; timestamp: number }> = new Map();
  private readonly KEY_CACHE_TTL = 3600000; // 1 hour

  constructor(config?: Partial<SecureExchangeConfig>) {
    this.config = {
      encryptionKey: config?.encryptionKey || this.getEncryptionKey(),
      algorithm: config?.algorithm || 'aes-256-cbc',
      keyDerivationRounds: config?.keyDerivationRounds || 100000,
      maxAge: config?.maxAge || 300000, // 5 minutes
      ...config
    };

    // Validate configuration
    this.validateConfig();
  }

  /**
   * Encrypt credential metadata for secure transmission
   */
  async encryptMetadata(
    metadata: CredentialMetadata,
    recipientId: string,
    salt?: string
  ): Promise<EncryptedMetadata> {
    try {
      const dataToEncrypt = JSON.stringify({
        ...metadata,
        timestamp: Date.now(),
        recipientId
      });

      // Generate or use provided salt
      const derivedSalt = salt ? Buffer.from(salt, 'hex') : crypto.randomBytes(32);
      
      // Derive encryption key
      const derivedKey = await this.deriveKey(this.config.encryptionKey, derivedSalt);
      
      // Generate IV
      const iv = crypto.randomBytes(16);
      
      // Create cipher
      const cipher = crypto.createCipheriv(this.config.algorithm, derivedKey, iv);
      
      // Encrypt data
      const encrypted = Buffer.concat([
        cipher.update(dataToEncrypt, 'utf8'),
        cipher.final()
      ]);
      
      // For non-GCM modes, use HMAC for authentication
      const tag = crypto.createHmac('sha256', derivedKey).update(encrypted).digest();

      return {
        encryptedData: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        timestamp: Date.now(),
        version: '1.0'
      };

    } catch (error) {
      throw new Error(`Metadata encryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Decrypt credential metadata
   */
  async decryptMetadata(
    encryptedMetadata: EncryptedMetadata,
    recipientId: string,
    salt?: string
  ): Promise<CredentialMetadata> {
    try {
      // Check age
      if (Date.now() - encryptedMetadata.timestamp > this.config.maxAge) {
        throw new Error('Encrypted metadata has expired');
      }

      // Derive decryption key
      const derivedSalt = salt ? Buffer.from(salt, 'hex') : this.generateDefaultSalt(recipientId);
      const derivedKey = await this.deriveKey(this.config.encryptionKey, derivedSalt);
      
      // Parse encrypted components
      const encryptedData = Buffer.from(encryptedMetadata.encryptedData, 'base64');
      const iv = Buffer.from(encryptedMetadata.iv, 'base64');
      const tag = Buffer.from(encryptedMetadata.tag, 'base64');

      // Verify authentication tag
      const expectedTag = crypto.createHmac('sha256', derivedKey).update(encryptedData).digest();
      if (!crypto.timingSafeEqual(tag, expectedTag)) {
        throw new Error('Authentication verification failed');
      }

      // Create decipher
      const decipher = crypto.createDecipheriv(this.config.algorithm, derivedKey, iv);

      // Decrypt data
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final()
      ]);

      const decryptedData = JSON.parse(decrypted.toString('utf8'));
      
      // Verify recipient
      if (decryptedData.recipientId !== recipientId) {
        throw new Error('Recipient ID mismatch');
      }

      // Remove internal fields
      delete decryptedData.timestamp;
      delete decryptedData.recipientId;

      return decryptedData as CredentialMetadata;

    } catch (error) {
      throw new Error(`Metadata decryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Create a secure metadata exchange token (JWT-like structure)
   */
  async createSecureToken(
    metadata: CredentialMetadata,
    recipientId: string,
    expiresIn: number = 300000 // 5 minutes
  ): Promise<string> {
    const header = {
      alg: 'HS256',
      typ: 'SME', // Secure Metadata Exchange
      ver: '1.0'
    };

    const payload = {
      ...metadata,
      aud: recipientId, // Audience
      iat: Math.floor(Date.now() / 1000), // Issued at
      exp: Math.floor((Date.now() + expiresIn) / 1000), // Expires
      jti: crypto.randomBytes(16).toString('hex') // JWT ID
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const signature = crypto
      .createHmac('sha256', this.config.encryptionKey)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * Verify and extract metadata from secure token
   */
  async verifySecureToken(token: string, recipientId: string): Promise<CredentialMetadata> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token format');
      }

      const [encodedHeader, encodedPayload, signature] = parts;
      
      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', this.config.encryptionKey)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        throw new Error('Invalid token signature');
      }

      // Decode and validate payload
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
      
      // Check expiration
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('Token expired');
      }

      // Check audience
      if (payload.aud !== recipientId) {
        throw new Error('Invalid token audience');
      }

      // Remove JWT fields
      const { aud, iat, exp, jti, ...metadata } = payload;
      
      return metadata as CredentialMetadata;

    } catch (error) {
      throw new Error(`Token verification failed: ${(error as Error).message}`);
    }
  }

  /**
   * Create envelope encryption for large metadata payloads
   */
  async createEnvelopeEncryption(
    metadata: CredentialMetadata,
    recipientPublicKey: string
  ): Promise<{
    encryptedData: string;
    encryptedKey: string;
    iv: string;
    tag: string;
  }> {
    try {
      // Generate data encryption key (DEK)
      const dek = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);

      // Encrypt metadata with DEK
      const cipher = crypto.createCipheriv('aes-256-cbc', dek, iv);
      const encryptedData = Buffer.concat([
        cipher.update(JSON.stringify(metadata), 'utf8'),
        cipher.final()
      ]);
      const tag = crypto.createHmac('sha256', dek).update(encryptedData).digest();

      // Encrypt DEK with recipient's public key
      const encryptedKey = crypto.publicEncrypt(
        {
          key: recipientPublicKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256'
        },
        dek
      );

      return {
        encryptedData: encryptedData.toString('base64'),
        encryptedKey: encryptedKey.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64')
      };

    } catch (error) {
      throw new Error(`Envelope encryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Decrypt envelope encrypted metadata
   */
  async decryptEnvelopeEncryption(
    envelope: {
      encryptedData: string;
      encryptedKey: string;
      iv: string;
      tag: string;
    },
    recipientPrivateKey: string
  ): Promise<CredentialMetadata> {
    try {
      // Decrypt DEK with private key
      const dek = crypto.privateDecrypt(
        {
          key: recipientPrivateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256'
        },
        Buffer.from(envelope.encryptedKey, 'base64')
      );

      // Verify authentication tag
      const encryptedData = Buffer.from(envelope.encryptedData, 'base64');
      const expectedTag = crypto.createHmac('sha256', dek).update(encryptedData).digest();
      const providedTag = Buffer.from(envelope.tag, 'base64');
      
      if (!crypto.timingSafeEqual(expectedTag, providedTag)) {
        throw new Error('Authentication verification failed');
      }

      // Decrypt metadata with DEK  
      const iv = Buffer.from(envelope.iv, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-cbc', dek, iv);

      const decryptedData = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final()
      ]);

      return JSON.parse(decryptedData.toString('utf8'));

    } catch (error) {
      throw new Error(`Envelope decryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Generate key exchange parameters for Perfect Forward Secrecy
   */
  async generateKeyExchange(): Promise<{
    publicKey: string;
    exchangeId: string;
    expiresAt: number;
  }> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const exchangeId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 3600000; // 1 hour

    // Store private key temporarily (in production, use secure storage)
    this.derivedKeys.set(exchangeId, {
      key: Buffer.from(privateKey),
      timestamp: Date.now()
    });

    return {
      publicKey,
      exchangeId,
      expiresAt
    };
  }

  /**
   * Derive shared secret for key exchange
   */
  async deriveSharedSecret(
    exchangeId: string,
    peerPublicKey: string
  ): Promise<Buffer> {
    const keyData = this.derivedKeys.get(exchangeId);
    if (!keyData) {
      throw new Error('Key exchange not found or expired');
    }

    const privateKeyObject = crypto.createPrivateKey(keyData.key);
    const publicKeyObject = crypto.createPublicKey(peerPublicKey);

    const sharedSecret = crypto.diffieHellman({
      privateKey: privateKeyObject,
      publicKey: publicKeyObject
    });

    return sharedSecret;
  }

  /**
   * Private helper methods
   */
  private async deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    const cacheKey = `${password}:${salt.toString('hex')}`;
    const cached = this.derivedKeys.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.KEY_CACHE_TTL) {
      return cached.key;
    }

    const pbkdf2 = promisify(crypto.pbkdf2);
    const derivedKey = await pbkdf2(password, salt, this.config.keyDerivationRounds, 32, 'sha256');
    
    this.derivedKeys.set(cacheKey, {
      key: derivedKey,
      timestamp: Date.now()
    });

    return derivedKey;
  }

  private generateDefaultSalt(recipientId: string): Buffer {
    return crypto
      .createHash('sha256')
      .update(`${recipientId}:${this.config.encryptionKey}`)
      .digest()
      .slice(0, 32);
  }

  private getEncryptionKey(): string {
    const key = process.env.METADATA_ENCRYPTION_KEY || 
                process.env.VALIDATION_TOKEN_SECRET || 
                'dev-key-change-in-production';
    
    if (key === 'dev-key-change-in-production' && process.env.NODE_ENV === 'production') {
      throw new Error('METADATA_ENCRYPTION_KEY must be set in production');
    }
    
    return key;
  }

  private validateConfig(): void {
    if (!this.config.encryptionKey || this.config.encryptionKey.length < 32) {
      throw new Error('Encryption key must be at least 32 characters');
    }

    if (!['aes-256-cbc', 'aes-192-cbc', 'aes-128-cbc'].includes(this.config.algorithm)) {
      throw new Error('Unsupported encryption algorithm');
    }

    if (this.config.keyDerivationRounds < 10000) {
      throw new Error('Key derivation rounds must be at least 10000');
    }
  }

  /**
   * Cleanup expired keys and data
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, data] of this.derivedKeys.entries()) {
      if (now - data.timestamp > this.KEY_CACHE_TTL) {
        this.derivedKeys.delete(key);
      }
    }
  }

  /**
   * Get statistics about the secure exchange
   */
  getStats(): {
    cachedKeys: number;
    algorithm: string;
    keyDerivationRounds: number;
    maxAge: number;
  } {
    return {
      cachedKeys: this.derivedKeys.size,
      algorithm: this.config.algorithm,
      keyDerivationRounds: this.config.keyDerivationRounds,
      maxAge: this.config.maxAge
    };
  }

  /**
   * Destroy sensitive data
   */
  destroy(): void {
    this.derivedKeys.clear();
  }
}

// Export singleton instance for convenience
export const secureMetadataExchange = new SecureMetadataExchange();

export default SecureMetadataExchange;