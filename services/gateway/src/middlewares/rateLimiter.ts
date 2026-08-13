import { Request, Response, NextFunction } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { secretLabel } from '../utils/secretLabel';
const logger = getDefaultLogger();

interface RateLimitEntry {
  count: number;
  startTime: number;
  pendingRequests: Set<string>;
}

interface RateLimitedRequest extends Request {
  bypassRateLimit?: boolean;
  isAwsAuthenticated?: boolean;
  awsCredentials?: {
    accessKeyId: string;
  };
  apiKey?: {
    key: string;
  };
  rateLimitRequestId?: string;
  body: {
    model?: string;
    [key: string]: any;
  };
}

// Builds a non-reversible label for log lines so requests remain correlatable
// without ever exposing the raw identifier (API key or AWS access key ID).
const bucketLabel = (identifier: string, model: string): string => {
  return `${secretLabel(identifier)}-${model}`;
};

// A simple in‑memory rate limiter keyed by API key and model. In production, integrate with your CDS ModelRateLimit data.
const rateLimitMap = new Map<string, RateLimitEntry>();
// Default limit if not defined in the CDS model
const DEFAULT_RATE_LIMIT = 100; // requests per minute

const rateLimiter = (req: RateLimitedRequest, res: Response, next: NextFunction): void => {
  try {
    // Check if this request should bypass rate limiting (set by plugins)
    if (req.bypassRateLimit) {
      logger.debug('RateLimiter', 'Bypassing rate limit due to req.bypassRateLimit flag');
      return next();
    }
    
    // Support both API key and AWS authentication
    let identifier: string;
    if (req.isAwsAuthenticated && req.awsCredentials) {
      identifier = req.awsCredentials.accessKeyId;
    } else if (req.apiKey && req.apiKey.key) {
      identifier = req.apiKey.key;
    } else {
      // No valid authentication found, should not reach here normally
      res.status(401).json({
        error: {
          message: 'No valid authentication found for rate limiting',
          type: 'authentication_error'
        }
      });
      return;
    }
    
    const model = req.body.model || 'default';
    const key = `${identifier}-${model}`;
    const label = bucketLabel(identifier, model);
    const currentTime = Date.now();
    const windowTime = 60000; // 60 seconds
    let entry = rateLimitMap.get(key);
    if (!entry) {
      entry = { count: 0, startTime: currentTime, pendingRequests: new Set() };
      rateLimitMap.set(key, entry);
    } else if (!entry.pendingRequests) {
      // Add pendingRequests to existing entries that don't have it
      entry.pendingRequests = new Set();
    }
    
    // Reset the counter if the time window has passed
    if (currentTime - entry.startTime > windowTime) {
      entry.count = 0;
      entry.startTime = currentTime;
      entry.pendingRequests.clear();
    }
    
    // Generate a unique ID for this request
    const requestId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    req.rateLimitRequestId = requestId;
    
    // In production, look up allowed limit from your ModelRateLimit CDS data.
    const allowed = DEFAULT_RATE_LIMIT;
    if (entry.count >= allowed) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }
    
    // Instead of incrementing immediately, track this request as pending
    entry.pendingRequests.add(requestId);
    
    // Only increment the counter when the response finishes, 
    // unless a plugin has set the bypassRateLimit flag
    res.on('finish', () => {
      if (!req.bypassRateLimit && entry!.pendingRequests.has(requestId)) {
        entry!.count++;
        entry!.pendingRequests.delete(requestId);
        logger.debug('RateLimiter', `Request ${requestId} counted against rate limit for ${label}, new count: ${entry!.count}`);
      } else if (req.bypassRateLimit && entry!.pendingRequests.has(requestId)) {
        entry!.pendingRequests.delete(requestId);
        logger.debug('RateLimiter', `Request ${requestId} bypassed rate limit for ${label}, not counted`);
      }
    });
    
    next();
  } catch (err) {
    next(err);
  }
};

export default rateLimiter;