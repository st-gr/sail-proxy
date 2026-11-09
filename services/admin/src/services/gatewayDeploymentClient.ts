/**
 * Admin → gateway calls for SAP AI Core deployments (spec section 5). The admin never holds AI
 * Core credentials; it asks the gateway's /api/admin/deployments with the same service key it
 * uses for /v1/models.
 */
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
import { modelCostService } from './modelCostService';

const logger = getDefaultLogger();

export class GatewayDeploymentError extends Error {
  status: number; code: string; details?: any;
  constructor(status: number, code: string, message: string, details?: any) { super(message); this.status = status; this.code = code; this.details = details; }
}

const gatewayUrl = () => process.env.GATEWAY_URL || 'http://localhost:3000';

async function headers(): Promise<Record<string, string>> {
  const key = await modelCostService.getGatewayServiceKey();
  return { Accept: 'application/json', 'X-API-Key': key, 'User-Agent': 'admin-service/model-library' };
}

function wrap(e: any): never {
  const status = e?.response?.status;
  const data = e?.response?.data || {};
  if (status) throw new GatewayDeploymentError(status, data.error || 'gateway_error', data.message || `gateway responded ${status}`, data);
  logger.error('GatewayDeploymentClient', `gateway unreachable: ${e?.message}`);
  throw new GatewayDeploymentError(502, 'gateway_unreachable', e?.message || 'gateway unreachable');
}

export async function listDeployments(model: string): Promise<any[]> {
  try {
    const r = await axios.get(`${gatewayUrl()}/api/admin/deployments`, { params: { model }, headers: await headers(), timeout: 30000 });
    return r.data?.deployments || [];
  } catch (e) { return wrap(e); }
}

export async function createDeployment(model: string): Promise<{ deploymentId: string; status: string; configurationId: string; reusedConfiguration: boolean }> {
  try {
    const r = await axios.post(`${gatewayUrl()}/api/admin/deployments`, { model }, { headers: { ...(await headers()), 'Content-Type': 'application/json' }, timeout: 60000 });
    const { deploymentId, status, configurationId, reusedConfiguration } = r.data;
    return { deploymentId, status, configurationId, reusedConfiguration };
  } catch (e) { return wrap(e); }
}

export async function deploymentStatus(id: string): Promise<{ status: string; deploymentUrl: string | null }> {
  try {
    const r = await axios.get(`${gatewayUrl()}/api/admin/deployments/${encodeURIComponent(id)}`, { headers: await headers(), timeout: 30000 });
    return { status: r.data?.status || 'UNKNOWN', deploymentUrl: r.data?.deploymentUrl ?? null };
  } catch (e) { return wrap(e); }
}
