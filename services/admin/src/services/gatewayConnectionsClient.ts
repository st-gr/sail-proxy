/**
 * Admin → gateway calls for a connection's test and upstream model list (spec 2026-10-23 §7). The
 * admin keeps credentials encrypted and never calls a provider; the gateway, which holds the
 * decrypted snapshot, does. Same service key and base URL as gatewayDeploymentClient.
 */
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
import { modelCostService } from './modelCostService';

const logger = getDefaultLogger();
const TIMEOUT_MS = 30000;

export class GatewayConnectionsError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export type ConnectionTestResult = { ok: true } | { ok: false; error: { reason: string; status?: number; code?: string } };

const gatewayUrl = () => process.env.GATEWAY_URL || 'http://localhost:3000';
const path = (id: string, leaf: string) => `${gatewayUrl()}/api/admin/connections/${encodeURIComponent(id)}/${leaf}`;

async function headers(): Promise<Record<string, string>> {
  const key = await modelCostService.getGatewayServiceKey();
  return { Accept: 'application/json', 'X-API-Key': key, 'User-Agent': 'admin-service/connections' };
}

/** A gateway that cannot be reached is a test result, not an error: the admin records it. */
export async function testConnection(id: string): Promise<ConnectionTestResult> {
  try {
    const r = await axios.post(path(id, 'test'), {}, { headers: await headers(), timeout: TIMEOUT_MS });
    return r.data;
  } catch (e: any) {
    const status = e?.response?.status;
    if (status) throw new GatewayConnectionsError(status, e.response.data?.error || 'gateway_error', e.response.data?.message || `gateway responded ${status}`);
    logger.warn('GatewayConnectionsClient', `gateway unreachable for a connection test: ${e?.code || e?.message}`);
    return { ok: false, error: { reason: 'gateway_unreachable' } };
  }
}

export async function listConnectionModels(id: string): Promise<string[]> {
  try {
    const r = await axios.get(path(id, 'models'), { headers: await headers(), timeout: TIMEOUT_MS });
    return Array.isArray(r.data?.models) ? r.data.models : [];
  } catch (e: any) {
    const status = e?.response?.status;
    if (status) {
      const data = e.response.data || {};
      throw new GatewayConnectionsError(status, data.error || 'gateway_error', data.message || `${data.error || 'gateway error'}${data.status ? ` (${data.status})` : ''}`);
    }
    throw new GatewayConnectionsError(502, 'gateway_unreachable', e?.message || 'gateway unreachable');
  }
}
