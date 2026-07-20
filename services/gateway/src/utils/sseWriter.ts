import { Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface SSEData {
  [key: string]: any;
}

interface ErrorWithDetails extends Error {
  status?: number;
  details?: {
    message?: string;
    code?: string | number;
    request_id?: string;
  };
}

export const writeChunk = (res: Response, chunk: string | SSEData): void => {
  // Skip if response is already ended or not writable
  if (!res.writable || res.writableEnded) {
    logger.debug('SSEWriter', 'Cannot write chunk - response not writable');
    return;
  }
  
  // Ensure chunk is a string
  const chunkStr = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
  
  // Write a data chunk in SSE format with detailed logging
  logger.trace('SSEWriter', `Writing SSE chunk (${chunkStr.length} bytes)`, { chunkPreview: chunkStr.substring(0, 100) + (chunkStr.length > 100 ? '...' : '') });
  
  try {
    // Ensure proper content-type is set
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    }
    
    // Proper SSE format requires data: prefix and double newline
    const sseChunk = `data: ${chunkStr}\n\n`;
    const writeResult = res.write(sseChunk);
    logger.trace('SSEWriter', `Write result: ${writeResult}`);
  } catch (writeError: any) {
    logger.error('SSEWriter', 'Error writing chunk to client:', writeError);
  }
};

/**
 * Write an SSE event with a specific event type (for Anthropic API)
 * @param res - Express response object
 * @param event - Event type
 * @param data - Event data
 */
export const writeEventStream = (res: Response, event: string, data: string | SSEData): void => {
  // Skip if response is already ended or not writable
  if (!res.writable || res.writableEnded) {
    logger.debug('SSEWriter', `Cannot write event ${event} - response not writable`);
    return;
  }
  
  // Ensure data is a string
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  
  // Write an event in SSE format with improved logging
  logger.trace('SSEWriter', `Writing SSE event ${event}`, { dataPreview: dataStr.substring(0, 100) + (dataStr.length > 100 ? '...' : '') });
  
  try {
    // Ensure proper content-type is set
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
      
      // First byte sent - log this for latency tracking
      logger.debug('SSEWriter', `Headers sent at ${new Date().toISOString()}`);
    }
    
    // Construct proper SSE format (event: name\ndata: data\n\n)
    const sseData = `event: ${event}\ndata: ${dataStr}\n\n`;
    logger.trace('SSEWriter', `Raw SSE data being sent (${sseData.length} bytes}`);
    
    // Write to response and check if we need to wait for drain
    const writeResult = res.write(sseData);
    
    if (!writeResult) {
      logger.debug('SSEWriter', 'Write buffer full, waiting for drain event');
      // Handle backpressure (optional - could add drain event handler here)
    }
  } catch (writeError: any) {
    // More detailed error handling
    logger.error('SSEWriter', `Error writing ${event} event to client:`, writeError);
  }
};

export const writeDone = (res: Response): void => {
  // Skip if response is already ended or not writable
  if (!res.writable || res.writableEnded) {
    logger.debug('SSEWriter', 'Skip sending DONE - connection already closed');
    return;
  }
  
  // Signal stream completion
  logger.debug('SSEWriter', 'Writing SSE [DONE] signal');
  try {
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (writeError: any) {
    // Silent handling of write errors (client likely disconnected)
    logger.debug('SSEWriter', 'Could not write DONE to client - connection already closed');
  }
};

export const writeError = (res: Response, err: string | ErrorWithDetails | Error | SSEData): void => {
  // Skip if response is already ended or not writable
  if (!res.writable || res.writableEnded) {
    return;
  }
  
  // Only log full error in debug mode
  if (process.env.DEBUG === 'true') {
    logger.debug('SSEWriter', 'Writing SSE error:', { error: err });
  } else {
    logger.info('SSEWriter', 'Writing SSE error message to client');
  }
  
  let errorPayload: SSEData;
  
  if (typeof err === 'string') {
    // Simple string error
    errorPayload = { error: { message: err } };
  } else if ('error' in err && err.error) {
    // Already formatted error object
    errorPayload = err as SSEData;
  } else if (err instanceof Error) {
    // Standard Error object
    const errorWithDetails = err as ErrorWithDetails;
    errorPayload = { 
      error: { 
        message: err.message,
        type: 'api_error',
        code: errorWithDetails.status || 500
      } 
    };
    
    // Add details if available and debug is enabled
    if (errorWithDetails.details && process.env.DEBUG === 'true') {
      errorPayload.error.details = errorWithDetails.details;
      
      // Use SAP AI Core specific fields if available
      if (errorWithDetails.details.message) {
        errorPayload.error.message = errorWithDetails.details.message;
      }
      if (errorWithDetails.details.code) {
        errorPayload.error.code = errorWithDetails.details.code;
      }
      if (errorWithDetails.details.request_id) {
        errorPayload.error.request_id = errorWithDetails.details.request_id;
      }
    }
  } else {
    // Unknown error format, convert to string
    errorPayload = { error: { message: String(err) } };
  }
  
  try {
    // Write the error in SSE format (only log summary in production)
    if (process.env.DEBUG === 'true') {
      logger.debug('SSEWriter', `Writing formatted error: ${JSON.stringify(errorPayload).substring(0, 200)}...`);
    }
    
    res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
    res.end();
  } catch (writeError: any) {
    // Silent handling of write errors (client likely disconnected)
    logger.debug('SSEWriter', 'Could not write error to client - connection already closed');
  }
};

/**
 * Write an SSE ping (comment) to keep the connection alive.
 * @param res - Express response object
 */
export const writePing = (res: Response): void => {
  // Skip if response is already ended or not writable
  if (!res.writable || res.writableEnded) {
    logger.debug('SSEWriter', 'Cannot write ping - response not writable');
    return;
  }
  
  logger.trace('SSEWriter', 'Sending ping to keep connection alive');
  
  try {
    // Ensure proper content-type is set
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
    }
    
    // Write a comment as ping (standard SSE practice)
    res.write(': ping\n\n');

    // Also write a ping event for clients that might not properly handle comments.
    // Framed with `event: ping` like Anthropic's wire format — strict SSE parsers
    // (claude-cli >= 2.1.215) require the event: field on every data block.
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
  } catch (writeError: any) {
    logger.error('SSEWriter', 'Error writing ping to client:', writeError);
  }
};