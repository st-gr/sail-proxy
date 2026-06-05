import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { getConfigPath } from './paths';
import { getGatewayUrl } from '../commands/apikey';
import chalk from 'chalk';

/**
 * Test if an API key is valid by making a test request to the gateway
 */
export async function validateApiKey(apiKey: string, baseUrl: string): Promise<boolean> {
  if (!apiKey || apiKey === 'your_api_key_here') {
    return false;
  }

  try {
    const response = await axios.get(`${baseUrl}/v1/models`, {
      headers: {
        'x-api-key': apiKey
      },
      timeout: 5000
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Get existing valid API key or create a new one
 */
export async function ensureApiKey(baseUrl: string): Promise<string> {
  // For simplicity, just create a new API key each time
  // since we can't easily list keys without authentication
  return await createApiKey(baseUrl);
}

/**
 * List existing API keys from the gateway
 */
async function listApiKeys(baseUrl: string): Promise<Array<{id: string, key: string, isActive: boolean}>> {
  try {
    // We need an admin API key to list keys, but we're trying to get one...
    // For now, skip listing and go straight to creation
    return [];
  } catch (error) {
    return [];
  }
}

/**
 * Create a new API key
 */
async function createApiKey(baseUrl: string): Promise<string> {
  const response = await axios.post(`${baseUrl}/api/admin/api-keys`, {
    createdBy: 'sail-proxy-ollama',
    email: 'ollama@sail-proxy.local'
  }, {
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  
  return response.data.apiKey;
}

/**
 * Update the ollama.env file with a new API key
 */
export function updateOllamaEnv(apiKey: string): void {
  const ollamaEnvPath = getConfigPath('ollama.env');
  
  let envContent = '';
  if (existsSync(ollamaEnvPath)) {
    envContent = readFileSync(ollamaEnvPath, 'utf-8');
  }
  
  // Update or add MAIN_PROXY_API_KEY
  const lines = envContent.split('\n');
  let keyUpdated = false;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('MAIN_PROXY_API_KEY=')) {
      lines[i] = `MAIN_PROXY_API_KEY=${apiKey}`;
      keyUpdated = true;
      break;
    }
  }
  
  if (!keyUpdated) {
    lines.push(`MAIN_PROXY_API_KEY=${apiKey}`);
  }
  
  writeFileSync(ollamaEnvPath, lines.join('\n'));
}

/**
 * Get the current API key from ollama.env
 */
export function getCurrentApiKey(): string | null {
  const ollamaEnvPath = getConfigPath('ollama.env');
  
  if (!existsSync(ollamaEnvPath)) {
    return null;
  }
  
  const envContent = readFileSync(ollamaEnvPath, 'utf-8');
  const lines = envContent.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('MAIN_PROXY_API_KEY=')) {
      return line.split('=', 2)[1] || null;
    }
  }
  
  return null;
}

/**
 * Pre-populate the gateway's model list with a pilot request
 * This prevents timeouts when Ollama tries to access /v1/models immediately after gateway startup
 */
export async function warmupGatewayModels(baseUrl: string, spinner?: any): Promise<void> {
  try {
    if (spinner) {
      spinner.text = 'Warming up gateway model list...';
    }
    
    // Use the unauthenticated OpenRouter endpoint to warm up the model cache
    // This will populate the same underlying model list that /v1/models uses
    await axios.get(`${baseUrl}/openrouter/api/v1/models`, {
      timeout: 30000 // 30 seconds timeout for initial model loading
    });
    
    if (spinner) {
      spinner.text = 'Gateway model list ready';
    }
    
  } catch (error) {
    // Non-fatal - just warn that warmup failed
    if (spinner) {
      spinner.warn('Gateway model warmup failed, Ollama may experience initial delays');
    }
    console.log(chalk.yellow(`Warning: Model list warmup failed - ${error instanceof Error ? error.message : String(error)}`));
  }
}

/**
 * Main function to ensure Ollama has a valid API key
 */
export async function ensureOllamaApiKey(spinner?: any): Promise<void> {
  try {
    // Get the gateway URL (this also validates the gateway is running)
    const baseUrl = await getGatewayUrl();
    
    // Check current API key
    const currentKey = getCurrentApiKey();
    let apiKey = currentKey;
    
    if (currentKey && await validateApiKey(currentKey, baseUrl)) {
      if (spinner) {
        spinner.text = 'Using existing valid API key for Ollama...';
      }
    } else {
      if (spinner) {
        spinner.text = 'Generating new API key for Ollama...';
      }
      
      // Need to get or create a new API key
      apiKey = await ensureApiKey(baseUrl);
      updateOllamaEnv(apiKey);
      
      if (spinner) {
        spinner.text = 'API key configured for Ollama service';
      }
    }
    
    // Pre-populate the gateway's model list to prevent timeouts
    // Use the unauthenticated OpenRouter endpoint for warmup
    await warmupGatewayModels(baseUrl, spinner);
    
  } catch (error) {
    if (spinner) {
      spinner.warn(`Could not configure API key for Ollama: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}