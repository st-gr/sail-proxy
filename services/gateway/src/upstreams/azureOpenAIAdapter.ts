/**
 * `azure-openai` connections (spec 2026-10-23 §5.2). Two API shapes: `v1` (`/openai/v1/...`, the
 * deployment name in the body's model) and `deployments` (`/openai/deployments/{name}/...` with an
 * api-version). Auth is the resource's `api-key` or an Entra bearer token.
 */
import type { Connection } from '../connections/types';
import { ProviderAdapter, UpstreamRequest, UpstreamRoute } from './types';
import { cachedEntraToken, getEntraToken } from './azureEntraToken';
import { probe, runTest, trimSlash } from './probe';

/** The data-plane deployments list; retired on newer resources (404), where the admin types names. */
const DEPLOYMENTS_LIST_API_VERSION = '2022-12-01';
const V1_PATHS: Record<Exclude<UpstreamRoute, 'messages'>, string> = { chat: '/chat/completions', responses: '/responses', embeddings: '/embeddings' };

export function azureOpenAIAdapter(connection: Connection, secret: string): ProviderAdapter {
  const s = connection.settings;
  const endpoint = trimSlash(s.endpoint || '');
  const deploymentsMode = s.apiMode === 'deployments';
  const version = encodeURIComponent(s.apiVersion || '');
  const entra = s.authMode === 'entra-client-secret';

  const authHeaders = async (): Promise<Record<string, string>> => (entra
    ? { Authorization: `Bearer ${await getEntraToken(connection.id, s.tenantId || '', s.clientId || '', secret)}` }
    : { 'api-key': secret });

  const urlFor = (route: UpstreamRoute, upstreamModel: string): string => {
    if (route === 'messages') throw new Error('the messages route is served by anthropic connections only');
    if (!deploymentsMode) return `${endpoint}/openai/v1${V1_PATHS[route]}`;
    if (route === 'responses') return `${endpoint}/openai/responses?api-version=${version}`;
    return `${endpoint}/openai/deployments/${encodeURIComponent(upstreamModel)}${V1_PATHS[route]}?api-version=${version}`;
  };

  return {
    async buildRequest(route, clientBody, upstreamModel): Promise<UpstreamRequest> {
      return {
        url: urlFor(route, upstreamModel),
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: { ...clientBody, model: upstreamModel },
      };
    },
    async listModels() {
      const response = await probe(`${endpoint}/openai/deployments?api-version=${DEPLOYMENTS_LIST_API_VERSION}`, await authHeaders());
      if (response.status === 404) return [];
      if (response.status >= 400) throw Object.assign(new Error(`deployment list refused (${response.status})`), { status: response.status });
      return (response.data?.data || []).map((d: any) => d?.id).filter((id: unknown): id is string => typeof id === 'string');
    },
    testConnection: () => runTest(async () => ({
      url: deploymentsMode ? `${endpoint}/openai/models?api-version=${version}` : `${endpoint}/openai/v1/models`,
      headers: await authHeaders(),
    })),
    secrets: () => {
      const token = entra ? cachedEntraToken(connection.id, s.clientId || '', secret) : undefined;
      return token ? [secret, token] : [secret];
    },
  };
}
