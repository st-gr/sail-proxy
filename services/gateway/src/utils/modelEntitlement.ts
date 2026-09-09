/**
 * Model entitlement on the wire (spec section 5). The admin attaches an EntitlementBlock to every
 * validated credential; it rides in the unified cache with the credential. No block means
 * unrestricted: standalone mode, the local validation fallback, or an admin whose lookup failed —
 * the same fail-open rule the quota design uses.
 */
import { Request, Response } from 'express';
import type { EntitlementBlock } from '../clients/adminServiceClient';
import { getDefaultLogger } from '@libs/logger';
import securityEventEmitter from '../services/securityEventEmitter';
import { getClientIp } from './clientIp';
import { getTrustForwardedFor } from '../services/configService';
import { userFromRequest, isAdminUser } from './userBlock';

const logger = getDefaultLogger();

function isBlock(x: any): x is EntitlementBlock {
  return !!x && typeof x === 'object' && (x.mode === 'all' || x.mode === 'list');
}

/**
 * The admin's block travels as untyped JSON; `isBlock` only guarantees `mode` is sane.
 * Normalise the rest so a malformed `include`/`exclude` can't degrade `.includes()` into a
 * substring check or throw. `include` fails closed (a broken list block entitles nothing);
 * `exclude` falls back to the unrestricted default (a broken exclusion list means "all").
 */
function normalizeBlock(x: any): EntitlementBlock {
  const normalized: EntitlementBlock = {
    catalogId: x.catalogId == null ? '' : String(x.catalogId),
    catalogName: x.catalogName == null ? '' : String(x.catalogName),
    mode: x.mode
  };
  // Only the field the block's own mode reads needs normalising: `include` for 'list'
  // (fail closed to [] so a broken list entitles nothing), `exclude` for 'all' (omit so a
  // broken exclusion list falls back to the mode's own "admit everything" default).
  if (x.mode === 'list') {
    normalized.include = Array.isArray(x.include) ? x.include.filter((v: any) => typeof v === 'string') : [];
  } else if (Array.isArray(x.exclude)) {
    normalized.exclude = x.exclude.filter((v: any) => typeof v === 'string');
  }
  return normalized;
}

export function entitlementFromRequest(req: any): EntitlementBlock | null {
  // An administrator is never restricted (spec §5's limitation, closed by §7.2 item 2): the block
  // follows the assignment for everyone else.
  if (isAdminUser(userFromRequest(req))) return null;
  const candidates = [
    req?.unifiedAuth?.data?.entitlement,
    req?.apiKeyInfo?.entitlement,
    req?.apiKeyInfo?.metadata?.entitlement,
    req?.awsAuth?.entitlement
  ];
  for (const c of candidates) if (isBlock(c)) return normalizeBlock(c);
  return null;
}

export function isModelEntitled(block: EntitlementBlock | null, modelId: string): boolean {
  if (!block) return true;
  if (block.mode === 'all') return !(block.exclude || []).includes(modelId);
  return (block.include || []).includes(modelId);
}

export function filterModels<T extends { id: string }>(block: EntitlementBlock | null, models: T[]): T[] {
  if (!block) return models;
  return models.filter(m => isModelEntitled(block, m.id));
}

/** 403 body for an inference request outside the entitlement. `enforceEntitlement` wraps this with the security event. */
export function respondNotEntitled(res: Response, model: string, block: EntitlementBlock): void {
  res.status(403).json({
    error: {
      type: 'model_not_entitled',
      message: `Model ${model} is not in your entitlement catalog "${block.catalogName}"`,
      model,
      catalog: block.catalogName
    }
  });
}

export function logEntitlementDecision(req: Request, model: string, allowed: boolean): void {
  if (!allowed) logger.info('ModelEntitlement', `Refused ${model} for ${req.originalUrl}`);
}

function credentialOf(req: any): { credentialId: string; authType: 'api_key' | 'aws_credential' } {
  if (req?.awsAuth?.credentialId || req?.unifiedAuth?.authType === 'aws_credential') {
    return { credentialId: req?.awsAuth?.credentialId || req?.unifiedAuth?.data?.credentialId || 'unknown', authType: 'aws_credential' };
  }
  return { credentialId: req?.unifiedAuth?.data?.keyId || req?.apiKeyInfo?.keyId || req?.apiKey?.keyId || req?.apiKeyInfo?.id || 'unknown', authType: 'api_key' };
}

/**
 * The `model_not_entitled` security event for one refusal — fire-and-forget, and self-silencing
 * on every failure path, so a SIEM problem can never turn a refusal into a 500.
 *
 * Separate from `enforceEntitlement` because a route whose 403 body is not the OpenAI envelope
 * cannot use that wrapper and would otherwise refuse SILENTLY, invisible to the SIEM: `/google`
 * answers in the Gemini envelope and calls this directly. Keeping the emission in one place is what
 * stops the two refusal paths from reporting differently.
 */
export function emitNotEntitled(req: Request, model: string, block: EntitlementBlock): void {
  try {
    const { credentialId, authType } = credentialOf(req);
    Promise.resolve(securityEventEmitter.emitModelNotEntitled({
      credentialId, authType, model, catalog: block.catalogName, catalogId: block.catalogId,
      clientIP: getClientIp(req, getTrustForwardedFor()),
      userAgent: typeof (req as any).get === 'function' ? (req as any).get('user-agent') : undefined,
      endpoint: req.originalUrl, method: req.method, requestId: (req as any).debugRequestId
    })).catch(e => logger.warn('ModelEntitlement', `security event failed: ${e instanceof Error ? e.message : String(e)}`));
  } catch (e) {
    logger.warn('ModelEntitlement', `security event failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Call after model substitution in every inference controller. Returns true to proceed; on false the
 * 403 has been sent and a model_not_entitled security event emitted (fire-and-forget).
 *
 * The no-block case returns before reading anything else off the request, so a caller (or a test)
 * that hands over a bare object without `get`, `originalUrl`, `socket` or `headers` still passes.
 */
export function enforceEntitlement(req: Request, res: Response, model: string): boolean {
  const block = entitlementFromRequest(req);
  if (!block || isModelEntitled(block, model)) return true;
  logEntitlementDecision(req, model, false);
  respondNotEntitled(res, model, block);
  emitNotEntitled(req, model, block);
  return false;
}
