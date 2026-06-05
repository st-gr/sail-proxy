import crypto from 'crypto';

// Type definitions
interface AwsCredential {
  id: string;
  accessKeyId: string;
  secretHash: string;
  salt: string;
  reconstructedSecret: string;
  userId: string;
  createdAt: Date;
  isActive: boolean;
}

interface AwsCredentialResponse {
  id: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
}

interface CredentialListItem {
  id: string;
  accessKeyId: string;
  userId: string;
  createdAt: Date;
  isActive: boolean;
}

// HACK / TODO: This is a temporary in-memory storage for AWS test credentials. REMOVE THIS IN PRODUCTION!
// In-memory storage for AWS credentials (use database in production)
let awsCredentials: AwsCredential[] = [];

if (process.env.DEBUG === 'true') {
    // Use environment variables for test credentials instead of hardcoded values
    const testAccessKeyId = process.env.TEST_AWS_ACCESS_KEY_ID || generateAccessKeyId();
    const testSecret = process.env.TEST_AWS_SECRET_ACCESS_KEY || generateSecretAccessKey();
    const testSalt = process.env.TEST_AWS_SALT || crypto.randomBytes(16).toString('hex');
    
    awsCredentials.push({
        id: "test-credential-id",
        accessKeyId: testAccessKeyId,
        secretHash: "test-secret-hash", // Will be calculated below
        salt: testSalt,
        reconstructedSecret: testSecret,
        userId: "test-user",
        createdAt: new Date(),
        isActive: true
    });
}


/**
 * Generate AWS-style access key ID
 * @returns Access key ID in format AKIA followed by 16 random characters
 */
function generateAccessKeyId(): string {
  return 'AKIA' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * Generate AWS-style secret access key
 * @returns 40-character hex string
 */
function generateSecretAccessKey(): string {
  return crypto.randomBytes(20).toString('hex');
}

/**
 * Hash a secret access key with salt for secure storage
 * @param secret - The secret access key
 * @param salt - Random salt
 * @returns HMAC-SHA256 hash
 */
function hashSecret(secret: string, salt: string): string {
  return crypto.createHmac('sha256', salt).update(secret).digest('hex');
}

// Calculate the correct hash for the test credentials after function definition
if (awsCredentials.length > 0) {
  const testCredential = awsCredentials[0];
  if (testCredential && testCredential.reconstructedSecret && testCredential.salt) {
    testCredential.secretHash = hashSecret(testCredential.reconstructedSecret, testCredential.salt);
  }
}

/**
 * Create new AWS credentials pair
 * @param userId - User identifier
 * @returns Credentials object with accessKeyId and secretAccessKey
 */
export async function createAwsCredentials(userId: string = 'default'): Promise<AwsCredentialResponse> {
  const accessKeyId = generateAccessKeyId();
  const secretAccessKey = generateSecretAccessKey();
  const salt = crypto.randomBytes(16).toString('hex');
  const secretHash = hashSecret(secretAccessKey, salt);
  
  const credential: AwsCredential = {
    id: crypto.randomUUID(),
    accessKeyId,
    secretHash,
    salt,
    // Store the secret temporarily for SigV4 validation (development only!)
    // In production, use a secure key management service
    reconstructedSecret: secretAccessKey,
    userId,
    createdAt: new Date(),
    isActive: true
  };
  
  awsCredentials.push(credential);
  
  // Get AWS region from SAP_AI_REGION configuration
  const sapAiRegion = process.env.SAP_AI_REGION || 'us-east-1';
  const awsRegion = sapAiRegion.includes('.') ? (sapAiRegion.split('.')[1] || 'us-east-1') : sapAiRegion;
  
  // Return the secret in plain text only this once
  return {
    id: credential.id,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_REGION: awsRegion
  };
}

/**
 * Validate AWS credentials
 * @param accessKeyId - Access key ID
 * @param secretAccessKey - Secret access key
 * @returns Credential record if valid, null otherwise
 */
export async function validateAwsCredentials(accessKeyId: string, secretAccessKey: string): Promise<AwsCredential | null> {
  try {
    const credential = awsCredentials.find(c => 
      c.accessKeyId === accessKeyId && c.isActive
    );
    
    if (!credential) {
      return null;
    }
    
    // Hash the provided secret with the stored salt
    const providedHash = hashSecret(secretAccessKey, credential.salt);
    
    // Use timing-safe comparison
    if (crypto.timingSafeEqual(Buffer.from(credential.secretHash), Buffer.from(providedHash))) {
      return credential;
    }
    
    return null;
  } catch (error: any) {
    console.error('[AwsCredentialsService] Error validating credentials:', error);
    return null;
  }
}

/**
 * List all AWS credentials (without secrets)
 * @returns Array of credential records
 */
export async function listAwsCredentials(): Promise<CredentialListItem[]> {
  return awsCredentials.map(c => ({
    id: c.id,
    accessKeyId: c.accessKeyId,
    userId: c.userId,
    createdAt: c.createdAt,
    isActive: c.isActive
  }));
}

/**
 * Revoke AWS credentials
 * @param accessKeyId - Access key ID to revoke
 * @returns True if revoked, false if not found
 */
export async function revokeAwsCredentials(accessKeyId: string): Promise<boolean> {
  const credential = awsCredentials.find(c => c.accessKeyId === accessKeyId);
  if (credential) {
    credential.isActive = false;
    return true;
  }
  return false;
}

/**
 * Find AWS credential by access key ID (without secret validation)
 * @param accessKeyId - Access key ID
 * @returns Credential record if found and active, null otherwise
 */
export async function findAwsCredential(accessKeyId: string): Promise<AwsCredential | null> {
  return awsCredentials.find(c => 
    c.accessKeyId === accessKeyId && c.isActive
  ) || null;
}

/**
 * Get secret access key for signature validation
 * @param accessKeyId - Access key ID
 * @returns Secret access key for signature calculation, null if not found
 * Note: This is only used internally for AWS SigV4 signature validation
 */
export async function getSecretForSignature(accessKeyId: string): Promise<string | null> {
  const credential = awsCredentials.find(c =>
    c.accessKeyId === accessKeyId && c.isActive
  );

  if (!credential) {
    return null;
  }

  // In a real implementation, you would derive the secret from the stored hash
  // For development/testing, we'll use a reconstructed secret approach
  // WARNING: This is not secure for production use!

  // Return the reconstructed secret (this is a simplified approach for development)
  // In production, you'd need a secure way to retrieve or regenerate the secret
  return credential.reconstructedSecret || null;
}

/**
 * Find AWS credential by access key ID (for duplicate checking)
 * @param accessKeyId - Access key ID to find
 * @param excludeId - Optional credential ID to exclude from search
 * @returns Credential record if found, undefined otherwise
 */
export async function findAwsCredentialByAccessKeyId(
  accessKeyId: string,
  excludeId?: string
): Promise<AwsCredential | undefined> {
  return awsCredentials.find(
    c => c.accessKeyId === accessKeyId && c.id !== excludeId
  );
}

/**
 * Set AWS credential keys for restoration
 * @param credentialId - Credential ID to update
 * @param accessKeyId - New access key ID
 * @param secretAccessKey - New secret access key
 * @returns True if updated successfully, false if credential not found
 */
export async function setAwsCredentialKeys(
  credentialId: string,
  accessKeyId: string,
  secretAccessKey: string
): Promise<boolean> {
  const credentialIndex = awsCredentials.findIndex(c => c.id === credentialId);

  if (credentialIndex === -1) {
    return false;
  }

  // Re-hash the secret
  const salt = crypto.randomBytes(16).toString('hex');
  const secretHash = hashSecret(secretAccessKey, salt);

  // Update credential
  awsCredentials[credentialIndex] = {
    ...awsCredentials[credentialIndex],
    accessKeyId,
    secretHash,
    salt,
    reconstructedSecret: secretAccessKey  // For dev mode only
  };

  return true;
}

class AwsCredentialsService {
  async createAwsCredentials(userId?: string): Promise<AwsCredentialResponse> {
    return createAwsCredentials(userId);
  }

  async validateAwsCredentials(accessKeyId: string, secretAccessKey: string): Promise<AwsCredential | null> {
    return validateAwsCredentials(accessKeyId, secretAccessKey);
  }

  async listAwsCredentials(): Promise<CredentialListItem[]> {
    return listAwsCredentials();
  }

  async revokeAwsCredentials(accessKeyId: string): Promise<boolean> {
    return revokeAwsCredentials(accessKeyId);
  }

  async findAwsCredential(accessKeyId: string): Promise<AwsCredential | null> {
    return findAwsCredential(accessKeyId);
  }

  async getSecretForSignature(accessKeyId: string): Promise<string | null> {
    return getSecretForSignature(accessKeyId);
  }
}

export default new AwsCredentialsService();

// Export the credentials array for debugging only (remove in production)
export { awsCredentials };