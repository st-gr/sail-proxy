import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/**
 * Get the configuration directory path based on the platform
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    // Windows: %APPDATA%/sail-proxy
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'sail-proxy');
  } else {
    // Linux/macOS: ~/.sail-proxy
    return join(homedir(), '.sail-proxy');
  }
}

/**
 * Ensure the configuration directory exists
 */
export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Get the path to a specific config file
 */
export function getConfigPath(filename: string): string {
  return join(getConfigDir(), filename);
}

/**
 * Check if this is the first run (no config exists)
 */
export function isFirstRun(): boolean {
  return !existsSync(getConfigPath('.env'));
}

/**
 * Get the path to store process PIDs
 */
export function getPidPath(service: 'gateway' | 'ollama'): string {
  return getConfigPath(`${service}.pid`);
}

/**
 * Get the path to the bundled gateway service
 */
export function getGatewayPath(): string {
  // In development, use the actual services directory
  if (process.env.NODE_ENV !== 'production') {
    return join(__dirname, '..', '..', '..', '..', 'services', 'gateway', 'dist', 'services', 'gateway', 'src', 'index.js');
  }
  return join(__dirname, '..', 'bundled', 'gateway', 'index.js');
}

/**
 * Get the path to the bundled ollama service
 */
export function getOllamaPath(): string {
  // In development, use the actual services directory
  if (process.env.NODE_ENV !== 'production') {
    return join(__dirname, '..', '..', '..', '..', 'services', 'ollama', 'index.js');
  }
  return join(__dirname, '..', 'bundled', 'ollama', 'index.js');
}

/**
 * Get the path to template files
 */
export function getTemplatePath(filename: string): string {
  return join(__dirname, '..', 'templates', filename);
}

/**
 * Get the logs directory path
 */
export function getLogsDir(): string {
  return join(getConfigDir(), 'logs');
}

/**
 * Get the path to a log file
 */
export function getLogPath(filename: string): string {
  return join(getLogsDir(), filename);
}

/**
 * Ensure the logs directory exists
 */
export function ensureLogDir(): void {
  const logsDir = getLogsDir();
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
}