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

// __dirname is dist/utils/ (compiled) or src/utils/ (tsx). Both walk up the same.
// Bundled tarball: bundled/ is sibling of dist/, so go up 2 to reach package root.
// Repo dev tree: services/ is at <repo>/, so go up 4 to reach repo root.
const BUNDLED_GATEWAY_ENTRY = ['..', '..', 'bundled', 'gateway', 'services', 'gateway', 'src', 'index.js'];
const DEV_GATEWAY_ENTRY = ['..', '..', '..', '..', 'services', 'gateway', 'dist', 'services', 'gateway', 'src', 'index.js'];
const BUNDLED_GATEWAY_ROOT = ['..', '..', 'bundled', 'gateway'];
const DEV_GATEWAY_ROOT = ['..', '..', '..', '..', 'services', 'gateway'];
const BUNDLED_OLLAMA_ENTRY = ['..', '..', 'bundled', 'ollama', 'services', 'ollama', 'index.js'];
const DEV_OLLAMA_ENTRY = ['..', '..', '..', '..', 'services', 'ollama', 'index.js'];

/**
 * Get the path to the gateway service entry script.
 * Picks bundled (production npm install) or dev (linked / from-source) based
 * on which one actually exists on disk. NODE_ENV is unreliable here — npm
 * doesn't set it on the parent CLI process.
 */
export function getGatewayPath(): string {
  const bundled = join(__dirname, ...BUNDLED_GATEWAY_ENTRY);
  return existsSync(bundled) ? bundled : join(__dirname, ...DEV_GATEWAY_ENTRY);
}

/**
 * Get the gateway service root (cwd for the spawned process).
 */
export function getGatewayCwd(): string {
  const bundled = join(__dirname, ...BUNDLED_GATEWAY_ROOT);
  return existsSync(bundled) ? bundled : join(__dirname, ...DEV_GATEWAY_ROOT);
}

/**
 * Get the path to the ollama service entry script.
 */
export function getOllamaPath(): string {
  const bundled = join(__dirname, ...BUNDLED_OLLAMA_ENTRY);
  return existsSync(bundled) ? bundled : join(__dirname, ...DEV_OLLAMA_ENTRY);
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