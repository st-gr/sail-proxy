/**
 * The rules a Connection and its models obey (spec 2026-10-23 §3, §4.1). Pure: the OData handlers
 * (srv/admin-service-connections.ts) call these and turn the messages into a 400.
 */
export const PROVIDER_TYPES = ['azure-openai', 'bedrock', 'openai', 'anthropic', 'sap-ai-core'] as const;
export type ProviderType = typeof PROVIDER_TYPES[number];
export const FAMILIES = ['openai', 'claude'] as const;
export type Family = typeof FAMILIES[number];

export const DEFAULTS = {
  openaiBaseUrl: 'https://api.openai.com/v1',
  anthropicBaseUrl: 'https://api.anthropic.com',
  anthropicVersion: '2023-06-01',
  azureApiMode: 'v1',
  azureAuthMode: 'api-key',
  bedrockAuthMode: 'access-key',
  sapResourceGroup: 'default',
} as const;

/** The id suffix: lower case, 2–31 characters. `--` would make the suffix ambiguous; `deployed` is the SAP deployment suffix. */
const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
/** Azure deployment names, Bedrock model and inference-profile ids, OpenAI/Anthropic ids incl. fine-tunes. No `/`: ids travel in URL paths. */
const UPSTREAM_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** SAP AI Core resource group ids. */
const RESOURCE_GROUP = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const URL_FIELDS = ['endpoint', 'baseUrl', 'runtimeEndpoint'] as const;
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

const present = (v: unknown): boolean => typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined;

/** https anywhere; http only on loopback, where the test fakes listen. */
function urlError(field: string, value: unknown): string | null {
  if (!present(value)) return null;
  let url: URL;
  try { url = new URL(String(value)); } catch { return `${field} must be a URL`; }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return `${field} must be an https URL`;
}

/**
 * The errors of a connection as it would be after this write: `existing` (on UPDATE) overlaid
 * with `input`, since a PATCH carries only what it changes. [] when valid.
 */
export function validateConnection(input: Record<string, any>, existing?: Record<string, any>): string[] {
  const errors: string[] = [];
  const row = { ...(existing || {}), ...input };
  if (existing) {
    if ('name' in input && input.name !== existing.name) errors.push('name cannot be changed after creation');
    if ('providerType' in input && input.providerType !== existing.providerType) errors.push('providerType cannot be changed after creation');
  }
  const name = row.name;
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('--') || name === 'deployed') {
    errors.push("name must be 2-31 characters of a-z, 0-9 and '-', start with a letter, not contain '--' and not be 'deployed'");
  }
  if (!(PROVIDER_TYPES as readonly string[]).includes(row.providerType)) {
    errors.push(`providerType must be one of ${PROVIDER_TYPES.join(', ')}`);
    return errors;
  }
  for (const field of URL_FIELDS) {
    const e = urlError(field, row[field]);
    if (e) errors.push(e);
  }
  switch (row.providerType as ProviderType) {
    case 'azure-openai':
      if (!present(row.endpoint)) errors.push('endpoint is required for azure-openai');
      if (!['v1', 'deployments'].includes(row.apiMode)) errors.push('apiMode must be v1 or deployments');
      else if (row.apiMode === 'deployments' && !present(row.apiVersion)) errors.push('apiVersion is required when apiMode is deployments');
      if (!['api-key', 'entra-client-secret'].includes(row.authMode)) errors.push('authMode must be api-key or entra-client-secret');
      else if (row.authMode === 'entra-client-secret') {
        if (!present(row.tenantId)) errors.push('tenantId is required for entra-client-secret');
        if (!present(row.clientId)) errors.push('clientId is required for entra-client-secret');
      }
      break;
    case 'bedrock':
      if (typeof row.region !== 'string' || !REGION.test(row.region)) errors.push('region must be an AWS region such as us-east-1');
      if (!['access-key', 'bearer'].includes(row.authMode)) errors.push('authMode must be access-key or bearer');
      else if (row.authMode === 'access-key' && !present(row.accessKeyId)) errors.push('accessKeyId is required for access-key');
      break;
    case 'sap-ai-core':
      if (typeof row.productive !== 'boolean') errors.push('productive is required for sap-ai-core (true for a productive SAP AI Core tenant)');
      if (typeof row.resourceGroup !== 'string' || !RESOURCE_GROUP.test(row.resourceGroup)) {
        errors.push("resourceGroup must be 1-64 characters of letters, digits, '.', '_' and '-', starting with a letter or digit");
      }
      break;
    default:
      break;
  }
  return errors;
}

/** The defaults a new connection of this type gets for the fields it left out. */
export function connectionDefaults(providerType: string): Record<string, string> {
  switch (providerType) {
    case 'azure-openai': return { apiMode: DEFAULTS.azureApiMode, authMode: DEFAULTS.azureAuthMode };
    case 'bedrock': return { authMode: DEFAULTS.bedrockAuthMode };
    case 'openai': return { baseUrl: DEFAULTS.openaiBaseUrl };
    case 'anthropic': return { baseUrl: DEFAULTS.anthropicBaseUrl, anthropicVersion: DEFAULTS.anthropicVersion };
    case 'sap-ai-core': return { resourceGroup: DEFAULTS.sapResourceGroup };
    default: return {};
  }
}

/** null when valid, else a message naming the field. */
export function validateUpstreamModel(value: unknown): string | null {
  return typeof value === 'string' && UPSTREAM_MODEL.test(value)
    ? null
    : "upstreamModel must be 1-64 characters of letters, digits, '.', '_', ':' and '-', starting with a letter or digit";
}

/** Not for sap-ai-core: it has no models of its own (the tenant's come through the Model Library). */
export function defaultFamily(providerType: ProviderType): Family {
  return providerType === 'azure-openai' || providerType === 'openai' ? 'openai' : 'claude';
}

export function modelIdFor(upstreamModel: string, name: string): string {
  return `${upstreamModel}--${name}`;
}
