// Main types export file
export * from './api';
export * from './auth';
export * from './providers';
export * from './config';

// Common utility types
export interface ServiceHealth {
  status: 'healthy' | 'unhealthy' | 'degraded';
  service: string;
  version: string;
  deployTarget: string;
  timestamp: string;
  uptime: number;
  dependencies?: {
    [key: string]: {
      status: 'healthy' | 'unhealthy';
      responseTime?: number;
      error?: string;
    };
  };
}

export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
  path: string;
  details?: any;
}

export interface RequestContext {
  requestId: string;
  timestamp: string;
  method: string;
  path: string;
  userAgent?: string;
  clientIp?: string;
  apiKey?: string;
  service: string;
}

export interface LogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
  component: string;
  timestamp: string;
  requestId?: string;
  metadata?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface ServiceMetrics {
  requests: {
    total: number;
    successful: number;
    failed: number;
    averageResponseTime: number;
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  uptime: number;
  errors: {
    total: number;
    byType: Record<string, number>;
  };
}