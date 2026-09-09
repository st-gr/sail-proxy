/**
 * /api/admin/deployments — HTTP surface over deploymentManagementService.
 *
 * Only the gateway holds SAP AI Core credentials, so the admin's Model Library reaches AI Core
 * through here with its ADMIN_TO_GATEWAY service key. Service errors carry the HTTP status the
 * CLI's flow implies (404 unknown model, 409 deployment already exists); anything else from AI
 * Core is surfaced as its upstream status or 502.
 */
import { Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import * as deployments from '../services/deploymentManagementService';
import securityEventEmitter from '../services/securityEventEmitter';
import { getClientIp } from '../utils/clientIp';
import { getTrustForwardedFor } from '../services/configService';

const logger = getDefaultLogger();

function fail(res: Response, e: any): void {
  if (e instanceof deployments.DeploymentError) { res.status(e.status).json({ error: e.code, message: e.message, ...(e.details || {}) }); return; }
  const status = e?.response?.status || 502;
  logger.error('DeploymentController', `AI Core call failed: ${e?.message}`, e instanceof Error ? e : new Error(String(e)));
  res.status(status >= 400 && status < 600 ? status : 502).json({ error: 'ai_core_error', message: e?.response?.data?.message || e?.message || 'SAP AI Core request failed' });
}

export const list = async (req: Request, res: Response): Promise<void> => {
  const model = String(req.query.model || '').trim();
  if (!model) { res.status(400).json({ error: 'missing_model', message: 'query parameter model is required' }); return; }
  try { res.json({ model, deployments: await deployments.listDeploymentsForModel(model) }); } catch (e) { fail(res, e); }
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const model = String(req.body?.model || '').trim();
  if (!model) { res.status(400).json({ error: 'missing_model', message: 'body.model is required' }); return; }
  try {
    const r = await deployments.createDeployment(model);
    // The service-key middleware records the validated key on req.serviceAuth.serviceKey
    // (libs/service-auth/types.ts ServiceAuthContext); the rest of the chain keeps the event
    // emitted in standalone mode too.
    const serviceKeyId = (req as any).serviceAuth?.serviceKey?.id || (req as any).apiKeyInfo?.keyId || 'service-key';
    Promise.resolve(securityEventEmitter.emitDeploymentCreated({
      credentialId: serviceKeyId, model, deploymentId: r.deploymentId, configurationId: r.configurationId, reusedConfiguration: r.reusedConfiguration,
      clientIP: getClientIp(req, getTrustForwardedFor()), userAgent: req.get('user-agent'), endpoint: req.originalUrl, requestId: (req as any).debugRequestId
    })).catch(err => logger.warn('DeploymentController', `security event failed: ${err instanceof Error ? err.message : String(err)}`));
    res.status(201).json(r);
  } catch (e) { fail(res, e); }
};

export const status = async (req: Request, res: Response): Promise<void> => {
  try { res.json(await deployments.getDeploymentStatus(req.params.id)); } catch (e) { fail(res, e); }
};
