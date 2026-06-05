import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getConfigPath, ensureConfigDir } from './paths';
import chalk from 'chalk';

export interface StoredAwsCredential {
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  userId: string;
  email?: string;
  region?: string;
  description?: string;
  expiresAt?: string;
  createdAt?: string;
}

const AWS_CREDENTIALS_FILE = 'aws-credentials.json';

/**
 * Load saved AWS credentials from storage
 */
export function loadAwsCredentials(): StoredAwsCredential[] {
  const filePath = getConfigPath(AWS_CREDENTIALS_FILE);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const credentials = JSON.parse(content);

    // Validate the structure
    if (!Array.isArray(credentials)) {
      console.warn(chalk.yellow('Warning: Invalid aws-credentials.json format, returning empty array'));
      return [];
    }

    // Filter out any invalid entries
    return credentials.filter(cred =>
      cred &&
      typeof cred.name === 'string' &&
      typeof cred.accessKeyId === 'string' &&
      typeof cred.secretAccessKey === 'string' &&
      typeof cred.userId === 'string' &&
      // Validate accessKeyId format
      /^AKIA[A-Z0-9]{16}$/.test(cred.accessKeyId) &&
      // Validate secretAccessKey length
      cred.secretAccessKey.length === 40
    );
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Failed to load AWS credentials: ${error instanceof Error ? error.message : String(error)}`));
    return [];
  }
}

/**
 * Save AWS credentials to storage
 */
export function saveAwsCredentials(credentials: StoredAwsCredential[]): void {
  ensureConfigDir();
  const filePath = getConfigPath(AWS_CREDENTIALS_FILE);

  try {
    // Write with restricted permissions (owner read/write only)
    writeFileSync(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error(chalk.red(`Error: Failed to save AWS credentials: ${error instanceof Error ? error.message : String(error)}`));
    throw error;
  }
}

/**
 * Add a new AWS credential to storage
 */
export function addAwsCredential(
  name: string,
  accessKeyId: string,
  secretAccessKey: string,
  metadata: {
    userId: string;
    email?: string;
    region?: string;
    description?: string;
    expiresAt?: string;
    createdAt?: string;
  }
): void {
  // Validate inputs
  if (!name || !accessKeyId || !secretAccessKey || !metadata.userId) {
    throw new Error('Missing required fields: name, accessKeyId, secretAccessKey, userId');
  }

  if (!/^AKIA[A-Z0-9]{16}$/.test(accessKeyId)) {
    throw new Error('Invalid accessKeyId format. Must start with AKIA followed by 16 alphanumeric characters.');
  }

  if (secretAccessKey.length !== 40) {
    throw new Error('Invalid secretAccessKey length. Must be exactly 40 characters.');
  }

  const credentials = loadAwsCredentials();

  // Check if a credential with this accessKeyId already exists
  const existingIndex = credentials.findIndex(c => c.accessKeyId === accessKeyId);

  if (existingIndex !== -1) {
    // Update existing credential
    credentials[existingIndex] = {
      name,
      accessKeyId,
      secretAccessKey,
      userId: metadata.userId,
      email: metadata.email,
      region: metadata.region,
      description: metadata.description,
      expiresAt: metadata.expiresAt,
      createdAt: credentials[existingIndex].createdAt || metadata.createdAt || new Date().toISOString()
    };
  } else {
    // Add new credential
    credentials.push({
      name,
      accessKeyId,
      secretAccessKey,
      userId: metadata.userId,
      email: metadata.email,
      region: metadata.region,
      description: metadata.description,
      expiresAt: metadata.expiresAt,
      createdAt: metadata.createdAt || new Date().toISOString()
    });
  }

  saveAwsCredentials(credentials);
}

/**
 * Remove an AWS credential from storage by accessKeyId
 */
export function removeAwsCredential(accessKeyId: string): void {
  const credentials = loadAwsCredentials();
  const filteredCredentials = credentials.filter(c => c.accessKeyId !== accessKeyId);

  if (filteredCredentials.length === credentials.length) {
    // Credential was not found in storage, no need to save
    return;
  }

  saveAwsCredentials(filteredCredentials);
}

/**
 * Get all stored AWS credentials
 */
export function getStoredAwsCredentials(): StoredAwsCredential[] {
  return loadAwsCredentials();
}
