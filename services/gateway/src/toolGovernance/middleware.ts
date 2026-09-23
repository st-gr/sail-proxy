/**
 * Tool governance middleware (spec §7): mounted after authentication on the four REST families.
 * Reads the policy blocks the admin attached to the validation response, evaluates the request's
 * declared tools, and monitors, strips or rejects. Fails open on every error path.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDefaultLogger } from '@libs/logger';
import securityEventEmitter from '../services/securityEventEmitter';
import { getClientIp } from '../utils/clientIp';
import { getTrustForwardedFor } from '../services/configService';
import { evaluate } from './evaluate';
import { conventionFor, normaliseIdentity, isContainerTool, nestedCallsIn } from './mcpNaming';
import { mcpNamingConfig } from './mcpNamingConfig';
import { toolName } from './identity';
import type { ToolPolicyBlock, PolicyMode, ToolIdentity } from './identity';
import { argsText } from './adapters/types';
import type { ToolAdapter } from './adapters/types';
import type { ToolGovernanceState } from './record';
import type { EvaluationResult } from './evaluate';

const logger = getDefaultLogger();
const MODES: PolicyMode[] = ['monitor', 'strip', 'reject'];

function isBlock(b: any): b is ToolPolicyBlock {
  return !!b && typeof b === 'object' && typeof b.policyId === 'string' && typeof b.policyName === 'string'
    && MODES.includes(b.mode) && Array.isArray(b.allow) && Array.isArray(b.deny);
}

const withLabels = (b: ToolPolicyBlock): ToolPolicyBlock => ({
  ...b,
  sensitive: Array.isArray(b.sensitive) ? b.sensitive.filter((p) => typeof p === 'string') : [],
  untrusted: Array.isArray(b.untrusted) ? b.untrusted.filter((p) => typeof p === 'string') : []
});

/**
 * The caller's policy blocks. Unlike the model entitlement check, administrators are NOT exempt: a
 * tool policy is a security control, and one assigned to a user or to a key must bind whoever holds
 * it. An administrator who blocks themselves can still edit the policy in the cockpit.
 */
export function policyBlocksFromRequest(req: any): { user: ToolPolicyBlock | null; key: ToolPolicyBlock | null } {
  const data = req?.unifiedAuth?.data ?? {};
  return {
    user: isBlock(data.toolPolicy) ? withLabels(data.toolPolicy) : null,
    key: isBlock(data.keyToolPolicy) ? withLabels(data.keyToolPolicy) : null
  };
}

function credentialOf(req: any): { credentialId: string; authType: 'api_key' | 'aws_credential' } {
  const data = req?.unifiedAuth?.data ?? {};
  return { credentialId: data.keyId ?? data.credentialId ?? 'unknown', authType: req?.unifiedAuth?.authType ?? 'api_key' };
}

/**
 * The `tool_not_entitled` event for a strip or a reject. A rejected request emits no usage event, so
 * the refused identities ride this event and the admin records them as attempts.
 */
export function emitToolPolicyEvent(req: any, result: EvaluationResult, identities: ToolIdentity[], mode: 'strip' | 'reject'): void {
  const policy = result.policyNames.join(' + ');
  const reasonOf = (id: ToolIdentity) => result.reasons.get(id) ?? 'policy';
  const kinds = new Set(identities.map(reasonOf));
  const reason = kinds.size > 1 ? 'mixed' : kinds.has('trust_chain') ? 'trust_chain' : 'policy';
  const tools = mode === 'reject'
    ? identities.map((identity) => ({ identity, facet: 'declared' as const, decision: 'rejected' as const, reason: reasonOf(identity) }))
    : undefined;
  try {
    const { credentialId, authType } = credentialOf(req);
    Promise.resolve(securityEventEmitter.emitToolNotEntitled({
      credentialId, authType, identities, policy, policyId: result.policyId, mode, tools, reason,
      sources: result.taintedBy.length > 0 ? result.taintedBy : undefined,
      model: typeof req?.body?.model === 'string' ? req.body.model : undefined,
      clientIP: getClientIp(req, getTrustForwardedFor()),
      userAgent: typeof req?.get === 'function' ? req.get('user-agent') : undefined,
      endpoint: req?.originalUrl, method: req?.method, requestId: req?.debugRequestId
    })).catch((e) => logger.warn('ToolGovernance', `security event failed: ${e instanceof Error ? e.message : String(e)}`));
  } catch (e) {
    logger.warn('ToolGovernance', `security event failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function toolGovernance(adapter: ToolAdapter): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // The fail-open boundary covers only the adapter/evaluation work: computing the decision
    // must never leave the request half-handled. Sending the 403 is deliberately OUTSIDE this
    // try, so a failure in res.status().json() itself (connection gone, headers already sent)
    // can never be mistaken for an evaluation failure and fall through to next() — that would
    // let the real handler run after a possibly partial 403, and a later write on that response
    // crashes with "Cannot set headers after they are sent".
    let rejection: string | null = null;
    try {
      const { user, key } = policyBlocksFromRequest(req);
      // A client that hosts its own MCP servers declares their tools as ordinary function tools
      // named `mcp__server__tool` (Claude Code does exactly this). Normalising that name into the
      // `mcp:server/tool` identity is what lets ONE policy pattern cover a locally hosted server
      // and a remotely declared one - and, because the tool is in the request, strip mode removes
      // it before the model can call it. The original spelling is kept so the adapter, which knows
      // only the body, can still find the tool it has to remove.
      const convention = conventionFor(
        typeof req.get === 'function' ? req.get('user-agent') : undefined, mcpNamingConfig());
      const spelling = new Map<ToolIdentity, ToolIdentity>();
      const declared = adapter.declaredTools(req.body).map((raw) => {
        const identity = normaliseIdentity(raw, convention);
        if (identity !== raw) spelling.set(identity, raw);
        return identity;
      });
      const forced = adapter.forcedTool(req.body);
      // What the request already carries from earlier tool calls (spec 2026-09-22 §3.2), in the
      // same identity space as the declarations. A container result also carries whatever MCP tools
      // its program reached, so a browser call made inside codex's exec taints like a direct one.
      const sources = adapter.resultSources(req.body).flatMap(({ identity, args }) => {
        const normalised = normaliseIdentity(identity, convention);
        return isContainerTool(toolName(identity), convention) ? [normalised, ...nestedCallsIn(argsText(args), convention)] : [normalised];
      });
      const result = evaluate(declared, user, key, forced === null ? null : normaliseIdentity(forced, convention), sources);
      const state: ToolGovernanceState = { result, declared, invoked: new Map(), family: adapter.family, convention, sources,
        blocks: [user, key].filter((b): b is ToolPolicyBlock => !!b) };
      (req as any).toolGovernance = state;
      const policyName = result.policyNames.join(' + ');
      if (result.reject) {
        const denied = [...result.decisions.entries()].filter(([, d]) => d === 'rejected').map(([id]) => id);
        emitToolPolicyEvent(req, result, denied, 'reject');
        logger.info('ToolGovernance', `rejected ${denied.join(', ')} (${result.reason}) by policy "${policyName}"`);
        rejection = `${result.reason}. Tool policy "${policyName}" does not permit: ${denied.join(', ')}`;
      } else if (result.blocked.length > 0 || result.narrow.size > 0) {
        // Strip, then SAY SO. A silently missing tool makes the model look for another way to do the
        // job and leaves the caller wondering why the assistant will not search the web; the note in
        // the family's own system channel lets the model state the limitation instead.
        const asDeclared = result.blocked.map((identity) => spelling.get(identity) ?? identity);
        const refusal = adapter.stripRefusal?.(req.body, new Set(asDeclared)) ?? null;
        if (refusal !== null) {
          emitToolPolicyEvent(req, result, result.blocked, 'reject');
          rejection = `${refusal}. Tool policy "${policyName}" does not permit: ${result.blocked.join(', ')}`;
        } else {
          req.body = adapter.noteStrippedTools(adapter.stripTools(req.body, new Set(asDeclared), result.narrow), result.blocked, result.taintedBy);
          const narrowed = [...result.narrow.keys()].map((server) => `mcp:${server}`);
          emitToolPolicyEvent(req, result, [...result.blocked, ...narrowed], 'strip');
          logger.info('ToolGovernance', `stripped ${[...result.blocked, ...narrowed].join(', ')} by policy "${policyName}"`);
        }
      }
    } catch (e) {
      delete (req as any).toolGovernance;
      logger.warn('ToolGovernance', `evaluation failed, request proceeds ungoverned: ${e instanceof Error ? e.message : String(e)}`);
      // Headers can only be sent by this middleware's own reject branch below, which always
      // returns without reaching here — but never call next() after a send regardless of how
      // that became true, since the caller's own handler would then double-respond.
      if (!res.headersSent) next();
      return;
    }
    if (rejection !== null) {
      try {
        if (typeof (res as any).set === 'function') {
          for (const [k, v] of Object.entries(adapter.rejectionHeaders?.() ?? {})) res.set(k, v);
        }
        res.status(403).json(adapter.rejectionBody(rejection));
      } catch (e) {
        // The decision and its security event already landed above; only the send failed.
        // Never call next() here: the caller believes the request was refused, and running
        // the real handler now would risk a second, conflicting response.
        logger.warn('ToolGovernance', `403 send failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    next();
  };
}
