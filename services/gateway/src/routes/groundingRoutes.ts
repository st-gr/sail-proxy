/**
 * /api/admin/grounding - the cockpit's door to file_search (spec 2026-10-01 §4, §5.2).
 *
 * Reachable only with the ADMIN_TO_GATEWAY service key. groundingActingUser then makes the acting
 * cockpit user the owner identity, and the OpenAI-shaped file and vector-store tables are
 * registered again under /files and /stores - the same handlers, the same ownership rules.
 */
import * as express from 'express';
import { getDefaultLogger } from '@libs/logger';
import { gatewayStandaloneOrServiceKeyAuth } from '../middlewares/gatewayServiceAuth';
import { groundingActingUser } from '../middlewares/groundingActingUser';
import { groundingAdmin } from '../middlewares/groundingAdmin';
import { nulByteGuard, nulByteParamGuard } from '../middlewares/nulByteGuard';
import { groundingQuota, createdStoreWithFiles, ownedStore, searchedStore, retriedJob } from '../middlewares/groundingQuota';
import { isStandaloneMode } from '../config/unifiedAuthConfig';
import { registerFileRoutes } from './fileRouteTable';
import { registerVectorStoreRoutes } from './vectorStoreRouteTable';
import * as groundingController from '../controllers/groundingController';
import * as groundingAdminController from '../controllers/groundingAdminController';
import * as groundingReembedController from '../controllers/groundingReembedController';
import * as groundingBlobMigrationController from '../controllers/groundingBlobMigrationController';
import * as groundingChunkingController from '../controllers/groundingChunkingController';

const logger = getDefaultLogger();

const router: express.Router = express.Router();
router.use(gatewayStandaloneOrServiceKeyAuth);
router.use(groundingActingUser);
router.use(nulByteGuard);
router.param('id', nulByteParamGuard);
router.param('file_id', nulByteParamGuard);
router.param('batch_id', nulByteParamGuard);
router.param('job_id', nulByteParamGuard);

// Quota on paid work (middlewares/groundingQuota.ts): the routes that start paid work check the
// payer's quota before their handler runs — the store owner for store work, the searcher for search. Registered first, so each guard runs ahead of
// the handler below or in the tables; it calls next() when it admits. The admin maintenance
// routes under /admin are exempt and get none.
router.post('/stores', groundingQuota(createdStoreWithFiles));
router.post('/stores/:id/files', groundingQuota(ownedStore));
router.post('/stores/:id/file_batches', groundingQuota(ownedStore));
router.post('/stores/:id/files/:file_id/retry', groundingQuota(ownedStore));
router.post('/stores/:id/reembed', groundingQuota(ownedStore));
router.post('/stores/:id/chunking', groundingQuota(ownedStore));
router.post('/stores/:id/reextract', groundingQuota(ownedStore));
router.post('/stores/:id/search', groundingQuota(searchedStore));
router.post('/jobs/:job_id/retry', groundingQuota(retriedJob));

router.get('/status', groundingController.status);
router.get('/file-attachments', groundingController.fileAttachments);
// Registered before the file table on purpose: this handler owns DELETE /files/:id and
// delegates to the table's handler unless ?detach=true is set.
router.delete('/files/:id', groundingController.deleteFile);

// Jobs and retries, registered before the tables so these paths win over /stores/:id/....
router.get('/jobs', groundingController.listJobs);
router.get('/jobs/:job_id', groundingController.getJob);
router.post('/jobs/:job_id/cancel', groundingController.cancelJob);
router.post('/jobs/:job_id/retry', groundingController.retryJob);
router.get('/jobs/:job_id/failures', groundingReembedController.jobFailures);
router.post('/stores/:id/files/:file_id/retry', groundingController.retryStoreFile);

// Re-embedding the caller's own store (owner only; a shared store of another owner is a 404).
router.get('/stores/:id/reembed/estimate', groundingReembedController.estimateStore);
router.post('/stores/:id/reembed', groundingReembedController.reembedStore);

// A store's chunking setting: the create with `chunking` (it replaces the table's POST /stores in
// this group), and re-chunking the caller's own store (owner only, like the re-embed).
router.post('/stores', groundingChunkingController.createStore);
router.get('/stores/:id/chunking/estimate', groundingChunkingController.estimateChunking);
router.post('/stores/:id/chunking', groundingChunkingController.startChunking);
// Re-extracting the caller's own store: the files read before the extractors improved (owner only).
router.get('/stores/:id/reextract/estimate', groundingChunkingController.estimateReextract);
router.post('/stores/:id/reextract', groundingChunkingController.startReextract);

// The caller's storage, and store reads that include every shared store (read-only for a
// non-owner). Registered before the store table, whose GET /stores and GET /stores/:id they
// replace in this group; every other store route stays the table's owner-only handler.
router.get('/storage', groundingAdminController.storage);
router.get('/stores', groundingAdminController.listStores);
router.get('/stores/:id', groundingAdminController.readStore);
// Sharing a store with a team (spec 2026-10-14 §8): the owner shares, the owner, a team admin or a
// platform admin unshares; the handlers check who may.
router.post('/stores/:id/share-team', groundingAdminController.shareStoreWithTeam);
router.post('/stores/:id/unshare-team', groundingAdminController.unshareStoreFromTeam);

// Administration: everything under /admin needs the acting role admin and grounding:admin.
router.use('/admin', groundingAdmin);
router.get('/admin/overview', groundingAdminController.overview);
router.get('/admin/stores', groundingAdminController.listAllStores);
router.get('/admin/files', groundingAdminController.listAllFiles);
router.get('/admin/failed', groundingAdminController.listFailed);
router.get('/admin/storage', groundingAdminController.listStorage);
router.get('/admin/jobs', groundingAdminController.listAllJobs);
router.get('/admin/jobs/:job_id', groundingAdminController.getJob);
router.delete('/admin/stores/:id', groundingAdminController.deleteStore);
router.delete('/admin/files/:id', groundingAdminController.deleteFile);
router.post('/admin/stores/:id/files/:file_id/retry', groundingAdminController.retryStoreFile);
router.post('/admin/stores/:id/share', groundingAdminController.shareStore);
router.post('/admin/stores/:id/unshare', groundingAdminController.unshareStore);
// The admin deleted a team: every share of it goes.
router.delete('/admin/teams/:teamId/shares', groundingAdminController.deleteTeamShares);
// Re-embedding any owner's store; cancel, retry and failures take re-embed jobs only (a file batch is a 404).
router.get('/admin/stores/:id/reembed/estimate', groundingReembedController.adminEstimateStore);
router.post('/admin/stores/:id/reembed', groundingReembedController.adminReembedStore);
router.get('/admin/reembed-outdated/estimate', groundingReembedController.adminEstimateOutdated);
router.post('/admin/reembed-outdated', groundingReembedController.adminReembedOutdated);
// Re-chunking any owner's store, as its owner (cancel and retry: the admin job routes).
router.get('/admin/stores/:id/chunking/estimate', groundingChunkingController.adminEstimateChunking);
router.post('/admin/stores/:id/chunking', groundingChunkingController.adminStartChunking);
router.get('/admin/stores/:id/reextract/estimate', groundingChunkingController.adminEstimateReextract);
router.post('/admin/stores/:id/reextract', groundingChunkingController.adminStartReextract);
router.post('/admin/jobs/:job_id/cancel', groundingReembedController.adminCancelJob);
router.post('/admin/jobs/:job_id/retry', groundingReembedController.adminRetryJob);
router.get('/admin/jobs/:job_id/failures', groundingReembedController.adminJobFailures);
// Blob storage: the panel's figures, the S3 connection test and the migration start (cancel, retry
// and failures of a blob_migration job go through the job routes above).
router.get('/admin/blob-storage', groundingBlobMigrationController.adminBlobStorage);
router.post('/admin/blob-storage/test', groundingBlobMigrationController.adminTestBlobStorage);
router.post('/admin/blob-storage/migrate', groundingBlobMigrationController.adminStartBlobMigration);

// The whole OpenAI-shaped tables. The guard list is empty: authentication happened above, and
// quotaEnforcement is keyed on API keys, which a cockpit call does not carry (the payer's quota
// is checked by the guards at the top instead).
registerFileRoutes(router, '/files', []);
registerVectorStoreRoutes(router, '/stores', []);

export const GROUNDING_PATH = '/api/admin/grounding';

/**
 * Mount the grounding routes, unless this gateway runs standalone. There
 * gatewayStandaloneOrServiceKeyAuth grants every request without a credential, a standalone
 * gateway has no admin cockpit, and groundingActingUser would refuse every call anyway - so the
 * routes are not mounted rather than being served to nobody. Returns whether they were mounted.
 */
export function mountGroundingRoutes(app: express.Application): boolean {
  if (isStandaloneMode()) {
    logger.info('Gateway Service', `Standalone mode - ${GROUNDING_PATH} not mounted (no admin cockpit)`);
    return false;
  }
  app.use(GROUNDING_PATH, router);
  return true;
}
