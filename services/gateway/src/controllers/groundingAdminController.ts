/**
 * Grounding administration and sharing (spec 2026-10-01 §5.1, §5.2, §7.5; plan decisions 1, 2, 5–9).
 *
 * - `/admin/*` handlers run behind the groundingAdmin guard. Reads use fileSearch/admin.ts, the only
 *   file_search reads not scoped by an owner. Mutations resolve the owner first and then call the
 *   SAME owner-scoped functions and response helpers the owner's routes use (decision 6), so the SQL,
 *   the lock order, the post-commit work (blob release, ingest hints) and the error mapping are
 *   the owner's, not a copy.
 * - `GET /stores`, `GET /stores/:id` and `GET /storage` are user-level: the caller's own stores plus
 *   every shared one, read-only (decision 1), and the caller's own storage (decision 2). Everything
 *   else on a store stays owner-only — a non-owner of a shared store gets 404 from the unchanged
 *   table handlers (ruling P1).
 *
 * Every query parameter is read through queryString() (express 4.22 null-prototype query).
 */
import { Request, Response, NextFunction } from 'express';
import { getPool } from '../fileSearch/db';
import * as admin from '../fileSearch/admin';
import {
  deleteStoreCascade,
  listVisibleStores as listVisibleStoreRows,
  readStoreRow,
  readVisibleStore as readVisibleStoreRow,
  setStoreShared,
  shareStoreWithTeam as shareStoreWithTeamRow,
  teamIdsOfStores,
  unshareStoreFromTeam as unshareStoreFromTeamRow,
  deleteTeamShares as deleteTeamShareRows,
  VectorStoreRow,
} from '../fileSearch/repository';
import type { GroundingActor } from '../middlewares/groundingActingUser';
import { storageOfOwner } from '../fileSearch/groundingQueries';
import { embeddingState } from '../fileSearch/embeddingState';
import { unfinishedReembedJobs } from '../fileSearch/reembed';
import { getFileSearchConfig } from '../services/configService';
import { buildPage, parsePageParams } from '../fileSearch/pagination';
import { jobSummaryAnyOwner, type JobState } from '../fileSearch/jobs';
import { queryString } from '../utils/queryParam';
import { callerTeamIds } from '../utils/userBlock';
import { computeUsageForStores, emptyUsage, handleDeadlock, sendStoreNotFound, toStoreObject } from './vectorStoresController';
import {
  jobOwner,
  sendDetachingDelete,
  sendError,
  sendFileNotFound,
  sendJobNotFound,
  sendRetryRefusal,
  sendStoreFileRetry,
} from './groundingController';

const DEFAULT_LIMIT = 20;

function toUnixSeconds(value: Date | string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

/** `?limit=`: 20 when absent, else an integer from 1 to 100 — or a 400 and null. */
function pageLimit(req: Request, res: Response): number | null {
  const raw = queryString(req.query.limit);
  const limit = raw === null ? DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > admin.MAX_ADMIN_PAGE_LIMIT) {
    sendError(res, 400, 'invalid_limit', `limit must be an integer from 1 to ${admin.MAX_ADMIN_PAGE_LIMIT}.`);
    return null;
  }
  return limit;
}

/** A value from a fixed set, null when absent — or a 400 and undefined. */
function oneOf<T extends string>(req: Request, res: Response, name: string, allowed: readonly T[]): T | null | undefined {
  const value = queryString(req.query[name]);
  if (value === null) return null;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  sendError(res, 400, `invalid_${name}`, `${name} must be one of ${allowed.join(', ')}.`);
  return undefined;
}

/** The data layer's input errors (owner or cursor too long, malformed failed-list cursor) are 400s;
 *  an id no row can carry is not one of them — the owner lookups answer it as not found. */
function handleAdminError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof admin.AdminQueryInputError) { sendError(res, 400, 'invalid_parameter', error.message); return; }
  next(error);
}

function sendList(res: Response, page: { data: unknown[]; has_more: boolean; first_id: string | null; last_id: string | null }): void {
  res.status(200).json({ object: 'list', data: page.data, has_more: page.has_more, first_id: page.first_id, last_id: page.last_id });
}

/** The configured model and dimension, which a store's embedding state is measured against. */
function embeddingTarget(): admin.EmbeddingTarget {
  const config = getFileSearchConfig();
  return { embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions };
}

/**
 * OpenAI store objects with the grounding fields: the sharing fields (whether it is shared, whether
 * the caller owns it, the owner) and the embedding fields (the store's model, dimension and active
 * generation, its state against the configuration, and its unfinished re-embed job), and the
 * store's chunking setting. The OpenAI
 * routes keep the plain store object. `reembed_job_id` is null on another owner's shared store
 * unless `allOwners` (the admin rows): that job is the owner's, not the reader's. `team_ids` are
 * the teams the store is shared with: all of them for the owner, the admin rows and a
 * `viewerTeamIds` of null (a platform admin); otherwise only those among `viewerTeamIds`, so a
 * member does not learn which other teams a store is shared with.
 */
async function toSharedStoreObjects(
  rows: VectorStoreRow[], actingEmail: string, allOwners = false, viewerTeamIds: readonly string[] | null = [],
): Promise<Record<string, unknown>[]> {
  const ids = rows.map((row) => row.id);
  const [usage, reembedJobs, teams] = await Promise.all([
    computeUsageForStores(getPool()!, ids), unfinishedReembedJobs(ids), teamIdsOfStores(ids),
  ]);
  const target = embeddingTarget();
  return rows.map((row) => {
    const owned = row.owner_email === actingEmail;
    return {
      ...toStoreObject(row, usage.get(row.id) ?? emptyUsage()),
      is_shared: row.is_shared,
      owned,
      owner_email: row.owner_email,
      embedding_model: row.embedding_model,
      embedding_dim: row.embedding_dim,
      active_generation: row.active_generation,
      embedding_state: embeddingState(row, target),
      reembed_job_id: owned || allOwners ? reembedJobs.get(row.id) ?? null : null,
      // The store's chunking setting as stored; null = a store from before the setting (static 800/400).
      chunking: row.chunking ?? null,
      team_ids: (teams.get(row.id) ?? []).filter((id) => owned || allOwners || viewerTeamIds === null || viewerTeamIds.includes(id)),
    };
  });
}

/** The team ids a caller sees on a store they do not own: every one for a platform admin (who may
 *  unshare any team), else the caller's own teams. */
function viewerTeamIdsOf(req: Request): readonly string[] | null {
  return (req as any).groundingActor?.role === 'admin' ? null : callerTeamIds(req);
}

// ---------------------------------------------------------------------------
// User level: shared-aware store reads and the caller's storage
// ---------------------------------------------------------------------------

/**
 * GET /stores - the caller's stores and every shared one, newest first. Paged with `limit` and
 * `after` like the OpenAI list (`limit` clamped to 1–100); `order=asc` and `before` are refused:
 * the cockpit pages forwards only, and silently ignoring them would return the wrong page.
 */
export async function listStores(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const { limit, order, after, before } = parsePageParams(req.query as Record<string, unknown>);
    if (order !== 'desc' || before !== null) {
      sendError(res, 400, 'unsupported_parameter', 'This list pages newest first with after only; order=asc and before are not supported.');
      return;
    }
    const page = buildPage(await listVisibleStoreRows(email, { limit, after, teamIds: callerTeamIds(req) }), limit);
    sendList(res, { ...page, data: await toSharedStoreObjects(page.data, email, false, viewerTeamIdsOf(req)) });
  } catch (error) {
    next(error);
  }
}

/** GET /stores/:id - one store the caller owns or that is shared; 404 otherwise. */
export async function readStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const row = await readVisibleStoreRow(email, req.params.id, callerTeamIds(req));
    if (!row) { sendStoreNotFound(res, req.params.id); return; }
    res.status(200).json((await toSharedStoreObjects([row], email, false, viewerTeamIdsOf(req)))[0]);
  } catch (error) {
    next(error);
  }
}

/** GET /storage - the caller's file count and logical bytes. */
export async function storage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    res.status(200).json(await storageOfOwner(email));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Admin level: reads
// ---------------------------------------------------------------------------

/** GET /admin/overview */
export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    res.status(200).json(await admin.overview(embeddingTarget()));
  } catch (error) {
    next(error);
  }
}

/** GET /admin/stores?owner=&status=&shared=&embedding_state=&after=&limit= */
export async function listAllStores(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const limit = pageLimit(req, res);
    if (limit === null) return;
    const status = oneOf(req, res, 'status', admin.ADMIN_STORE_STATUSES);
    if (status === undefined) return;
    const shared = oneOf(req, res, 'shared', ['true', 'false'] as const);
    if (shared === undefined) return;
    const state = oneOf(req, res, 'embedding_state', admin.ADMIN_EMBEDDING_STATES);
    if (state === undefined) return;
    const rows = await admin.listAllStores({
      owner: queryString(req.query.owner),
      status,
      shared: shared === null ? null : shared === 'true',
      embeddingState: state === null ? null : { state, target: embeddingTarget() },
      after: queryString(req.query.after),
      limit,
    });
    const page = buildPage(rows, limit);
    sendList(res, { ...page, data: await toSharedStoreObjects(page.data, email, true) });
  } catch (error) {
    handleAdminError(error, res, next);
  }
}

/** GET /admin/files?owner=&after=&limit= - file objects with the owner and attachment count; no hash. */
export async function listAllFiles(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const limit = pageLimit(req, res);
    if (limit === null) return;
    const rows = await admin.listAllFiles({ owner: queryString(req.query.owner), after: queryString(req.query.after), limit });
    const page = buildPage(rows, limit);
    sendList(res, {
      ...page,
      data: page.data.map((row) => ({
        id: row.id,
        object: 'file',
        bytes: row.size_bytes,
        created_at: toUnixSeconds(row.created_at),
        filename: row.filename,
        purpose: row.purpose,
        owner_email: row.owner_email,
        attachment_count: row.attachment_count,
      })),
    });
  } catch (error) {
    handleAdminError(error, res, next);
  }
}

/** GET /admin/failed?owner=&batch_id=&after=&limit= - failed ingestions; `id` is `<store_id>/<file_id>`. */
export async function listFailed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const limit = pageLimit(req, res);
    if (limit === null) return;
    const rows = await admin.listFailedAttachments({
      owner: queryString(req.query.owner), batchId: queryString(req.query.batch_id), after: queryString(req.query.after), limit,
    });
    const page = buildPage(rows, limit);
    sendList(res, { ...page, data: page.data.map((row) => ({ ...row, created_at: toUnixSeconds(row.created_at) })) });
  } catch (error) {
    handleAdminError(error, res, next);
  }
}

/**
 * GET /admin/storage?after=&limit= - file count and logical bytes per owner, ordered by e-mail.
 * An owner has no id: the page is keyed on `owner_email`, so `first_id`/`last_id` are e-mails and
 * `after` takes the `last_id` of the previous page.
 */
export async function listStorage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const limit = pageLimit(req, res);
    if (limit === null) return;
    const rows = await admin.storageByOwner({ after: queryString(req.query.after), limit });
    const page = buildPage(rows.map((row) => ({ ...row, id: row.owner_email })), limit);
    sendList(res, {
      ...page,
      data: page.data.map((row) => ({ owner_email: row.owner_email, file_count: row.file_count, logical_bytes: row.logical_bytes })),
    });
  } catch (error) {
    handleAdminError(error, res, next);
  }
}

/** GET /admin/jobs?owner=&state=&after=&limit= - everyone's jobs, read-only (ruling P2). */
export async function listAllJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const limit = pageLimit(req, res);
    if (limit === null) return;
    const state = oneOf<JobState>(req, res, 'state', admin.ADMIN_JOB_STATES);
    if (state === undefined) return;
    const rows = await admin.listAllJobs({ owner: queryString(req.query.owner), state, after: queryString(req.query.after), limit });
    sendList(res, buildPage(rows, limit));
  } catch (error) {
    handleAdminError(error, res, next);
  }
}

/** GET /admin/jobs/:job_id - one job of any owner, with its owner (the job page an admin opens from
 *  the admin list); an unknown id is the owner route's 404. */
export async function getJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const job = await jobSummaryAnyOwner(req.params.job_id);
    if (!job) { sendJobNotFound(res); return; }
    res.status(200).json(job);
  } catch (error) {
    handleAdminError(error, res, next);
  }
}

// ---------------------------------------------------------------------------
// Admin level: mutations on anyone's data (decision 6), sharing (decision 8)
// ---------------------------------------------------------------------------

/** DELETE /admin/stores/:id - the owner's delete (deleteStoreCascade) run as the store's owner. */
export async function deleteStore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const storeId = req.params.id;
    const owner = await admin.ownerOfStore(storeId);
    // A store deleted between the two statements is the same 404 the owner would get.
    const { deleted } = owner === null ? { deleted: false } : await deleteStoreCascade(storeId, owner);
    if (!deleted) { sendStoreNotFound(res, storeId); return; }
    res.status(200).json({ id: storeId, object: 'vector_store.deleted', deleted: true });
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    handleAdminError(error, res, next);
  }
}

/** DELETE /admin/files/:id - the owner's `?detach=true` delete run as the file's owner. */
export async function deleteFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const fileId = req.params.id;
    const owner = await admin.ownerOfFile(fileId);
    if (owner === null) { sendFileNotFound(res, fileId); return; }
    await sendDetachingDelete(res, fileId, owner);
  } catch (error) {
    if (handleDeadlock(error, res)) return;
    handleAdminError(error, res, next);
  }
}

/** POST /admin/stores/:id/files/:file_id/retry - the owner's retry run as the store's owner. */
export async function retryStoreFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  let owner: string | null;
  try {
    if (!jobOwner(req, res)) return;
    owner = await admin.ownerOfStore(req.params.id);
  } catch (error) {
    handleAdminError(error, res, next);
    return;
  }
  if (owner === null) { sendRetryRefusal(res, 'not_found', ''); return; }
  await sendStoreFileRetry(res, next, req.params.id, req.params.file_id, owner);
}

/** POST /admin/stores/:id/share and /unshare - only a store the acting admin owns; 404 otherwise. */
function setShared(shared: boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const email = jobOwner(req, res);
      if (!email) return;
      const row = await setStoreShared(req.params.id, email, shared);
      if (!row) { sendStoreNotFound(res, req.params.id); return; }
      res.status(200).json((await toSharedStoreObjects([row], email))[0]);
    } catch (error) {
      next(error);
    }
  };
}

export const shareStore = setShared(true);
export const unshareStore = setShared(false);

// ---------------------------------------------------------------------------
// Team shares (spec 2026-10-14 §8): read and search for the team's members, nothing owner-only
// ---------------------------------------------------------------------------

const TEAM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A team id, lower-cased — or a 400 and null. */
function teamIdOf(value: unknown, res: Response): string | null {
  const teamId = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (TEAM_ID_PATTERN.test(teamId)) return teamId;
  sendError(res, 400, 'invalid_team_id', 'teamId must be a team id.');
  return null;
}

function sendTeamAdminRequired(res: Response): void {
  sendError(res, 403, 'team_admin_required', 'Only an administrator of that team may change its shares.', 'permission_error');
}

/** POST /stores/:id/share-team { teamId } - the owner shares with a team they administer (any team,
 *  as a platform admin). A store the caller does not own is a 404, also for a platform admin. */
export async function shareStoreWithTeam(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const actor = (req as any).groundingActor as GroundingActor;
    const teamId = teamIdOf(req.body?.teamId, res);
    if (!teamId) return;
    if (actor.role !== 'admin' && !(actor.adminTeamIds ?? []).includes(teamId)) { sendTeamAdminRequired(res); return; }
    const row = await shareStoreWithTeamRow(req.params.id, email, teamId);
    if (!row) { sendStoreNotFound(res, req.params.id); return; }
    res.status(200).json((await toSharedStoreObjects([row], email, false, viewerTeamIdsOf(req)))[0]);
  } catch (error) {
    next(error);
  }
}

/** POST /stores/:id/unshare-team { teamId } - the owner, an admin of that team, or a platform admin.
 *  A store the caller cannot see is a 404; a team the store is not shared with is a no-op. */
export async function unshareStoreFromTeam(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = jobOwner(req, res);
    if (!email) return;
    const actor = (req as any).groundingActor as GroundingActor;
    const teamId = teamIdOf(req.body?.teamId, res);
    if (!teamId) return;
    const platformAdmin = actor.role === 'admin';
    const row = platformAdmin ? await readStoreRow(req.params.id) : await readVisibleStoreRow(email, req.params.id, callerTeamIds(req));
    if (!row) { sendStoreNotFound(res, req.params.id); return; }
    if (!platformAdmin && row.owner_email !== email && !(actor.adminTeamIds ?? []).includes(teamId)) { sendTeamAdminRequired(res); return; }
    await unshareStoreFromTeamRow(req.params.id, teamId);
    res.status(200).json((await toSharedStoreObjects([row], email, false, viewerTeamIdsOf(req)))[0]);
  } catch (error) {
    next(error);
  }
}

/** DELETE /admin/teams/:teamId/shares - the admin deleted the team; every share of it goes. */
export async function deleteTeamShares(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!jobOwner(req, res)) return;
    const teamId = teamIdOf(req.params.teamId, res);
    if (!teamId) return;
    res.status(200).json({ deleted: await deleteTeamShareRows(teamId) });
  } catch (error) {
    next(error);
  }
}
