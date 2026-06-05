/**
 * Shared Service
 * 
 * Provides a clean interface to communicate with the main proxy server.
 * This is the only module that should make HTTP calls to the main proxy,
 * ensuring we have a single point of integration.
 */

const axios = require('axios');
require('dotenv').config();

const MAIN_PROXY_URL = process.env.MAIN_PROXY_URL || 'http://localhost:3000';
const API_KEY = process.env.MAIN_PROXY_API_KEY || process.env.OPENAI_API_KEY;

// Debug logging
if (process.env.DEBUG === 'true') {
  console.log('[Shared] Configuration:');
  console.log('[Shared] MAIN_PROXY_URL:', MAIN_PROXY_URL);
  console.log('[Shared] API_KEY configured:', API_KEY ? 'YES' : 'NO');
}

// Default timeout for requests to main proxy
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 10000; // 10 seconds default

/**
 * Create axios instance with default configuration
 */
const createAxiosInstance = (streaming = false) => {
  const config = {
    baseURL: MAIN_PROXY_URL,
    timeout: streaming ? 0 : REQUEST_TIMEOUT, // No timeout for streaming
    headers: {
      'Content-Type': 'application/json'
    }
  };
    // Add API key if available
  if (API_KEY) {
    config.headers['x-api-key'] = API_KEY;
  }
  
  if (streaming) {
    config.responseType = 'stream';
  }
  
  return axios.create(config);
};

/**
 * Call the main proxy with a non-streaming request
 * @param {string} endpoint - The endpoint path (e.g., '/openai/v1/chat/completions')
 * @param {Object} data - Request payload
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @returns {Promise<Object>} Response data
 */
exports.callMainProxy = async (endpoint, data = {}, method = 'POST') => {
  const axiosInstance = createAxiosInstance(false);
  
  try {
    console.log(`[Shared] Calling main proxy: ${method} ${endpoint}`);
    console.log(`[Shared] Request data:`, JSON.stringify(data, null, 2));
    
    let response;
    
    switch (method.toUpperCase()) {
      case 'GET':
        response = await axiosInstance.get(endpoint, { params: data });
        break;
      case 'POST':
        response = await axiosInstance.post(endpoint, data);
        break;
      case 'PUT':
        response = await axiosInstance.put(endpoint, data);
        break;
      case 'DELETE':
        response = await axiosInstance.delete(endpoint, { data });
        break;
      default:
        throw new Error(`Unsupported HTTP method: ${method}`);
    }
    
    console.log(`[Shared] Response status: ${response.status}`);
    return response.data;
    
  } catch (error) {
    console.error(`[Shared] Error calling main proxy:`, error.message);
    
    if (error.response) {
      console.error(`[Shared] Response status: ${error.response.status}`);
      console.error(`[Shared] Response data:`, error.response.data);
      
      // Throw a more informative error
      const proxyError = new Error(`Main proxy error: ${error.response.status} ${error.response.statusText}`);
      proxyError.status = error.response.status;
      proxyError.data = error.response.data;
      throw proxyError;
    } else if (error.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to main proxy at ${MAIN_PROXY_URL}. Is it running?`);
    } else {
      throw error;
    }
  }
};

/**
 * Call the main proxy with a streaming request
 * @param {string} endpoint - The endpoint path
 * @param {Object} data - Request payload
 * @returns {Promise<Object>} Axios response with stream
 */
exports.callMainProxyStreaming = async (endpoint, data) => {
  const axiosInstance = createAxiosInstance(true);
  
  try {
    console.log(`[Shared] Calling main proxy (streaming): POST ${endpoint}`);
    console.log(`[Shared] Request data:`, JSON.stringify(data, null, 2));
    
    const response = await axiosInstance.post(endpoint, data);
    
    console.log(`[Shared] Streaming response status: ${response.status}`);
    return response;
    
  } catch (error) {
    console.error(`[Shared] Error in streaming call to main proxy:`, error.message);
    
    if (error.response) {
      console.error(`[Shared] Response status: ${error.response.status}`);
      
      // For streaming, we might get error details in the stream
      const proxyError = new Error(`Main proxy streaming error: ${error.response.status}`);
      proxyError.status = error.response.status;
      throw proxyError;
    } else if (error.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to main proxy at ${MAIN_PROXY_URL}. Is it running?`);
    } else {
      throw error;
    }
  }
};

/**
 * Health check for the main proxy
 * @returns {Promise<boolean>} True if main proxy is healthy
 */
exports.checkMainProxyHealth = async () => {
  try {
    const response = await exports.callMainProxy('/', {}, 'GET');
    return response && typeof response === 'object';
  } catch (error) {
    console.error('[Shared] Main proxy health check failed:', error.message);
    return false;
  }
};

/**
 * Get main proxy configuration/info
 * @returns {Promise<Object>} Main proxy info
 */
exports.getMainProxyInfo = async () => {
  try {
    return await exports.callMainProxy('/', {}, 'GET');
  } catch (error) {
    console.error('[Shared] Failed to get main proxy info:', error.message);
    return {
      message: 'Main proxy information not available',
      status: 'unknown',
      url: MAIN_PROXY_URL
    };
  }
};

/**
 * Validate that we can communicate with the main proxy
 * @returns {Promise<void>} Throws if validation fails
 */
exports.validateMainProxyConnection = async () => {
  console.log('[Shared] Validating connection to main proxy...');
  
  const isHealthy = await exports.checkMainProxyHealth();
  
  if (!isHealthy) {
    throw new Error(`Cannot establish connection to main proxy at ${MAIN_PROXY_URL}. Please ensure the main proxy is running and accessible.`);
  }
  
  console.log('[Shared] Main proxy connection validated successfully');
};
