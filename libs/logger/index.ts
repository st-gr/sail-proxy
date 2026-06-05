import { LogEntry, RequestContext } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

// Define log levels with their numerical values (lower = higher priority)
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
} as const;

// ANSI color codes for console output
const COLORS = {
  ERROR: '\x1b[31m', // Red
  WARN: '\x1b[33m',  // Yellow
  INFO: '\x1b[32m',  // Green
  DEBUG: '\x1b[36m', // Cyan
  TRACE: '\x1b[35m', // Magenta
  RESET: '\x1b[0m'   // Reset
} as const;

export interface Logger {
  // Original interface (admin service compatibility)
  trace(component: string, message: string, metadata?: any): void;
  debug(component: string, message: string, metadata?: any): void;
  info(component: string, message: string, metadata?: any): void;
  warn(component: string, message: string, metadata?: any): void;
  error(component: string, message: string, error?: Error, metadata?: any): void;
  
  // Gateway interface compatibility (component is first parameter)
  trace(component: string, message: string, metadata?: any): void;
  debug(component: string, message: string, metadata?: any): void;
  info(component: string, message: string, metadata?: any): void;
  warn(component: string, message: string, metadata?: any): void;
  error(component: string, message: string, error?: Error, metadata?: any): void;
  
  // Generic log method
  log(level: LogLevel, component: string, message: string, metadata?: any, error?: Error): void;
  
  // Utility methods
  setRequestContext(context: RequestContext): void;
  clearRequestContext(): void;
  isLevelEnabled(component: string, level: LogLevel): boolean;
  reinitialize(): void;
  close(): void;
  
  // Morgan HTTP integration
  stream: { write: (message: string) => void };
}

export interface LogConfig {
  level: LogLevel;
  format: 'json' | 'simple' | 'combined';
  transports: LogTransport[];
  enableColors: boolean;
  enableTimestamp: boolean;
  enableRequestId: boolean;
  
  // Enhanced configuration options
  componentLevels?: Record<string, LogLevel>;
  logFolderPath?: string;
  configFilePath?: string;
  enableFileLogging?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
}

export interface LogTransport {
  type: 'console' | 'file' | 'http';
  level?: LogLevel;
  config?: {
    filename?: string;
    maxsize?: number;
    maxFiles?: number;
    url?: string;
    headers?: Record<string, string>;
  };
}

// Configuration interface for api_config.json compatibility
interface ApiLogConfig {
  api_config?: {
    logging?: {
      defaultLevel?: string;
      components?: Record<string, string>;
      log_folder_path?: string;
      payload_logging_enabled?: boolean;
    };
  };
}

class EnhancedServiceLogger implements Logger {
  private config: LogConfig;
  private requestContext?: RequestContext;
  private componentLevels: Record<string, LogLevel> = {};
  private logDir: string = '';
  private logFiles: Set<fs.WriteStream> = new Set();

  constructor(config: Partial<LogConfig> = {}) {
    // Check if file logging should be disabled
    const disableFileLogging = 
      process.env.DISABLE_FILE_LOGGING === 'true' ||
      process.env.LOG_TO_STDOUT === 'true' ||
      !!process.env.KUBERNETES_SERVICE_HOST; // Auto-detect Kubernetes

    this.config = {
      level: 'info',
      format: 'simple',
      transports: [{ type: 'console' }],
      enableColors: true,
      enableTimestamp: true,
      enableRequestId: true,
      logFolderPath: './logs',
      configFilePath: process.env.CONFIG_FILE_PATH || './api_config.json',
      enableFileLogging: !disableFileLogging,
      maxFileSize: 5242880, // 5MB
      maxFiles: 5,
      ...config
    };

    // Override with explicit config if provided
    if (config.enableFileLogging !== undefined) {
      this.config.enableFileLogging = config.enableFileLogging;
    }

    // Load dynamic configuration from file
    this.loadConfigurationFromFile();
    
    // Initialize log directory only if file logging is enabled
    if (this.config.enableFileLogging && this.config.logFolderPath) {
      try {
        this.logDir = this.ensureLogDirectory(path.resolve(this.config.logFolderPath));
      } catch (error) {
        // Disable file logging if directory creation fails
        console.warn(`Failed to create log directory, falling back to console only: ${error}`);
        this.config.enableFileLogging = false;
        // Ensure console transport is present
        if (!this.config.transports.some(t => t.type === 'console')) {
          this.config.transports.push({ type: 'console' });
        }
      }
    }

    // Set up process cleanup handlers
    this.setupCleanupHandlers();
  }

  private loadConfigurationFromFile(): void {
    try {
      if (this.config.configFilePath && fs.existsSync(this.config.configFilePath)) {
        const fileConfig: ApiLogConfig = JSON.parse(fs.readFileSync(this.config.configFilePath, 'utf8'));
        
        if (fileConfig.api_config?.logging) {
          const loggingConfig = fileConfig.api_config.logging;
          
          // Set default level (environment variable takes priority)
          const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel;
          const configLevel = loggingConfig.defaultLevel?.toLowerCase() as LogLevel;
          
          if (envLevel && Object.keys(LOG_LEVELS).includes(envLevel)) {
            this.config.level = envLevel;
          } else if (configLevel && Object.keys(LOG_LEVELS).includes(configLevel)) {
            this.config.level = configLevel;
          }
          
          // Set component-specific levels
          if (loggingConfig.components) {
            Object.entries(loggingConfig.components).forEach(([component, level]) => {
              const normalizedLevel = level.toLowerCase() as LogLevel;
              if (Object.keys(LOG_LEVELS).includes(normalizedLevel)) {
                this.componentLevels[component] = normalizedLevel;
              }
            });
          }
          
          // Set log folder path
          if (loggingConfig.log_folder_path) {
            this.config.logFolderPath = loggingConfig.log_folder_path;
          }
        }
      }
    } catch (error) {
      // Fallback to environment variables and defaults
      const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel;
      if (envLevel && Object.keys(LOG_LEVELS).includes(envLevel)) {
        this.config.level = envLevel;
      }
    }
  }

  private ensureLogDirectory(logDir: string): string {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    return logDir;
  }

  private setupCleanupHandlers(): void {
    const cleanup = () => {
      this.close();
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  setRequestContext(context: RequestContext): void {
    this.requestContext = context;
  }

  clearRequestContext(): void {
    this.requestContext = undefined;
  }

  isLevelEnabled(component: string, level: LogLevel): boolean {
    const componentLevel = this.componentLevels[component] || this.config.level;
    const componentLevelValue = LOG_LEVELS[componentLevel];
    const requestedLevelValue = LOG_LEVELS[level];
    
    return requestedLevelValue <= componentLevelValue;
  }

  reinitialize(): void {
    this.close();
    this.loadConfigurationFromFile();
    
    if (this.config.enableFileLogging && this.config.logFolderPath) {
      this.logDir = this.ensureLogDirectory(path.resolve(this.config.logFolderPath));
    }
  }

  close(): void {
    for (const stream of this.logFiles) {
      try {
        stream.end();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.logFiles.clear();
  }

  trace(component: string, message: string, metadata?: any): void {
    this.log('trace', component, message, metadata);
  }

  debug(component: string, message: string, metadata?: any): void {
    this.log('debug', component, message, metadata);
  }

  info(component: string, message: string, metadata?: any): void {
    this.log('info', component, message, metadata);
  }

  warn(component: string, message: string, metadata?: any): void {
    this.log('warn', component, message, metadata);
  }

  error(component: string, message: string, error?: Error, metadata?: any): void {
    this.log('error', component, message, metadata, error);
  }

  log(level: LogLevel, component: string, message: string, metadata?: any, error?: Error): void {
    // Check if this level is enabled for this component
    if (!this.isLevelEnabled(component, level)) {
      return;
    }

    const logEntry: LogEntry = {
      level,
      message,
      component,
      timestamp: new Date().toISOString(),
      requestId: this.requestContext?.requestId,
      metadata: this.formatMetadata(level, metadata),
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : undefined
    };

    this.writeLog(logEntry);
  }

  private formatMetadata(level: LogLevel, metadata?: any): any {
    if (!metadata) return undefined;

    // Special formatting for TRACE level
    if (level === 'trace') {
      return this.formatMetaForTrace(metadata);
    }

    // Handle headers specially for all levels
    if (metadata && typeof metadata === 'object' && metadata.headers) {
      const formatted = { ...metadata };
      formatted.headers = this.formatHeaders(metadata.headers);
      return formatted;
    }

    return metadata;
  }

  private formatMetaForTrace(meta: any): any {
    if (!meta || typeof meta !== 'object') {
      return meta;
    }
    
    const formatted: any = {};
    
    Object.entries(meta).forEach(([key, value]) => {
      if (key === 'headers' && typeof value === 'object') {
        formatted[key] = this.formatHeaders(value);
      } else if (Array.isArray(value)) {
        try {
          formatted[key] = JSON.stringify(value, null, 2);
        } catch (err) {
          formatted[key] = `[Array of length ${value.length}]`;
        }
      } else if (value && typeof value === 'object' && !(value instanceof Error)) {
        try {
          formatted[key] = JSON.stringify(value, null, 2);
        } catch (err) {
          formatted[key] = '[Object]';
        }
      } else {
        formatted[key] = value;
      }
    });
    
    return formatted;
  }

  private formatHeaders(headers: any): any {
    if (!headers || typeof headers !== 'object') return headers;
    
    const formatted: any = {};
    Object.entries(headers).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        formatted[key] = value.map(v => String(v)).join(', ');
      } else {
        formatted[key] = value;
      }
    });
    return formatted;
  }

  private writeLog(entry: LogEntry): void {
    this.config.transports.forEach(transport => {
      if (transport.level && !this.shouldLogForTransport(entry.level, transport.level)) {
        return;
      }

      switch (transport.type) {
        case 'console':
          this.writeToConsole(entry);
          break;
        case 'file':
          this.writeToFile(entry, transport);
          break;
        case 'http':
          this.writeToHttp(entry, transport);
          break;
      }
    });
  }

  private shouldLogForTransport(messageLevel: LogLevel, transportLevel: LogLevel): boolean {
    const transportLevelValue = LOG_LEVELS[transportLevel];
    const messageLevelValue = LOG_LEVELS[messageLevel];
    return messageLevelValue <= transportLevelValue;
  }

  private writeToConsole(entry: LogEntry): void {
    const formatted = this.formatLogEntry(entry);
    
    switch (entry.level) {
      case 'trace':
        console.debug(formatted);
        break;
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  private writeToFile(entry: LogEntry, transport: LogTransport): void {
    if (!this.config.enableFileLogging || !this.logDir) {
      this.writeToConsole(entry);
      return;
    }

    try {
      const filename = transport.config?.filename || 'app.log';
      const filepath = path.join(this.logDir, filename);
      const formatted = JSON.stringify(entry) + '\n';

      // Simple file append (in production, consider using rotating file streams)
      fs.appendFileSync(filepath, formatted);
    } catch (error) {
      // Fallback to console on file write error
      this.writeToConsole(entry);
    }
  }

  private writeToHttp(entry: LogEntry, transport: LogTransport): void {
    // HTTP logging would require HTTP client
    // For now, fallback to console
    this.writeToConsole(entry);
  }

  private formatLogEntry(entry: LogEntry): string {
    switch (this.config.format) {
      case 'json':
        return JSON.stringify(entry);
      case 'combined':
        return this.formatCombined(entry);
      case 'simple':
      default:
        return this.formatSimple(entry);
    }
  }

  private formatSimple(entry: LogEntry): string {
    const timestamp = this.config.enableTimestamp ? `${entry.timestamp} ` : '';
    const requestId = this.config.enableRequestId && entry.requestId ? `[${entry.requestId}] ` : '';
    const level = entry.level.toUpperCase().padEnd(5);
    
    // Apply colors if enabled
    const levelColor = this.config.enableColors ? this.getLevelColor(entry.level) : '';
    const resetColor = this.config.enableColors ? COLORS.RESET : '';
    const componentColor = this.config.enableColors ? levelColor : '';
    
    const component = `${componentColor}[${entry.component}]${resetColor}`;
    
    let formatted = `${timestamp}${requestId}${level} ${component} ${entry.message}`;
    
    if (entry.metadata) {
      formatted += ` ${JSON.stringify(entry.metadata)}`;
    }
    
    if (entry.error) {
      formatted += `\nError: ${entry.error.name}: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\nStack: ${entry.error.stack}`;
      }
    }
    
    return formatted;
  }

  private formatCombined(entry: LogEntry): string {
    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase();
    const component = entry.component;
    const message = entry.message;
    const requestId = entry.requestId || '-';
    
    let formatted = `${timestamp} [${requestId}] ${level} [${component}] ${message}`;
    
    if (entry.metadata) {
      formatted += ` meta=${JSON.stringify(entry.metadata)}`;
    }
    
    if (entry.error) {
      formatted += ` error="${entry.error.name}: ${entry.error.message}"`;
    }
    
    return formatted;
  }

  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case 'error': return COLORS.ERROR;
      case 'warn': return COLORS.WARN;
      case 'info': return COLORS.INFO;
      case 'debug': return COLORS.DEBUG;
      case 'trace': return COLORS.TRACE;
      default: return '';
    }
  }

  // Morgan HTTP integration
  get stream() {
    return {
      write: (message: string) => {
        this.info('HTTP', message.trim());
      }
    };
  }
}

// Utility functions for safe logging (Gateway compatibility)
export function createSafePreview(data: any, maxLength: number = 1000): string {
  try {
    if (data == null) {
      return String(data);
    }

    if (typeof data === 'string') {
      if ((data.startsWith('{') && data.endsWith('}')) || (data.startsWith('[') && data.endsWith(']'))) {
        try {
          const parsed = JSON.parse(data);
          const formatted = JSON.stringify(parsed, null, 2);
          return formatted.length > maxLength ? formatted.substring(0, maxLength) + '... [truncated]' : formatted;
        } catch (e) {
          return data.length > maxLength ? data.substring(0, maxLength) + '... [truncated]' : data;
        }
      }
      return data.length > maxLength ? data.substring(0, maxLength) + '... [truncated]' : data;
    } 
    
    if (Buffer.isBuffer(data)) {
      const previewLength = Math.min(200, data.length);
      return `[Buffer ${data.length} bytes]: ${data.toString('utf8', 0, previewLength)}${data.length > previewLength ? '... [truncated]' : ''}`;
    } 
    
    const jsonStr = JSON.stringify(data, null, 2);
    return jsonStr.length > maxLength ? jsonStr.substring(0, maxLength) + '... [truncated]' : jsonStr;
  } catch (e: any) {
    return `[Object - failed to serialize: ${e.message}]`;
  }
}

export function createHeadersPreview(headers: Record<string, any> | null | undefined): string {
  if (!headers) return '[No headers]';
  
  const sanitizedHeaders = { ...headers };
  
  // Sanitize authorization header
  if (sanitizedHeaders.Authorization || sanitizedHeaders.authorization) {
    const authKey = sanitizedHeaders.Authorization ? 'Authorization' : 'authorization';
    const authValue = sanitizedHeaders[authKey];
    if (typeof authValue === 'string' && authValue.length > 15) {
      sanitizedHeaders[authKey] = `${authValue.substring(0, 15)}...`;
    }
  }
  
  return createSafePreview(sanitizedHeaders, 500);
}

// Default logger instance
let defaultLogger: EnhancedServiceLogger;

export function createLogger(config?: Partial<LogConfig>): Logger {
  return new EnhancedServiceLogger(config);
}

export function getDefaultLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new EnhancedServiceLogger();
  }
  return defaultLogger;
}

export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger as EnhancedServiceLogger;
}

// Convenience exports
export const logger = getDefaultLogger();
export default logger;