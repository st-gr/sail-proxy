/**
 * AwsBedrockResponseCache Plugin
 * 
 * A high-performance in-memory caching plugin for LLM responses
 * with configurable thresholds and LRU eviction policy.
 * 
 * Features:
 * - Optimized cache key generation
 * - Memory-only LRU cache implementation
 * - Performance-based caching (only cache responses exceeding time threshold)
 * - Support for both original and emulated endpoints
 */

import crypto from 'crypto';
import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import * as sseWriter from '../utils/sseWriter';
import { requestDeclaresWebSearchTool } from './webSearch/webSearchTool';

// Type definitions
interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  tooLarge: number;
  sets?: number;
  updates?: number;
  additions?: number;
  size: number;
  memoryUsageMB: number;
  memoryCapacityMB: number;
  utilization: number;
  memoryUtilization: number;
}

interface CacheEntry {
  value: any;
  expiresAt: number;
  accessCount: number;
  size: number;
  createdAt: number;
}

interface CacheConfig {
  maxCacheEntries: number;
  maxCacheMemoryMB: number;
  maxSingleItemSizeMB: number;
  defaultTTL: number;
  minResponseTimeToCache: number;
  uniqueRequestHeaders: string[];
  enableCaching: boolean;
  enableMetrics: boolean;
}

interface PluginContext {
  req: PluginRequest;
  res: Response;
  upstreamResponse?: any;
  chunk?: Buffer;
  utils: PluginUtils;
}

interface PluginRequest extends Request {
  id?: string;
  capturedEvents?: StreamingEvent[];
  body: any;
}

interface PluginUtils {
  logger: Logger;
  sseWriter?: (responseStream: Response, events: SSEEvent | SSEEvent[]) => Promise<void>;
}

interface Logger {
  error: (message: string, meta?: any) => void;
  warn: (message: string, meta?: any) => void;
  info: (message: string, meta?: any) => void;
  debug: (message: string, meta?: any) => void;
  trace: (message: string, meta?: any) => void;
}

interface SSEEvent {
  event: string;
  data: any;
}

interface StreamingEvent {
  type?: string;
  message?: any;
  messageStart?: any;
  contentBlockStart?: any;
  contentBlockDelta?: any;
  contentBlockStop?: any;
  messageStop?: any;
  metadata?: any;
  contentBlockIndex?: number;
  index?: number;
  delta?: any;
  usage?: any;
  content_block?: any;
}

interface CacheData {
  events?: StreamingEvent[];
  body?: any;
  timestamp: number;
  duration: number;
}

interface RequestContext {
  cacheRequestId: string;
  cacheKey: string;
  cacheModelId: string;
  isStreaming: boolean;
  capturedEvents?: StreamingEvent[];
  lastReturnedEventCount?: number;
  pendingRequestResolve?: (value: { success: boolean; cached: boolean }) => void;
  pendingRequestReject?: (reason?: any) => void;
}

interface PluginResult {
  stop: boolean;
  response?: any;
}

interface StreamHandlerResult {
  chunk: Buffer;
  capturedEvents: StreamingEvent[];
}

interface ContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
}

interface NonStreamingResponse {
  id: string;
  type: string;
  role: string;
  content: ContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// In-memory LRU Cache implementation
class LRUCache {
  private cache: Map<string, CacheEntry>;
  private maxEntries: number;
  private maxMemoryBytes: number;
  private currentMemoryUsage: number;
  private stats: CacheStats;
  private defaultTTL: number;

  constructor(maxEntries: number = 1000, maxMemoryMB: number = 512) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.maxMemoryBytes = maxMemoryMB * 1024 * 1024;
    this.currentMemoryUsage = 0;
    this.defaultTTL = 3600000; // 1 hour
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      tooLarge: 0,
      sets: 0,
      updates: 0,
      additions: 0,
      size: 0,
      memoryUsageMB: 0,
      memoryCapacityMB: 0,
      utilization: 0,
      memoryUtilization: 0
    };
  }

  /**
   * Get an item from cache
   */
  get(key: string): any {
    if (!this.cache.has(key)) {
      this.stats.misses++;
      return null;
    }
    
    // Get the item and refresh its position in the LRU
    const item = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, item);
    
    this.stats.hits++;
    return item.value;
  }

  /**
   * Set an item in cache
   */
  set(key: string, value: any, ttl: number | null = null): boolean {
    // Using imported logger
    const now = Date.now();
    const effectiveTTL = ttl || this.defaultTTL;
    const expiresAt = now + effectiveTTL;
    
    // Calculate size before setting
    const valueSize = this._estimateObjectSize(value);
    logger.debug('Plugin', `LRUCache.set: Attempting to cache key ${key.substring(0, 8)}... (size: ${Math.round(valueSize / 1024)}KB, TTL: ${effectiveTTL}ms)`);
    
    // Check if we already have this key
    const existingEntry = this.cache.get(key);
    const existingSize = existingEntry ? existingEntry.size : 0;
    
    // Calculate new memory usage
    const newMemoryUsage = this.currentMemoryUsage - existingSize + valueSize;
    logger.debug('Plugin', `LRUCache.set: Memory calculation - current: ${Math.round(this.currentMemoryUsage / 1024)}KB, existing entry: ${Math.round(existingSize / 1024)}KB, new entry: ${Math.round(valueSize / 1024)}KB, projected: ${Math.round(newMemoryUsage / 1024)}KB, limit: ${Math.round(this.maxMemoryBytes / 1024)}KB`);
    
    // If adding this would exceed memory limit, make room
    if (newMemoryUsage > this.maxMemoryBytes) {
      logger.info('Plugin', `LRUCache.set: Would exceed memory limit, attempting to make room (need to free: ${Math.round((newMemoryUsage - this.maxMemoryBytes) / 1024)}KB)`);
      const spaceFreed = this._ensureMemoryLimit(valueSize - existingSize);
      logger.info('Plugin', `LRUCache.set: Freed ${Math.round(spaceFreed / 1024)}KB of space`);
    }
    
    // Recheck if we have enough space after eviction
    const finalMemoryCheck = this.currentMemoryUsage - existingSize + valueSize;
    if (finalMemoryCheck > this.maxMemoryBytes) {
      logger.error('Plugin', `LRUCache.set: Still not enough memory after eviction (need: ${Math.round(finalMemoryCheck / 1024)}KB, limit: ${Math.round(this.maxMemoryBytes / 1024)}KB) - REJECTING CACHE ENTRY`);
      return false;
    }
    
    // Create the cache entry
    const entry: CacheEntry = {
      value,
      expiresAt,
      accessCount: 1,
      size: valueSize,
      createdAt: now
    };
    
    try {
      // Update memory usage
      if (existingEntry) {
        this.currentMemoryUsage -= existingEntry.size;
        logger.debug('Plugin', `LRUCache.set: Removed existing entry (${Math.round(existingEntry.size / 1024)}KB)`);
      }
      
      this.currentMemoryUsage += valueSize;
      
      // Set the entry (this moves it to end/most recent)
      this.cache.set(key, entry);
      
      // Update stats
      this.stats.sets = (this.stats.sets || 0) + 1;
      if (existingEntry) {
        this.stats.updates = (this.stats.updates || 0) + 1;
        logger.debug('Plugin', `LRUCache.set: Updated existing entry`);
      } else {
        this.stats.additions = (this.stats.additions || 0) + 1;
        logger.debug('Plugin', `LRUCache.set: Added new entry`);
      }
      
      logger.debug('Plugin', `✅ LRUCache.set: SUCCESS for key ${key.substring(0, 8)}... (final cache size: ${this.cache.size} entries, ${Math.round(this.currentMemoryUsage / 1024)}KB)`);
      return true;
      
    } catch (error: any) {
      logger.error('Plugin', `❌ LRUCache.set: ERROR setting cache entry for key ${key.substring(0, 8)}...: ${error.message}`, error);
      // Rollback memory usage if we failed
      if (existingEntry) {
        this.currentMemoryUsage += existingEntry.size;
      }
      this.currentMemoryUsage -= valueSize;
      return false;
    }
  }

  private _ensureMemoryLimit(additionalSize: number = 0): number {
    // Using imported logger
    let freedSpace = 0;
    const targetSpace = this.currentMemoryUsage + additionalSize - this.maxMemoryBytes;
    
    logger.debug('Plugin', `_ensureMemoryLimit: Need to free ${Math.round(targetSpace / 1024)}KB`);
    
    // Remove expired entries first
    const expiredFreed = this._removeExpiredEntries();
    freedSpace += expiredFreed;
    
    if (expiredFreed > 0) {
      logger.debug('Plugin', `_ensureMemoryLimit: Freed ${Math.round(expiredFreed / 1024)}KB from expired entries`);
    }
    
    // If still need more space, evict LRU entries
    while (this.currentMemoryUsage + additionalSize > this.maxMemoryBytes && this.cache.size > 0) {
      // Get the least recently used entry (first entry in the Map)
      const firstEntry = this.cache.entries().next().value;
      if (!firstEntry) break;
      const [oldestKey, oldestEntry] = firstEntry;
      
      logger.debug('Plugin', `_ensureMemoryLimit: Evicting LRU entry ${oldestKey.substring(0, 8)}... (${Math.round(oldestEntry.size / 1024)}KB)`);
      
      this.cache.delete(oldestKey);
      this.currentMemoryUsage -= oldestEntry.size;
      freedSpace += oldestEntry.size;
      this.stats.evictions++;
    }
    
    logger.info('Plugin', `_ensureMemoryLimit: Total freed: ${Math.round(freedSpace / 1024)}KB`);
    return freedSpace;
  }

  private _removeExpiredEntries(): number {
    const now = Date.now();
    let freedSpace = 0;
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (entry.expiresAt && entry.expiresAt < now) {
        keysToDelete.push(key);
        freedSpace += entry.size;
      }
    }
    
    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.currentMemoryUsage -= this.cache.get(key)?.size || 0;
    }
    
    return freedSpace;
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    if (!this.cache.has(key)) return false;
    
    const item = this.cache.get(key)!;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      // Expired, remove it
      this.currentMemoryUsage -= this._estimateObjectSize(item.value);
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats & { maxMemoryBytes: number; currentMemoryUsage: number } {
    return {
      ...this.stats,
      size: this.cache.size,
      memoryUsageMB: Math.round(this.currentMemoryUsage / (1024 * 1024) * 100) / 100,
      memoryCapacityMB: Math.round(this.maxMemoryBytes / (1024 * 1024) * 100) / 100,
      utilization: this.cache.size / this.maxEntries,
      memoryUtilization: this.currentMemoryUsage / this.maxMemoryBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      currentMemoryUsage: this.currentMemoryUsage
    };
  }

  /**
   * Estimate object size in bytes (approximate)
   */
  _estimateObjectSize(object: any): number {
    try {
      // Handle null/undefined
      if (object == null) {
        return 8; // minimal size
      }
      
      // For very large objects, use a different estimation method to avoid JSON.stringify limits
      if (this._isLikelyTooLargeForStringify(object)) {
        return this._estimateSizeWithoutStringify(object);
      }
      
      const json = JSON.stringify(object);
      // Approximate size: 2 bytes per character plus some overhead
      return json.length * 2;
    } catch (error: any) {
      // If JSON.stringify fails (e.g., "Invalid string length"), fall back to estimation
      // Using imported logger
      logger.warn('LRUCache._estimateObjectSize: JSON.stringify failed, using fallback estimation', 'Operation message', {error: error.message });
      return this._estimateSizeWithoutStringify(object);
    }
  }

  /**
   * Check if an object is likely too large for JSON.stringify
   */
  private _isLikelyTooLargeForStringify(object: any): boolean {
    if (!object || typeof object !== 'object') {
      return false;
    }
    
    // More aggressive guards to prevent OOM crashes
    if (Array.isArray(object)) {
      // Much lower threshold for arrays to prevent OOM
      if (object.length > 10_000) {
        return true;
      }
      // Special guard for capturedEvents arrays
      if (object.length > 1_000 && object[0] && (object[0].type || object[0].messageStart || object[0].contentBlockDelta)) {
        return true;
      }
    }
    
    // Quick heuristic: if it has many properties, it might be too large
    if (object.constructor === Object && Object.keys(object).length > 1000) {
      return true;
    }
    
    return false;
  }

  /**
   * Estimate object size without using JSON.stringify (safer for very large objects)
   */
  private _estimateSizeWithoutStringify(object: any): number {
    try {
      // let size = 0; // Unused variable
      const visited = new WeakSet();
      
      const estimateRecursive = (obj: any, depth: number = 0): number => {
        // Prevent infinite recursion
        if (depth > 10) {
          return 100; // arbitrary size for deep objects
        }
        
        if (obj == null) {
          return 8;
        }
        
        // Prevent circular references
        if (typeof obj === 'object' && visited.has(obj)) {
          return 0;
        }
        
        if (typeof obj === 'string') {
          return obj.length * 2; // 2 bytes per character
        }
        
        if (typeof obj === 'number') {
          return 8; // 8 bytes for numbers
        }
        
        if (typeof obj === 'boolean') {
          return 4; // 4 bytes for booleans
        }
        
        if (Array.isArray(obj)) {
          visited.add(obj);
          let arraySize = 24; // base array overhead
          
          // For very large arrays, sample instead of measuring every element
          if (obj.length > 1000) {
            // Sample first 100, last 100, and some middle elements
            const sampleSize = Math.min(200, obj.length);
            let sampleTotalSize = 0;
            
            for (let i = 0; i < Math.min(100, obj.length); i++) {
              sampleTotalSize += estimateRecursive(obj[i], depth + 1);
            }
            
            if (obj.length > 100) {
              for (let i = Math.max(100, obj.length - 100); i < obj.length; i++) {
                sampleTotalSize += estimateRecursive(obj[i], depth + 1);
              }
            }
            
            // Estimate total size based on sample
            const averageElementSize = sampleTotalSize / sampleSize;
            arraySize += averageElementSize * obj.length;
          } else {
            // Small array, measure all elements
            for (const item of obj) {
              arraySize += estimateRecursive(item, depth + 1);
            }
          }
          
          return arraySize;
        }
        
        if (typeof obj === 'object') {
          visited.add(obj);
          let objectSize = 24; // base object overhead
          const keys = Object.keys(obj);
          
          // For very large objects, sample instead of measuring every property
          if (keys.length > 500) {
            // Sample first 100 properties
            const sampleKeys = keys.slice(0, 100);
            let sampleTotalSize = 0;
            
            for (const key of sampleKeys) {
              sampleTotalSize += key.length * 2; // key name
              sampleTotalSize += estimateRecursive(obj[key], depth + 1); // value
            }
            
            // Estimate total size based on sample
            const averagePropertySize = sampleTotalSize / sampleKeys.length;
            objectSize += averagePropertySize * keys.length;
          } else {
            // Small object, measure all properties
            for (const key of keys) {
              objectSize += key.length * 2; // key name
              objectSize += estimateRecursive(obj[key], depth + 1); // value
            }
          }
          
          return objectSize;
        }
        
        return 16; // fallback size for unknown types
      };
      
      return estimateRecursive(object);
    } catch (error: any) {
      // Using imported logger
      logger.warn('LRUCache._estimateSizeWithoutStringify: Fallback estimation failed, using default size', 'Operation message', {error: error.message });
      return 1048576; // 1MB fallback size
    }
  }
}

// Plugin configuration - adjustable and dynamically configurable
const config: CacheConfig = {
  maxCacheEntries: 1000,
  maxCacheMemoryMB: 512,
  maxSingleItemSizeMB: 50, // Maximum size for a single cache item (50MB)
  defaultTTL: 3600000, // 1 hour in ms
  minResponseTimeToCache: 5000, // 5 seconds in ms (reduced from 12s to be more aggressive)
  uniqueRequestHeaders: ['authorization', 'x-api-key'],
  enableCaching: true,
  enableMetrics: true
};

// Initialize the cache
const responseCache = new LRUCache(config.maxCacheEntries, config.maxCacheMemoryMB);

// Start time map to track request durations
const requestStartTimes = new Map<string, number>();

// WeakMap to store plugin-specific request context without modifying the request object
const requestContextMap = new WeakMap<Request, RequestContext>();

// Map to track pending requests by cache key to avoid duplicate processing
const pendingRequests = new Map<string, Promise<{ success: boolean; cached: boolean }>>();

// Plugin-level error boundary to prevent unhandled promise rejections from crashing the service
let unhandledRejectionHandler: ((reason: any, promise: Promise<any>) => void) | null = null;

// Initialize plugin-level error boundaries
function initializeErrorBoundaries(logger: Logger): void {
  if (!unhandledRejectionHandler) {
    unhandledRejectionHandler = (reason: any, promise: Promise<any>) => {
      try {
        const error = reason || new Error('Unknown rejection reason');
        logger.error('[awsBedrockResponseCache] Caught unhandled promise rejection:', {
          error: error.message || String(error),
          stack: error.stack,
          component: 'awsBedrockResponseCache'
        });
      } catch (handlerError: any) {
        // Fallback logging if even the error handler fails
        console.error('[awsBedrockResponseCache] Error in unhandled rejection handler:', handlerError.message);
      }
    };
    
    // Add process-level handler for this plugin's unhandled rejections
    process.on('unhandledRejection', unhandledRejectionHandler);
    logger.debug('Plugin', '[awsBedrockResponseCache] Initialized plugin-level error boundaries');
  }
}

// Safe promise utilities that never throw unhandled rejections
const SafePromise = {
  /**
   * Create a timeout promise that resolves instead of rejecting
   */
  timeout<T>(ms: number, timeoutValue: T): Promise<T> {
    return new Promise<T>((resolve) => {
      setTimeout(() => resolve(timeoutValue), ms);
    });
  },
  
  /**
   * Safely reject a promise with error handling
   */
  safeReject(rejectFn: ((reason?: any) => void) | undefined, error: Error, logger: Logger): void {
    if (!rejectFn) return;
    
    try {
      // Use setTimeout to ensure the rejection is handled asynchronously
      setTimeout(() => {
        try {
          rejectFn(error);
        } catch (rejectError: any) {
          logger.debug('[awsBedrockResponseCache] Promise rejection handler threw:', rejectError.message);
        }
      }, 0);
    } catch (outerError: any) {
      logger.debug('[awsBedrockResponseCache] Error in safeReject:', outerError.message);
    }
  },
  
  /**
   * Safely resolve a promise with error handling
   */
  safeResolve<T>(resolveFn: ((value: T) => void) | undefined, value: T, logger: Logger): void {
    if (!resolveFn) return;
    
    try {
      resolveFn(value);
    } catch (resolveError: any) {
      logger.debug('[awsBedrockResponseCache] Promise resolution handler threw:', resolveError.message);
    }
  }
};

/**
 * Before handler - check cache and return cached response if available
 */
async function beforeHandler({ req, res, utils }: PluginContext): Promise<PluginResult> {
  const logger = utils.logger;
  
  // Initialize error boundaries on first request
  initializeErrorBoundaries(logger);

  if (!config.enableCaching) {
    return { stop: false };
  }

  // A web_search turn is never cached, in either direction.
  //
  // SERVING: a cache hit returns { stop: true } from here, so the whole Bedrock
  // streaming handler — and with it the web_search stream interception — never
  // runs. STORING: `streamHandler` captures the RAW upstream chunk, before
  // `BedrockStreamParser.processChunk` and therefore before the interception, so
  // what lands in the cache is the un-rewritten `tool_use` turn. Together those
  // mean one uncached web_search request could poison the cache and every later
  // hit would replay the exact bug this module exists to fix — silently, and
  // with no upstream call to notice it by.
  //
  // Returning before `requestContextMap.set` is what disarms all of it: the
  // stream, after and error handlers all begin by looking that context up and
  // pass through untouched when it is absent, so this one guard covers serve
  // AND store.
  //
  // Search results are time-sensitive anyway — a cached answer about "the
  // current version" is wrong the moment it stops being current — so this is
  // the right behaviour independently of the correctness bug.
  if (requestDeclaresWebSearchTool(req.body)) {
    logger.info('Plugin', '[awsBedrockResponseCache] NOT CACHING: request declares the web_search tool');
    return { stop: false };
  }

  // Record start time for performance tracking
  const requestId = req.id || Math.random().toString(36).substring(2, 15);
  requestStartTimes.set(requestId, Date.now());
  
  // Generate cache key for the current request type
  const cacheKey = generateCacheKey(req);
  
  // LOG THE FULL CACHE KEY and request details to debug retry issues
  logger.info(`🔑 CACHE KEY GENERATED: ${cacheKey.substring(0, 16)}... for request: ${req.method} ${req.originalUrl || req.url}`);
  logger.debug(`🔍 CACHE KEY DEBUG:`, {
    cacheKey: cacheKey.substring(0, 32) + '...',
    url: req.originalUrl || req.url,
    method: req.method,
    hasBody: !!req.body,
    bodySize: req.body ? JSON.stringify(req.body).length : 0,
    relevantHeaders: config.uniqueRequestHeaders.reduce((acc: Record<string, string>, header) => {
      if (req.headers && req.headers[header]) {
        acc[header] = (req.headers[header] as string).substring(0, 20) + '...';
      }
      return acc;
    }, {}),
    currentPendingCount: pendingRequests.size
  });
  
  // Extract and store model ID for later use
  const modelId = extractModelId(req);
  
  // Determine if this is a streaming request
  const isStreaming = req.originalUrl?.includes('-stream') || 
                      req.url?.includes('-stream') ||
                      (req.body && req.body.stream === true);
  
  // Store context in WeakMap instead of modifying request object
  requestContextMap.set(req, {
    cacheRequestId: requestId,
    cacheKey: cacheKey,
    cacheModelId: modelId,
    isStreaming: isStreaming  // Store streaming flag here for later use
  });
  
  // Check for pending requests with the same cache key (request deduplication)
  if (pendingRequests.has(cacheKey)) {
    logger.info(`🔄 DUPLICATE REQUEST DETECTED: Waiting for pending request with key: ${cacheKey.substring(0, 8)}... (current pending: ${pendingRequests.size} requests)`);
    
    try {
      // Set a reasonable timeout for waiting (shorter than client timeout to avoid hanging)
      const waitTimeout = 30000; // 30 seconds
      
      // Use safe timeout that resolves instead of rejecting
      const timeoutResult = { success: false, cached: false, timeout: true };
      const safeTimeout = SafePromise.timeout(waitTimeout, timeoutResult);
      
      // Race between the pending request and our safe timeout
      const pendingResult = await Promise.race([
        pendingRequests.get(cacheKey)!.catch((error: any) => {
          logger.warn('Plugin', `[awsBedrockResponseCache] Pending request failed: ${error.message}`);
          return { success: false, cached: false, error: true };
        }),
        safeTimeout
      ]);
      
      if (pendingResult && pendingResult.success && !(pendingResult as any).timeout) {
        logger.info(`✅ DUPLICATE REQUEST SERVED: Pending request completed, serving from cache for key: ${cacheKey.substring(0, 8)}...`);
        
        // The pending request should have cached the response, so try to get it from cache
        if (responseCache.has(cacheKey)) {
          const cachedResponse = responseCache.get(cacheKey);
          
          if (isStreaming && cachedResponse.events && Array.isArray(cachedResponse.events)) {
            // Set SSE headers and replay events for streaming requests
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Accel-Buffering', 'no');
            }
            
            await replayStreamingEvents(res, cachedResponse.events, logger, modelId);
            return { stop: true };
          } else if (!isStreaming && cachedResponse.body) {
            // Return JSON response for non-streaming requests
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'application/json');
            }
            
            const responseWithCorrectModel = {
              ...cachedResponse.body,
              model: modelId
            };
            
            res.status(200).json(responseWithCorrectModel);
            return { stop: true };
          }
        }
        
        // If cache lookup failed, check normalized key
        const normalizedCacheKey = generateCacheKey(req, true);
        if (normalizedCacheKey !== cacheKey && responseCache.has(normalizedCacheKey)) {
          const cachedResponse = responseCache.get(normalizedCacheKey);
          
          if (cachedResponse.body) {
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'application/json');
            }
            
            const responseWithCorrectModel = {
              ...cachedResponse.body,
              model: modelId
            };
            
            res.status(200).json(responseWithCorrectModel);
            return { stop: true };
          }
        }
        
        logger.warn(`⚠️ DUPLICATE REQUEST: Pending request completed but no cache entry found for key: ${cacheKey.substring(0, 8)}...`);
      } else if ((pendingResult as any).timeout) {
        logger.warn(`⏰ DUPLICATE REQUEST TIMEOUT: Giving up waiting for pending request after 30s for key: ${cacheKey.substring(0, 8)}...`);
      } else {
        logger.warn(`⚠️ DUPLICATE REQUEST: Pending request failed for key: ${cacheKey.substring(0, 8)}...`);
      }
    } catch (waitError: any) {
      logger.error('Plugin', `❌ DUPLICATE REQUEST: Error waiting for pending request: ${waitError.message}`);
    }
    
    // If we reach here, the pending request didn't result in a usable cache entry
    // Fall through to normal cache lookup and potentially start a new request
  }
  
  // Check cache for current request type first
  let cachedResponse: CacheData | null = null;
  
  if (responseCache.has(cacheKey)) {
    cachedResponse = responseCache.get(cacheKey);
    logger.info(`Direct cache hit for full key: ${cacheKey.substring(0, 8)}...`);
  } else {
    // Generate a normalized cache key that strips streaming differences
    const normalizedCacheKey = generateCacheKey(req, true);
    
    logger.info(`Normalized cache key generated: ${normalizedCacheKey.substring(0, 8)}...`);
    
    if (normalizedCacheKey !== cacheKey && responseCache.has(normalizedCacheKey)) {
      cachedResponse = responseCache.get(normalizedCacheKey);
      logger.info(`Cross-format cache hit for normalized key: ${normalizedCacheKey.substring(0, 8)}...`);
    } else if (normalizedCacheKey === cacheKey) {
      logger.debug('Plugin', 'Normalized cache key identical to main key - no streaming differences to normalize');
    }
  }
  
  if (cachedResponse) {
    logger.info(`Cache hit found! isStreaming: ${isStreaming}, hasEvents: ${!!cachedResponse.events}, hasBody: ${!!cachedResponse.body}`);
    
    if (isStreaming) {
      // For streaming requests, ALWAYS replay events if they exist
      if (cachedResponse.events && Array.isArray(cachedResponse.events)) {
        logger.info(`Cache hit for streaming request, replaying ${cachedResponse.events.length} events`);
        
        try {
          // Set SSE headers
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
          }
          
          // Replay each cached event with the correct model ID
          await replayStreamingEvents(res, cachedResponse.events, logger, modelId);
          
          logger.info('Plugin', `Successfully replayed cached streaming response`);
          return { stop: true };
        } catch (error: any) {
          logger.error('Plugin', `Error replaying cached streaming events: ${error.message}`);
          return { stop: false };
        }
      } else {
        // No events available - this shouldn't happen for streaming cache hits
        logger.warn('Plugin', `Cache hit for streaming request but no events available - cache format issue`);
        return { stop: false };
      }
    } else {
      // For non-streaming requests, return the body
      if (cachedResponse.body) {
        logger.info('Plugin', `Cache hit for non-streaming request`);
        
        try {
          if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
          }
          
          // Update the model ID in the cached response body
          const responseWithCorrectModel = {
            ...cachedResponse.body,
            model: modelId
          };
          
          res.status(200).json(responseWithCorrectModel);
          return { stop: true };
        } catch (error: any) {
          logger.error('Plugin', `Error sending cached non-streaming response: ${error.message}`);
          return { stop: false };
        }
      } else {
        logger.warn('Plugin', `Cache hit for non-streaming request but no body available - cache format issue`);
        return { stop: false };
      }
    }
  }
  
  // LOG DETAILED DEBUG INFO FOR CACHE MISSES
  logger.info('Plugin', `Cache miss for full key: ${cacheKey.substring(0, 8)}...`);
  logger.debug('Plugin', 'Cache miss debug info');
  
  // Register this request as pending to avoid duplicate processing
  if (!pendingRequests.has(cacheKey)) {
    logger.info(`📝 REGISTERING PENDING REQUEST: Cache miss, registering as pending for key: ${cacheKey.substring(0, 8)}...`);
    
    // Create a promise that will be resolved by the afterHandler
    let resolveRequest: (value: { success: boolean; cached: boolean }) => void;
    let rejectRequest: (reason?: any) => void;
    const pendingPromise = new Promise<{ success: boolean; cached: boolean }>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    
    // Store the promise and its resolvers
    pendingRequests.set(cacheKey, pendingPromise);

    // Attach a no-op catch handler to prevent unhandled rejection warnings
    // when the timeout fires and no duplicate request is waiting
    pendingPromise.catch(() => {
      // Intentionally empty - rejections are handled by the timeout cleanup
    });

    // Store the resolvers in the request context for the afterHandler
    const context = requestContextMap.get(req);
    if (context) {
      context.pendingRequestResolve = resolveRequest!;
      context.pendingRequestReject = rejectRequest!;
    }
    
    // Set a timeout to prevent pending requests from hanging forever
    // Use a shorter, more reasonable timeout (5 minutes instead of 1 hour)
    const timeoutMs = Math.min(config.defaultTTL, 300000); // Max 5 minutes
    setTimeout(() => {
      try {
        if (pendingRequests.has(cacheKey)) {
          logger.warn(`⏰ PENDING REQUEST TIMEOUT: Removing stale pending request for key: ${cacheKey.substring(0, 8)}... (timeout: ${timeoutMs}ms)`);
          pendingRequests.delete(cacheKey);
          
          // Use safe rejection to prevent unhandled promise rejections
          SafePromise.safeReject(rejectRequest, new Error('Pending request timeout'), logger);
        }
      } catch (error: any) {
        logger.error('[awsBedrockResponseCache] Error in pending request timeout handler:', error.message);
      }
    }, timeoutMs);
  }
  
  return { stop: false };
}

/**
 * Extract model ID from request
 */
function extractModelId(req: PluginRequest): string {
  // First try to get from request body
  if (req.body?.model) {
    return req.body.model;
  }
  
  // Then try to extract from URL path
  const url = req.originalUrl || req.url || '';
  const pathParts = url.split('/');
  
  // Look for model ID in different positions based on URL structure
  // Example: /aws-bedrock/model/us.anthropic.claude-3-7-sonnet-20250219-v1:0/invoke-with-response-stream
  // Example: /v1/models/us.anthropic.claude-3-7-sonnet-20250219-v1:0/invoke-with-response-stream
  for (let i = 0; i < pathParts.length; i++) {
    if ((pathParts[i] === 'models' || pathParts[i] === 'model') && i + 1 < pathParts.length) {
      const potentialModelId = pathParts[i + 1];
      // Skip if it's a subpath like 'invoke' or 'invoke-with-response-stream'
      if (potentialModelId && !['invoke', 'invoke-with-response-stream', 'converse', 'converse-stream'].includes(potentialModelId)) {
        return potentialModelId;
      }
    }
  }
  
  // Fallback to unknown if we can't extract it
  return 'unknown';
}

/**
 * Replay streaming events from cache to client
 */
async function replayStreamingEvents(res: Response, events: StreamingEvent[], logger: Logger, modelId: string = 'unknown'): Promise<void> {
  // Using imported sseWriter
  
  for (const event of events) {
    if (res.writableEnded) {
      logger.warn('Plugin', 'Response ended while replaying events');
      break;
    }
    
    try {
      // Handle different event formats
      if (event.type) {
        // Anthropic format - write as-is but update model if it's in message_start
        if (event.type === 'message_start' && event.message) {
          const updatedEvent = {
            ...event,
            message: {
              ...event.message,
              model: modelId // Use the provided model ID instead of "unknown"
            }
          };
          sseWriter.writeEventStream(res, event.type, JSON.stringify(updatedEvent));
        } else {
          sseWriter.writeEventStream(res, event.type, JSON.stringify(event));
        }
      } else if (event.messageStart) {
        // Convert Bedrock messageStart to Anthropic format
        const messageId = `msg_cache_${Date.now()}`;
        sseWriter.writeEventStream(res, 'message_start', JSON.stringify({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: event.messageStart.role || 'assistant',
            model: modelId, // Use the provided model ID
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));
      } else if (event.contentBlockStart) {
        // Convert Bedrock contentBlockStart to Anthropic format
        const blockIndex = event.contentBlockIndex ?? 0;
        let contentBlock: any;
        
        if (event.contentBlockStart.start?.toolUse) {
          contentBlock = {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: event.contentBlockStart.start.toolUse.toolUseId.replace('tooluse_', 'toolu_bdrk_'),
              name: event.contentBlockStart.start.toolUse.name,
              input: {}
            }
          };
        } else {
          contentBlock = {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'text',
              text: ''
            }
          };
        }
        
        sseWriter.writeEventStream(res, 'content_block_start', JSON.stringify(contentBlock));
      } else if (event.contentBlockDelta) {
        // Convert Bedrock contentBlockDelta to Anthropic format
        const blockIndex = event.contentBlockIndex ?? 0;
        
        if (event.contentBlockDelta.delta?.text !== undefined) {
          sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'text_delta',
              text: event.contentBlockDelta.delta.text
            }
          }));
        } else if (event.contentBlockDelta.delta?.toolUse?.input !== undefined) {
          sseWriter.writeEventStream(res, 'content_block_delta', JSON.stringify({
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: event.contentBlockDelta.delta.toolUse.input
            }
          }));
        }
      } else if (event.contentBlockStop) {
        const blockIndex = event.contentBlockIndex ?? 0;
        sseWriter.writeEventStream(res, 'content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: blockIndex
        }));
      } else if (event.messageStop) {
        sseWriter.writeEventStream(res, 'message_delta', JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason: event.messageStop.stopReason,
            stop_sequence: null
          },
          usage: {}
        }));
      } else if (event.metadata) {
        if (event.metadata.usage) {
          sseWriter.writeEventStream(res, 'message_delta', JSON.stringify({
            type: 'message_delta',
            delta: {},
            usage: {
              output_tokens: event.metadata.usage.outputTokens || 0
            }
          }));
        }
        
        sseWriter.writeEventStream(res, 'message_stop', JSON.stringify({
          type: 'message_stop',
          'amazon-bedrock-invocationMetrics': {
            inputTokenCount: event.metadata.usage?.inputTokens || 0,
            outputTokenCount: event.metadata.usage?.outputTokens || 0,
            invocationLatency: event.metadata.metrics?.latencyMs || 0,
            firstByteLatency: event.metadata.metrics?.firstByteLatency || 0
          }
        }));
      }
      
      // Small delay to avoid overwhelming the client
      await new Promise(resolve => setTimeout(resolve, 1));
    } catch (eventError: any) {
      logger.error('Plugin', `Error replaying event: ${eventError.message}`);
    }
  }
  
  // End the response
  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * Helper function to clean up pending requests and notify waiting clients
 */
function cleanupPendingRequests(context: RequestContext, cacheKey: string, logger: Logger, success: boolean = false, cached: boolean = false): void {
  if (context && context.pendingRequestResolve && pendingRequests.has(cacheKey)) {
    logger.info(`🧹 CLEANING UP PENDING REQUESTS: Notifying waiting requests for key: ${cacheKey.substring(0, 8)}... (success: ${success}, cached: ${cached})`);
    
    // Use safe resolution to prevent any throwing
    SafePromise.safeResolve(context.pendingRequestResolve, { success, cached }, logger);
    
    // Safely remove from pending requests map
    try {
      pendingRequests.delete(cacheKey);
    } catch (deleteError: any) {
      logger.debug('[awsBedrockResponseCache] Error removing from pendingRequests map:', deleteError.message);
    }
  }
}

/**
 * After handler - capture and cache responses
 */
async function afterHandler({ req, upstreamResponse, utils }: PluginContext): Promise<any> {
  const logger = utils.logger;
  
  logger.debug('Plugin', `AfterHandler called for request: ${req.method} ${req.originalUrl || req.url}`);
  
  // If caching is disabled or we have no upstream response, just return
  if (!config.enableCaching) {
    logger.info('Plugin', 'NOT CACHING: Caching is disabled in config');
    return upstreamResponse;
  }
  
  if (!upstreamResponse) {
    logger.info('Plugin', 'NOT CACHING: No upstream response provided');
    return null;
  }
  
  // Get context from WeakMap
  const context = requestContextMap.get(req);
  if (!context) {
    logger.warn('Plugin', 'NOT CACHING: No context found in WeakMap for request');
    return upstreamResponse;
  }
  
  const { cacheRequestId: requestId, cacheKey } = context;
  
  if (!requestId || !cacheKey) {
    logger.warn('Plugin', `NOT CACHING: Missing requestId (${!!requestId}) or cacheKey (${!!cacheKey}) from context`);
    // Clean up pending requests even if we can't cache
    cleanupPendingRequests(context, cacheKey || 'unknown', logger, true, false);
    requestContextMap.delete(req);
    return upstreamResponse;
  }
  
  // Check if request took long enough to warrant caching
  const startTime = requestStartTimes.get(requestId);
  if (!startTime) {
    logger.info('Plugin', `NOT CACHING: No start time found for request ID: ${requestId}`);
    // Clean up pending requests even if we can't cache
    cleanupPendingRequests(context, cacheKey, logger, true, false);
    requestContextMap.delete(req);
    return upstreamResponse;
  }
  
  const requestDuration = Date.now() - startTime;
  // Safely clean up request start times
  try {
    requestStartTimes.delete(requestId);
  } catch (deleteError: any) {
    logger.debug('[awsBedrockResponseCache] Error cleaning up requestStartTimes:', deleteError.message);
  }
  
  // Add detailed logging for caching decision
  logger.info('Plugin', `Request completed in ${requestDuration}ms (threshold: ${config.minResponseTimeToCache}ms)`);
  
  // Check memory limits before attempting to cache
  const stats = responseCache.getStats();
  const estimatedSize = responseCache._estimateObjectSize(upstreamResponse);
  logger.info(`Cache stats before caching attempt: ${stats.size} entries, ${stats.memoryUsageMB}MB used (${stats.memoryCapacityMB}MB max), estimated response size: ${Math.round(estimatedSize / 1024)}KB`);
  
  // Only cache responses that took a significant amount of time
  if (requestDuration < config.minResponseTimeToCache) {
    logger.info('Plugin', `NOT CACHING: Request duration (${requestDuration}ms) below threshold (${config.minResponseTimeToCache}ms)`);
    // Clean up pending requests - notify that request succeeded but wasn't cached
    cleanupPendingRequests(context, cacheKey, logger, true, false);
    requestContextMap.delete(req);
    return upstreamResponse;
  }
  
  // Check if the response is too large to cache
  const maxSingleItemSize = config.maxSingleItemSizeMB * 1024 * 1024; // Convert MB to bytes
  if (estimatedSize > maxSingleItemSize) {
    logger.warn('Plugin', `NOT CACHING: Response too large (estimated: ${Math.round(estimatedSize / 1024 / 1024)}MB > max: ${config.maxSingleItemSizeMB}MB)`);
    // Clean up pending requests - notify that request succeeded but wasn't cached
    cleanupPendingRequests(context, cacheKey, logger, true, false);
    requestContextMap.delete(req);
    return upstreamResponse;
  }
  
  // Check if we have enough memory to cache this response
  if (stats.currentMemoryUsage + estimatedSize > stats.maxMemoryBytes) {
    logger.warn('Plugin', `NOT CACHING: Would exceed memory limit (current: ${stats.memoryUsageMB}MB + estimated: ${Math.round(estimatedSize / 1024 / 1024)}MB > max: ${stats.memoryCapacityMB}MB)`);
    // Clean up pending requests - notify that request succeeded but wasn't cached
    cleanupPendingRequests(context, cacheKey, logger, true, false);
    requestContextMap.delete(req);
    return upstreamResponse;
  }
  
  logger.info(`ATTEMPTING TO CACHE: Response for key: ${cacheKey.substring(0, 8)}... (duration: ${requestDuration}ms exceeded threshold, size: ${Math.round(estimatedSize / 1024)}KB)`);
  
  // Get streaming flag from stored context (more reliable than detecting from potentially consumed body)
  const isStreaming = context.isStreaming;
  
  logger.info('Plugin', `Streaming detection: isStreaming=${isStreaming} (from stored context)`);
                      
  try {
    if (isStreaming) {
      // For streaming responses, we need to have captured events in the context
      if (context.capturedEvents && Array.isArray(context.capturedEvents)) {
        logger.info('Plugin', `Processing streaming response with ${context.capturedEvents.length} captured events`);
        
        // Check if the captured events are too large to safely process
        // Use constant-time guard to prevent OOM from JSON.stringify
        const TOO_MANY_EVENTS = 10_000;
        let eventsSize = Number.MAX_SAFE_INTEGER;
        
        if (context.capturedEvents.length > TOO_MANY_EVENTS) {
          logger.warn('Plugin', `NOT CACHING STREAMING: Too many captured events (${context.capturedEvents.length} > ${TOO_MANY_EVENTS}) - skipping size calculation to prevent OOM`);
          // Clean up pending requests - notify that request succeeded but wasn't cached
          cleanupPendingRequests(context, cacheKey, logger, true, false);
          requestContextMap.delete(req);
          return upstreamResponse;
        }
        
        try {
          eventsSize = responseCache._estimateObjectSize(context.capturedEvents);
          if (eventsSize > maxSingleItemSize) {
            logger.warn('Plugin', `NOT CACHING STREAMING: Captured events too large (estimated: ${Math.round(eventsSize / 1024 / 1024)}MB > max: ${config.maxSingleItemSizeMB}MB)`);
            // Clean up pending requests - notify that request succeeded but wasn't cached
            cleanupPendingRequests(context, cacheKey, logger, true, false);
            requestContextMap.delete(req);
            return upstreamResponse;
          }
        } catch (eventsSizeError: any) {
          logger.warn(`NOT CACHING STREAMING: Failed to estimate events size, likely too large: ${eventsSizeError.message}`);
          // Clean up pending requests - notify that request succeeded but wasn't cached
          cleanupPendingRequests(context, cacheKey, logger, true, false);
          requestContextMap.delete(req);
          return upstreamResponse;
        }
        
        // Extract model ID from request - use the stored one from beforeHandler first
        let modelId = context.cacheModelId || extractModelId(req);
        
        // If still unknown, try to extract from the actual streaming events
        if (modelId === 'unknown') {
          for (const event of context.capturedEvents) {
            if (event.type === 'message_start' && event.message?.model) {
              modelId = event.message.model;
              break;
            }
          }
        }
        
        logger.debug('Plugin', `Using model ID for conversion: ${modelId}`);
        
        // Convert streaming events to non-streaming format
        const nonStreamingResponse = convertStreamingToNonStreaming(context.capturedEvents, logger, modelId);
        
        // Now that we always normalize the 'stream' field, cache keys will differ only by URL path
        // Cache the current format (streaming) with both events and converted body
        const streamingCacheData: CacheData = {
          events: context.capturedEvents,
          body: nonStreamingResponse, // Add the converted body here too for cross-format lookup
          timestamp: Date.now(),
          duration: requestDuration
        };
        
        logger.debug(`Attempting to cache streaming format with key: ${cacheKey.substring(0, 8)}...`);
        const streamingCacheSuccess = responseCache.set(cacheKey, streamingCacheData, config.defaultTTL);
        
        if (streamingCacheSuccess) {
          logger.debug(`✅ CACHED STREAMING: SUCCESS for key: ${cacheKey.substring(0, 8)}...`);
        } else {
          logger.error(`❌ CACHE STREAMING: FAILED for key: ${cacheKey.substring(0, 8)}...`);
        }
        
        // Also cache the non-streaming format for direct non-streaming lookups
        // Generate a normalized cache key for non-streaming requests
        const normalizedCacheKey = generateCacheKey(req, true); // This will normalize the URL path
        
        if (normalizedCacheKey !== cacheKey && nonStreamingResponse) {
          const nonStreamingCacheData: CacheData = {
            body: nonStreamingResponse,
            timestamp: Date.now(),
            duration: requestDuration
          };
          
          logger.debug(`Attempting to cache non-streaming format with normalized key: ${normalizedCacheKey.substring(0, 8)}...`);
          const nonStreamingCacheSuccess = responseCache.set(normalizedCacheKey, nonStreamingCacheData, config.defaultTTL);
          
          if (nonStreamingCacheSuccess) {
            logger.debug(`✅ CACHED NON-STREAMING: SUCCESS for normalized key: ${normalizedCacheKey.substring(0, 8)}...`);
            logger.debug('Plugin', `✅ Successfully cached both formats for response (${context.capturedEvents.length} events converted)`);
          } else {
            logger.error(`❌ CACHE NON-STREAMING: FAILED for normalized key: ${normalizedCacheKey.substring(0, 8)}...`);
          }
        } else if (normalizedCacheKey === cacheKey) {
          logger.debug('Plugin', `✅ Single cache entry covers both streaming and non-streaming requests (${context.capturedEvents.length} events converted)`);
        } else {
          logger.warn('Plugin', '❌ Failed to convert streaming response to non-streaming format - no non-streaming cache created');
        }
      } else {
        logger.warn('Plugin', `NOT CACHING STREAMING: No captured events found (context.capturedEvents: ${context.capturedEvents ? 'exists but not array' : 'missing'})`);
      }
    } else {
      // For non-streaming, cache the response body
      const cacheData: CacheData = {
        body: upstreamResponse,
        timestamp: Date.now(),
        duration: requestDuration
      };
      
      logger.debug(`Attempting to cache non-streaming response with key: ${cacheKey.substring(0, 8)}...`);
      const cacheSuccess = responseCache.set(cacheKey, cacheData, config.defaultTTL);
      
      if (cacheSuccess) {
        logger.debug(`✅ CACHED NON-STREAMING: SUCCESS for key: ${cacheKey.substring(0, 8)}...`);
      } else {
        logger.error(`❌ CACHE NON-STREAMING: FAILED for key: ${cacheKey.substring(0, 8)}...`);
      }
    }
    
    // Log final cache stats
    const finalStats = responseCache.getStats();
    logger.debug(`Cache stats after caching attempt: ${finalStats.size} entries, ${finalStats.memoryUsageMB}MB used, ${finalStats.hits} hits, ${finalStats.misses} misses, ${finalStats.evictions} evictions`);
    
  } catch (error: any) {
    logger.error(`❌ ERROR during caching: ${error.message}`, { stack: error.stack });
  } finally {
    // Resolve any pending requests waiting for this response
    if (context && context.pendingRequestResolve && pendingRequests.has(cacheKey)) {
      logger.info(`🎯 RESOLVING PENDING REQUESTS: Notifying waiting requests for key: ${cacheKey.substring(0, 8)}...`);
      
      // Use safe resolution and cleanup
      SafePromise.safeResolve(context.pendingRequestResolve, { success: true, cached: true }, logger);
      
      // Safely remove from pending requests map
      try {
        pendingRequests.delete(cacheKey);
      } catch (deleteError: any) {
        logger.debug('[awsBedrockResponseCache] Error removing from pendingRequests map:', deleteError.message);
      }
    }
    
    // Clean up large arrays to help garbage collection
    try {
      if (context && context.capturedEvents) {
        context.capturedEvents = []; // Clear the array to free memory immediately
      }
    } catch (cleanupError: any) {
      logger.debug('[awsBedrockResponseCache] Error during capturedEvents cleanup:', cleanupError.message);
    }
    
    // Clean up the WeakMap entry to prevent memory leaks
    requestContextMap.delete(req);
  }
  
  // Return unmodified response
  return upstreamResponse;
}

/**
 * Convert streaming SSE events to non-streaming response format
 */
function convertStreamingToNonStreaming(events: StreamingEvent[], logger: Logger, modelId: string = 'unknown'): NonStreamingResponse | null {
  try {
    let messageStart: any = null;
    let contentBlocks: ContentBlock[] = [];
    let finalUsage: any = null;
    let stopReason: string | null = null;
    let messageIdFromEvents = `msg_cache_${Date.now()}`;
    
    // Use the provided modelId as fallback, but still try to extract from events
    let responseModelId = modelId;
    
    logger.debug('Plugin', `Converting ${events.length} captured events to non-streaming format`);
    
    // Process events to reconstruct the response
    for (const event of events) {
      // Handle Anthropic format events (already converted during replay)
      if (event.type === 'message_start') {
        messageStart = event.message;
        messageIdFromEvents = event.message.id;
        responseModelId = event.message.model || responseModelId; // Extract model from message_start
        logger.trace(`Found Anthropic message_start with ID: ${messageIdFromEvents}, model: ${responseModelId}`);
      } else if (event.type === 'content_block_start') {
        // Initialize content block
        if (event.content_block) {
          contentBlocks[event.index!] = {
            type: event.content_block.type,
            ...(event.content_block.type === 'text' ? { text: event.content_block.text || '' } : {}),
            ...(event.content_block.type === 'tool_use' ? {
              id: event.content_block.id,
              name: event.content_block.name,
              input: event.content_block.input || {}
            } : {})
          };
        }
      } else if (event.type === 'content_block_delta') {
        const blockIndex = event.index || 0;
        
        // AUTO-INITIALIZE content block if we haven't seen a start event
        if (!contentBlocks[blockIndex]) {
          if (event.delta && event.delta.type === 'text_delta') {
            contentBlocks[blockIndex] = { type: 'text', text: '' };
            logger.trace('Plugin', `Auto-initialized text content block ${blockIndex}`);
          } else if (event.delta && event.delta.type === 'input_json_delta') {
            contentBlocks[blockIndex] = { type: 'tool_use', input: {} };
            logger.trace('Plugin', `Auto-initialized tool_use content block ${blockIndex}`);
          }
        }
        
        // Append deltas to content block
        if (event.delta && event.delta.type === 'text_delta') {
          if (contentBlocks[blockIndex] && contentBlocks[blockIndex].type === 'text') {
            contentBlocks[blockIndex].text! += event.delta.text;
          }
        } else if (event.delta && event.delta.type === 'input_json_delta') {
          if (contentBlocks[blockIndex] && contentBlocks[blockIndex].type === 'tool_use') {
            // For tool use input_json_delta, ALWAYS concatenate as string - never try to parse partial JSON
            if (typeof contentBlocks[blockIndex].input === 'string') {
              contentBlocks[blockIndex].input += event.delta.partial_json;
            } else {
              // Initialize as string if it was an object
              contentBlocks[blockIndex].input = event.delta.partial_json;
            }
            logger.trace('Plugin', `Added input_json_delta to block ${blockIndex}: "${event.delta.partial_json}"`);
          }
        }
      } else if (event.type === 'content_block_stop') {
        const blockIndex = event.index || 0;
        // When tool use block stops, parse the accumulated input JSON
        if (contentBlocks[blockIndex] && contentBlocks[blockIndex].type === 'tool_use' && 
            typeof contentBlocks[blockIndex].input === 'string') {
          try {
            // Clean up the JSON string before parsing
            let inputString = (contentBlocks[blockIndex].input as string).trim();
            
            // Handle incomplete JSON by attempting to close it
            if (inputString && !inputString.endsWith('}')) {
              // Count open braces and try to close them
              const openBraces = (inputString.match(/\\{/g) || []).length;
              const closeBraces = (inputString.match(/\\}/g) || []).length;
              const missingCloseBraces = openBraces - closeBraces;
              
              if (missingCloseBraces > 0) {
                inputString += '}'.repeat(missingCloseBraces);
                logger.debug('Plugin', `Fixed incomplete JSON by adding ${missingCloseBraces} closing braces`);
              }
            }
            
            contentBlocks[blockIndex].input = JSON.parse(inputString);
            logger.trace('Plugin', `Parsed tool use input for block ${blockIndex}: ${JSON.stringify(contentBlocks[blockIndex].input)}`);
          } catch (e: any) {
            logger.warn('Plugin', `Failed to parse tool use input JSON for block ${blockIndex}: ${e.message}. Raw input: ${(contentBlocks[blockIndex].input as string).substring(0, 200)}...`);
            // Keep as string if parsing fails
          }
        }
      } else if (event.type === 'message_delta') {
        // Capture final usage and stop reason
        if (event.delta) {
          if (event.delta.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          if (event.usage) {
            finalUsage = event.usage;
          }
        }
      }
      // Handle Bedrock format events (from emulated streaming) - THESE are the ones we're actually getting
      else if (event.messageStart) {
        messageStart = {
          id: messageIdFromEvents,
          type: 'message',
          role: event.messageStart.role || 'assistant',
          content: [],
          model: responseModelId, // Use the passed-in model ID, not "unknown"
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        };
        logger.trace('Plugin', `Found Bedrock messageStart with role: ${event.messageStart.role}`);
      } else if (event.contentBlockStart) {
        const blockIndex = event.contentBlockIndex ?? 0;
        if (event.contentBlockStart.start?.toolUse) {
          // This is a tool use block
          contentBlocks[blockIndex] = {
            type: 'tool_use',
            id: event.contentBlockStart.start.toolUse.toolUseId.replace('tooluse_', 'toolu_bdrk_'),
            name: event.contentBlockStart.start.toolUse.name,
            input: {}
          };
          logger.trace('Plugin', `Initialized tool use block ${blockIndex} with name: ${event.contentBlockStart.start.toolUse.name}`);
        } else if (event.contentBlockStart.start?.text !== undefined) {
          contentBlocks[blockIndex] = {
            type: 'text',
            text: event.contentBlockStart.start.text || ''
          };
        } else {
          // Initialize empty text block if no start text
          contentBlocks[blockIndex] = {
            type: 'text',
            text: ''
          };
        }
        logger.trace('Plugin', `Initialized content block ${blockIndex}`);
      } else if (event.contentBlockDelta) {
        const blockIndex = event.contentBlockIndex ?? 0;
        
        // AUTO-INITIALIZE content block if we haven't seen a start event
        if (!contentBlocks[blockIndex]) {
          if (event.contentBlockDelta.delta?.text !== undefined) {
            contentBlocks[blockIndex] = { type: 'text', text: '' };
            logger.trace('Plugin', `Auto-initialized text content block ${blockIndex} from Bedrock delta`);
          } else if (event.contentBlockDelta.delta?.toolUse?.input !== undefined) {
            contentBlocks[blockIndex] = { type: 'tool_use', input: '' };
            logger.trace('Plugin', `Auto-initialized tool_use content block ${blockIndex} from Bedrock delta`);
          }
        }
        
        if (event.contentBlockDelta.delta?.text !== undefined) {
          // Text content delta
          if (contentBlocks[blockIndex] && contentBlocks[blockIndex].type === 'text') {
            contentBlocks[blockIndex].text! += event.contentBlockDelta.delta.text;
            logger.trace('Plugin', `Added text delta to block ${blockIndex}: "${event.contentBlockDelta.delta.text}"`);
          }
        } else if (event.contentBlockDelta.delta?.toolUse?.input !== undefined) {
          // Tool use input delta
          if (contentBlocks[blockIndex] && contentBlocks[blockIndex].type === 'tool_use') {
            // Concatenate the tool use input (it comes as incremental JSON string)
            if (typeof contentBlocks[blockIndex].input === 'string') {
              contentBlocks[blockIndex].input += event.contentBlockDelta.delta.toolUse.input;
            } else {
              contentBlocks[blockIndex].input = event.contentBlockDelta.delta.toolUse.input;
            }
            logger.trace('Plugin', `Added tool use input delta to block ${blockIndex}: "${event.contentBlockDelta.delta.toolUse.input}"`);
          }
        }
      } else if (event.contentBlockStop) {
        const blockIndex = event.contentBlockIndex ?? 0;
        // When tool use block stops, parse the accumulated input JSON
        if (contentBlocks[blockIndex] && contentBlocks[blockIndex].type === 'tool_use' && 
            typeof contentBlocks[blockIndex].input === 'string') {
          try {
            // Clean up the JSON string before parsing
            let inputString = (contentBlocks[blockIndex].input as string).trim();
            
            // Handle incomplete JSON by attempting to close it
            if (inputString && !inputString.endsWith('}')) {
              // Count open braces and try to close them
              const openBraces = (inputString.match(/\\{/g) || []).length;
              const closeBraces = (inputString.match(/\\}/g) || []).length;
              const missingCloseBraces = openBraces - closeBraces;
              
              if (missingCloseBraces > 0) {
                inputString += '}'.repeat(missingCloseBraces);
                logger.debug('Plugin', `Fixed incomplete JSON by adding ${missingCloseBraces} closing braces`);
              }
            }
            
            contentBlocks[blockIndex].input = JSON.parse(inputString);
            logger.trace('Plugin', `Parsed tool use input for block ${blockIndex}: ${JSON.stringify(contentBlocks[blockIndex].input)}`);
          } catch (e: any) {
            logger.warn('Plugin', `Failed to parse tool use input JSON for block ${blockIndex}: ${e.message}. Raw input: ${(contentBlocks[blockIndex].input as string).substring(0, 200)}...`);
            // Keep as string if parsing fails
          }
        }
      } else if (event.messageStop) {
        stopReason = event.messageStop.stopReason;
        logger.trace('Plugin', `Found messageStop with reason: ${stopReason}`);
      } else if (event.metadata && event.metadata.usage) {
        finalUsage = {
          output_tokens: event.metadata.usage.outputTokens || 0,
          input_tokens: event.metadata.usage.inputTokens || 0
        };
        logger.trace('Plugin', `Found usage data: ${JSON.stringify(finalUsage)}`);
      }
    }
    
    // Create a basic message structure if we don't have messageStart but have content
    if (!messageStart && contentBlocks.length > 0) {
      messageStart = {
        id: messageIdFromEvents,
        type: 'message',
        role: 'assistant',
        content: [],
        model: responseModelId,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      };
      logger.debug('Plugin', 'Created messageStart from content blocks since none was found');
    }
    
    // If we found a messageStart, construct the response
    if (messageStart) {
      const nonStreamingResponse: NonStreamingResponse = {
        id: messageStart.id,
        type: messageStart.type,
        role: messageStart.role,
        content: contentBlocks.filter(block => block && (block.text !== undefined || block.input !== undefined)), // Include both text and tool use blocks
        model: responseModelId, // Use the extracted/provided model ID
        stop_reason: stopReason || messageStart.stop_reason,
        stop_sequence: messageStart.stop_sequence,
        usage: {
          input_tokens: finalUsage?.input_tokens || messageStart.usage?.input_tokens || 0,
          output_tokens: finalUsage?.output_tokens || messageStart.usage?.output_tokens || 0
        }
      };
      
      const textContent = nonStreamingResponse.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
      const toolCount = nonStreamingResponse.content.filter(block => block.type === 'tool_use').length;
      logger.debug(`Converted streaming response with ${contentBlocks.length} content blocks (${toolCount} tool use, text length: ${textContent.length})`);
      return nonStreamingResponse;
    } else {
      // If no messageStart found, create a minimal valid response from the content we do have
      const validContentBlocks = contentBlocks.filter(block => block && (block.text !== undefined || block.input !== undefined));
      if (validContentBlocks.length > 0) {
        logger.warn('No messageStart found, creating minimal response from content blocks');
        return {
          id: messageIdFromEvents,
          type: 'message',
          role: 'assistant',
          content: validContentBlocks,
          model: responseModelId, // Use the extracted/provided model ID
          stop_reason: stopReason || 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: finalUsage?.input_tokens || 0,
            output_tokens: finalUsage?.output_tokens || 0
          }
        };
      }
    }
    
    logger.warn('Plugin', 'No valid message content found in streaming response');
    return null;
  } catch (error: any) {
    logger.error('Plugin', `Error converting streaming to non-streaming: ${error.message}`);
    return null;
  }
}

/**
 * Stream handler - processes streaming responses as they arrive
 */
async function streamHandler({ req, chunk, utils }: PluginContext): Promise<StreamHandlerResult> {
  const logger = utils.logger;
  
  logger.trace('Plugin', '🔥🔥🔥 STREAM HANDLER CALLED 🔥🔥🔥');
  
  // Check if we have context from beforeHandler
  let context = requestContextMap.get(req);
  if (!context) {
    // No context means beforeHandler didn't run (request didn't meet size criteria)
    // This is expected for smaller requests, so we just pass through
    logger.trace('Plugin', 'No context from beforeHandler - request likely below size threshold');
    return { chunk: chunk!, capturedEvents: [] };
  }
  
  if (!context.capturedEvents) {
    context.capturedEvents = [];
  }
  if (context.lastReturnedEventCount === undefined) {
    context.lastReturnedEventCount = 0;
  }

  // Hard guard to prevent runaway memory - truncate if too many events
  const MAX_EVENTS = 200_000;
  if (context.capturedEvents.length > MAX_EVENTS) {
    logger.warn('[awsBedrockResponseCache] capturedEvents cap hit; truncating to prevent OOM');
    context.capturedEvents = context.capturedEvents.slice(-MAX_EVENTS);
    // Reset the counter since we truncated
    context.lastReturnedEventCount = 0;
  }
  
  try {
    const data = chunk!.toString();
    logger.trace('Plugin', `Processing chunk (${data.length} bytes): ${JSON.stringify(data.substring(0, 100))}`);
    
    // Handle different streaming formats
    if (data.startsWith('data: ')) {
      // Standard SSE format
      const eventData = data.substring(6).trim();
      logger.trace('✅ Found SSE format event:', JSON.stringify(eventData.substring(0, 50)));
      try {
        if (eventData && eventData !== '[DONE]') {
          const parsedData = JSON.parse(eventData);
          context.capturedEvents!.push(parsedData);
          
          logger.trace(`✅ Captured SSE event, total events: ${context.capturedEvents!.length}`);
        }
      } catch (parseError: any) {
        logger.trace('❌ Failed to parse SSE event data:', parseError.message);
      }
    } else if (data.trim().startsWith('{') && data.trim().endsWith('}')) {
      // Raw JSON format (might be AWS Bedrock format)
      logger.trace('Plugin', '✅ Found raw JSON format');
      
      try {
        const parsedData = JSON.parse(data.trim());
        context.capturedEvents!.push(parsedData);
        
        logger.trace(`✅ Captured JSON event, total events: ${context.capturedEvents!.length}`);
      } catch (parseError: any) {
        logger.trace('❌ Failed to parse raw JSON:', parseError.message);
      }
    } else if (data.includes('data:')) {
      // Multiple SSE events in one chunk
      logger.trace('Plugin', '✅ Found multiple SSE events in chunk');
      
      const lines = data.split('\
');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const eventData = line.substring(6).trim();
          try {
            if (eventData && eventData !== '[DONE]') {
              const parsedData = JSON.parse(eventData);
              context.capturedEvents!.push(parsedData);
            }
          } catch (parseError: any) {
            logger.trace('❌ Failed to parse multi-line SSE event:', parseError.message);
          }
        }
      }
      
      logger.trace(`✅ Captured multi-line events, total events: ${context.capturedEvents!.length}`);
    } else {
      logger.trace('❌ Unknown chunk format, first 100 chars:', JSON.stringify(data.substring(0, 100)));
    }
    
  } catch (error: any) {
    logger.trace('❌ Error in stream handler:', error.message);
  }
  
  // Return only NEW events since last call to prevent quadratic memory growth
  const newEvents = context.capturedEvents.slice(context.lastReturnedEventCount);
  context.lastReturnedEventCount = context.capturedEvents.length;
  
  return {
    chunk: chunk!,
    capturedEvents: newEvents  // Only new events, not the entire accumulated array
  };
}

/**
 * Generate a cache key from request data, with option to normalize certain fields
 */
function generateCacheKey(req: PluginRequest, normalizeStreaming: boolean = false): string {
  // Extract relevant headers (handle missing headers gracefully)
  const headers: Record<string, string> = {};
  
  // Headers to exclude from cache key generation (retry-related headers that shouldn't affect caching)
  const excludeHeaders = new Set([
    'x-request-id', 'x-trace-id', 'x-correlation-id', 'x-retry-count', 'x-attempt',
    'request-id', 'trace-id', 'correlation-id', 'retry-count', 'attempt',
    'x-amzn-trace-id', 'x-amzn-requestid', 'x-forwarded-for', 'x-real-ip',
    'user-agent', 'accept', 'accept-encoding', 'accept-language', 'cache-control',
    'connection', 'host', 'content-length', 'date', 'if-none-match', 'if-modified-since'
  ]);
  
  if (req.headers && typeof req.headers === 'object') {
    for (const header of config.uniqueRequestHeaders) {
      if (req.headers[header] && !excludeHeaders.has(header.toLowerCase())) {
        headers[header] = req.headers[header] as string;
      }
    }
  }
  
  // Extract path and model information
  let url = req.originalUrl || req.url || '';
  
  // Normalize URL for cross-format cache lookup if requested
  if (normalizeStreaming) {
    // Convert both streaming and non-streaming URLs to the same base format
    url = url.replace(/\/invoke-with-response-stream/g, '/invoke');
  }
  
  // Use the complete request payload to ensure uniqueness (handle missing body gracefully)
  const requestPayload = req.body ? JSON.parse(JSON.stringify(req.body)) : {};
  
  // ALWAYS remove the 'stream' field from payload to ensure same cache key for same content
  // regardless of streaming vs non-streaming request type
  if (requestPayload && 'stream' in requestPayload) {
    delete requestPayload.stream;
  }
  
  // Remove common retry-related fields from payload that shouldn't affect caching
  const excludePayloadFields = ['request_id', 'trace_id', 'correlation_id', 'retry_count', 'attempt'];
  excludePayloadFields.forEach(field => {
    if (requestPayload && field in requestPayload) {
      delete requestPayload[field];
    }
  });
  
  // Create a string from combined data
  const dataToHash = JSON.stringify({
    headers,
    url,
    payload: requestPayload
  });
  
  // Generate a SHA-512/256 hash
  return crypto.createHash('sha512-256').update(dataToHash).digest('hex');
}

// Plugin rule interface
interface PluginErrorContext {
  req: PluginRequest;
  error: Error;
  utils: PluginUtils;
}

interface PluginRule {
  id: string;
  match: string[];
  strategy: 'before' | 'after' | 'stream' | 'error';
  handler: (context: PluginContext) => Promise<any>;
}

interface PluginErrorRule {
  id: string;
  match: string[];
  strategy: 'error';
  handler: (context: PluginErrorContext) => Promise<any>;
}

/**
 * Error handler - clean up pending requests when requests fail
 */
async function errorHandler({ req, error, utils }: PluginErrorContext): Promise<Error> {
  const logger = utils.logger;
  
  logger.debug('Plugin', `ErrorHandler called for request: ${req.method} ${req.originalUrl || req.url} - Error: ${error.message}`);
  
  // Get context from WeakMap
  const context = requestContextMap.get(req);
  if (context && context.cacheKey) {
    const { cacheKey } = context;
    
    logger.info(`🚨 REQUEST FAILED: Cleaning up pending requests for key: ${cacheKey.substring(0, 8)}... - Error: ${error.message}`);
    
    // Clean up pending requests - notify that request failed
    cleanupPendingRequests(context, cacheKey, logger, false, false);
    
    // Clean up request start times if they exist
    if (context.cacheRequestId) {
      try {
        requestStartTimes.delete(context.cacheRequestId);
      } catch (deleteError: any) {
        logger.debug('[awsBedrockResponseCache] Error cleaning up requestStartTimes in errorHandler:', deleteError.message);
      }
    }
    
    // Clean up large arrays to help garbage collection
    try {
      if (context.capturedEvents) {
        context.capturedEvents = []; // Clear the array to free memory immediately
      }
    } catch (cleanupError: any) {
      logger.debug('[awsBedrockResponseCache] Error during capturedEvents cleanup in errorHandler:', cleanupError.message);
    }
    
    // Clean up the WeakMap entry
    try {
      requestContextMap.delete(req);
    } catch (deleteError: any) {
      logger.debug('[awsBedrockResponseCache] Error cleaning up requestContextMap:', deleteError.message);
    }
  }
  
  // Return the error to continue normal error handling
  return error;
}

// Export the plugin rules (match conditions now centralized in api_config.json)
const pluginRules: (PluginRule | PluginErrorRule)[] = [
  {
    id: "awsBedrockResponseCache",
    match: [], // Match rules moved to api_config.json
    strategy: "before",
    handler: beforeHandler
  },
  {
    id: "awsBedrockResponseCache", 
    match: [], // Match rules moved to api_config.json
    strategy: "after",
    handler: afterHandler
  },
  {
    id: "awsBedrockResponseCache",
    match: [], // Match rules moved to api_config.json
    strategy: "error",
    handler: errorHandler
  } as PluginErrorRule,
  {
    id: "awsBedrockResponseCache",
    match: [], // Match rules moved to api_config.json
    strategy: "stream",
    handler: streamHandler
  }
];

export = pluginRules;