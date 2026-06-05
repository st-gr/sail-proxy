import { ServiceKey, ParsedConfig } from './types';
import { extractRegion } from './utils';

/**
 * Parse SAP BTP service key and extract configuration values
 */
export function parseServiceKey(serviceKeyJson: string): ParsedConfig {
  let serviceKey: ServiceKey;
  
  try {
    serviceKey = JSON.parse(serviceKeyJson);
  } catch (error) {
    throw new Error('Invalid JSON format. Please provide a valid SAP BTP service key.');
  }
  
  // Validate required fields
  if (!serviceKey.serviceurls?.AI_API_URL) {
    throw new Error('Missing required field: serviceurls.AI_API_URL');
  }
  if (!serviceKey.url) {
    throw new Error('Missing required field: url');
  }
  if (!serviceKey.clientid) {
    throw new Error('Missing required field: clientid');
  }
  if (!serviceKey.clientsecret) {
    throw new Error('Missing required field: clientsecret');
  }
  
  // Extract region from AI_API_URL
  // Example: https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com → prod.us-east-1
  const region = extractRegion(serviceKey.serviceurls.AI_API_URL);
  
  return {
    SAP_AI_CORE_URL: serviceKey.serviceurls.AI_API_URL,
    AUTH_URL: `${serviceKey.url}/oauth/token`,
    CLIENT_ID: serviceKey.clientid,
    CLIENT_SECRET: serviceKey.clientsecret,
    SAP_AI_REGION: region,
    SAP_AI_RESOURCE_GROUP: 'default',
    PORT: '3000',
    GATEWAY_STANDALONE: 'true',
    OLLAMA_AUTOSTART: 'false'
  };
}