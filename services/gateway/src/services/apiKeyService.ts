// In production, use a secure DB (e.g. via CAP CDS) with hashed keys. This sample uses an in‑memory array.
import crypto from 'crypto';

interface ApiKeyRecord {
  id: string;
  key: string;
  createdBy: string;
  email: string;
  createdAt: Date;
  isActive: boolean;
}

interface ValidatedApiKey {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
}

// In production, replace with database calls
let apiKeys: ApiKeyRecord[] = [
  // Sample entry: { id: 'uuid-string', key: 'sk-abc123', createdBy: 'admin', email: 'admin@example.com', isActive: true, createdAt: new Date() }
];

/**
 * Verify an API key
 * @param providedKey - The API key to verify
 * @returns The key record if valid, null otherwise
 */
export async function verifyApiKey(providedKey: string): Promise<ApiKeyRecord | null> {
  // In production, compare hashed keys. Here we use plain text for demonstration.
  const keyRecord = apiKeys.find(k => k.key === providedKey && k.isActive);
  return keyRecord || null;
}

/**
 * Create a new API key
 * @param createdBy - Who created the key
 * @param email - Email associated with the key
 * @returns The new API key record
 */
export async function createApiKey(createdBy: string, email: string): Promise<ApiKeyRecord> {
  const newKey = 'sk-' + crypto.randomBytes(24).toString('hex');
  const id = crypto.randomUUID(); // Generate a UUID for the record
  const record: ApiKeyRecord = { 
    id,
    key: newKey, 
    createdBy, 
    email, 
    isActive: true, 
    createdAt: new Date() 
  };
  apiKeys.push(record);
  return record;
}

/**
 * Revoke an API key
 * @param key - The API key to revoke
 * @returns The revoked key record or null if not found
 */
export async function revokeApiKey(key: string): Promise<ApiKeyRecord | null> {
  const keyRecord = apiKeys.find(k => k.key === key);
  if (keyRecord) {
    keyRecord.isActive = false;
  }
  return keyRecord || null;
}

/**
 * Revoke all API keys for an email
 * @param email - The email to revoke keys for
 * @returns Array of revoked key records
 */
export async function revokeApiKeysByEmail(email: string): Promise<ApiKeyRecord[]> {
  if (!email) {
    throw new Error('Email is required for revoking API keys');
  }
  
  const keysToRevoke = apiKeys.filter(k => k.email === email && k.isActive);
  
  // Revoke all matching keys
  keysToRevoke.forEach(keyRecord => {
    keyRecord.isActive = false;
  });
  
  return keysToRevoke;
}

/**
 * Get an API key by ID
 * @param id - The API key ID
 * @returns The API key record or undefined if not found
 */
export async function getApiKeyById(id: string): Promise<ApiKeyRecord | undefined> {
  // Get a specific API key by its UUID
  return apiKeys.find(k => k.id === id);
}

/**
 * Update an API key
 * @param id - The API key ID
 * @param newKey - Optional new key value
 * @param isActive - Optional active status
 * @returns The updated key record or null if not found
 */
export async function setApiKey(id: string, newKey?: string, isActive?: boolean): Promise<ApiKeyRecord | null> {
  // Find the key by ID
  const keyRecord = apiKeys.find(k => k.id === id);
  if (!keyRecord) {
    return null;
  }
  
  // Update the key if provided
  if (newKey) {
    keyRecord.key = newKey;
  }
  
  // Update active status if provided
  if (isActive !== undefined) {
    keyRecord.isActive = isActive;
  }
  
  return keyRecord;
}

/**
 * List all API keys
 * @returns Array of all API key records
 */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  return apiKeys;
}

/**
 * Validates an API key against the database
 * @param apiKey - The API key to validate
 * @returns API key info if valid, null if invalid
 */
export async function validateApiKey(apiKey: string): Promise<ValidatedApiKey | null> {
  try {
    if (!apiKey) return null;
    
    // Use the existing listApiKeys function instead of getAllApiKeys
    const allKeys = await listApiKeys();
    
    // Find matching key - note the property is isActive not active
    const matchingKey = allKeys.find(k => k.key === apiKey && k.isActive === true);
    
    if (matchingKey) {
      return {
        id: matchingKey.id,
        name: matchingKey.createdBy || 'API Key', // Using createdBy as name
        active: matchingKey.isActive,
        createdAt: matchingKey.createdAt
      };
    }
    
    return null;
  } catch (error) {
    console.error(`[ApiKeyService] Error validating API key:`, error);
    return null;
  }
}

class ApiKeyService {
  async createApiKey(createdBy: string, email: string): Promise<ApiKeyRecord> {
    return createApiKey(createdBy, email);
  }

  async validateApiKey(key: string): Promise<ValidatedApiKey | null> {
    return validateApiKey(key);
  }

  async verifyApiKey(key: string): Promise<ApiKeyRecord | null> {
    return verifyApiKey(key);
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    return listApiKeys();
  }

  async revokeApiKey(key: string): Promise<ApiKeyRecord | null> {
    return revokeApiKey(key);
  }

  async revokeApiKeysByEmail(email: string): Promise<ApiKeyRecord[]> {
    return revokeApiKeysByEmail(email);
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | undefined> {
    return getApiKeyById(id);
  }

  async setApiKey(id: string, key?: string, isActive?: boolean): Promise<ApiKeyRecord | null> {
    return setApiKey(id, key, isActive);
  }
}

export default new ApiKeyService();