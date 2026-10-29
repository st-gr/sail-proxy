---
title: Plugin system
description: "Write, load and test gateway plugins: hooks, strategies, matchers and utilities."
---

# Plugin System Development

The SAIL-PROXY gateway loads plugin modules that intercept and modify requests and responses. **All matching logic lives in the gateway configuration (`api_config.json`)**: a plugin only declares what it does, the configuration decides when it runs. This page covers writing, configuring, testing and shipping a plugin.

## Overview

The plugin system supports intercepting requests at multiple points in the processing pipeline:

- **`before`**: Execute before making the upstream request (can short-circuit)
- **`after`**: Execute after receiving the upstream response (can modify response)
- **`stream`**: Execute on each chunk of streaming responses (can modify chunks)
- **`error`**: accepted by the loader and registered, but not executed: `pluginExecutor.ts` runs only `before`, `after` and `stream` rules (see [Error strategy](#error-strategy))

## Supported Endpoints

Each route looks up its hooks with `configService.getHookConfig(model, subpath, endpoint)`. The endpoint key and the subpath name the hook list:

| Endpoint key   | Route                                  | Subpath values                                                          |
|----------------|----------------------------------------|-------------------------------------------------------------------------|
| `aws-bedrock`  | Bedrock-compatible route               | `invoke`, `invoke-with-response-stream`, `converse`, `converse-stream`  |
| `anthropic`    | Anthropic Messages                     | `invoke`, `invoke-with-response-stream`                                 |
| `openai`       | OpenAI Chat Completions                | `invoke`, `invoke-with-response-stream`                                 |
| `openai`       | OpenAI Responses                       | `responses`, `responses-stream`                                         |
| `google`       | Gemini                                 | `generateContent`, `streamGenerateContent`, `embedContent`              |

The routes themselves are listed in [API endpoints](/reference/api-endpoints).

## Plugin Architecture

### Plugin Flow Diagram

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

### Core Implementation Files

**Plugin System Components:**
- **Plugin Loader** (`services/gateway/src/services/pluginLoader.ts`): loads the plugin files, keeps the rule registry and evaluates the match rules
- **Plugin Executor** (`services/gateway/src/services/pluginExecutor.ts`): runs the `before`, `after` and `stream` rules a matching hook names
- **Plugin Directory** (`services/gateway/src/plugins/`): the plugin implementations

The loader reads the `plugins` directory next to its own module (`DEFAULT_PLUGINS_DIR`, resolved from `__dirname`, never from the working directory), so the same code finds `src/plugins/*.ts` in local development, the compiled `.js` files in the Docker image and the bundled plugins in the npm package. Only files directly in that directory are loaded; subdirectories such as `pseudonymization/` hold helper modules that a top-level plugin file imports. In development a `.ts` file wins over a `.js` file of the same name and is loaded through `ts-node` (transpile-only); `.d.ts` and `.js.map` files are skipped. The registry is rebuilt at start and every time a configuration change is applied, which also clears the require cache of the plugin modules.

**Example Plugins:**
- `awsBedrockResponseCache.ts` - Shows caching implementation
- `removeEmptyAssistantMessages.ts` - Request preprocessing example
- `stripCacheControlScope.ts` - Claude Code compatibility fix (strips unsupported cache_control fields)
- `repairToolBlocks.ts` - Repairs compressed tool_use/tool_result blocks missing required fields (id, name, tool_use_id)
- `resizeOversizedImages.ts` - Resizes images exceeding per-model dimension limits in multi-image requests
- `pseudonymization/` - Detects and masks PII/secrets in outbound requests and unmasks them in responses; activation and per-category masking are configurable in `api_config.json`. Precision is tuned with four optional keys in the same block: `min_confidence` and `thresholds` (how much evidence a value needs before it is masked, globally and per category), `allowlist` (`terms`, case-sensitive literals, and `patterns`, regex sources the gateway anchors to the whole value — a listed value is exempt no matter what the score says), and `saturation_warn` (report-only: above that many distinct masked values the request logs one warning and the usage SIEM event carries `saturated: true`, but every value is still masked). See [`services/gateway/src/plugins/pseudonymization.md`](https://github.com/st-gr/sail-proxy/blob/main/services/gateway/src/plugins/pseudonymization.md) for activation methods and category toggles, and its "Tuning pseudonymization precision" section for what raising each key costs, how to read the saturation report, and how to re-baseline with the `services/gateway/test/pseudonymization-precision/` harness (the CI regression gate for every detector change).

## Creating a Plugin

### 1. Basic Plugin Structure

Create a JavaScript or TypeScript file directly in `services/gateway/src/plugins/`. The module must export an **array** of rules; each rule needs a string `id`, a `match` array (keep it empty: matching is configured in `api_config.json`), a `strategy` and a `handler` function. A rule that fails this check is logged and dropped, and a module that does not export an array is skipped.

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
    error: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    info: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
    trace: (message: string, meta?: any) => void;
  };
  // Present for 'before' and 'after' rules only; 'stream' rules get the logger alone
  sseWriter?: (res: Response, events: SSEEvent | SSEEvent[]) => Promise<void>;
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

Configure your plugin in `api_config.json`. A hook fires when **every** rule id in `request.match` matches; `request.callback.id` names the plugin whose rule for the current phase then runs:

```json
{
  "api_config": {
    "hooks": {
      "definitions": {
        "size:min10kb": {
          "type": "header",
          "name": "content-length",
          "from": 10240,
          "to": 999999999
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
      }
    },
    "models": {
      "overrides": {
        "anthropic--claude-4.5-haiku--deployed": {
          "hooks": {
            "invoke-with-response-stream": [
              {
                "request": {
                  "match": [
                    "size:min10kb",
                    "header:x-app=cli"
                  ],
                  "callback": {
                    "id": "myUniquePluginId"
                  }
                }
              }
            ]
          }
        }
      }
    }
  }
}
```

Hooks can be set per model (`models.overrides.<model>.hooks.<subpath>`) or per endpoint (`hooks.defaults.<endpoint>.<subpath>`). The endpoint default is consulted only when the model has no hook list for that subpath; a per-model list replaces the default rather than merging with it. The hooks in one list are tried in order: `before` rules until one returns `stop: true`, `after` and `stream` rules chained, each receiving the previous result. Every key is described in the [Gateway configuration reference](/reference/configuration).

### 3. Hook Definition Types

The `hooks.definitions` section supports various matching criteria:

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
"tools:hasFileSearch": {
  "type": "json-path-regex",
  "path": "$.tools",
  "regex": "file_search",
  "desc": "Match requests containing a file_search tool"
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

#### Matcher semantics: `equals` and `regex`

The `equals` and `regex` keys are compared differently depending on the rule `type`. The schema
also constrains which keys a given type accepts, so a key that a type never reads is rejected at
validation time rather than sitting inert in the config.

**`equals`** — the value the addressed thing must equal:

- **`header`** rule — compared on **media type**, not by strict equality: everything before the
  first `;` is trimmed and lowercased, so `"application/json"` matches a request sending
  `Content-Type: application/json; charset=utf-8`. This is deliberate: the strict comparison it
  replaced silently excluded charset-appending clients (OkHttp, .NET `JsonContent`, older axios),
  which for `header:contentTypeJson` meant those requests **bypassed pseudonymization on every
  endpoint**. An expected value that itself contains a `;` restores exact matching, so a rule can
  still pin a specific charset when it means to.
- **`json-path`** rule — **strict** equality (`===`) against the value the path resolves to in the
  request body, so `512` (number) and `"512"` (string) are different rules.
- **Omitted** — a `header` rule falls through to a `from`/`to` numeric-range check (only when both
  bounds are set) and finally to a bare presence check (the header exists with any value); a
  `json-path` rule matches when the path resolves to anything at all.
- **Rejected** on `json-path-regex` and `url-regex` — those match by regular expression and never
  read `equals`, so the schema forbids the key on them (`not: { required: ["equals"] }`).

**`regex`** — a JavaScript regular-expression **source** string (paired with optional `flags`):

- **`json-path-regex`** rule — tested against whatever the path resolved to: a **string** directly;
  an **array** element by element, a string element directly and an object element in its
  `JSON.stringify` form, matching if **any** element matches (other elements are skipped); **any
  other object** against its `JSON.stringify` form.
- **`url-regex`** rule — tested against `req.url`, i.e. the request **path and query string** as the
  gateway sees them, **not** an absolute URL. An expression anchored with `^https?://` can therefore
  never match.
- Each expression is compiled once and cached per rule id, source and flags. An expression the
  regex engine rejects is caught and treated as **no match** (never a crash).
- An **empty** source is rejected by the schema (`minLength: 1`); write a real expression.

## Plugin Strategies

### Before Strategy

Executes before the upstream LLM call. Returning `{ stop: true }` short-circuits the request: the route returns without calling upstream, so the plugin must already have written the response to `res` (for example with `utils.sseWriter`). Only the Gemini route additionally sends a `response` value the plugin returns; the other routes ignore it.

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

Executes after the upstream LLM call. The value it returns replaces the response (returning `undefined` is logged as an error and the previous response is kept):

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

Executes on each streaming chunk. Return the chunk, or `{ chunk, capturedEvents }`: captured events are appended to `req.capturedEvents` for the service to consume. A stream rule's `utils` carries the logger only:

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

The loader accepts and registers rules with `strategy: "error"` (the shipped `awsBedrockResponseCache` plugin declares one to clean up after a failed request), but `pluginExecutor.ts` exports no executor for them and no route calls one: an `error` rule is never invoked. Do not rely on it for cleanup or error transformation.

## Advanced Plugin Patterns

### Multiple Plugin Rules with Same ID

You can define multiple plugin rules with the same ID but different strategies; for each strategy the executor uses the first rule registered under the ID:

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
      // Registered, but never invoked (see Error Strategy)
    }
  }
];
```

### Plugin Utilities

#### SSE Writer

`before` and `after` rules receive `utils.sseWriter`, which writes one event or an array of events as Server-Sent Events. Called from a `before` rule it also ends the response:

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

Gateway tests live in `services/gateway/test/` (Jest, `*.test.ts`); the existing `plugin-loader-*.test.ts` suites show how to mock `@libs/logger`:

```typescript
// services/gateway/test/myPlugin.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import pluginRules from '../../src/plugins/myPlugin';

describe('MyPlugin', () => {
  it('should handle before strategy correctly', async () => {
    const mockUtils = {
      logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        trace: jest.fn()
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
  -H "x-api-key: sk-demo-your-test-key" \
  -H "x-app: cli" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 512
  }'
```

### 3. Debugging Plugins

A plugin's `utils.logger` logs under the plugin's rule id as the component, so one plugin can be made verbose without the rest of the gateway: set `platform.logging.components.<ruleId>` to `debug` in the configuration, or raise everything with `LOG_LEVEL=debug`. How the levels combine is described in [Debugging and troubleshooting (developer)](/developer/debugging#log-level-resolution).

```bash
LOG_LEVEL=debug pnpm run dev
```

The executor itself logs under `PluginExecutor` (which rule ran, short-circuits, handler errors) and the loader under `PluginLoader` (files loaded, rules registered, rule ids missing from `hooks.definitions`).

## Plugin Deployment

### 1. Development Deployment

For local development:
1. Place the plugin file in `services/gateway/src/plugins/`
2. Add the hook to the configuration (`api_config.json`, or the cockpit's [Gateway configuration](/guide/cockpit/configuration))
3. Restart the gateway, or let `nodemon` restart it on the file change; a configuration change alone reloads the plugin modules

### 2. Production Deployment

Plugins are part of the gateway build: the loader only reads the shipped `plugins` directory, so a new or changed plugin reaches a deployment with a new Docker image or npm package. Which hooks call it is configuration: activate the configuration in the cockpit, and the gateway reloads its plugins when it applies the change.

## Example: Complete Caching Plugin

A complete example implementing response caching. The gateway's own cache plugin, `awsBedrockResponseCache.ts`, caches in memory; this example uses an in-process `Map` as well and writes the cached JSON itself, because a short-circuiting `before` rule must answer the request on its own:

```typescript
// services/gateway/src/plugins/responseCache.ts
import { Request, Response } from 'express';

const cache = new Map<string, string>();

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
    const cached = cache.get(cacheKey);
    
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
      
      cache.set(req.cacheKey, JSON.stringify(cacheData));
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

1. **Plugin not loading**: the file must sit directly in the plugins directory and export an array; the `PluginLoader` log names every file it loads and every rule it rejects
2. **Hook never fires**: every rule id in `request.match` must exist in `hooks.definitions` (a missing id logs a warning and the hook matches nothing), and `callback.id` must name a rule registered for the phase
3. **Handler errors**: the executor logs the error and continues with the next hook; the request is not failed by a throwing plugin
4. **Performance issues**: profile plugin execution time
