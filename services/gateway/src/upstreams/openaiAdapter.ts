/**
 * `openai` connections (spec 2026-10-23 §5.2): the OpenAI API itself, or any server speaking it at
 * `baseUrl`. Bearer auth plus the optional OpenAI-Organization / OpenAI-Project headers.
 */
import type { Connection } from '../connections/types';
import { ProviderAdapter, UpstreamRequest, UpstreamRoute } from './types';
import { probe, runTest, trimSlash } from './probe';

const PATHS: Record<Exclude<UpstreamRoute, 'messages'>, string> = { chat: '/chat/completions', responses: '/responses', embeddings: '/embeddings' };
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export function openaiAdapter(connection: Connection, secret: string): ProviderAdapter {
  const base = trimSlash(connection.settings.baseUrl || DEFAULT_BASE_URL);
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${secret}`,
    ...(connection.settings.organization ? { 'OpenAI-Organization': connection.settings.organization } : {}),
    ...(connection.settings.project ? { 'OpenAI-Project': connection.settings.project } : {}),
  });

  return {
    async buildRequest(route, clientBody, upstreamModel): Promise<UpstreamRequest> {
      if (route === 'messages') throw new Error('the messages route is served by anthropic connections only');
      return {
        url: `${base}${PATHS[route]}`,
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: { ...clientBody, model: upstreamModel },
      };
    },
    async listModels() {
      const response = await probe(`${base}/models`, headers());
      if (response.status >= 400) throw Object.assign(new Error(`model list refused (${response.status})`), { status: response.status });
      return (response.data?.data || []).map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === 'string');
    },
    testConnection: () => runTest(async () => ({ url: `${base}/models`, headers: headers() })),
    secrets: () => [secret],
  };
}
