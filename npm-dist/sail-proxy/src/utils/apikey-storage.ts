import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getConfigPath, ensureConfigDir } from './paths';
import chalk from 'chalk';

interface StoredApiKey {
  name: string;
  key: string;
}

const APIKEYS_FILE = 'apikeys.json';

/**
 * Load saved API keys from storage
 */
export function loadApiKeys(): StoredApiKey[] {
  const filePath = getConfigPath(APIKEYS_FILE);
  
  if (!existsSync(filePath)) {
    return [];
  }
  
  try {
    const content = readFileSync(filePath, 'utf-8');
    const keys = JSON.parse(content);
    
    // Validate the structure
    if (!Array.isArray(keys)) {
      console.warn(chalk.yellow('Warning: Invalid apikeys.json format, returning empty array'));
      return [];
    }
    
    // Filter out any invalid entries
    return keys.filter(key => 
      key && 
      typeof key.name === 'string' && 
      typeof key.key === 'string'
    );
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Failed to load API keys: ${error instanceof Error ? error.message : String(error)}`));
    return [];
  }
}

/**
 * Save API keys to storage
 */
export function saveApiKeys(keys: StoredApiKey[]): void {
  ensureConfigDir();
  const filePath = getConfigPath(APIKEYS_FILE);
  
  try {
    writeFileSync(filePath, JSON.stringify(keys, null, 2));
  } catch (error) {
    console.error(chalk.red(`Error: Failed to save API keys: ${error instanceof Error ? error.message : String(error)}`));
    throw error;
  }
}

/**
 * Add a new API key to storage
 */
export function addApiKey(name: string, key: string): void {
  const keys = loadApiKeys();
  
  // Check if a key with this name already exists
  const existingIndex = keys.findIndex(k => k.name === name);
  
  if (existingIndex !== -1) {
    // Update existing key
    keys[existingIndex].key = key;
  } else {
    // Add new key
    keys.push({ name, key });
  }
  
  saveApiKeys(keys);
}

/**
 * Remove an API key from storage by key value
 */
export function removeApiKey(key: string): void {
  const keys = loadApiKeys();
  const filteredKeys = keys.filter(k => k.key !== key);
  
  if (filteredKeys.length === keys.length) {
    // Key was not found in storage, no need to save
    return;
  }
  
  saveApiKeys(filteredKeys);
}

/**
 * Get all stored API keys
 */
export function getStoredApiKeys(): StoredApiKey[] {
  return loadApiKeys();
}