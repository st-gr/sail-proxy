/**
 * The adapter serving a connection, or null when none can: no credential stored (or it could not be
 * decrypted), or a provider type this gateway does not serve (`sap-ai-core` has no adapter by design).
 */
import type { Connection } from '../connections/types';
import type { ProviderAdapter } from './types';
import { openaiAdapter } from './openaiAdapter';
import { azureOpenAIAdapter } from './azureOpenAIAdapter';
import { anthropicAdapter } from './anthropicAdapter';
import { bedrockAdapter } from './bedrockAdapter';

export function adapterFor(connection: Connection): ProviderAdapter | null {
  const secret = connection.credentials?.secret;
  if (!secret) return null;
  switch (connection.providerType) {
    case 'openai':
      return openaiAdapter(connection, secret);
    case 'azure-openai':
      return azureOpenAIAdapter(connection, secret);
    case 'anthropic':
      return anthropicAdapter(connection, secret);
    case 'bedrock':
      return bedrockAdapter(connection, secret, connection.credentials?.sessionToken);
    default:
      return null;
  }
}
