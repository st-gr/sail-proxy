import { Request } from 'express';
import { UsageEvent, UsageMetrics } from '../types/usage';
import usageEmitter from '../services/usageEventEmitter';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();
import { isStandaloneMode } from '../config/unifiedAuthConfig';

/**
 * Extract authentication info from request for usage tracking
 */
export function extractAuthInfo(req: Request): { authType: 'api_key' | 'aws_credential'; credentialId: string } | null {
  try {
    // Check unified auth first
    if ((req as any).unifiedAuth?.valid) {
      return {
        authType: (req as any).unifiedAuth.authType,
        credentialId: (req as any).unifiedAuth.data?.id || (req as any).unifiedAuth.data?.keyId || (req as any).unifiedAuth.data?.credentialId || 'unknown'
      };
    }

    // Fallback to legacy auth patterns
    if ((req as any).apiKey?.id) {
      return {
        authType: 'api_key' as const,
        credentialId: (req as any).apiKey.id
      };
    }

    if ((req as any).awsCredential?.accessKeyId) {
      return {
        authType: 'aws_credential' as const, 
        credentialId: (req as any).awsCredential.accessKeyId
      };
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Create usage metrics tracker for request
 */
export function createUsageMetrics(): UsageMetrics {
  return {
    startTime: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  };
}

/**
 * Update token counts in usage metrics with separate cache token tracking
 */
export function updateTokenCounts(
  metrics: UsageMetrics, 
  inputTokens: number, 
  outputTokens: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number
): void {
  const safeInputTokens = inputTokens || 0;
  const safeOutputTokens = outputTokens || 0;
  const safeCacheCreationTokens = cacheCreationInputTokens || 0;
  const safeCacheReadTokens = cacheReadInputTokens || 0;
  
  metrics.inputTokens += safeInputTokens;
  metrics.outputTokens += safeOutputTokens;
  metrics.cacheCreationInputTokens = (metrics.cacheCreationInputTokens || 0) + safeCacheCreationTokens;
  metrics.cacheReadInputTokens = (metrics.cacheReadInputTokens || 0) + safeCacheReadTokens;
  
  // Add instrumentation logging
  logger.info('UsageTrackingService', 'Token counts updated', {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheCreationInputTokens: metrics.cacheCreationInputTokens,
    cacheReadInputTokens: metrics.cacheReadInputTokens,
    delta: { 
      input: safeInputTokens, 
      output: safeOutputTokens,
      cacheCreation: safeCacheCreationTokens,
      cacheRead: safeCacheReadTokens,
      originalInput: inputTokens,
      originalOutput: outputTokens,
      originalCacheCreation: cacheCreationInputTokens,
      originalCacheRead: cacheReadInputTokens
    }
  });
}

/**
 * Emit usage event - minimal overhead, fire-and-forget
 * Provider is now resolved from model cache instead of being passed in
 */
export async function emitUsageEvent(
  req: Request,
  metrics: UsageMetrics,
  model: string,
  statusCode: number
): Promise<void> {
  try {
    // Skip usage tracking in standalone mode
    if (isStandaloneMode()) {
      return;
    }

    const authInfo = extractAuthInfo(req);
    if (!authInfo) return; // Skip if no auth info available

    // Provider will be resolved by admin service from model data
    // Gateway no longer needs to resolve providers during request processing
    const provider = 'unknown';

    const responseTime = Date.now() - metrics.startTime;
    
    // Extract clean endpoint without provider-specific path components
    const originalUrl = req.originalUrl || req.url || '';
    let endpoint = originalUrl;
    
    // Remove query parameters for cleaner endpoint tracking
    if (endpoint.includes('?')) {
      endpoint = endpoint.split('?')[0];
    }
    
    const event: UsageEvent = {
      requestId: (req as any).debugRequestId || 'unknown',
      timestamp: Math.floor(Date.now() / 1000), // Unix timestamp
      authType: authInfo.authType,
      credentialId: authInfo.credentialId,
      provider,
      model,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheCreationInputTokens: metrics.cacheCreationInputTokens,
      cacheReadInputTokens: metrics.cacheReadInputTokens,
      responseTime,
      statusCode,
      endpoint,
      usageEstimated: metrics.usageEstimated
    };

    // Add comprehensive logging before emission
    logger.info('UsageTrackingService', 'Emitting usage event', {
      requestId: event.requestId,
      provider: event.provider,
      model: event.model,
      tokens: {
        input: event.inputTokens,
        output: event.outputTokens,
        cacheCreation: event.cacheCreationInputTokens,
        cacheRead: event.cacheReadInputTokens,
        total: event.inputTokens + event.outputTokens + (event.cacheCreationInputTokens || 0) + (event.cacheReadInputTokens || 0)
      },
      authType: event.authType,
      credentialId: event.credentialId,
      statusCode: event.statusCode,
      responseTime: event.responseTime
    });

    // Fire and forget - don't await to minimize overhead
    usageEmitter.emit(event).catch((error) => {
      logger.error('UsageTrackingService', 'Failed to emit usage event', error, {
        requestId: event.requestId
      });
    });
  } catch (error) {
    // Never throw from usage tracking
  }
}