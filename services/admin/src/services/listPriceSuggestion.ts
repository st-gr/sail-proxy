/**
 * A suggested list price for a Connection model, from the LiteLLM price snapshot
 * (litellmPrices.json, MIT; see LITELLM-NOTICE.md). A starting point only: the administrator
 * confirms every price, and the figures are per 1K tokens in USD.
 */
import snapshot from './litellmPrices.json';

export interface SuggestedListPrice {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number | null;
  cacheCreationCost: number | null;
}

interface LitellmEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

/** The snapshot keys tried per provider type, in order, and the `litellm_provider` values that count. */
const LOOKUP: Record<string, { keys: (m: string) => string[]; providers: string[] }> = {
  'openai': { keys: (m) => [m], providers: ['openai'] },
  'azure-openai': { keys: (m) => [`azure/${m}`, m], providers: ['azure'] },
  'anthropic': { keys: (m) => [m], providers: ['anthropic'] },
  'bedrock': { keys: (m) => [m, `bedrock/${m}`], providers: ['bedrock', 'bedrock_converse'] },
};
const MODES = ['chat', 'embedding'];

const per1K = (perToken: number): number => Math.round(perToken * 1000 * 1_000_000) / 1_000_000;
const optional = (perToken: number | undefined): number | null => (typeof perToken === 'number' ? per1K(perToken) : null);

export function suggestListPrice(providerType: string, upstreamModel: string): SuggestedListPrice | null {
  const lookup = LOOKUP[providerType];
  if (!lookup || !Object.prototype.hasOwnProperty.call(LOOKUP, providerType)) return null;
  const table = snapshot.prices as Record<string, LitellmEntry>;
  for (const key of lookup.keys(upstreamModel)) {
    if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
    const e = table[key];
    if (!e.litellm_provider || !lookup.providers.includes(e.litellm_provider) || !e.mode || !MODES.includes(e.mode)) continue;
    if (typeof e.input_cost_per_token !== 'number' || typeof e.output_cost_per_token !== 'number') continue;
    return {
      inputCost: per1K(e.input_cost_per_token), outputCost: per1K(e.output_cost_per_token),
      cacheReadCost: optional(e.cache_read_input_token_cost), cacheCreationCost: optional(e.cache_creation_input_token_cost),
    };
  }
  return null;
}
