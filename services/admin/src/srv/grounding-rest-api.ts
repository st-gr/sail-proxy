/**
 * /api/grounding - the cockpit's Grounding layer (spec 2026-10-01 §4.1).
 *
 * It adds no logic of its own: it takes the signed-in user from the session, names that user to
 * the gateway, forwards the call and returns the gateway's answer. Every file_search rule,
 * including who may see what, is the gateway's. The route table is explicit, so the layer cannot
 * be used to reach anything but the routes listed here.
 *
 * One route is answered here, not by the gateway: GET /model-cost prices an estimate's tokens with
 * the admin's own Model Library price (see modelCost below).
 */
import express from 'express';
import { getDefaultLogger } from '@libs/logger';
import { callGateway, streamToGateway, streamFromGateway, getMaxFileBytes, GroundingActor } from '../services/groundingGatewayClient';
import { membershipsOf, getTeam } from '../services/teamLookups';
import { computeSapNative, isProductive } from '../services/sapCapacityService';

const cds = require('@sap/cds');
const logger = getDefaultLogger();
const router: express.Router = express.Router();

type Kind = 'json' | 'upload' | 'download';
interface Route { method: 'get' | 'post' | 'delete'; path: string; kind: Kind }

// Phase 1: what the Vector Stores and Files screens call; phase 2 adds jobs, retries, batches and search.
const ROUTES: Route[] = [
  { method: 'get', path: '/status', kind: 'json' },
  { method: 'get', path: '/file-attachments', kind: 'json' },
  { method: 'post', path: '/files', kind: 'upload' },
  { method: 'get', path: '/files', kind: 'json' },
  { method: 'get', path: '/files/:id/content', kind: 'download' },
  { method: 'get', path: '/files/:id', kind: 'json' },
  { method: 'delete', path: '/files/:id', kind: 'json' },
  { method: 'post', path: '/stores', kind: 'json' },
  { method: 'get', path: '/stores', kind: 'json' },
  { method: 'get', path: '/stores/:id', kind: 'json' },
  { method: 'post', path: '/stores/:id', kind: 'json' },
  { method: 'delete', path: '/stores/:id', kind: 'json' },
  { method: 'post', path: '/stores/:id/files', kind: 'json' },
  { method: 'get', path: '/stores/:id/files', kind: 'json' },
  { method: 'get', path: '/stores/:id/files/:file_id', kind: 'json' },
  { method: 'post', path: '/stores/:id/files/:file_id', kind: 'json' },
  { method: 'delete', path: '/stores/:id/files/:file_id', kind: 'json' },
  // Phase 2: jobs, retries, batches and retrieval.
  { method: 'get', path: '/jobs', kind: 'json' },
  { method: 'get', path: '/jobs/:job_id', kind: 'json' },
  { method: 'post', path: '/jobs/:job_id/cancel', kind: 'json' },
  { method: 'post', path: '/jobs/:job_id/retry', kind: 'json' },
  { method: 'post', path: '/stores/:id/files/:file_id/retry', kind: 'json' },
  { method: 'post', path: '/stores/:id/search', kind: 'json' },
  { method: 'post', path: '/stores/:id/file_batches', kind: 'json' },
  { method: 'get', path: '/stores/:id/file_batches/:batch_id', kind: 'json' },
  { method: 'get', path: '/stores/:id/file_batches/:batch_id/files', kind: 'json' },
  // Phase 3: administration and sharing. The gateway decides who may call the admin routes.
  { method: 'get', path: '/storage', kind: 'json' },
  { method: 'get', path: '/admin/overview', kind: 'json' },
  { method: 'get', path: '/admin/stores', kind: 'json' },
  { method: 'get', path: '/admin/files', kind: 'json' },
  { method: 'get', path: '/admin/failed', kind: 'json' },
  { method: 'get', path: '/admin/storage', kind: 'json' },
  { method: 'get', path: '/admin/jobs', kind: 'json' },
  // One job of any owner (the job page an admin opens from the admin list).
  { method: 'get', path: '/admin/jobs/:job_id', kind: 'json' },
  { method: 'delete', path: '/admin/stores/:id', kind: 'json' },
  { method: 'delete', path: '/admin/files/:id', kind: 'json' },
  { method: 'post', path: '/admin/stores/:id/files/:file_id/retry', kind: 'json' },
  { method: 'post', path: '/admin/stores/:id/share', kind: 'json' },
  { method: 'post', path: '/admin/stores/:id/unshare', kind: 'json' },
  // Team sharing (spec 2026-10-14 §8): the gateway decides who may share and unshare.
  { method: 'post', path: '/stores/:id/share-team', kind: 'json' },
  { method: 'post', path: '/stores/:id/unshare-team', kind: 'json' },
  // Phase 4a: re-embedding. The gateway decides who owns a store and who may call the admin routes.
  { method: 'get', path: '/stores/:id/reembed/estimate', kind: 'json' },
  { method: 'post', path: '/stores/:id/reembed', kind: 'json' },
  { method: 'get', path: '/admin/stores/:id/reembed/estimate', kind: 'json' },
  { method: 'post', path: '/admin/stores/:id/reembed', kind: 'json' },
  { method: 'get', path: '/admin/reembed-outdated/estimate', kind: 'json' },
  { method: 'post', path: '/admin/reembed-outdated', kind: 'json' },
  { method: 'post', path: '/admin/jobs/:job_id/cancel', kind: 'json' },
  { method: 'post', path: '/admin/jobs/:job_id/retry', kind: 'json' },
  // The files a re-embed job could not re-embed: the owner's (scoped by the gateway) and any owner's for an admin.
  { method: 'get', path: '/jobs/:job_id/failures', kind: 'json' },
  { method: 'get', path: '/admin/jobs/:job_id/failures', kind: 'json' },
  // W2: a store's chunking setting (the create takes `chunking` on POST /stores above). Re-chunk jobs
  // are re-embed jobs: cancel, retry and failures use the job routes above.
  { method: 'get', path: '/stores/:id/chunking/estimate', kind: 'json' },
  { method: 'post', path: '/stores/:id/chunking', kind: 'json' },
  { method: 'get', path: '/admin/stores/:id/chunking/estimate', kind: 'json' },
  { method: 'post', path: '/admin/stores/:id/chunking', kind: 'json' },
  // W3: re-reading the files an older extractor read (a re-chunk job to the store's own setting).
  { method: 'get', path: '/stores/:id/reextract/estimate', kind: 'json' },
  { method: 'post', path: '/stores/:id/reextract', kind: 'json' },
  { method: 'get', path: '/admin/stores/:id/reextract/estimate', kind: 'json' },
  { method: 'post', path: '/admin/stores/:id/reextract', kind: 'json' },
  // Phase 5: blob storage. Cancel, retry and failures of a migration use the admin job routes above.
  { method: 'get', path: '/admin/blob-storage', kind: 'json' },
  { method: 'post', path: '/admin/blob-storage/test', kind: 'json' },
  { method: 'post', path: '/admin/blob-storage/migrate', kind: 'json' },
];

/**
 * The signed-in cockpit user. req.user is the only identity source. Docker and Kyma set it from
 * the oauth2-proxy headers and local `cds watch` supplies a cds.User; both have is(). A plain
 * object without is() falls back to its roles array. An anonymous user has no e-mail and is refused.
 */
function actorOf(req: any): GroundingActor | null {
  const user = req.user;
  const email = typeof user?.id === 'string' && user.id.includes('@') ? user.id : null;
  if (!email) return null;
  const roles: unknown = user.roles ?? user.scope ?? [];
  const isAdmin = typeof user.is === 'function' ? !!user.is('admin') : Array.isArray(roles) && roles.includes('admin');
  return { email, role: isAdmin ? 'admin' : 'user' };
}

// The gateway rejects more than this many acting teams with 400 (invalid_acting_teams).
const MAX_ACTING_TEAMS = 200;

/**
 * The actor with their teams (spec 2026-10-14 §8): one membership read before the gateway call,
 * outside any CAP request transaction. The ids come from the server-side memberships, never from
 * the browser. Over 200 memberships the list is capped, team admin rights first, so the gateway
 * never answers every call with 400. A failed read sends no teams: the user then sees what they
 * saw before teams existed, never more.
 */
async function withTeams(actor: GroundingActor): Promise<GroundingActor> {
  try {
    const memberships = await membershipsOf(cds, actor.email);
    const admin = memberships.filter((m) => m.role === 'admin').map((m) => m.team_ID.toLowerCase());
    const member = memberships.filter((m) => m.role !== 'admin').map((m) => m.team_ID.toLowerCase());
    const all = [...admin, ...member];
    if (all.length > MAX_ACTING_TEAMS) logger.warn('GroundingRestApi', `${actor.email} has ${all.length} team memberships; acting with ${MAX_ACTING_TEAMS}`);
    const teamIds = all.slice(0, MAX_ACTING_TEAMS);
    return { ...actor, teamIds, adminTeamIds: admin.filter((id) => teamIds.includes(id)) };
  } catch (error) {
    logger.warn('GroundingRestApi', `team lookup failed; acting without teams: ${error instanceof Error ? error.message : String(error)}`);
    return { ...actor, teamIds: [], adminTeamIds: [] };
  }
}

/** The refusal text in the caller's language (Accept-Language), from the admin's messages bundle. */
function refusal(req: express.Request, key: string): string {
  const header = String(req.headers['accept-language'] ?? '').split(',')[0].split(';')[0].trim().toLowerCase();
  return cds.i18n.messages.at(key, header.split('-')[0] || undefined) ?? key;
}

/** Only plain string values travel on. A bracketed parameter is a prototype-less object and is dropped. */
function stringQuery(query: unknown): URLSearchParams {
  const out = new URLSearchParams();
  if (!query || typeof query !== 'object') return out;
  for (const key of Object.keys(query as object)) {
    const raw = (query as any)[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string') out.append(key, value);
  }
  return out;
}

const MULTIPART_ALLOWANCE_BYTES = 1048576;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function gatewayPath(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:([A-Za-z_]+)/g, (_match, name) => encodeURIComponent(String(params[name] ?? '')));
}

function sendUnreachable(res: express.Response): void {
  if (!res.headersSent) res.status(502).json({ error: 'gateway_unreachable', message: 'The gateway could not be reached.' });
}

const MODEL_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const TOKEN_COUNT = /^\d{1,13}$/;

/**
 * GET /model-cost?model=&input_tokens=&output_tokens= - what that many tokens of `model` cost by the
 * Model Library's current price, priced like a usage event (sapCapacityService.computeSapNative:
 * GenAI tokens x CU factor x the capacity unit price). For the cockpit's estimates (a re-chunk's
 * vision pages): `{ priced, capacity_units, cost, currency }`; `priced: false` when the model has no
 * price, `cost: null` when no capacity unit price is maintained. Any signed-in user: the capacity unit
 * price is admin-readable only, but a user can derive the same ratio from their own usage stats, so the
 * answer reveals nothing they could not work out.
 */
router.get('/model-cost', async (req, res) => {
  if (!actorOf(req)) {
    res.status(401).json({ error: 'authentication_required', message: 'Sign in to use Grounding.' });
    return;
  }
  const query = stringQuery(req.query);
  const model = query.get('model') ?? '';
  const input = query.get('input_tokens') ?? '0';
  const output = query.get('output_tokens') ?? '0';
  if (!MODEL_ID.test(model) || !TOKEN_COUNT.test(input) || !TOKEN_COUNT.test(output)) {
    res.status(400).json({ error: 'invalid_request', message: 'Name a model and whole token counts.' });
    return;
  }
  try {
    const priced = await computeSapNative({
      model, provider: '', inputTokens: Number(input), outputTokens: Number(output),
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, at: new Date(), productive: isProductive()
    });
    res.status(200).json(priced
      ? { priced: true, capacity_units: priced.capacityUnits, cost: priced.sapCost, currency: priced.sapCostCurrency }
      : { priced: false, capacity_units: null, cost: null, currency: null });
  } catch (error) {
    logger.error('GroundingRestApi', `GET /model-cost failed: ${(error as Error)?.message}`, error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ error: 'price_lookup_failed', message: 'The price could not be read.' });
  }
});

for (const route of ROUTES) {
  const handlers: express.RequestHandler[] = [];
  // Docker has no global JSON parser in front of this router; local dev has one, and then
  // express.json sees the body is already parsed and does nothing.
  if (route.kind === 'json' && route.method === 'post') handlers.push(express.json({ limit: '1mb' }));

  handlers.push(async (req, res) => {
    const base = actorOf(req);
    if (!base) {
      res.status(401).json({ error: 'authentication_required', message: 'Sign in to use Grounding.' });
      return;
    }
    // A header value is printable ASCII; anything else would make the HTTP client throw and be reported as an unreachable gateway.
    if (!/^[\x21-\x7e]{1,254}$/.test(base.email)) {
      res.status(400).json({ error: 'unsupported_identity', message: 'Your sign-in e-mail contains characters Grounding cannot pass to the gateway.' });
      return;
    }
    // An id is a plain token. Anything else (such as a dot segment) could be normalised into another gateway route.
    if (Object.values(req.params).some((value) => !ID_PATTERN.test(String(value)))) {
      res.status(400).json({ error: 'invalid_id', message: 'The id is not valid.' });
      return;
    }
    const path = gatewayPath(route.path, req.params);
    try {
      // Read the memberships first and on their own: no transaction is open while the gateway call runs.
      const actor = await withTeams(base);
      // The gateway cannot tell whether a team exists; only the admin knows.
      if (route.path === '/stores/:id/share-team' && typeof req.body?.teamId === 'string' && !(await getTeam(cds, req.body.teamId))) {
        res.status(404).json({ error: 'team_not_found', message: refusal(req, 'TEAM_SHARE_TARGET_NOT_FOUND') });
        return;
      }
      if (route.kind === 'upload') {
        const contentType = req.headers['content-type'];
        if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('multipart/form-data')) {
          res.status(400).json({ error: 'invalid_content_type', message: 'Upload the file as multipart/form-data.' });
          return;
        }
        const contentLength = typeof req.headers['content-length'] === 'string' ? req.headers['content-length'] : undefined;
        // The gateway answers an oversized file by closing the connection, which the client would see as an interruption.
        const declared = contentLength ? Number(contentLength) : NaN;
        if (Number.isFinite(declared)) {
          const maxFileBytes = await getMaxFileBytes(actor);
          if (maxFileBytes !== null && declared > maxFileBytes + MULTIPART_ALLOWANCE_BYTES) {
            res.status(413).json({ error: 'file_too_large', message: `The file is larger than the allowed ${(maxFileBytes / 1048576).toFixed(1)} MB.` });
            return;
          }
        }
        const reply = await streamToGateway(actor, path, req, { contentType, contentLength });
        res.status(reply.status).json(reply.data ?? {});
        return;
      }
      if (route.kind === 'download') {
        const upstream = await streamFromGateway(actor, path);
        res.status(upstream.status);
        for (const header of ['content-type', 'content-length', 'content-disposition']) {
          if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
        }
        upstream.stream.on('error', () => { if (!res.headersSent) sendUnreachable(res); else res.end(); });
        // A browser that gave up while the gateway was answering has already fired 'close'.
        if (res.destroyed) { upstream.stream.destroy(); return; }
        // A browser that gives up later must not keep the gateway streaming into nothing.
        res.on('close', () => { if (!res.writableFinished) upstream.stream.destroy(); });
        upstream.stream.pipe(res);
        return;
      }
      const reply = await callGateway(actor, route.method, path, {
        query: stringQuery(req.query),
        body: route.method === 'post' ? req.body : undefined
      });
      res.status(reply.status).json(reply.data ?? {});
    } catch (error) {
      logger.error('GroundingRestApi', `${route.method.toUpperCase()} ${route.path} failed: ${(error as Error)?.message}`, error instanceof Error ? error : new Error(String(error)));
      sendUnreachable(res);
    }
  });

  (router as any)[route.method](route.path, ...handlers);
}

// Export the router
module.exports = router;
