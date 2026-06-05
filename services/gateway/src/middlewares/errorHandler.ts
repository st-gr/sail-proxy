import { Request, Response, NextFunction } from 'express';

// Use require for CommonJS module
import { getDefaultLogger } from '@libs/logger';
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
  
  // If there are additional details from SAP AI Core, include them
  if (err.details) {
    // Include the SAP AI Core error details
    errorResponse.error.details = err.details;
    
    // If the SAP AI Core error has a specific message, use it
    if (err.details.message) {
      errorResponse.error.message = err.details.message;
    }
    
    // If the SAP AI Core error has a specific code, include it
    if (err.details.code) {
      errorResponse.error.code = err.details.code;
    }
    
    // Include any location information
    if (err.details.location) {
      errorResponse.error.location = err.details.location;
    }
    
    // Include the request ID if available
    if (err.details.request_id) {
      errorResponse.error.request_id = err.details.request_id;
    }
  }
  
  res.status(statusCode).json(errorResponse);
};

export default errorHandler;