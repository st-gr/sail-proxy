/**
 * The Gemini API surface: POST /google/{v1beta|v1}/models/<model>:<method>.
 *
 * A Gemini client (the Gemini CLI, `@google/genai`, anything taking a Gemini
 * base URL) reaches EVERY model this gateway offers here. Gemini models with a
 * SAP AI Core deployment are served natively; everything else — Claude, GPT,
 * Mistral, an undeployed Gemini model — is served by SAP orchestration with a
 * Gemini↔orchestration translation. Which of the two serves a request is
 * `chooseRoute`'s decision (spec section 5.4); moving the bytes afterwards is
 * googleDispatch.ts's job.
 *
 * Everything the other inference routes do applies here unchanged: API-key auth,
 * entitlement, quotas, hooks/plugins (pseudonymization included) and metered
 * usage. What is different is only the ERROR SHAPE — Gemini clients read
 * `{error:{code,message,status}}`, never the OpenAI or Anthropic envelope — and
 * that the model name arrives in the PATH rather than in the body.
 */
import { NextFunction, Request, Response } from 'express';
import { getDefaultLogger } from '@libs/logger';
import configService from '../services/configService';
import modelService from '../services/modelService';
import { executeBeforePlugins } from '../services/pluginExecutor';
import { createUsageMetrics, emitUsageEvent } from '../utils/usageTracker';
import { emitNotEntitled, entitlementFromRequest, isModelEntitled, logEntitlementDecision } from '../utils/modelEntitlement';
import { sseBlock } from '../utils/sseFraming';
import { geminiFailure, refuse } from './googleWire';
import {
  GEMINI_METHODS, GeminiDeployment, GeminiMethod, geminiError, parseModelMethod, resolveGeminiDeployment,
} from '../services/googleGeminiService';
import { validateGeminiRequest } from '../google/orchestrationBridge/requestTranslator';
import { GeminiDispatchContext, dispatchBridge, dispatchEmbeddings, dispatchNative } from './googleDispatch';

const logger = getDefaultLogger();

const DEPLOYED_SUFFIX = '--deployed';

/** "generateContent, streamGenerateContent and embedContent" — one source, Task 1's list. */
const SUPPORTED_METHODS = `${GEMINI_METHODS.slice(0, -1).join(', ')} and ${GEMINI_METHODS[GEMINI_METHODS.length - 1]}`;

export type GeminiRoute =
  | { kind: 'native'; deployment: GeminiDeployment }
  | { kind: 'bridge'; modelName: string }
  | { kind: 'embeddings-orchestration'; modelName: string }
  | { kind: 'embeddings-native'; deployment: GeminiDeployment };

/** A deployment counts as "Google" when SAP labels its provider so. */
function isGoogleProvider(details: any): boolean {
  return /google|gemini/i.test(details?.provider || details?.owned_by || '');
}

/** Bare catalogue entries carry the scenarios orchestration will accept them for. */
function hasOrchestrationScenario(details: any): boolean {
  return (details?.allowedScenarios || []).some((s: any) => s?.scenarioId === 'orchestration');
}

function hasEmbeddingCapability(details: any): boolean {
  return (details?.versions || []).some((v: any) => (v?.capabilities || []).includes('embedding'));
}

/**
 * Which transport serves `<model>:<method>` — spec section 5.4, the same rule
 * `/openai/v1/responses` follows: a deployment is used when one exists AND can
 * serve the request, and orchestration serves everything else. Every model in
 * the catalogue is therefore reachable; a deployment only takes precedence when
 * it is capable.
 *
 * Pure given `getDetails`, so the whole table is testable without a catalogue.
 * Returns null when nothing can serve the request — the caller 404s.
 */
export async function chooseRoute(
  model: string,
  method: GeminiMethod,
  getDetails: (id: string) => Promise<any>,
): Promise<GeminiRoute | null> {
  const baseModel = model.endsWith(DEPLOYED_SUFFIX) ? model.slice(0, -DEPLOYED_SUFFIX.length) : model;
  const deployment = await resolveGeminiDeployment(model, getDetails);
  const deploymentDetails = deployment ? await getDetails(deployment.id) : null;
  const googleDeployment = deployment && isGoogleProvider(deploymentDetails) ? deployment : null;

  if (method === 'embedContent') {
    // Orchestration FIRST, and deliberately so: it is the metered path, and
    // `/openai/v1/embeddings` never uses a deployment either. A chat deployment
    // is never offered `embedContent` — SAP refuses the subpath outright — which
    // the capability check below is what enforces.
    const baseDetails = await getDetails(baseModel);
    if (hasOrchestrationScenario(baseDetails)) {
      return { kind: 'embeddings-orchestration', modelName: baseDetails.model || baseModel };
    }
    if (googleDeployment && hasEmbeddingCapability(deploymentDetails)) {
      return { kind: 'embeddings-native', deployment: googleDeployment };
    }
    return null;
  }

  if (googleDeployment) return { kind: 'native', deployment: googleDeployment };
  // An explicitly named deployment that is NOT Google's — a Claude chat
  // deployment asked for in Gemini shape — is served by orchestration under its
  // base name, not refused.
  if (deployment && model.endsWith(DEPLOYED_SUFFIX)) return { kind: 'bridge', modelName: baseModel };

  const details = await getDetails(model);
  if (details) return { kind: 'bridge', modelName: details.model || baseModel };
  return null;
}

/** The model id usage, entitlement and hooks are recorded against. */
export function accountedModelId(route: GeminiRoute): string {
  return route.kind === 'native' || route.kind === 'embeddings-native' ? route.deployment.id : route.modelName;
}

/** One per-request memo, so the route table's repeated catalogue reads cost one lookup each. */
function catalogueReader(): (id: string) => Promise<any> {
  const seen = new Map<string, Promise<any>>();
  return (id: string) => {
    let hit = seen.get(id);
    if (!hit) {
      hit = modelService.getModelDetails(id);
      seen.set(id, hit);
    }
    return hit;
  };
}

async function headersForSap(): Promise<Record<string, string>> {
  const authToken = await (modelService as any).getAuthToken();
  return {
    Authorization: `Bearer ${authToken}`,
    'AI-Resource-Group': configService.getSAPAICoreConfig().resourceGroup,
    'Content-Type': 'application/json',
  };
}

async function failGemini(req: Request, res: Response, usage: any, accountedId: string, error: any): Promise<void> {
  const { status, message } = await geminiFailure(error);
  logger.error('googleController', `Gemini request failed for ${accountedId || 'unresolved model'}: ${message}`,
    undefined, { status });

  // Only once a model was resolved: a 404 or a refused method never reached an
  // upstream and belongs to no model's account.
  if (accountedId) emitUsageEvent(req, usage, accountedId, status);

  if (res.headersSent || res.writableEnded) {
    // Mid-stream: the status line is long gone, so the failure travels as a frame.
    if (!res.writableEnded) {
      try { res.write(sseBlock(geminiError(status, message))); } catch { /* best effort */ }
      res.end();
    }
    return;
  }
  refuse(res, status, message);
}

export const handleGemini = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
  const usage = createUsageMetrics();
  const segment = String((req.params as any)?.modelAndMethod ?? '');
  // Declared outside the try because the catch bills against it.
  let accountedId = '';

  try {
    const parsed = parseModelMethod(segment);
    if (!parsed) {
      refuse(res, 404, `Unsupported Gemini method in "${segment}". This gateway serves ${SUPPORTED_METHODS}.`);
      return;
    }

    const { method } = parsed;
    const model = configService.getSubstitutedModel('google', parsed.model);
    const route = await chooseRoute(model, method, catalogueReader());
    if (!route) {
      refuse(res, 404, method === 'embedContent'
        ? `Model ${model} does not support embedContent through this gateway. It has neither an `
          + 'orchestration embedding scenario nor a Google embedding deployment.'
        : `Model ${model} is not available through this gateway`);
      return;
    }
    accountedId = accountedModelId(route);

    // Entitlement, on BOTH ids when routing moved the request off the name the
    // client asked for — the parity `/openai/v1/responses` established at its own
    // `--deployed` sibling swap (responsesController.ts): the swap moves the request
    // onto a DIFFERENT catalog id, and a catalog that lists only the bare id must not
    // admit the decorated deployment, or vice versa. Both directions occur here — a
    // bare name swapped onto its Google twin, and a `--deployed` id bridged under its
    // base name — so the pair is checked rather than either one alone.
    //
    // `respondNotEntitled` is not used: it writes the OpenAI envelope.
    const block = entitlementFromRequest(req);
    const refusedId = [model, accountedId].find((id) => !isModelEntitled(block, id));
    if (refusedId !== undefined) {
      logEntitlementDecision(req, refusedId, false);
      // The SIEM event every other route raises through `enforceEntitlement`. Emitted
      // here explicitly because only the 403 BODY differs on this route, not the fact
      // that a credential was refused a model.
      emitNotEntitled(req, refusedId, block!);
      refuse(res, 403, `Model ${refusedId} is not in your entitlement catalog "${block?.catalogName}"`);
      return;
    }

    // Plugins first, so masking reaches the outbound body. They read
    // `req.__endpoint` and `req.body.model`; Gemini carries neither, so both are
    // supplied here and `model` is removed again before anything is sent
    // upstream — SAP would reject the extra field.
    (req as any).__endpoint = 'google';
    req.body = req.body || {};
    req.body.model = accountedId;

    const hookConfig = configService.getHookConfig(accountedId, method, 'google');
    if (hookConfig) {
      const pluginResult: any = await executeBeforePlugins(req, res, hookConfig);
      if (pluginResult?.stop) {
        logger.info('googleController', `Plugin short-circuited ${accountedId}/${method}`);
        // A plugin that answered on its own (a cache hit) hands back the body it
        // wants sent; one that already wrote to `res` hands back nothing. Honouring
        // `pluginResult.response` is a benign SUPERSET of what the other routes do —
        // they only ever `return` here, because no shipped plugin sets the field.
        if (pluginResult.response !== undefined && !res.headersSent) res.status(200).json(pluginResult.response);
        return;
      }
    }
    delete req.body.model;

    const ctx: GeminiDispatchContext = {
      req, res, method, body: req.body, route, usage, hookConfig, headersForSap, modelName: accountedId,
    };
    if (route.kind === 'native') {
      // The documented limits apply whichever transport serves the turn. The bridge
      // enforces them by translating, so it is not checked twice; a native deployment
      // would otherwise answer a request the gateway says it does not accept, and the
      // same body would be refused or served depending only on which model was picked.
      // Embeddings carry none of these fields, so only the chat methods are checked.
      validateGeminiRequest(ctx.body);
      await dispatchNative(ctx);
    } else if (route.kind === 'bridge') {
      await dispatchBridge(ctx);
    } else {
      await dispatchEmbeddings(ctx);
    }
  } catch (error: any) {
    await failGemini(req, res, usage, accountedId, error);
  }
};
