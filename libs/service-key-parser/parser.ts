import { ServiceKey, ParsedConfig, SapTenantIdentity } from './types';
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

/**
 * Tenant identity of a service key: the tenant key of its auth URL (see tenantFromAuthUrl; stable
 * across key rotation), the identity zone id and the AI Core region. Validates like
 * parseServiceKey and requires an identityzone.
 */
export function tenantFromServiceKey(serviceKeyJson: string): SapTenantIdentity {
  const parsed = parseServiceKey(serviceKeyJson);
  const serviceKey: ServiceKey = JSON.parse(serviceKeyJson);
  if (!String(serviceKey.identityzone || '').trim()) {
    throw new Error('Missing required field: identityzone');
  }
  return {
    zone: tenantFromAuthUrl(parsed.AUTH_URL, parsed.SAP_AI_CORE_URL).zone,
    zoneId: serviceKey.identityzoneid || null,
    region: parsed.SAP_AI_REGION
  };
}

/**
 * Tenant identity from environment settings. The zone (the tenant key) is `<subdomain>.<landscape>`
 * of the auth URL (https://<subdomain>.authentication.<landscape>.hana.ondemand.com/oauth/token):
 * one subdomain may exist on several landscapes. A host without an `authentication` label gives
 * the whole host.
 */
export function tenantFromAuthUrl(authUrl: string, aiCoreUrl: string): SapTenantIdentity {
  let host: string;
  try {
    host = new URL(authUrl).hostname;
  } catch (error) {
    throw new Error('Invalid auth URL');
  }
  const labels = host.trim().toLowerCase().split('.');
  const auth = labels.indexOf('authentication');
  const zone = (auth > 0 && labels[auth + 1] ? `${labels[0]}.${labels[auth + 1]}` : labels.join('.')).slice(0, 100);
  if (!zone) {
    throw new Error('Invalid auth URL');
  }
  return { zone, zoneId: null, region: extractRegion(aiCoreUrl) };
}
