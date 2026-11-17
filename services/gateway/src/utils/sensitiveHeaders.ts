import { Request, Response } from 'express';
import { redactUrl, redactQuery } from './redactUrl';
import { API_KEY_HEADERS } from './extractApiKey';

/*
 * The payload logger's redaction of a stage's request and response facts, in a module of its own so
 * that the raw capture (services/rawCapture.ts), which the payload logger feeds, can use it without an
 * import cycle.
 */

// Headers that should be filtered out for security
const SENSITIVE_HEADERS = [
  'authorization',
  ...API_KEY_HEADERS,
  'x-auth-token',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-session-id',
  'proxy-authorization',
  'www-authenticate',
  'x-forwarded-authorization',
  // Provider connection credentials: the Azure OpenAI key, an AWS session token, a Google API key
  'api-key',
  'x-amz-security-token',
  'x-goog-api-key'
];

export function filterSensitiveHeaders(headers: Record<string, any>): Record<string, string> {
  const filtered: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.includes(lowerKey)) {
      filtered[key] = '[REDACTED]';
    } else if (lowerKey === 'referer' || lowerKey === 'referrer') {
      filtered[key] = redactUrl(String(value));
    } else {
      filtered[key] = String(value);
    }
  }
  
  return filtered;
}

export interface StageFacts {
  httpMethod?: string;
  url?: string;
  queryParams?: Record<string, unknown>;
  requestHeaders?: Record<string, string>;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
}

/**
 * The request facts of a stage (method, URL, query, headers) when it came with `req`, the response facts
 * (status, headers set so far) when it came with `res`; URL, query and headers redacted.
 */
export function stageFacts(req?: Request, res?: Response): StageFacts {
  const facts: StageFacts = {};
  if (req) {
    facts.httpMethod = req.method;
    facts.url = redactUrl(req.originalUrl || req.url);
    facts.queryParams = req.query && Object.keys(req.query).length > 0 ? redactQuery(req.query as Record<string, unknown>) : undefined;
    facts.requestHeaders = filterSensitiveHeaders(req.headers);
  }
  if (res) {
    facts.statusCode = res.statusCode;
    // Get response headers (if any have been set)
    const responseHeaders = res.getHeaders();
    if (Object.keys(responseHeaders).length > 0) {
      facts.responseHeaders = filterSensitiveHeaders(responseHeaders as Record<string, any>);
    }
  }
  return facts;
}
