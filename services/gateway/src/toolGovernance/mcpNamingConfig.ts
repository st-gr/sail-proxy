/**
 * The MCP naming conventions in force: `platform.toolGovernance.mcpNaming` from the active API
 * configuration, falling back to the presets for the clients measured on this gateway.
 *
 * Kept apart from mcpNaming.ts so that module stays pure and testable without the config service.
 */
import { getConfig } from '../services/configService';
import { DEFAULT_MCP_NAMING } from './mcpNaming';
import type { McpNaming, McpClientConvention } from './mcpNaming';

const isClient = (c: any): c is McpClientConvention =>
  !!c && typeof c.name === 'string' && typeof c.userAgent === 'string' && Array.isArray(c.containerTools)
  && c.containerTools.every((t: any) => typeof t === 'string')
  && (c.nestedCallPattern === undefined || typeof c.nestedCallPattern === 'string');

/** Never throws and never returns a half-configured object: a bad block falls back to the presets. */
export function mcpNamingConfig(): McpNaming {
  try {
    const configured = (getConfig() as any)?.api_config?.platform?.toolGovernance?.mcpNaming;
    if (!configured || typeof configured !== 'object') return DEFAULT_MCP_NAMING;
    const namePattern = typeof configured.namePattern === 'string' && configured.namePattern.length > 0
      ? configured.namePattern : DEFAULT_MCP_NAMING.namePattern;
    const clients = Array.isArray(configured.clients) ? configured.clients.filter(isClient) : null;
    return { namePattern, clients: clients ?? DEFAULT_MCP_NAMING.clients };
  } catch {
    return DEFAULT_MCP_NAMING;
  }
}
