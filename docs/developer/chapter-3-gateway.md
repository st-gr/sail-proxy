---
title: SAIL-PROXY Developer Guide - Chapter 3
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

[<< Previous Chapter](chapter-2-architecture.md) | [Content Table](README.md) | [Next Chapter >>](chapter-4-gateway-testing.md)

---

## Gateway Service

The Gateway service is the core component of SAIL-PROXY, responsible for API translation, authentication, request routing, and response processing. This chapter provides deep technical details on the Gateway implementation, configuration, and security features.

### Core Implementation

#### Entry Point and Server Setup

**Main Server** (`services/gateway/src/index.ts`):
```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authenticationMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { loggingMiddleware } from './middleware/logging.js';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

// Core middleware stack
app.use(express.json({ limit: '10mb' }));
app.use(loggingMiddleware);
app.use(authenticationMiddleware);
app.use(rateLimitMiddleware);

// API route handlers
app.use('/openai', openAIRoutes);
app.use('/anthropic', anthropicRoutes);
app.use('/aws-bedrock', bedrockRoutes);
app.use('/openrouter', openRouterRoutes);
app.use('/v1', unifiedRoutes);

const server = app.listen(process.env.PORT || 3000);
```

#### Request Processing Pipeline

**Middleware Stack Architecture**:
```typescript
interface MiddlewareContext {
  correlationId: string;
  user: AuthenticatedUser;
  apiKey: APIKey;
  permissions: Permission[];
  rateLimitInfo: RateLimitInfo;
  startTime: number;
}

// Logging middleware - tracks all requests
const loggingMiddleware = (req: Request, res: Response, next: NextFunction) => {
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.startTime = Date.now();
  
  logger.info('Request received', {
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });
  
  next();
};
```

### Authentication System

#### Token Validation and User Resolution

**Authentication Middleware** (`services/gateway/src/middleware/auth.ts`):
```typescript
interface AuthenticationResult {
  user: User;
  apiKey: APIKey;
  permissions: Permission[];
}

class AuthenticationService {
  async validateBearerToken(token: string): Promise<AuthenticationResult> {
    // Check token format
    if (!token.startsWith('sp-proj-')) {
      throw new AuthenticationError('Invalid token format');
    }
    
    // Query database for API key
    const apiKey = await this.apiKeyRepository.findByToken(token);
    if (!apiKey || apiKey.status !== 'active') {
      throw new AuthenticationError('Invalid or revoked API key');
    }
    
    // Check expiration
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
      throw new AuthenticationError('API key expired');
    }
    
    // Load user and permissions
    const user = await this.userRepository.findById(apiKey.userId);
    const permissions = await this.permissionService.getUserPermissions(user.id);
    
    return { user, apiKey, permissions };
  }
  
  async validateAWSSignature(req: Request): Promise<AuthenticationResult> {
    const signature = new AWSSignatureV4();
    const isValid = await signature.verify(req);
    
    if (!isValid) {
      throw new AuthenticationError('Invalid AWS signature');
    }
    
    // Extract AWS credentials and validate
    const awsCredentials = await this.awsCredentialRepository.findByAccessKey(
      signature.accessKeyId
    );
    
    return this.resolveAWSUser(awsCredentials);
  }
}
```

#### API Key Security Features

**Rate Limiting Implementation**:
```typescript
class RateLimitService {
  private redis: Redis;
  private algorithms = {
    'sliding-window': this.slidingWindowLimit.bind(this),
    'token-bucket': this.tokenBucketLimit.bind(this),
    'fixed-window': this.fixedWindowLimit.bind(this),
  };
  
  async checkRateLimit(apiKey: APIKey, endpoint: string): Promise<RateLimitResult> {
    const limits = this.parseRateLimits(apiKey.rateLimits);
    const algorithm = apiKey.rateLimitAlgorithm || 'sliding-window';
    
    for (const limit of limits) {
      const result = await this.algorithms[algorithm](apiKey.id, limit, endpoint);
      if (!result.allowed) {
        return {
          allowed: false,
          resetTime: result.resetTime,
          remaining: 0,
          limit: limit.requests
        };
      }
    }
    
    return { allowed: true, remaining: limits[0].requests, limit: limits[0].requests };
  }
  
  private async slidingWindowLimit(keyId: string, limit: RateLimit, endpoint: string): Promise<any> {
    const key = `rate_limit:${keyId}:${endpoint}:${limit.window}`;
    const now = Date.now();
    const windowStart = now - (limit.windowMs);
    
    // Remove expired entries and count current requests
    await this.redis.zremrangebyscore(key, '-inf', windowStart);
    const currentRequests = await this.redis.zcard(key);
    
    if (currentRequests >= limit.requests) {
      const oldestRequest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const resetTime = oldestRequest[1] + limit.windowMs;
      return { allowed: false, resetTime };
    }
    
    // Add current request
    await this.redis.zadd(key, now, `${now}-${crypto.randomUUID()}`);
    await this.redis.expire(key, Math.ceil(limit.windowMs / 1000));
    
    return { allowed: true };
  }
}
```

### API Translation Layer

#### OpenAI API Implementation

**OpenAI Route Handler** (`services/gateway/src/routes/openai.ts`):
```typescript
class OpenAITranslator {
  async translateChatCompletion(request: OpenAIRequest): Promise<SAPRequest> {
    const { model, messages, stream, tools, ...otherParams } = request;
    
    // Model substitution
    const sapModel = this.modelMappings[model] || model;
    
    // Message format translation
    const translatedMessages = messages.map(msg => ({
      role: this.translateRole(msg.role),
      content: this.translateContent(msg.content)
    }));
    
    // SAP AI Core orchestration request
    return {
      orchestration_config: {
        model_name: sapModel,
        model_params: {
          max_tokens: otherParams.max_tokens,
          temperature: otherParams.temperature,
          top_p: otherParams.top_p,
        },
        template_id: 'chat-completion'
      },
      input_params: {
        messages: translatedMessages,
        tools: tools ? this.translateTools(tools) : undefined
      }
    };
  }
  
  async translateResponse(sapResponse: SAPResponse, originalRequest: OpenAIRequest): Promise<OpenAIResponse> {
    const { choices, usage } = sapResponse;
    
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: originalRequest.model,
      choices: choices.map(choice => ({
        index: choice.index,
        message: {
          role: 'assistant',
          content: choice.message.content,
          tool_calls: choice.message.tool_calls ? 
            this.translateToolCalls(choice.message.tool_calls) : undefined
        },
        finish_reason: this.translateFinishReason(choice.finish_reason)
      })),
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    };
  }
}

// Route implementation
router.post('/v1/chat/completions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const translator = new OpenAITranslator();
    const sapRequest = await translator.translateChatCompletion(req.body);
    
    if (req.body.stream) {
      return await handleStreamingResponse(req, res, sapRequest);
    } else {
      return await handleBatchResponse(req, res, sapRequest);
    }
  } catch (error) {
    return handleAPIError(res, error);
  }
});
```

#### Anthropic API Implementation

**Anthropic Route Handler** (`services/gateway/src/routes/anthropic.ts`):
```typescript
class AnthropicTranslator {
  async translateMessages(request: AnthropicRequest): Promise<SAPRequest> {
    const { model, messages, max_tokens, tools, ...otherParams } = request;
    
    // Anthropic-specific message handling
    const processedMessages = this.processAnthropicMessages(messages);
    
    return {
      orchestration_config: {
        model_name: this.modelMappings[model] || model,
        model_params: {
          max_tokens,
          temperature: otherParams.temperature,
          top_p: otherParams.top_p,
          stop_sequences: otherParams.stop_sequences,
        }
      },
      input_params: {
        messages: processedMessages,
        tools: tools ? this.translateAnthropicTools(tools) : undefined,
        system: otherParams.system
      }
    };
  }
  
  private processAnthropicMessages(messages: AnthropicMessage[]): SAPMessage[] {
    // Handle Anthropic's unique message format
    return messages.map(msg => {
      if (Array.isArray(msg.content)) {
        // Multi-modal content (text + images)
        return {
          role: msg.role,
          content: msg.content.map(item => {
            if (item.type === 'image') {
              return {
                type: 'image_url',
                image_url: {
                  url: `data:${item.source.media_type};base64,${item.source.data}`
                }
              };
            }
            return item;
          })
        };
      }
      return msg;
    });
  }
}
```

#### AWS Bedrock Implementation

**Bedrock Route Handler** (`services/gateway/src/routes/bedrock.ts`):
```typescript
class BedrockTranslator {
  async translateInvokeRequest(request: BedrockInvokeRequest): Promise<SAPRequest> {
    const { modelId, body } = request;
    const parsedBody = JSON.parse(body);
    
    // Model-specific translation based on provider
    if (modelId.includes('anthropic')) {
      return this.translateAnthropicBedrock(parsedBody, modelId);
    } else if (modelId.includes('amazon')) {
      return this.translateTitanBedrock(parsedBody, modelId);
    } else if (modelId.includes('ai21')) {
      return this.translateJurassicBedrock(parsedBody, modelId);
    }
    
    throw new Error(`Unsupported Bedrock model: ${modelId}`);
  }
  
  private async translateAnthropicBedrock(body: any, modelId: string): Promise<SAPRequest> {
    // Anthropic Claude via Bedrock has specific format requirements
    return {
      orchestration_config: {
        model_name: this.mapBedrockModel(modelId),
        model_params: {
          max_tokens: body.max_tokens_to_sample || body.max_tokens,
          temperature: body.temperature,
          top_p: body.top_p,
          stop_sequences: body.stop_sequences,
        }
      },
      input_params: {
        prompt: body.prompt,
        messages: body.messages
      }
    };
  }
}

// AWS Signature V4 validation
router.use('/model/:modelId/*', async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader?.startsWith('AWS4-HMAC-SHA256')) {
    // Validate AWS SigV4 signature
    const signatureValidator = new AWSSignatureV4Validator();
    const isValid = await signatureValidator.validate(req);
    
    if (!isValid) {
      return res.status(403).json({ error: 'Invalid AWS signature' });
    }
    
    // Resolve AWS credentials to internal user
    req.awsCredentials = await resolveAWSCredentials(req);
  }
  
  next();
});
```

### Streaming Implementation

#### Server-Sent Events (SSE) Handling

**Streaming Response Manager**:
```typescript
class StreamingManager {
  async handleStreamingResponse(
    req: AuthenticatedRequest, 
    res: Response, 
    sapRequest: SAPRequest
  ): Promise<void> {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });
    
    const sapStream = await this.sapAICore.createStream(sapRequest);
    const translator = this.getTranslator(req.path);
    
    let buffer = '';
    let tokenCount = 0;
    
    sapStream.on('data', async (chunk: Buffer) => {
      try {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            const translatedChunk = await translator.translateStreamChunk(data);
            
            res.write(`data: ${JSON.stringify(translatedChunk)}\n\n`);
            tokenCount += this.countTokens(translatedChunk);
          }
        }
      } catch (error) {
        logger.error('Stream processing error', { error: error.message });
        res.write(`data: ${JSON.stringify({ error: 'Stream processing failed' })}\n\n`);
      }
    });
    
    sapStream.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      
      // Log usage after stream completion
      this.usageTracker.logUsage({
        userId: req.user.id,
        apiKeyId: req.apiKey.id,
        model: sapRequest.orchestration_config.model_name,
        tokensUsed: tokenCount,
        endpoint: req.path
      });
    });
    
    sapStream.on('error', (error) => {
      logger.error('SAP AI Core stream error', { error: error.message });
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.end();
    });
  }
}
```

#### Streaming Emulation

**Pseudo-Streaming for Batch Models**:
```typescript
class StreamingEmulator {
  async emulateStreaming(
    response: APIResponse, 
    res: Response, 
    chunkDelay: number = 50
  ): Promise<void> {
    const content = response.choices[0].message.content;
    const words = content.split(' ');
    
    let accumulatedContent = '';
    
    for (let i = 0; i < words.length; i++) {
      accumulatedContent += (i > 0 ? ' ' : '') + words[i];
      
      const chunk = {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [{
          index: 0,
          delta: {
            role: i === 0 ? 'assistant' : undefined,
            content: (i > 0 ? ' ' : '') + words[i]
          },
          finish_reason: i === words.length - 1 ? 'stop' : null
        }]
      };
      
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      
      if (i < words.length - 1) {
        await new Promise(resolve => setTimeout(resolve, chunkDelay));
      }
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
```

### Configuration Management

#### Dynamic Configuration Loading

**Configuration Service** (`services/gateway/src/config/ConfigService.ts`):
```typescript
interface GatewayConfiguration {
  modelMappings: Record<string, string>;
  rateLimits: RateLimitConfig;
  streamingEmulation: Record<string, boolean>;
  pluginConfig: PluginConfiguration;
  cacheConfig: CacheConfiguration;
}

class ConfigurationManager {
  private config: GatewayConfiguration;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  
  constructor() {
    this.loadConfiguration();
    this.setupConfigWatchers();
  }
  
  private loadConfiguration(): void {
    // Cascade: base -> environment -> service -> runtime
    const baseConfig = this.loadBaseConfig();
    const envConfig = this.loadEnvironmentConfig();
    const serviceConfig = this.loadServiceConfig();
    const runtimeConfig = this.loadRuntimeConfig();
    
    this.config = deepMerge(baseConfig, envConfig, serviceConfig, runtimeConfig);
  }
  
  private setupConfigWatchers(): void {
    // Watch for configuration file changes
    const configPath = path.join(process.cwd(), 'config/api_config.json');
    
    this.watchers.set('api_config', fs.watch(configPath, (eventType) => {
      if (eventType === 'change') {
        logger.info('Configuration file changed, reloading...');
        this.loadConfiguration();
        this.emit('configurationChanged', this.config);
      }
    }));
  }
  
  async updateConfiguration(updates: Partial<GatewayConfiguration>): Promise<void> {
    // Admin API can trigger real-time config updates
    this.config = deepMerge(this.config, updates);
    
    // Persist to database/file
    await this.persistConfiguration(updates);
    
    // Notify all components of config change
    this.emit('configurationChanged', this.config);
  }
}
```

#### Model Mapping Configuration

**Model Substitution Engine**:
```typescript
class ModelMappingService {
  private mappings: Map<string, ModelMapping>;
  
  resolveModel(requestedModel: string, provider: string): ModelMapping {
    // Check exact match first
    if (this.mappings.has(requestedModel)) {
      return this.mappings.get(requestedModel);
    }
    
    // Check pattern matches
    for (const [pattern, mapping] of this.mappings) {
      if (this.matchesPattern(requestedModel, pattern)) {
        return { ...mapping, resolvedName: this.applyPattern(requestedModel, pattern, mapping.targetModel) };
      }
    }
    
    // Fallback to provider defaults
    return this.getProviderDefault(provider);
  }
  
  private matchesPattern(model: string, pattern: string): boolean {
    // Support glob-like patterns: gpt-4* -> gpt-4o, gpt-4-turbo, etc.
    const regex = new RegExp(pattern.replace('*', '.*'));
    return regex.test(model);
  }
}
```

### Security Implementation

#### Cryptographic Key Management

**Key Generation and Usage** (adapted from `/CRYPTOGRAPHIC_KEY_GENERATION.md`):
```typescript
class SecurityManager {
  private validationTokenSecret: Buffer;
  private metadataEncryptionKey: Buffer;
  private awsSecretEncryptionKey: Buffer;
  
  constructor() {
    // Load or generate cryptographic keys
    this.validationTokenSecret = this.loadOrGenerateKey('VALIDATION_TOKEN_SECRET', 32);
    this.metadataEncryptionKey = this.loadOrGenerateKey('METADATA_ENCRYPTION_KEY', 32);
    this.awsSecretEncryptionKey = this.loadOrGenerateKey('AWS_SECRET_ENCRYPTION_KEY', 32);
  }
  
  private loadOrGenerateKey(envVar: string, bytes: number): Buffer {
    const existing = process.env[envVar];
    if (existing) {
      return Buffer.from(existing, 'hex');
    }
    
    // Generate new key for development
    const key = crypto.randomBytes(bytes);
    logger.warn(`Generated new ${envVar}. Add to environment: ${key.toString('hex')}`);
    return key;
  }
  
  encryptMetadata(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher('aes-256-cbc', this.metadataEncryptionKey);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }
  
  decryptMetadata(ciphertext: string): string {
    const [ivHex, encryptedHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipher('aes-256-cbc', this.metadataEncryptionKey);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  
  generateJWT(payload: any, expiresIn: string = '1h'): string {
    return jwt.sign(payload, this.validationTokenSecret, { 
      expiresIn,
      algorithm: 'HS256',
      issuer: 'sail-proxy-gateway'
    });
  }
  
  verifyJWT(token: string): any {
    return jwt.verify(token, this.validationTokenSecret, {
      algorithms: ['HS256'],
      issuer: 'sail-proxy-gateway'
    });
  }
}
```

### Usage Tracking and Analytics

#### Comprehensive Usage Logging

**Usage Tracking Service**:
```typescript
interface UsageEvent {
  id: string;
  userId: string;
  apiKeyId: string;
  correlationId: string;
  timestamp: Date;
  endpoint: string;
  method: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseTime: number;
  statusCode: number;
  ipAddress: string;
  userAgent: string;
  cost?: number;
}

class UsageTracker {
  private redis: Redis;
  private database: Database;
  private eventQueue: Queue<UsageEvent>;
  
  async logUsage(event: Omit<UsageEvent, 'id' | 'timestamp'>): Promise<void> {
    const fullEvent: UsageEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...event
    };
    
    // Immediate Redis publish for real-time analytics
    await this.redis.publish('usage-events', JSON.stringify(fullEvent));
    
    // Queue for database persistence
    await this.eventQueue.add('persist-usage', fullEvent, {
      attempts: 3,
      backoff: 'exponential'
    });
    
    // Update real-time counters
    await this.updateCounters(fullEvent);
  }
  
  private async updateCounters(event: UsageEvent): Promise<void> {
    const date = event.timestamp.toISOString().split('T')[0];
    const hour = event.timestamp.getHours();
    
    // Increment various counters for analytics
    await Promise.all([
      this.redis.hincrby(`usage:daily:${date}`, 'requests', 1),
      this.redis.hincrby(`usage:daily:${date}`, 'tokens', event.totalTokens),
      this.redis.hincrby(`usage:hourly:${date}:${hour}`, 'requests', 1),
      this.redis.hincrby(`usage:user:${event.userId}:${date}`, 'requests', 1),
      this.redis.hincrby(`usage:model:${event.model}:${date}`, 'requests', 1)
    ]);
  }
}
```

#### Token Counting and Cost Calculation

**Token Counter Service**:
```typescript
class TokenCounter {
  private encoders = new Map<string, any>();
  
  async countTokens(text: string, model: string): Promise<number> {
    const encoder = this.getEncoder(model);
    
    if (encoder) {
      return encoder.encode(text).length;
    }
    
    // Fallback estimation (approximately 4 characters per token)
    return Math.ceil(text.length / 4);
  }
  
  private getEncoder(model: string): any {
    if (!this.encoders.has(model)) {
      // Load model-specific encoder
      try {
        const encoding = getEncoding(this.getEncodingName(model));
        this.encoders.set(model, encoding);
      } catch (error) {
        logger.warn(`No encoder found for model ${model}, using estimation`);
        return null;
      }
    }
    
    return this.encoders.get(model);
  }
  
  private getEncodingName(model: string): string {
    // Map models to their tokenizer encodings
    if (model.startsWith('gpt-4')) return 'cl100k_base';
    if (model.startsWith('gpt-3.5')) return 'cl100k_base';
    if (model.startsWith('claude')) return 'cl100k_base'; // Approximation
    return 'cl100k_base'; // Default fallback
  }
}
```

---

*Next: Learn how to [run and test the Gateway](chapter-4-gateway-testing.md) service effectively.*