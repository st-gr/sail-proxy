/**
 * /openai/v1/embeddings served by a Connection (spec 2026-10-23 §5.3): the client body goes whole to
 * the provider (every input, without the 256-element cap and token limit, which are SAP AI Core's), with the model swapped,
 * and the answer comes back with the client's model id. No plugins: the SAP embeddings path has
 * none either.
 */
import type { Request, Response } from 'express';
import { emitUsageEvent, updateTokenCounts } from '../utils/usageTracker';
import type { ExternalTarget } from './externalTarget';
import { callUpstream, sendUpstreamError } from './upstreamCall';

export async function dispatchEmbeddings(req: Request, res: Response, target: ExternalTarget, usageMetrics: any, clientModel: string): Promise<void> {
  try {
    const upstreamRequest = await target.adapter.buildRequest('embeddings', req.body, target.model.upstreamModel);
    const upstream = await callUpstream(upstreamRequest, { stream: false });
    const body = upstream.data && typeof upstream.data === 'object' ? { ...upstream.data, model: clientModel } : upstream.data;
    updateTokenCounts(usageMetrics, upstream.data?.usage?.prompt_tokens || 0, 0);
    emitUsageEvent(req, usageMetrics, clientModel, upstream.status);
    res.status(upstream.status).json(body);
  } catch (error) {
    emitUsageEvent(req, usageMetrics, clientModel, await sendUpstreamError(req, res, error, target.adapter, 'openai'));
  }
}
