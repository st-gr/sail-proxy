/**
 * Microsoft Entra ID tokens for `azure-openai` connections with `entra-client-secret` auth: the
 * client-credential flow for the Cognitive Services scope, cached per connection until five
 * minutes before expiry. The cache key includes a hash of the secret, so a rotated secret fetches
 * anew. Tokens live in process memory only and are never logged.
 */
import axios from 'axios';
import crypto from 'crypto';
import { UpstreamAuthError } from './types';
import { PROBE_TIMEOUT_MS, trimSlash } from './probe';

export const ENTRA_SCOPE = 'https://cognitiveservices.azure.com/.default';
const DEFAULT_AUTHORITY_HOST = 'https://login.microsoftonline.com';
const EXPIRY_MARGIN_MS = 5 * 60_000;

const cache = new Map<string, { token: string; expiresAt: number }>();

export function clearEntraTokenCache(): void {
  cache.clear();
}

/** The cached token for these credentials, if one is still valid. */
export function cachedEntraToken(connectionId: string, clientId: string, secret: string): string | undefined {
  const entry = cache.get(keyOf(connectionId, clientId, secret));
  return entry && entry.expiresAt > Date.now() ? entry.token : undefined;
}

function keyOf(connectionId: string, clientId: string, secret: string): string {
  return `${connectionId}:${clientId}:${crypto.createHash('sha256').update(secret).digest('hex')}`;
}

export async function getEntraToken(connectionId: string, tenantId: string, clientId: string, secret: string): Promise<string> {
  const cached = cachedEntraToken(connectionId, clientId, secret);
  if (cached) return cached;
  const authority = trimSlash(process.env.AZURE_AUTHORITY_HOST || DEFAULT_AUTHORITY_HOST);
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: ENTRA_SCOPE });
  const response = await axios.post(`${authority}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: PROBE_TIMEOUT_MS,
    validateStatus: () => true,
  });
  const token = response.data?.access_token;
  if (response.status >= 400 || typeof token !== 'string') throw new UpstreamAuthError(response.status >= 400 ? response.status : 502);
  const expiresInMs = Number(response.data?.expires_in) * 1000 || 0;
  cache.set(keyOf(connectionId, clientId, secret), { token, expiresAt: Date.now() + expiresInMs - EXPIRY_MARGIN_MS });
  return token;
}
