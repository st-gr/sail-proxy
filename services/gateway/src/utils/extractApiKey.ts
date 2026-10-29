import { Request } from 'express';
import { queryString } from './queryParam';

/** Every request header extractApiKey reads a key from, in order; header sanitisers mask exactly these. */
export const API_KEY_HEADERS = ['x-api-key', 'x-stainless-key', 'x-goog-api-key'] as const;

/**
 * The one place that decides where a request carries its sail-proxy API key, shared by the
 * unified and the legacy (standalone) auth middlewares so their lists cannot drift apart.
 *
 * Order: `x-api-key`, `x-stainless-key`, `x-goog-api-key` (Gemini clients), `?api_key=`,
 * `?key=` (Gemini clients), then `Authorization: Bearer sk-...`.
 *
 * Headers are string | string[]; a query value can also be a null-prototype object
 * (`?api_key[a]=1`, express >= 4.22). queryString narrows every source to a string or null,
 * so a non-string key is "no key" - it never reaches the validation service, the cache-key
 * hash or credentialIdentity.
 */
export function extractApiKey(req: Request): string | null {
  let apiKey: string | null =
    API_KEY_HEADERS.map((h) => queryString(req.headers[h])).find(Boolean) ||
    queryString(req.query.api_key) || queryString(req.query.key);

  // Authorization Bearer tokens that look like API keys
  if (!apiKey && req.headers['authorization']) {
    const authHeader = req.headers['authorization'] as string;
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (token.startsWith('sk-')) {
        apiKey = token;
      }
    }
  }

  return apiKey;
}
