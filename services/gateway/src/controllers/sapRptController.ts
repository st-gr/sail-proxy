/**
 * SAP-RPT tabular prediction: a pass-through.
 *
 * The models expose a tabular contract (rows in, predictions out - spec §3), not a chat
 * contract, so nothing that governs chat applies: no hook chain, no masking, no tool
 * governance, no streaming. The gateway resolves the model to its deployment, adds the SAP
 * credentials, forwards the body verbatim and relays SAP's answer verbatim - status, content
 * type, inference id and body - including SAP's own 400/422 validation errors, which are
 * structured and useful. It re-validates nothing SAP validates itself. It marks the relay with
 * `res.locals.sapRelay` so `shapeMiddlewareErrors` leaves SAP's own body - including SAP's own
 * 401/429 - untouched instead of misattributing it to the gateway.
 *
 * Usage is folded from the RESPONSE (sapRpt/usage.ts): cells ride the token fields with
 * `unit: 'cells'`, so a rejected call bills nothing and a Parquet call, whose request cannot be
 * read here, still bills from its metadata.
 */
import type { Request, Response } from 'express';
import axios from 'axios';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import * as modelService from '../services/modelService';
import { entitlementFromRequest, isModelEntitled, emitNotEntitled, logEntitlementDecision } from '../utils/modelEntitlement';
import { createUsageMetrics, updateTokenCounts, emitUsageEvent } from '../utils/usageTracker';
import { resolveDeployedTwin } from '../utils/deployedTwin';
import { cellsFromResponse, accountedModel } from '../sapRpt/usage';
import { rptError } from '../sapRpt/errors';

const logger = getDefaultLogger();
const RELAYED_HEADERS = ['content-type', 'ai-inference-id', 'x-request-id', 'x-upstream-service-time'];

function refuse(res: Response, status: number, type: Parameters<typeof rptError>[1], msg: string): void {
  const e = rptError(status, type, msg);
  res.status(e.status).json(e.body);
}

async function headersForSap(contentType: string): Promise<Record<string, string>> {
  const token = await modelService.getAuthToken();
  return { Authorization: `Bearer ${token}`, 'AI-Resource-Group': configService.getSAPAICoreConfig().resourceGroup, 'Content-Type': contentType };
}

/** Model → deployment URL, with the SAP-shaped refusals of spec §4.4. Null means a response was sent. */
async function resolveDeployment(req: Request, res: Response): Promise<{ model: string; url: string } | null> {
  const requested = String((req.params as any)?.model ?? '');
  const model = configService.getSubstitutedModel('sap-rpt', requested) || requested;
  const twin = await resolveDeployedTwin(model, (id) => modelService.getModelDetails(id));
  if (!twin) { refuse(res, 404, 'model_not_found', `Model ${model} is not available`); return null; }
  const block = entitlementFromRequest(req);
  const refusedId = [model, twin.id].find((id) => !isModelEntitled(block, id));
  if (refusedId !== undefined) {
    logEntitlementDecision(req, refusedId, false);
    emitNotEntitled(req, refusedId, block!);
    refuse(res, 403, 'model_not_entitled', `Model ${refusedId} is not in your entitlement catalog "${block!.catalogName}"`);
    return null;
  }
  return { model: twin.id, url: twin.deploymentUrl };
}

async function forward(req: Request, res: Response, subpath: 'predict' | 'predict-parquet', payload: any, contentType: string): Promise<void> {
  const target = await resolveDeployment(req, res);
  if (!target) return;
  const usage = createUsageMetrics();
  usage.unit = 'cells';
  let upstream: { status: number; data: any; headers: Record<string, any> };
  try {
    upstream = await axios.post(`${target.url}/${subpath}`, payload, {
      headers: await headersForSap(contentType), timeout: configService.getTimeout(false), validateStatus: () => true,
      maxBodyLength: Infinity, maxContentLength: Infinity
    });
  } catch (e: any) {
    logger.warn('sapRptController', `upstream unreachable for ${target.model}: ${e?.code || e?.message}`);
    refuse(res, 502, 'upstream_unavailable', `The deployment for ${target.model} could not be reached`);
    return;
  }
  const cells = upstream.status === 200 ? cellsFromResponse(upstream.data) : null;
  if (cells) {
    updateTokenCounts(usage, cells.inputCells, cells.predictCells, 0, 0);
    usage.usageEstimated = false;
    void emitUsageEvent(req, usage, accountedModel(target.model, cells.contextMode), upstream.status);
  }
  for (const h of RELAYED_HEADERS) { const v = upstream.headers?.[h]; if (typeof v === 'string') res.set(h, v); }
  res.locals.sapRelay = true;
  res.status(upstream.status);
  if (typeof upstream.data === 'string') res.send(upstream.data); else res.json(upstream.data);
}

export async function predict(req: Request, res: Response): Promise<void> {
  await forward(req, res, 'predict', req.body, 'application/json');
}

/** Multipart Parquet upload: the raw request stream is forwarded; the JSON response still carries the cells. */
export async function predictParquet(req: Request, res: Response): Promise<void> {
  await forward(req, res, 'predict-parquet', req, String(req.headers['content-type'] || 'multipart/form-data'));
}
