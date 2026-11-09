// Configuration types (extending the ones from libs/config)
export * from '../config/types';
import type { DeployTarget, DatabaseConfig, LoggingConfig } from '../config/types';

// Additional configuration interfaces
export interface ModelSubstitution {
  from: string;
  to: string;
  reason?: string;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retries?: number;
  rateLimits?: {
    requestsPerSecond: number;
    requestsPerMinute: number;
    requestsPerHour: number;
  };
  headers?: Record<string, string>;
}

export interface TimeoutConfig {
  request: number;
  response: number;
  idle: number;
  keepAlive: number;
}

export interface ModelHooks {
  beforeRequest?: string[];
  afterResponse?: string[];
  onError?: string[];
}

export interface ModelListChange {
  type: 'added' | 'removed' | 'modified';
  modelId: string;
  timestamp: string;
  details?: any;
}

export interface ModelListChanges {
  changes: ModelListChange[];
  lastChecked: string;
  nextCheck: string;
}

export interface ApiConfig {
  version: string;
  name: string;
  description: string;
  baseUrl: string;
  providers: ProviderConfig[];
  models: {
    substitutions: ModelSubstitution[];
    hooks: Record<string, ModelHooks>;
    cache: {
      ttl: number;
      maxSize: number;
    };
  };
  security: {
    apiKeys: {
      required: boolean;
      headerName: string;
      queryParamName?: string;
    };
    cors: {
      enabled: boolean;
      origins: string[];
      methods: string[];
      headers: string[];
    };
    rateLimiting: {
      enabled: boolean;
      windowMs: number;
      maxRequests: number;
      skipSuccessfulRequests: boolean;
    };
  };
  logging: LoggingConfig;
  timeouts: TimeoutConfig;
  plugins: {
    enabled: boolean;
    directory: string;
    rules: PluginRule[];
  };
}

export interface PluginRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  conditions: {
    method?: string[];
    path?: string[];
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
  };
  actions: {
    type: 'modify' | 'block' | 'log' | 'redirect';
    config: any;
  };
}

export interface ServiceConfig {
  serviceName: string;
  version: string;
  deployTarget: DeployTarget;
  server: {
    host: string;
    port: number;
    maxRequestSize: string;
    timeout: number;
  };
  database?: DatabaseConfig;
  cache?: {
    type: 'memory' | 'redis';
    host?: string;
    port?: number;
    ttl: number;
  };
  monitoring?: {
    enabled: boolean;
    metricsEndpoint: string;
    healthEndpoint: string;
  };
}