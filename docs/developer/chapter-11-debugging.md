---
title: SAIL-PROXY Developer Guide - Chapter 11
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-10-security.md) | [Content Table](README.md) | [Next Chapter >>](chapter-12-ui5-app-development.md)

---

## Debugging & Troubleshooting

### Development Debugging

#### Debug Configuration

**Environment Setup**:
```bash
# Enable debug logging
export DEBUG=sail-proxy:*
export LOG_LEVEL=debug
export NODE_ENV=development

# Start with debugging
pnpm run dev:gateway
pnpm run dev:admin
```

**Debug Namespaces**:
```typescript
// Use specific debug namespaces
import debug from 'debug';

const debugAuth = debug('sail-proxy:auth');
const debugAPI = debug('sail-proxy:api');
const debugDB = debug('sail-proxy:database');
const debugCache = debug('sail-proxy:cache');
const debugSAP = debug('sail-proxy:sap-ai-core');

// Usage in code
debugAuth('Validating API key: %s', apiKey.substring(0, 10) + '...');
debugAPI('Processing request to %s %s', req.method, req.path);
debugDB('Database query: %s', query);
```

#### VS Code Debugging

**Launch Configuration** (`.vscode/launch.json`):
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Gateway Service",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/services/gateway/src/index.ts",
      "env": {
        "NODE_ENV": "development",
        "DEBUG": "sail-proxy:*",
        "LOG_LEVEL": "debug"
      },
      "runtimeArgs": ["--loader", "tsx/esm"],
      "skipFiles": ["<node_internals>/**"],
      "console": "integratedTerminal",
      "restart": true,
      "sourceMaps": true
    },
    {
      "name": "Debug Admin Service",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/services/admin/server.js",
      "env": {
        "NODE_ENV": "development",
        "DEBUG": "cds:*"
      },
      "console": "integratedTerminal"
    },
    {
      "name": "Debug Tests",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/node_modules/.bin/jest",
      "args": ["--runInBand", "--no-cache", "--testTimeout=30000"],
      "cwd": "${workspaceFolder}/services/gateway",
      "console": "integratedTerminal",
      "env": {
        "NODE_ENV": "test"
      }
    }
  ]
}
```

#### Breakpoint Debugging

**Strategic Breakpoint Placement**:
```typescript
// Authentication middleware
export const authenticationMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);
  
  // BREAKPOINT: Check token extraction
  debugger; // <- Set breakpoint here
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const validation = await validateToken(token);
    
    // BREAKPOINT: Check validation result
    debugger; // <- Set breakpoint here
    
    if (!validation.valid) {
      return res.status(401).json({ error: validation.error });
    }
    
    req.user = validation.user;
    req.apiKey = validation.apiKey;
    next();
  } catch (error) {
    // BREAKPOINT: Check error details
    debugger; // <- Set breakpoint here
    
    logger.error('Authentication error', { error: error.message, token: token.substring(0, 10) });
    return res.status(500).json({ error: 'Internal authentication error' });
  }
};
```

### Logging and Observability

#### Structured Logging

**Logger Configuration**:
```typescript
// services/gateway/src/utils/logger.ts
import winston from 'winston';
import { ElasticsearchTransport } from 'winston-elasticsearch';

const logLevel = process.env.LOG_LEVEL || 'info';
const nodeEnv = process.env.NODE_ENV || 'development';

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'sail-proxy-gateway',
    environment: nodeEnv
  },
  transports: [
    new winston.transports.Console({
      format: nodeEnv === 'development' 
        ? winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        : winston.format.json()
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'logs/combined.log'
    })
  ]
});

// Add Elasticsearch transport for production
if (nodeEnv === 'production' && process.env.ELASTICSEARCH_URL) {
  logger.add(new ElasticsearchTransport({
    level: 'info',
    clientOpts: {
      node: process.env.ELASTICSEARCH_URL
    },
    index: 'sail-proxy-logs'
  }));
}

export { logger };
```

**Contextual Logging**:
```typescript
// Request correlation middleware
export const correlationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  req.correlationId = req.headers['x-correlation-id'] as string || crypto.randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  
  // Create child logger with correlation context
  req.logger = logger.child({
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  
  next();
};

// Usage in route handlers
app.post('/openai/v1/chat/completions', async (req: AuthenticatedRequest, res: Response) => {
  req.logger.info('Processing chat completion request', {
    userId: req.user.id,
    model: req.body.model,
    messageCount: req.body.messages.length
  });
  
  try {
    const result = await processRequest(req.body);
    
    req.logger.info('Request completed successfully', {
      tokensUsed: result.usage.total_tokens,
      responseTime: Date.now() - req.startTime
    });
    
    res.json(result);
  } catch (error) {
    req.logger.error('Request failed', {
      error: error.message,
      stack: error.stack,
      requestBody: sanitizeRequestBody(req.body)
    });
    
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

#### Performance Monitoring

**Request Timing Middleware**:
```typescript
export const timingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const startTime = process.hrtime.bigint();
  req.startTime = Date.now();
  
  // Track timing for different phases
  const timings: Record<string, number> = {};
  
  req.markTiming = (phase: string) => {
    const now = process.hrtime.bigint();
    timings[phase] = Number(now - startTime) / 1000000; // Convert to milliseconds
  };
  
  res.on('finish', () => {
    const totalTime = Date.now() - req.startTime;
    
    req.logger?.info('Request timing', {
      totalTime,
      phases: timings,
      statusCode: res.statusCode
    });
    
    // Send metrics to monitoring system
    if (process.env.PROMETHEUS_ENABLED) {
      prometheusMetrics.httpDuration
        .labels(req.method, req.route?.path || req.path, res.statusCode.toString())
        .observe(totalTime / 1000);
    }
  });
  
  next();
};
```

### Database Debugging

#### Query Logging

**PostgreSQL Query Debugging**:
```typescript
// Database connection with query logging
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Enable query logging in development
  log: process.env.NODE_ENV === 'development' ? (msg) => {
    logger.debug('PostgreSQL:', msg);
  } : undefined
});

// Query wrapper with timing
export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now();
  const client = await pool.connect();
  
  try {
    logger.debug('Executing query', {
      query: text,
      params: params?.map(p => typeof p === 'string' && p.length > 100 ? p.substring(0, 100) + '...' : p)
    });
    
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    
    logger.debug('Query completed', {
      duration,
      rowCount: result.rowCount
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error('Query failed', {
      error: error.message,
      query: text,
      params,
      duration
    });
    throw error;
  } finally {
    client.release();
  }
}
```

#### CAP Service Debugging

**CAP Debug Configuration**:
```javascript
// services/admin/server.js - Enhanced debugging
const cds = require('@sap/cds');

// Enable CDS debugging
if (process.env.NODE_ENV === 'development') {
  cds.env.log.levels = {
    'cds': 'debug',
    'db': 'debug',
    'http': 'debug',
    'odata': 'debug'
  };
}

// Custom logging for CAP events
cds.on('listening', ({ server, url }) => {
  console.log(`🚀 CAP server listening on ${url}`);
  console.log('🔍 Debug endpoints:');
  console.log('  - OData metadata: ${url}/$metadata');
  console.log('  - Health check: ${url}/health');
});

// Log all incoming requests in development
if (process.env.NODE_ENV === 'development') {
  cds.on('request', (req) => {
    console.log(`📨 ${req.method} ${req.path}`, {
      query: req.query,
      user: req.user?.id
    });
  });
}
```

### SAP AI Core Integration Debugging

#### OAuth2 Token Debugging

```typescript
export class SAPAICoreClient {
  private async refreshToken(): Promise<string> {
    const tokenRequest = {
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret
    };
    
    logger.debug('Requesting SAP AI Core token', {
      oauthUrl: this.oauthUrl,
      clientId: this.clientId
      // Never log client_secret
    });
    
    try {
      const response = await fetch(this.oauthUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(tokenRequest)
      });
      
      const tokenData = await response.json();
      
      if (!response.ok) {
        logger.error('OAuth2 token request failed', {
          status: response.status,
          statusText: response.statusText,
          error: tokenData
        });
        throw new Error(`Token request failed: ${response.statusText}`);
      }
      
      logger.debug('OAuth2 token received', {
        tokenType: tokenData.token_type,
        expiresIn: tokenData.expires_in,
        // Log token prefix for debugging but not full token
        tokenPrefix: tokenData.access_token?.substring(0, 20) + '...'
      });
      
      return tokenData.access_token;
    } catch (error) {
      logger.error('OAuth2 token request error', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
}
```

#### Request/Response Debugging

```typescript
export class RequestResponseLogger {
  static logRequest(req: any, correlationId: string): void {
    logger.debug('SAP AI Core request', {
      correlationId,
      method: 'POST',
      url: '/inference/api/v1/completions',
      headers: this.sanitizeHeaders(req.headers),
      bodySize: JSON.stringify(req.body).length,
      model: req.body.orchestration_config?.model_name
    });
  }
  
  static logResponse(res: any, correlationId: string, startTime: number): void {
    const duration = Date.now() - startTime;
    
    logger.debug('SAP AI Core response', {
      correlationId,
      status: res.status,
      duration,
      responseSize: JSON.stringify(res.body).length,
      tokensUsed: res.body.usage?.total_tokens
    });
  }
  
  static logError(error: any, correlationId: string): void {
    logger.error('SAP AI Core error', {
      correlationId,
      error: error.message,
      status: error.status,
      code: error.code,
      details: error.details
    });
  }
  
  private static sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized = { ...headers };
    
    // Remove sensitive headers
    delete sanitized.authorization;
    delete sanitized.cookie;
    
    // Truncate large headers
    Object.keys(sanitized).forEach(key => {
      if (typeof sanitized[key] === 'string' && sanitized[key].length > 200) {
        sanitized[key] = sanitized[key].substring(0, 200) + '...';
      }
    });
    
    return sanitized;
  }
}
```

### Common Issues and Solutions

#### Port Conflicts

**Issue**: `Error: listen EADDRINUSE :::3000`

**Debugging**:
```bash
# Find what's using the port
sudo lsof -i :3000

# Kill the process
sudo kill -9 $(sudo lsof -t -iTCP:3000 -sTCP:LISTEN)

# Or kill all Node.js processes (use with caution)
pkill -f node
```

**Prevention**:
```typescript
// Graceful shutdown handling
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
```

#### Memory Leaks

**Detection**:
```typescript
// Memory monitoring
setInterval(() => {
  const usage = process.memoryUsage();
  logger.debug('Memory usage', {
    rss: Math.round(usage.rss / 1024 / 1024) + 'MB',
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB',
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
    external: Math.round(usage.external / 1024 / 1024) + 'MB'
  });
}, 30000); // Every 30 seconds

// Heap dump on high memory usage
const v8 = require('v8');
const fs = require('fs');

function checkMemoryUsage(): void {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  
  if (heapUsedMB > 512) { // Alert if heap usage exceeds 512MB
    logger.warn('High memory usage detected', {
      heapUsedMB: Math.round(heapUsedMB),
      timestamp: new Date().toISOString()
    });
    
    // Generate heap dump for analysis
    if (process.env.NODE_ENV === 'development') {
      const heapSnapshot = v8.getHeapSnapshot();
      const fileName = `heap-dump-${Date.now()}.heapsnapshot`;
      const fileStream = fs.createWriteStream(fileName);
      heapSnapshot.pipe(fileStream);
      logger.info(`Heap dump saved to ${fileName}`);
    }
  }
}
```

#### Connection Issues

**Database Connection Debugging**:
```typescript
// Connection health check
export class DatabaseHealthChecker {
  static async checkConnection(): Promise<HealthStatus> {
    try {
      const result = await query('SELECT 1 as healthy', []);
      return {
        status: 'healthy',
        latency: 0, // Measure actual latency
        details: { rowCount: result.rowCount }
      };
    } catch (error) {
      logger.error('Database health check failed', { error: error.message });
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

// Redis connection debugging
export class RedisHealthChecker {
  static async checkConnection(redis: Redis): Promise<HealthStatus> {
    try {
      const start = Date.now();
      const result = await redis.ping();
      const latency = Date.now() - start;
      
      if (result === 'PONG') {
        return {
          status: 'healthy',
          latency,
          details: { response: result }
        };
      } else {
        return {
          status: 'unhealthy',
          error: `Unexpected ping response: ${result}`
        };
      }
    } catch (error) {
      logger.error('Redis health check failed', { error: error.message });
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}
```

### Production Debugging

#### Log Aggregation

**ELK Stack Configuration**:
```yaml
# docker-compose.override.prod.yml
version: '3.8'

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"
    volumes:
      - es_data:/usr/share/elasticsearch/data

  kibana:
    image: docker.elastic.co/kibana/kibana:8.11.0
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch

  logstash:
    image: docker.elastic.co/logstash/logstash:8.11.0
    volumes:
      - ./logstash/pipeline:/usr/share/logstash/pipeline
    ports:
      - "5044:5044"
    depends_on:
      - elasticsearch
```

#### Monitoring and Alerting

**Prometheus Metrics**:
```typescript
// Prometheus metrics setup
import prometheus from 'prom-client';

// Create metrics registry
const register = new prometheus.Register();

// HTTP request metrics
const httpDuration = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

// API key usage metrics
const apiKeyUsage = new prometheus.Counter({
  name: 'api_key_requests_total',
  help: 'Total number of requests per API key',
  labelNames: ['api_key_id', 'model', 'status']
});

// Token usage metrics
const tokenUsage = new prometheus.Counter({
  name: 'tokens_used_total',
  help: 'Total number of tokens consumed',
  labelNames: ['model', 'type'] // type: 'prompt' or 'completion'
});

register.registerMetric(httpDuration);
register.registerMetric(apiKeyUsage);
register.registerMetric(tokenUsage);

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

#### Error Tracking

**Sentry Integration**:
```typescript
import * as Sentry from '@sentry/node';

// Initialize Sentry
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  beforeSend(event) {
    // Filter out sensitive information
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    return event;
  }
});

// Error handling middleware
app.use(Sentry.Handlers.errorHandler());

// Custom error reporting
export function reportError(error: Error, context?: any): void {
  Sentry.withScope((scope) => {
    if (context) {
      scope.setContext('additional', context);
    }
    scope.setLevel('error');
    Sentry.captureException(error);
  });
}
```

---

*Next: Learn [UI5 Application Development](chapter-12-ui5-app-development.md) patterns including dual architecture requirements and integration best practices.*