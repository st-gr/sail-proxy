/**
 * Quota on the cockpit's paid grounding work (W8).
 *
 * A cockpit call carries the admin service key, not a credential of the user who pays, so the
 * model routes' quotaEnforcement cannot run here. Instead each route that STARTS paid work checks
 * the quota of whoever PAYS for it, with the model routes' own spend/token admission
 * (createOwnerAdmission): store work (ingestion, re-embedding, re-chunking, re-extraction, their
 * retries) is billed to the store owner, so it is checked against the owner; a search is billed to
 * the searcher (fileSearch/usage.ts fileSearchCallerOf), so it is checked against the acting user,
 * also an admin searching through the user route and anyone searching a shared store.
 *
 * Not checked: reads, estimates, cancels, edits, detaches and uploads (no paid work), work already
 * queued or running (the workers never look), and the admin maintenance routes under /admin
 * (groundingRoutes.ts mounts no guard there). No requests-per-minute limit on cockpit calls.
 *
 * Each guard runs before its handler and calls next() when it admits. A store or job the acting
 * user cannot use is not checked: the handler answers its own 404 first.
 */
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDefaultLogger } from '@libs/logger';
import { admitOwner, Exceeded } from './quotaEnforcement';
import { isFileSearchAvailable } from '../fileSearch/db';
import { readVisibleStore } from '../fileSearch/repository';
import { callerTeamIds } from '../utils/userBlock';
import { jobSummary } from '../fileSearch/jobs';
import { ADMIN_JOB_KINDS } from '../controllers/groundingController';

const logger = getDefaultLogger();

/** Whose quota a request's paid work is checked against, or null when it starts none here. */
export type PayerOf = (req: Request) => Promise<string | null>;

const actorOf = (req: Request): string | null => (req as any).groundingActor?.email ?? null;

async function visibleStore(req: Request) {
  const actor = actorOf(req);
  if (!actor || !isFileSearchAvailable()) return null;
  return readVisibleStore(actor, req.params.id, callerTeamIds(req));
}

/** Owner-only store routes (attach, batch, re-embed, re-chunk, re-extract, file retry): the acting owner. */
export const ownedStore: PayerOf = async (req) => {
  const store = await visibleStore(req);
  return store?.owned ? store.owner_email : null;
};

/** Search (own or shared store): the searcher pays, also an admin or another user on a shared store. */
export const searchedStore: PayerOf = async (req) => ((await visibleStore(req)) ? actorOf(req) : null);

/** A store create ingests only when it names files; the new store's owner is the acting user. */
export const createdStoreWithFiles: PayerOf = async (req) => {
  const fileIds = (req.body ?? {}).file_ids;
  return Array.isArray(fileIds) && fileIds.length > 0 ? actorOf(req) : null;
};

/**
 * A job retry of the acting user's own job (jobSummary is scoped to its owner). An admin's bulk
 * re-embed or blob migration retried here is maintenance and is not checked.
 */
export const retriedJob: PayerOf = async (req) => {
  const actor = actorOf(req);
  if (!actor || !isFileSearchAvailable()) return null;
  const job = await jobSummary(req.params.job_id, actor);
  return job && !ADMIN_JOB_KINDS.includes(job.kind) ? actor : null;
};

/**
 * The model routes' 429 shape plus a code and a message (a team pool's names the team). The limit and usage figures are sent only
 * when the payer is the acting user (their own figures): with today's resolvers always, since the
 * owner-only routes resolve an owner who is the acting user and search resolves the searcher.
 */
export function sendQuotaExceeded(res: Response, x: Exceeded, now: number, ownQuota: boolean): void {
  const resetsAt = new Date(x.resetsAt).toISOString();
  res.set({ 'Retry-After': String(Math.max(1, Math.ceil((x.resetsAt - now) / 1000))) });
  const team = x.scope === 'team';
  const whose = team ? (x.team ? `The team ${x.team}'s` : "The team's") : ownQuota ? 'Your' : "The vector store owner's";
  res.status(429).json({ error: {
    type: 'quota_exceeded', code: 'quota_exceeded',
    message: `${whose} usage quota for this ${x.window} is used up. New processing and searches can start after ${resetsAt}; work already queued continues.`,
    scope: x.scope, ...(team && x.team ? { team: x.team } : {}), dimension: x.dimension, window: x.window,
    ...(ownQuota ? { limit: x.limit, used: Math.round(x.used * 1000) / 1000 } : {}),
    resets_at: resetsAt
  } });
}

export function createGroundingQuota(admit: (req: any, email: string) => Promise<Exceeded | null>, clock: () => number = Date.now) {
  return (payerOf: PayerOf): RequestHandler => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let payer: string | null;
    try {
      payer = await payerOf(req);
    } catch (error) {
      // The handler makes the same lookup and answers the failure itself; the check fails open.
      logger.warn('GroundingQuota', `payer lookup failed, not checked: ${error instanceof Error ? error.message : String(error)}`);
      next();
      return;
    }
    if (!payer) { next(); return; }
    try {
      const exceeded = await admit(req, payer);
      if (exceeded) { sendQuotaExceeded(res, exceeded, clock(), payer === (req as any).groundingActor?.email); return; }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** `router.post(path, groundingQuota(ownedStore))` ahead of the route's handler. */
export const groundingQuota = createGroundingQuota(admitOwner);
