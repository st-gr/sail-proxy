/**
 * `bedrock` connections: Claude served from an AWS account through Bedrock's invoke API. Requests
 * are signed with SigV4 (service `bedrock`, runtime and control plane alike) or carry a Bedrock API
 * key as a bearer token. The body is sent as the exact JSON string that was signed.
 */
import type { Connection } from '../connections/types';
import { ProviderAdapter, UpstreamRequest } from './types';
import { probe, runTest, trimSlash } from './probe';
import { signAwsRequest } from '@libs/aws-signing/sigV4';
import configService from '../services/configService';
import { filterBetaFeatures, mergeBetaFeatures, parseAnthropicBetaHeader } from '../utils/betaFeatureFilter';

const DEFAULT_ANTHROPIC_VERSION = 'bedrock-2023-05-31';
const PROFILE_PAGE_SIZE = 1000;

export function bedrockAdapter(connection: Connection, secret: string, sessionToken?: string): ProviderAdapter {
  const region = connection.settings.region || 'us-east-1';
  const bearer = connection.settings.authMode === 'bearer';
  const accessKeyId = connection.settings.accessKeyId || '';
  const configured = connection.settings.runtimeEndpoint;
  const runtime = trimSlash(configured || `https://bedrock-runtime.${region}.amazonaws.com`);
  // A runtime override also serves the control plane (same origin, `bedrock-runtime` read as `bedrock`).
  const control = configured ? runtime.replace('bedrock-runtime', 'bedrock') : `https://bedrock.${region}.amazonaws.com`;

  const authHeaders = (method: string, url: string, body: string): Record<string, string> =>
    bearer
      ? { Authorization: `Bearer ${secret}` }
      : signAwsRequest({ method, url, body, service: 'bedrock', region, accessKeyId, secretAccessKey: secret, sessionToken });
  const getHeaders = (url: string) => authHeaders('GET', url, '');

  const betaFlags = (clientBody: any, clientHeaders: Record<string, string | string[] | undefined> | undefined): string[] => {
    const headerFlags = parseAnthropicBetaHeader(clientHeaders?.['anthropic-beta']);
    // The header wins over a body-supplied list, as on the SAP Bedrock path.
    const bodyFlags = headerFlags.length === 0 && Array.isArray(clientBody.anthropic_beta) ? clientBody.anthropic_beta.map(String) : [];
    return filterBetaFeatures(mergeBetaFeatures(headerFlags, bodyFlags), {
      supported: configService.getSupportedBetaHeaders(),
      excluded: configService.getExcludedBetaHeaders(),
    });
  };

  return {
    async buildRequest(route, clientBody, upstreamModel, clientHeaders): Promise<UpstreamRequest> {
      if (route !== 'messages') throw new Error(`bedrock connections serve the messages route only, not ${route}`);
      const { model: _model, stream, anthropic_beta: _beta, ...rest } = clientBody;
      const flags = betaFlags(clientBody, clientHeaders);
      const body = JSON.stringify({
        anthropic_version: DEFAULT_ANTHROPIC_VERSION,
        ...rest,
        ...(flags.length > 0 ? { anthropic_beta: flags } : {}),
      });
      const streaming = stream === true;
      const url = `${runtime}/model/${encodeURIComponent(upstreamModel)}/${streaming ? 'invoke-with-response-stream' : 'invoke'}`;
      // Bedrock rejects axios's default Accept; Accept is not a signed header.
      const accept = streaming ? 'application/vnd.amazon.eventstream' : 'application/json';
      return { url, headers: { ...authHeaders('POST', url, body), 'Content-Type': 'application/json', Accept: accept }, body };
    },
    async listModels() {
      const profiles: string[] = [];
      const models: string[] = [];
      let nextToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const url = `${control}/inference-profiles?maxResults=${PROFILE_PAGE_SIZE}&typeEquals=SYSTEM_DEFINED${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`;
        const response = await probe(url, getHeaders(url));
        if (response.status >= 400) throw Object.assign(new Error(`model list refused (${response.status})`), { status: response.status });
        for (const p of response.data?.inferenceProfileSummaries || []) if (typeof p?.inferenceProfileId === 'string') profiles.push(p.inferenceProfileId);
        const token = response.data?.nextToken;
        // A token seen before (a repeat or a cycle) would page forever.
        nextToken = typeof token === 'string' && !seenTokens.has(token) ? token : undefined;
        if (nextToken) seenTokens.add(nextToken);
      } while (nextToken);
      const foundationUrl = `${control}/foundation-models?byProvider=Anthropic`;
      const foundation = await probe(foundationUrl, getHeaders(foundationUrl));
      if (foundation.status >= 400) throw Object.assign(new Error(`model list refused (${foundation.status})`), { status: foundation.status });
      for (const m of foundation.data?.modelSummaries || []) if (typeof m?.modelId === 'string') models.push(m.modelId);
      return [...new Set([...profiles, ...models].filter((id) => id.includes('anthropic.claude')))];
    },
    testConnection: () =>
      runTest(async () => {
        const url = `${control}/foundation-models?byProvider=Anthropic`;
        return { url, headers: getHeaders(url) };
      }),
    secrets: () => (sessionToken ? [secret, sessionToken] : [secret]),
  };
}
