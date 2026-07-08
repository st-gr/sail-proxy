import * as fs from 'fs';
import * as path from 'path';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { Request, Response } from 'express';
import configService from '../services/configService';
import { isStandaloneMode } from '../config/unifiedAuthConfig';

interface LoggingConfig {
  api_config?: {
    logging?: {
      log_folder_path?: string;
      payload_logging_enabled?: boolean;
    };
  };
}

interface EnhancedLogData {
  timestamp: string;
  requestId: string | number;
  stage: string;
  httpMethod?: string;
  url?: string;
  queryParams?: any;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  statusCode?: number;
  payload: any;
}

// Configuration loading function with fallback support
const getLoggingConfig = (): { logFolderPath: string; payloadLoggingEnabled: boolean } => {
  let logFolderPath = './logs';
  let payloadLoggingEnabled = false;

  try {
    // Use ConfigService to get centralized configuration
    const config = configService.getConfig();
    logFolderPath = config.api_config?.logging?.log_folder_path || './logs';
    payloadLoggingEnabled = config.api_config?.logging?.payload_logging_enabled || false;
    
    logger.debug('PayloadLogger', `Loaded config from ConfigService (standalone: ${isStandaloneMode()}): logFolderPath=${logFolderPath}, payloadLoggingEnabled=${payloadLoggingEnabled}`);
  } catch (error: any) {
    logger.warn('PayloadLogger', `Failed to load config from ConfigService, using defaults and environment variables: ${error.message}`);
    
    // Fallback to environment variables and defaults when ConfigService fails
    logFolderPath = process.env.LOG_FOLDER_PATH || './logs';
    
    // In fallback mode, default to environment variable or false
    if (process.env.PAYLOAD_LOGGING_ENABLED === 'true') {
      payloadLoggingEnabled = true;
    } else if (process.env.PAYLOAD_LOGGING_ENABLED === 'false') {
      payloadLoggingEnabled = false;
    } else {
      // When no explicit config is available, default to false for security
      payloadLoggingEnabled = false;
    }
  }

  // Environment variables always override config settings (higher priority)
  if (process.env.PAYLOAD_LOGGING_ENABLED === 'true') {
    payloadLoggingEnabled = true;
    logger.debug('PayloadLogger', 'Environment variable PAYLOAD_LOGGING_ENABLED=true overrides config');
  } else if (process.env.PAYLOAD_LOGGING_ENABLED === 'false') {
    payloadLoggingEnabled = false;
    logger.debug('PayloadLogger', 'Environment variable PAYLOAD_LOGGING_ENABLED=false overrides config');
  }

  return { logFolderPath, payloadLoggingEnabled };
};

// Get dynamic log directory path
const getLogDir = (): string => {
  const { logFolderPath } = getLoggingConfig();
  // Use project root logs directory to avoid nodemon restart issues
  return path.join(__dirname, '..', '..', logFolderPath, 'payloads');
};

// Headers that should be filtered out for security
const SENSITIVE_HEADERS = [
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-session-id',
  'proxy-authorization',
  'www-authenticate',
  'x-forwarded-authorization'
];

function filterSensitiveHeaders(headers: Record<string, any>): Record<string, string> {
  const filtered: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.includes(lowerKey)) {
      filtered[key] = '[REDACTED]';
    } else {
      filtered[key] = String(value);
    }
  }
  
  return filtered;
}

function ensureLogDirExists(): { success: boolean; logDir: string } {
  const logDir = getLogDir();
  logger.debug('PayloadLogger', `Checking/creating LOG_DIR: ${logDir}`);
  
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      logger.debug('PayloadLogger', `Created directory: ${logDir}`);
    } catch (dirError: any) {
      logger.error('PayloadLogger', `FAILED to create directory ${logDir}: ${dirError.message}`);
      return { success: false, logDir };
    }
  } else {
    logger.debug('PayloadLogger', `Directory already exists: ${logDir}`);
  }
  return { success: true, logDir };
}

/**
 * Whether payload logging is currently enabled. Re-reads the dynamic config
 * on every call (with the PAYLOAD_LOGGING_ENABLED env override applied), so
 * an api_config.json change takes effect on the next request — no restart.
 */
export const isPayloadLoggingEnabled = (): boolean => {
  return getLoggingConfig().payloadLoggingEnabled;
};

// Enhanced payload logger with headers and HTTP method support
export const savePayload = (
  requestId: string | number,
  stage: string,
  data: any,
  req?: Request,
  res?: Response
): void => {
  const { payloadLoggingEnabled } = getLoggingConfig();

  // Skip debug logging for disabled payload logging to avoid log noise at INFO level
  if (!payloadLoggingEnabled) {
    return;
  }

  logger.debug('PayloadLogger', `Enhanced save called for requestId: ${requestId}, stage: ${stage}, PAYLOAD_LOGGING_ENABLED: ${payloadLoggingEnabled}`);

  if (!requestId) {
    logger.debug('PayloadLogger', `Skipping enhanced save, no requestId provided.`);
    return;
  }

  const logDirResult = ensureLogDirExists();
  let filePath: string = path.join(logDirResult.logDir, 'unknown_file.json');
  try {
    if (!logDirResult.success) {
      logger.error('PayloadLogger', `Skipping enhanced save, log directory could not be ensured.`);
      return;
    }

    const safeRequestId = String(requestId).replace(/[^a-zA-Z0-9_-]/g, '');
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const filename = `${timestamp}_${safeRequestId}_${stage}.json`;
    filePath = path.join(logDirResult.logDir, filename);
    logger.debug('PayloadLogger', `Attempting to write enhanced log to: ${filePath}`);

    // Build enhanced log data
    const enhancedData: EnhancedLogData = {
      timestamp: new Date().toISOString(),
      requestId,
      stage,
      payload: data
    };

    // Add request information if available
    if (req) {
      enhancedData.httpMethod = req.method;
      enhancedData.url = req.originalUrl || req.url;
      enhancedData.queryParams = req.query && Object.keys(req.query).length > 0 ? req.query : undefined;
      enhancedData.requestHeaders = filterSensitiveHeaders(req.headers);
    }

    // Add response information if available
    if (res) {
      enhancedData.statusCode = res.statusCode;
      // Get response headers (if any have been set)
      const responseHeaders = res.getHeaders();
      if (Object.keys(responseHeaders).length > 0) {
        enhancedData.responseHeaders = filterSensitiveHeaders(responseHeaders as Record<string, any>);
      }
    }

    // Safely handle large or circular objects
    let jsonData: string;
    try {
      jsonData = JSON.stringify(enhancedData, null, 2);
    } catch (jsonError: any) {
      logger.error('PayloadLogger', `Error stringifying enhanced data for ${stage}: ${jsonError.message}`);
      
      // Try a more robust stringify approach with circular reference handling
      const getCircularReplacer = () => {
        const seen = new WeakSet();
        return (_key: string, value: any) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular Reference]';
            }
            seen.add(value);
          }
          return value;
        };
      };
      
      try {
        jsonData = JSON.stringify(enhancedData, getCircularReplacer(), 2);
      } catch (fallbackError: any) {
        // Last resort: store object keys and summary
        jsonData = JSON.stringify({
          __error: "Could not stringify enhanced data",
          __summary: `Enhanced data was of type ${typeof enhancedData}`,
          __keys: enhancedData ? Object.keys(enhancedData) : "null or undefined data",
          __error_message: fallbackError.message
        }, null, 2);
      }
    }

    fs.writeFileSync(filePath, jsonData, 'utf8');
    logger.info('PayloadLogger', `Saved enhanced ${stage} to ${filename}`);
  } catch (error: any) {
    const targetPath = filePath || path.join(logDirResult.logDir, 'unknown_file.json');
    logger.error('PayloadLogger', `Error saving enhanced ${stage} for request ${requestId} to ${targetPath}: ${error.message}`);
  }
};

