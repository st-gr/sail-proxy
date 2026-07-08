---
title: SAIL-PROXY Developer Guide - Chapter 13
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-12-ui5-app-development.md) | [Content Table](README.md)

---

## Plugin System Development

The SAIL-PROXY gateway includes a sophisticated plugin system that allows developers to intercept and modify requests and responses dynamically. This chapter provides comprehensive guidance for developing, testing, and deploying custom plugins.

### Overview

The plugin system supports intercepting requests at multiple points in the processing pipeline:

- **`before`**: Execute before making the upstream request (can short-circuit)
- **`after`**: Execute after receiving the upstream response (can modify response)
- **`stream`**: Execute on each chunk of streaming responses (can modify chunks)
- **`error`**: Execute when an error occurs during request processing (can customize error handling)

### Supported Providers

The plugin system supports all major provider endpoints:

| Provider      | Endpoint Path                     | Subpath Values                                                    |
|--------------|-----------------------------------|-------------------------------------------------------------------|
| AWS Bedrock  | `/aws-bedrock/model/{modelId}`    | `invoke`, `invoke-with-response-stream`, `converse`, `converse-stream` |
| Anthropic    | `/anthropic`                      | `invoke`, `invoke-with-response-stream` (streaming)               |  
| OpenAI       | `/openai`                         | `invoke` (chat completions)                                       |

### Plugin Architecture

#### Plugin Flow Diagram

```
     ┌─────────────┐    ┌───────────────┐    ┌─────────────┐    ┌───────────────┐
     │  Request    │    │ Before Plugin │    │   LLM API   │    │ After Plugin  │
     │             │───►│  (optional)   │───►│   Request   │───►│  (optional)   │
     └─────────────┘    └───────────────┘    └─────────────┘    └───────────────┘
                               │                      │                 │
                               │                      │                 │
                               ▼                      ▼                 │
                        ┌─────────────┐        ┌─────────────┐          │
                        │Short-Circuit│        │   Stream    │          │
                        │  Response   │        │   Plugin    │          │
                        └─────────────┘        │(per chunk)  │          │
                               ▲               └─────────────┘          │
                               │                      │                 │
                               │                      │                 ▼
     ┌─────────────┐    ┌─────────────────┐           │       ┌─────────────────┐
     │  Response   │◄───│   Unmodified    │◄──────────┘       │    Modified     │
     │  to Client  │    │    Response     │◄──────────────────│    Response     │
     └─────────────┘    └─────────────────┘                   └─────────────────┘
```

#### Core Implementation Files

**Plugin System Components:**
- **Plugin Loader** (`services/gateway/src/services/pluginLoader.ts`): Discovers and loads plugins from the filesystem
- **Plugin Executor** (`services/gateway/src/services/pluginExecutor.ts`): Executes plugin hooks during request processing
- **Plugin Directory** (`services/gateway/src/plugins/`): Contains plugin implementations

**Example Plugins:**
- `mockWhimsicalGerundVerb.ts` - Demonstrates before/after strategies
- `awsBedrockResponseCache.ts` - Shows caching implementation
- `removeEmptyAssistantMessages.ts` - Request preprocessing example
- `stripCacheControlScope.ts` - Claude Code compatibility fix (strips unsupported cache_control fields)
- `repairToolBlocks.ts` - Repairs compressed tool_use/tool_result blocks missing required fields (id, name, tool_use_id)
- `resizeOversizedImages.ts` - Resizes images exceeding per-model dimension limits in multi-image requests
- `pseudonymization/` - Detects and masks PII/secrets in outbound requests and unmasks them in responses; activation and per-category masking are configurable in `api_config.json`. See [`services/gateway/src/plugins/pseudonymization.md`](../../services/gateway/src/plugins/pseudonymization.md) for activation methods and category toggles.

## Creating a Plugin

### 1. Basic Plugin Structure

Create a JavaScript/TypeScript file in the `services/gateway/src/plugins/` directory:

```javascript
// services/gateway/src/plugins/myPlugin.ts
import { Request, Response } from 'express';

interface PluginHandlerParams {
  req: Request;
  res: Response;
  utils: PluginUtils;
  upstreamResponse?: any;
  chunk?: Buffer;
}

interface PluginUtils {
  logger: {
    info: (message: string) => void;
    debug: (message: string) => void;
    error: (message: string) => void;
  };
  sseWriter: (res: Response, events: SSEEvent[]) => Promise<void>;
}

interface SSEEvent {
  event: string;
  data: any;
}

interface PluginRule {
  id: string;
  match: string[];  // MUST be empty - matching in api_config.json
  strategy: 'before' | 'after' | 'stream' | 'error';
  handler: (params: PluginHandlerParams) => Promise<any>;
}

const pluginRules: PluginRule[] = [
  {
    id: "myUniquePluginId",
    match: [],  // Match rules moved to api_config.json
    strategy: "before",
    handler: async ({ req, res, utils }) => {
      utils.logger.info('Plugin executing');
      // Plugin logic here
      return { stop: false };  // Continue to upstream
    }
  }
];

export = pluginRules;
```

### 2. Plugin Configuration

Configure your plugin in `api_config.json`:

```json
{
  "hookDefinitions": {
    "size:1k-3k": {
      "type": "header",
      "name": "content-length",
      "from": 1024,
      "to": 3072
    },
    "header:x-app=cli": {
      "type": "header",
      "name": "x-app",
      "equals": "cli"
    },
    "anthropic:all": {
      "type": "url-regex",
      "regex": "anthropic",
      "flags": "i",
      "desc": "Match any URL containing 'anthropic'"
    }
  },
  "model_list_changes": {
    "anthropic--claude-3-haiku--deployed": {
      "hooks": {
        "invoke-with-response-stream": [
          {
            "request": {
              "match": ["size:1k-3k", "header:x-app=cli"],
              "callback": { 
                "id": "myUniquePluginId", 
                "strategy": "before" 
              }
            }
          }
        ]
      }
    }
  }
}
```

### 3. Hook Definition Types

The `hookDefinitions` section supports various matching criteria:

#### Content Length Range
```json
"size:min10kb": {
  "type": "header",
  "name": "content-length",
  "from": 10240,
  "to": 999999999,
  "desc": "Cache requests with content-length >= 10 KB"
}
```

#### Header Value Matching
```json
"header:x-app=cli": {
  "type": "header",
  "name": "x-app",
  "equals": "cli"
}
```

#### JSON Path Matching
```json
"payload:maxTokens512": {
  "type": "json-path",
  "path": "$.max_tokens",
  "equals": 512
}
```

#### JSON Path Regex Matching
```json
"system:whimsicalPrompt": {
  "type": "json-path-regex",
  "path": "$.system.0.text",
  "regex": "^Analyze\\s+this\\s+message",
  "flags": "i"
}
```

#### URL Regex Matching
```json
"anthropic:all": {
  "type": "url-regex",
  "regex": "anthropic",
  "flags": "i",
  "desc": "Match any URL containing 'anthropic'"
}
```

## Plugin Strategies

### Before Strategy

Executes before the upstream LLM call. Can short-circuit the request:

```typescript
async function beforeHandler({ req, res, utils }: PluginHandlerParams): Promise<{stop: boolean, response?: any}> {
  // Example: Cache check
  const cacheKey = generateCacheKey(req);
  const cachedResponse = await cache.get(cacheKey);
  
  if (cachedResponse) {
    utils.logger.info('Serving from cache');
    
    // Send cached response directly
    await utils.sseWriter(res, cachedResponse.events);
    return { stop: true };  // Short-circuit
  }
  
  return { stop: false };  // Continue to upstream
}
```

### After Strategy

Executes after the upstream LLM call. Can modify the response:

```typescript
async function afterHandler({ req, res, upstreamResponse, utils }: PluginHandlerParams): Promise<any> {
  if (!upstreamResponse) {
    return { content: [] };
  }
  
  try {
    // Example: Add custom metadata
    if (upstreamResponse.content && Array.isArray(upstreamResponse.content)) {
      upstreamResponse.metadata = {
        processedAt: new Date().toISOString(),
        pluginVersion: '1.0.0'
      };
    }
    
    return upstreamResponse;
  } catch (error) {
    utils.logger.error(`Error in after handler: ${error}`);
    return upstreamResponse;
  }
}
```

### Stream Strategy

Executes on each streaming chunk:

```typescript
async function streamHandler({ chunk, utils }: PluginHandlerParams): Promise<{chunk: Buffer, capturedEvents?: any[]}> {
  try {
    // Example: Content filtering
    const chunkStr = chunk.toString();
    const filtered = chunkStr.replace(/badword/gi, '***');
    
    return { 
      chunk: Buffer.from(filtered),
      capturedEvents: [] // For caching plugins
    };
  } catch (error) {
    utils.logger.error(`Error in stream handler: ${error}`);
    return { chunk };
  }
}
```

### Error Strategy

Executes when an error occurs:

```typescript
async function errorHandler({ req, error, utils }: PluginHandlerParams): Promise<{stop: boolean, response?: any}> {
  utils.logger.error(`Handling error: ${error.message}`);
  
  // Example: Custom error response
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    return {
      stop: true,
      response: {
        error: {
          type: 'rate_limit_error',
          message: 'Please try again in a moment'
        }
      }
    };
  }
  
  return { stop: false };  // Use default error handling
}
```

## Advanced Plugin Patterns

### Multiple Plugin Rules with Same ID

You can define multiple plugin rules with the same ID but different strategies:

```javascript
module.exports = [
  {
    id: "awsBedrockResponseCache",
    match: [],
    strategy: "before",
    handler: async ({ req, res, utils }) => {
      // Check cache and return cached response if available
      // Return { stop: true } if serving from cache
    }
  },
  {
    id: "awsBedrockResponseCache", 
    match: [],
    strategy: "stream",
    handler: async ({ req, res, chunk, utils }) => {
      // Capture streaming data for caching
      // Return the chunk (possibly modified)
    }
  },
  {
    id: "awsBedrockResponseCache",
    match: [],
    strategy: "after", 
    handler: async ({ req, res, upstreamResponse, utils }) => {
      // Save captured data to cache
      // Return the response
    }
  },
  {
    id: "awsBedrockResponseCache",
    match: [],
    strategy: "error",
    handler: async ({ req, error, utils }) => {
      // Clean up on error
      // Return { stop: true } to prevent default error handling
    }
  }
];
```

### Plugin Utilities

#### SSE Writer

For streaming responses, use the `sseWriter` utility:

```javascript
await utils.sseWriter(res, [
  { 
    event: "message_start", 
    data: { 
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: "your-model-name"
      }
    }
  },
  { 
    event: "content_block_delta", 
    data: {
      index: 0,
      delta: {
        type: "text_delta",
        text: "Your response text"
      }
    }
  },
  { 
    event: "message_stop", 
    data: { type: "message_stop" }
  }
]);
```

## Plugin Development Best Practices

### 1. Error Handling

Always wrap plugin logic in try-catch blocks:

```typescript
async function safeHandler({ req, res, utils }: PluginHandlerParams) {
  try {
    // Plugin logic here
    return { stop: false };
  } catch (error) {
    utils.logger.error(`Plugin error: ${error.message}`);
    return { stop: false };  // Fail gracefully
  }
}
```

### 2. Performance Considerations

- Cache expensive operations
- Use async/await properly
- Avoid blocking the event loop
- Set reasonable timeouts

```typescript
async function performantHandler({ req, utils }: PluginHandlerParams) {
  const startTime = Date.now();
  
  try {
    // Set timeout for external calls
    const result = await Promise.race([
      expensiveOperation(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 5000)
      )
    ]);
    
    const duration = Date.now() - startTime;
    utils.logger.debug(`Plugin execution took ${duration}ms`);
    
    return { stop: false };
  } catch (error) {
    utils.logger.error(`Plugin failed: ${error.message}`);
    return { stop: false };
  }
}
```

### 3. Security Guidelines

- Validate all input data
- Sanitize content appropriately
- Never log sensitive information
- Use secure defaults

```typescript
function validateInput(data: any): boolean {
  // Implement appropriate validation
  if (!data || typeof data !== 'object') {
    return false;
  }
  
  // Check for malicious patterns
  const dangerousPatterns = ['<script', 'javascript:', 'data:'];
  const str = JSON.stringify(data);
  
  return !dangerousPatterns.some(pattern => 
    str.toLowerCase().includes(pattern)
  );
}
```

## Testing Plugins

### 1. Unit Testing

Create test files in `services/gateway/tests/plugins/`:

```typescript
// services/gateway/tests/plugins/myPlugin.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import pluginRules from '../../src/plugins/myPlugin';

describe('MyPlugin', () => {
  it('should handle before strategy correctly', async () => {
    const mockUtils = {
      logger: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn()
      },
      sseWriter: jest.fn()
    };

    const rule = pluginRules.find(r => r.strategy === 'before');
    const result = await rule.handler({
      req: {} as any,
      res: {} as any,
      utils: mockUtils
    });

    expect(result.stop).toBe(false);
    expect(mockUtils.logger.info).toHaveBeenCalled();
  });
});
```

### 2. Integration Testing

Test plugins with real requests:

```bash
# Start the gateway in development mode
pnpm run dev

# Test plugin with curl
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-test-key" \
  -H "x-app: cli" \
  -d '{
    "model": "claude-3-haiku",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 512
  }'
```

### 3. Debugging Plugins

Enable debug logging to troubleshoot plugins:

```bash
DEBUG=true pnpm run dev
```

Add debug statements in your plugin:

```typescript
async function debugHandler({ req, utils }: PluginHandlerParams) {
  utils.logger.debug('Plugin input:', {
    url: req.url,
    headers: req.headers,
    body: req.body
  });
  
  // Plugin logic...
  
  utils.logger.debug('Plugin output:', { result });
  return result;
}
```

## Plugin Deployment

### 1. Development Deployment

For local development:
1. Place plugin file in `services/gateway/src/plugins/`
2. Update `api_config.json` with hook configuration
3. Restart the gateway service

### 2. Production Deployment

For production environments:
1. Test thoroughly in development
2. Code review plugin implementation
3. Update configuration via admin API
4. Deploy with rolling restart strategy

### 3. Plugin Distribution

Consider creating reusable plugins as npm packages:

```json
{
  "name": "@yourorg/sail-proxy-plugin-cache",
  "version": "1.0.0",
  "main": "dist/index.js",
  "peerDependencies": {
    "@sail-proxy/gateway": "^1.0.0"
  }
}
```

## Example: Complete Caching Plugin

Here's a complete example implementing response caching:

```typescript
// services/gateway/src/plugins/responseCache.ts
import { Request, Response } from 'express';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

interface PluginHandlerParams {
  req: Request;
  res: Response;
  utils: any;
  upstreamResponse?: any;
  chunk?: Buffer;
}

// Before handler - check cache
async function checkCache({ req, res, utils }: PluginHandlerParams) {
  try {
    const cacheKey = `cache:${req.method}:${req.url}:${JSON.stringify(req.body)}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      utils.logger.info('Cache hit', { cacheKey });
      const response = JSON.parse(cached);
      
      if (response.streaming) {
        await utils.sseWriter(res, response.events);
      } else {
        res.json(response.data);
      }
      
      return { stop: true };
    }
    
    // Store cache key for later use
    req.cacheKey = cacheKey;
    return { stop: false };
    
  } catch (error) {
    utils.logger.error('Cache check failed', { error: error.message });
    return { stop: false };
  }
}

// After handler - store in cache
async function storeCache({ req, upstreamResponse, utils }: PluginHandlerParams) {
  try {
    if (req.cacheKey && upstreamResponse) {
      const cacheData = {
        data: upstreamResponse,
        streaming: false,
        cachedAt: new Date().toISOString()
      };
      
      // Cache for 1 hour
      await redis.setex(req.cacheKey, 3600, JSON.stringify(cacheData));
      utils.logger.info('Response cached', { cacheKey: req.cacheKey });
    }
    
    return upstreamResponse;
    
  } catch (error) {
    utils.logger.error('Cache store failed', { error: error.message });
    return upstreamResponse;
  }
}

const pluginRules = [
  {
    id: "responseCache",
    match: [],
    strategy: "before" as const,
    handler: checkCache
  },
  {
    id: "responseCache", 
    match: [],
    strategy: "after" as const,
    handler: storeCache
  }
];

export = pluginRules;
```

## Troubleshooting

### Common Issues

1. **Plugin not loading**: Check file path and export format
2. **Match conditions not working**: Verify `hookDefinitions` in `api_config.json`
3. **Handler errors**: Check error logs and add proper error handling
4. **Performance issues**: Profile plugin execution time

### Debug Commands

```bash
# Check loaded plugins
curl http://localhost:3000/api/debug/plugins

# View plugin execution logs
tail -f logs/gateway.log | grep Plugin

# Test specific hook definitions
curl -X POST http://localhost:3000/api/debug/hooks \
  -d '{"url": "/anthropic/v1/messages", "headers": {"x-app": "cli"}}'
```

---

*For more information on gateway architecture, see [Chapter 3: Gateway Service](chapter-3-gateway.md).*