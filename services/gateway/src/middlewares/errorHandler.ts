import { Request, Response, NextFunction } from 'express';

// Use require for CommonJS module
import { getDefaultLogger } from '@libs/logger';
// One allow-list of client-safe upstream error fields, shared with the Responses
// envelope and the streaming translator. Three copies of a security filter is how
// one of them silently falls behind.
import { sanitizeUpstreamErrorObject, unwrapUpstreamError } from '../utils/upstreamErrorEnvelope';
const logger = getDefaultLogger();

interface CustomError extends Error {
  status?: number;
  details?: {
    message?: string;
    code?: string | number;
    location?: string;
    request_id?: string;
    [key: string]: any;
  };
}

const errorHandler = (err: CustomError, _req: Request, res: Response, _next: NextFunction): void => {
  logger.error('ErrorHandler', err.message || 'Error occurred', err);
  
  // Determine the appropriate status code
  const statusCode = err.status || 500;
  
  // Create a response object with error details
  const errorResponse: any = {
    error: {
      message: err.message || 'Internal Server Error',
      type: 'api_error',
      code: statusCode
    }
  };
  
  // If there are additional details from SAP AI Core, include them — FILTERED.
  //
  // `err.details` is `error.response?.data` straight off the upstream call
  // (sapAIService.ts:161,228), and SAP's error body carries
  // `intermediate_results.templating`: the fully templated prompt, system
  // instructions and conversation included. Assigning it wholesale — which this
  // did — returned the caller its own system prompt on any 400. Measured with
  // canary strings on /openai/v1/chat/completions and /anthropic/v1/messages,
  // 2026-08-14. See utils/upstreamErrorEnvelope.ts for the full note.
  if (err.details) {
    // Two shapes reach here. SAP nests everything under `error`
    // (`{error:{message,code,location,request_id,intermediate_results}}`); other
    // upstreams put those fields at the top level. Unwrapping first is why the
    // real message now surfaces at all: before this, the nested shape left
    // `err.details.message` undefined and the client saw only axios's
    // "Request failed with status code 400".
    const safe = sanitizeUpstreamErrorObject(unwrapUpstreamError(err.details));
    if (Object.keys(safe).length > 0) {
      errorResponse.error.details = safe;
    }

    if (safe.message) {
      errorResponse.error.message = safe.message;
    }
    if (safe.code) {
      errorResponse.error.code = safe.code;
    }
    if (safe.location) {
      errorResponse.error.location = safe.location;
    }
    if (safe.request_id) {
      errorResponse.error.request_id = safe.request_id;
    }
  }
  
  res.status(statusCode).json(errorResponse);
};

export default errorHandler;