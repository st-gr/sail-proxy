/**
 * `anthropic` connections: the Anthropic API itself, or any server speaking it at `baseUrl`.
 * `x-api-key` plus `anthropic-version`; the client's `anthropic-beta` header is passed on.
 */
import type { Connection } from '../connections/types';
import { ProviderAdapter, UpstreamRequest } from './types';
import { probe, runTest, trimSlash } from './probe';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';
const PAGE_SIZE = 1000;

export function anthropicAdapter(connection: Connection, secret: string): ProviderAdapter {
  const base = trimSlash(connection.settings.baseUrl || DEFAULT_BASE_URL);
  const headers = (): Record<string, string> => ({
    'x-api-key': secret,
    'anthropic-version': connection.settings.anthropicVersion || DEFAULT_VERSION,
  });

  return {
    async buildRequest(route, clientBody, upstreamModel, clientHeaders): Promise<UpstreamRequest> {
      if (route !== 'messages') throw new Error(`anthropic connections serve the messages route only, not ${route}`);
      const beta = clientHeaders?.['anthropic-beta'];
      const betaValue = Array.isArray(beta) ? beta.join(',') : beta;
      return {
        url: `${base}/v1/messages`,
        headers: { ...headers(), 'Content-Type': 'application/json', ...(betaValue ? { 'anthropic-beta': betaValue } : {}) },
        body: { ...clientBody, model: upstreamModel },
      };
    },
    async listModels() {
      const ids = new Set<string>();
      let afterId: string | undefined;
      do {
        const response = await probe(`${base}/v1/models?limit=${PAGE_SIZE}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`, headers());
        if (response.status >= 400) throw Object.assign(new Error(`model list refused (${response.status})`), { status: response.status });
        for (const m of response.data?.data || []) if (typeof m?.id === 'string') ids.add(m.id);
        const last = response.data?.last_id;
        // A cursor that does not advance would page forever.
        const next = response.data?.has_more && typeof last === 'string' ? last : undefined;
        afterId = next !== afterId ? next : undefined;
      } while (afterId);
      return [...ids];
    },
    testConnection: () => runTest(async () => ({ url: `${base}/v1/models?limit=1`, headers: headers() })),
    secrets: () => [secret],
  };
}
