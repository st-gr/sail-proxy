const cds = require('@sap/cds');
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getDefaultLogger } from '@libs/logger';
import { usageEventProcessor } from '../services/usageEventProcessor';
import { cacheInvalidationService } from '../services/cacheInvalidationService';
import { lifecycleChangeViolation, defaultExpiresAt, rotationPolicy, creationExpiresAt, expiresAtInPast, normalizeLifecycle } from '../services/credentialLifecycle';
import SecurityEventService from '../services/securityEventService';
import { recordAuditEvent } from '../services/auditEventService';
import securityEventSubscriber from '../services/securityEventSubscriber';
import { clientContext } from '../utils/clientIp';
import { costRecalculationService } from '../services/costRecalculationService';
import { reconcile } from '../services/reconciliationService';
import { seedSapCapacityUnitPrice } from '../db/data/sap-capacity-unit-price-seed';
import { backfillNeverExpires } from '../db/data/never-expires-backfill';
import { backfillNotificationContext } from '../db/data/security-notification-context-backfill';
import { securityNotificationConfig } from '../config/security-notifications';
import { notificationPopulationService } from '../services/notificationPopulationService';
import { dismissNotification, markNotificationSeen, markNotificationUnseen, snoozeNotification, pinNotification, unpinNotification, deleteSecurityNotification } from './notification-handlers';
import { notificationStreamService } from './notification-stream';
import { registerLibraryHandlers, initializeModelLibrary } from './admin-service-library';
import { registerUserHandlers } from './admin-service-users';
import { registerQuotaProfileHandlers } from './admin-service-quota-profiles';
import { touch as touchUser, backfillUsers, migrateCatalogAssignments } from '../services/usersService';
import { isDeactivated } from '../services/userLifecycleService';
import { quotaStateStore } from '../services/quotaStateStore';
import { republishAll, startRolloverTimer } from '../services/userQuotaService';
import { rebuildIfEmpty } from '../services/usageCounters';
import { processOrderByForCompatibility } from '../config/database-compatibility';
import { startDispatcher } from '../siem/dispatcher';
import { resolveSiemDispatch } from '../siem/siemConfigResolver';
import { setSiemDispatcherHandle } from '../siem/dispatcherHandle';
import { refreshSecretResolver, startSecretResolver, stopSecretResolver } from '../siem/secretResolverHandle';
import {
  setCredential, deleteCredential, listCredentialNames, MissingCredentialKeyError,
} from '../siem/credentialStore';
import type { CredentialMetadata } from '../siem/credentialStore';
import { findOrphanedCredentials, deleteOrphanedCredentials } from '../siem/credentialSweep';
import type { OrphanedCredential } from '../siem/credentialSweep';
const configurationService = require('./config-service');
const configRestApi = require('./config-rest-api');

// Initialize logger
const logger = getDefaultLogger();

interface AdminRequest {
  data: {
    name?: string;
    email?: string;
    permissions?: string[];
    rateLimits?: any;
    keyId?: string;
    key?: string;
    newKey?: string;
    userId?: string;
    description?: string;
    expiresAt?: Date;
    neverExpires?: boolean;
    accessKeyId?: string;
    signature?: string;
    stringToSign?: string;
    configId?: string;
    configData?: string;
    configurationId?: string;
    value?: string;
    reason?: string;
    startDate?: Date;
    endDate?: Date;
    granularity?: string;
    severity?: string;
    // Cache invalidation properties
    credentialId?: string;
    authType?: string;
    pattern?: string;
    // Usage event processing
    events?: any[];
    // Security event properties
    eventType?: string;
    actionTaken?: string;
    clientIP?: string;
    userAgent?: string;
    endpoint?: string;
    requestId?: string;
    // Legacy recordUsage properties
    method?: string;
    timestamp?: string;
    // Security event batch processing
    batchId?: string;
    count?: number;
    // Bulk action properties
    IDs?: string[];
    // Orphaned SIEM credential sweep properties
    names?: string[];
    configurationIds?: string[];
    // Invoice reconciliation properties (reconcileInvoice)
    from?: Date | string;
    to?: Date | string;
    invoiceGenAiTokens?: number | string;
    invoiceCapacityUnits?: number | string;
    invoiceCacheReadInputTokens?: number | string;
    invoiceCacheWriteInputTokens?: number | string;
  };
  user?: { id: string };
  error: (code: number, message: string) => void;
}

interface ApiKeyResponse {
  id: string;
  key: string;
  maskedKey: string;
  name: string;
  email: string;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: Date;
}

interface AwsCredentialsResponse {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sapAiRegion: string;
  expiresAt?: Date;
}

interface ValidationResponse {
  isValid: boolean;
  keyInfo?: any;
  credentialInfo?: any;
}

/**
 * Utility function to mask API keys for display
 * @param key - The full API key to mask
 * @returns Masked version of the key
 */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key[0] + '***';
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

/**
 * Implementation for AdminService custom actions and functions
 */
class AdminService {
  // async because the Model Library seed below must complete before the first request is
  // served. The invariant only holds because the CAP impl wrapper at the bottom of this file
  // RETURNS this promise - cds awaits the impl's return value - so do not drop it there.
  async init(service: any): Promise<void> {
    // ========================================
    // Add global request debugging
    // ========================================
    service.before('*', (req: any) => {
      if (req.path && !req.path.includes('$metadata')) {
        logger.trace('AdminService', '🎯 CDS Request Processing:', {
          entity: req.target?.name || req.entity,
          path: req.path,
          method: req.method,
          user: {
            id: req.user?.id,
            roles: req.user?.roles,
            attr: req.user?.attr,
            isAuthenticated: req.user?.is ? req.user.is('authenticated') : false,
            isAnonymous: req.user?.constructor?.name === 'AnonymousUser',
            isPrivileged: req.user?.constructor?.name === 'PrivilegedUser'
          },
          headers: req.headers
        });
      }
    });
    
    // ========================================
    // PostgreSQL Compatibility Handler
    // ========================================
    service.before('READ', '*', (req: any) => {
      // Apply PostgreSQL compatibility for all READ operations with orderBy
      if (req.query?.SELECT?.orderBy) {
        const entity = req.target?.name || req.entity;
        const originalOrderBy = JSON.stringify(req.query.SELECT.orderBy);
        req.query.SELECT.orderBy = processOrderByForCompatibility(req.query.SELECT.orderBy);
        
        const newOrderBy = JSON.stringify(req.query.SELECT.orderBy);
        if (originalOrderBy !== newOrderBy) {
          logger.info('AdminService', '[PostgreSQL Compatibility] Modified orderBy clause for entity', {
            entity,
            originalOrderBy,
            newOrderBy,
            dbKind: process.env.CDS_PROFILE || 'default'
          });
        }
      }
    });

    // Virtual fields are now defined in CDS annotations
    
    // Initialize configuration service
    configurationService(service);

    // Model Library and entitlement catalogs (srv/admin-service-library.ts)
    registerLibraryHandlers(service);
    // Users & quotas (srv/admin-service-users.ts)
    registerUserHandlers(service);
    // Quota profiles and their assignment (srv/admin-service-quota-profiles.ts)
    registerQuotaProfileHandlers(service);

    // Initialize services
    this.initializeUsageProcessor();
    this.initializeCacheInvalidation();
    this.initializeQuotaPublisher();
    this.initializeSecurityEventSubscriber();
    this.initializeCostRecalculation();
    this.initializeSapCapacityUnitPrice();
    this.initializeNeverExpiresBackfill();
    this.initializeNotificationContextBackfill();
    this.initializeSiemDispatcher();
    this.initializeCredentialSweepReport();

    // Register event handlers
    service.on('createApiKey', this.createApiKey.bind(this));
    service.on('disableApiKey', this.disableApiKey.bind(this));
    service.on('enableApiKey', this.enableApiKey.bind(this));
    service.on('deleteApiKey', this.deleteApiKey.bind(this));
    service.on('disableApiKeysByEmail', this.disableApiKeysByEmail.bind(this));
    service.on('updateApiKeyValue', this.updateApiKeyValue.bind(this));
    service.on('validateApiKey', this.validateApiKey.bind(this));
    service.on('rotateApiKey', this.rotateApiKey.bind(this));
    
    // Register draft and CRUD operation handlers
    // NEW draft: prefill the create form. Registered on the draft entity with before() - the
    // on('NEW', 'ApiKeys') form never fires under lean draft, which is why Expires At came back
    // empty. Same pattern as SapCapacityUnitPrice.drafts below.
    service.before('NEW', 'ApiKeys.drafts', this.beforeNewApiKey.bind(this));
    service.before('CREATE', 'ApiKeys', this.beforeCreateApiKey.bind(this));
    service.before('UPDATE', 'ApiKeys', this.beforeUpdateApiKeyActive.bind(this));
    service.before('UPDATE', 'ApiKeys.drafts', this.beforeUpdateApiKeyDraft.bind(this));
    service.after('UPDATE', 'ApiKeys', this.afterUpdateApiKey.bind(this));
    
    // Add maskedKey computation handlers
    service.before('CREATE', 'ApiKeys', this.computeMaskedKey.bind(this));
    service.before('UPDATE', 'ApiKeys', this.computeMaskedKey.bind(this));
    service.before('UPDATE', 'ApiKeys.drafts', this.computeMaskedKey.bind(this));

    // Force redirection to base table when CAP writes to service view
    service.on('CREATE', 'ApiKeys', this.onCreateApiKey.bind(this));
    service.on('UPDATE', 'ApiKeys', this.onUpdateApiKey.bind(this));
    
    // Register AWS Credentials draft and CRUD operation handlers
    service.before('NEW', 'AwsCredentials.drafts', this.beforeNewAwsCredentials.bind(this));
    service.before('CREATE', 'AwsCredentials', this.beforeCreateAwsCredentials.bind(this));
    service.before('UPDATE', 'AwsCredentials', this.beforeUpdateAwsCredentialsActive.bind(this));
    service.before('UPDATE', 'AwsCredentials.drafts', this.beforeUpdateAwsCredentialsDraft.bind(this));
    service.after('UPDATE', 'AwsCredentials', this.afterUpdateAwsCredentials.bind(this));
    
    // Force redirection to base table when CAP writes to service view
    service.on('CREATE', 'AwsCredentials', this.onCreateAwsCredentials.bind(this));
    service.on('UPDATE', 'AwsCredentials', this.onUpdateAwsCredentials.bind(this));
    
    // Decrypt secretAccessKey for display
    service.after('READ', 'AwsCredentials', this.afterReadAwsCredentials.bind(this));

    // Lifecycle field control (isActiveFC/expiresAtFC/neverExpiresFC): admin-only editability.
    // The before-READ handler guarantees neverExpires is loaded whenever a client $select asks
    // for one of these FC virtuals without it, so the after-READ computation below never sees an
    // undefined neverExpires just because the caller's column list omitted it (e.g. Fiori Elements'
    // SideEffects re-read after toggling Never Expires, which selects expiresAtFC alone).
    service.before('READ', ['ApiKeys', 'ApiKeys.drafts', 'AwsCredentials', 'AwsCredentials.drafts'], this.beforeReadLifecycleFieldControl.bind(this));
    service.after('READ', ['ApiKeys', 'ApiKeys.drafts', 'AwsCredentials', 'AwsCredentials.drafts'], this.afterReadLifecycleFieldControl.bind(this));

    // Removed virtual field handlers for clean projection approach

    // Reject a new/edited rate or price whose [dateFrom,dateTo) window overlaps an
    // existing row with the same lookup key (model / usageType). Runs before the
    // via-base-table writers below so the persist step never sees an overlapping row.
    // CREATE auto-delimits: a new price row extends to the end of time and closes the
    // previously-open row for its usage type. UPDATE keeps the plain overlap reject (editing
    // a row's own window is a manual correction, not a supersession).
    service.before('CREATE', 'SapCapacityUnitPrice', this.beforeCreateSapCapacityUnitPrice.bind(this));
    service.before('UPDATE', 'SapCapacityUnitPrice', this.beforeWriteSapCapacityUnitPrice.bind(this));
    // NEW draft: prefill Valid To with the end of time so the create form shows it up front
    // (CREATE forces the same value on activation; this just surfaces it in the draft).
    service.before('NEW', 'SapCapacityUnitPrice.drafts', this.beforeNewSapCapacityUnitPrice.bind(this));

    // Force redirection to base table when CAP writes to service view - same fix as
    // ApiKeys/AwsCredentials above. SapCapacityUnitPrice is a draft-enabled projection,
    // but generic CREATE/UPDATE/DELETE against it fails with "cannot modify <entity>
    // because it is a view" under @cap-js/sqlite, so writes are redirected to the base
    // admin.SapCapacityUnitPrice table.
    service.on('CREATE', 'SapCapacityUnitPrice', this.onCreateSapCapacityUnitPrice.bind(this));
    service.on('UPDATE', 'SapCapacityUnitPrice', this.onUpdateSapCapacityUnitPrice.bind(this));
    service.on('DELETE', 'SapCapacityUnitPrice', this.onDeleteSapCapacityUnitPrice.bind(this));
    
    
    service.on('createAwsCredentials', this.createAwsCredentials.bind(this));
    service.on('disableAwsCredentials', this.disableAwsCredentials.bind(this));
    service.on('enableAwsCredentials', this.enableAwsCredentials.bind(this));
    service.on('deleteAwsCredentials', this.deleteAwsCredentials.bind(this));
    service.on('rotateAwsCredentials', this.rotateAwsCredentials.bind(this));
    
    // Gateway validation functions
    service.on('getApiKeyByKey', this.getApiKeyByKey.bind(this));
    service.on('getAwsCredentialByAccessKeyId', this.getAwsCredentialByAccessKeyId.bind(this));
    
    service.on('updateConfiguration', this.updateConfiguration.bind(this));
    service.on('patchConfiguration', this.patchConfiguration.bind(this));
    service.on('resetConfiguration', this.resetConfiguration.bind(this));
    service.on('validateConfiguration', this.validateConfiguration.bind(this));
    service.on('getActiveConfiguration', this.getActiveConfiguration.bind(this));
    service.on('setSiemCredential', this.setSiemCredential.bind(this));
    service.on('deleteSiemCredential', this.deleteSiemCredential.bind(this));
    service.on('listSiemCredentials', this.listSiemCredentials.bind(this));
    service.on('findOrphanedSiemCredentials', this.findOrphanedSiemCredentials.bind(this));
    service.on('deleteOrphanedSiemCredentials', this.deleteOrphanedSiemCredentials.bind(this));
    
    // Changed from action to function - functions use 'on' handler just like actions
    service.on('getUsageStatistics', this.getUsageStatistics.bind(this));
    service.on('reconcileInvoice', this.reconcileInvoice.bind(this));
    service.on('getSecurityEvents', this.getSecurityEvents.bind(this));
    service.on('processUsageEvents', this.processUsageEvents.bind(this));
    service.on('processSecurityEvents', this.processSecurityEvents.bind(this));
    
    // Legacy endpoint for backward compatibility
    service.on('recordUsage', this.recordUsage.bind(this));
    
    // Cache invalidation endpoints
    service.on('invalidateCache', this.invalidateCache.bind(this));
    service.on('clearCachePattern', this.clearCachePattern.bind(this));
    
    // Security event endpoints
    service.on('logSecurityEvent', this.logSecurityEvent.bind(this));
    
    // Debug endpoints
    service.on('whoami', this.whoami.bind(this));
    
    // Notification population endpoint
    service.on('populateSecurityNotifications', this.populateSecurityNotifications.bind(this));
    
    // Bulk action endpoints
    service.on('bulkMarkNotificationsSeen', this.bulkMarkNotificationsSeen.bind(this));
    service.on('bulkDeleteSecurityNotifications', this.bulkDeleteSecurityNotifications.bind(this));

    // User preferences management
    service.on('getCurrentUserPreferences', this.getCurrentUserPreferences.bind(this));
    service.on('updateUserPreference', this.updateUserPreference.bind(this));
    
    // Notification management actions (now as bound actions on MySecurityNotifications)
    service.on('dismissNotification', 'MySecurityNotifications', dismissNotification);
    service.on('markNotificationSeen', 'MySecurityNotifications', markNotificationSeen);
    service.on('markNotificationUnseen', 'MySecurityNotifications', markNotificationUnseen);
    service.on('snoozeNotification', 'MySecurityNotifications', snoozeNotification);
    service.on('pinNotification', 'MySecurityNotifications', pinNotification);
    service.on('unpinNotification', 'MySecurityNotifications', unpinNotification);
    service.on('deleteSecurityNotification', 'MySecurityNotifications', deleteSecurityNotification);
    
    // SQLite-compatible MySecurityNotifications READ handlers
    service.before('READ', 'MySecurityNotifications', this.beforeReadMySecurityNotifications.bind(this));
    service.after('READ', 'MySecurityNotifications', this.afterReadMySecurityNotifications.bind(this));

    // Awaited, and last: until the default catalog exists, entitlementBlockFor cannot compute a
    // block, the validation service answers with none at all - i.e. unrestricted - and both the
    // admin and the gateway cache that for an hour. The impl wrapper at the bottom of this file
    // returns this promise and cds awaits it (@sap/cds lib/srv/factory.js:76), so the seed is
    // done before the first request is served. It sits after every registration above because
    // those must stay synchronous: handlers registered past an await land too late for CAP's
    // draft and authorization wiring.
    await this.initializeUsers();
    await this.initializeModelLibrary();
  }

  // ========================================
  // API Key Management
  // ========================================

  async createApiKey(req: AdminRequest): Promise<ApiKeyResponse> {
    const { name, email, permissions = [], rateLimits = {} } = req.data;
    
    // User-scoped authorization: Users can only create API keys for themselves, admins for anyone
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    if (!isAdmin && email !== userEmail) {
      logger.warn('AdminService', `[RBAC] User ${userEmail} attempted to create API key for ${email}`, {
        userEmail,
        requestedEmail: email,
        userRoles,
        isAdmin,
        endpoint: 'createApiKey'
      });
      req.error(403, 'Access denied: Users can only create API keys for themselves');
      await this.recordApiKeyAudit(req, userEmail, 'api_key.create', email || 'unknown', 'failure', `Access denied: ${userEmail} attempted to create an API key for ${email}`);
      return {} as ApiKeyResponse;
    }

    logger.info('AdminService', `[RBAC] API key creation authorized for ${email} by ${userEmail}`, {
      isOwnKey: email === userEmail,
      isAdmin,
      userRoles,
      endpoint: 'createApiKey'
    });

    if (await this.rejectIfDeactivated(req, email)) return {} as ApiKeyResponse;

    try {
      // Generate new API key using same format as gateway service
      const apiKey = 'sk-' + crypto.randomBytes(24).toString('hex'); // 48 characters total
      const keyId = crypto.randomUUID(); // Use crypto.randomUUID() like gateway service

      // Default rate limits
      const defaultRateLimits = {
        requestsPerMinute: 60,
        requestsPerHour: 1000,
        requestsPerDay: 10000,
        ...rateLimits
      };

      // Insert API key record
      const maskedKey = maskApiKey(apiKey);
      // Expiration is admin-managed: owners get the configured default, admins may pre-set a date
      // or flag the key as never-expiring. The createApiKey action declares neither expiresAt nor
      // neverExpires, so req.data never carries them and the branches below are inert; they hold
      // the rule if the signature ever gains them.
      const wantsNeverExpires = isAdmin && req.data.neverExpires === true;
      if (!wantsNeverExpires && expiresAtInPast(req.data.expiresAt)) {
        req.error(400, 'Expires At must be in the future');
        return {} as ApiKeyResponse;
      }
      const lifecycle = normalizeLifecycle({
        neverExpires: wantsNeverExpires,
        expiresAt: creationExpiresAt({
          isAdmin,
          requested: req.data.expiresAt,
          fallback: defaultExpiresAt()
        })
      });
      const expiresAt = lifecycle.expiresAt === null ? null : new Date(lifecycle.expiresAt).toISOString();

      const INSERT = cds.ql.INSERT.into('sap.llm.gateway.admin.ApiKeys').entries({
        ID: keyId,
        key: apiKey,
        maskedKey,
        name,
        email,
        createdBy: req.user?.id || 'system',
        isActive: true,
        expiresAt,
        neverExpires: lifecycle.neverExpires,
        usageCount: 0
      });

      await cds.run(INSERT);
      await touchUser(cds, email!);

      // Insert rate limits
      if (Object.keys(defaultRateLimits).length > 0) {
        const rateLimitId = uuidv4();
        const INSERT_RATE_LIMITS = cds.ql.INSERT.into('sap.llm.gateway.admin.RateLimits').entries({
          ID: rateLimitId,
          apiKey_ID: keyId,
          ...defaultRateLimits
        });
        await cds.run(INSERT_RATE_LIMITS);
      }

      // Insert permissions
      for (const permission of permissions) {
        const permissionId = uuidv4();
        const INSERT_PERMISSION = cds.ql.INSERT.into('sap.llm.gateway.admin.ApiKeyPermissions').entries({
          ID: permissionId,
          apiKey_ID: keyId,
          permission,
          grantedBy: req.user?.id || 'system',
          grantedAt: new Date()
        });
        await cds.run(INSERT_PERMISSION);
      }

      await this.recordApiKeyAudit(req, userEmail, 'api_key.create', keyId, 'success', `API key created for ${email} by ${userEmail}`);

      return {
        id: keyId,
        key: apiKey,
        maskedKey,
        name: name!,
        email: email!,
        isActive: true,
        expiresAt,
        createdAt: new Date()
      };
    } catch (error) {
      logger.error('AdminService', `Error creating API key for ${email}: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error : undefined, { email, userEmail });
      await this.recordApiKeyAudit(req, userEmail, 'api_key.create', email || 'unknown', 'failure', `Failed to create API key for ${email}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  async disableApiKey(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    const { keyId } = req.data;
    
    // Extract user information for authorization
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);

    // Authorization check: only an administrator may change the active state, not even the owner
    // (the action is @(requires: 'admin'), so CAP normally answers 403 before this handler runs).
    if (!isAdmin) {
      return {
        success: false,
        message: 'Access denied: only an administrator can enable/disable API keys'
      };
    }

    // Get the actual API key string for cache invalidation
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .columns('key')
      .where({ ID: keyId });

    const result = await cds.run(SELECT);

    if (result.length === 0) {
      return {
        success: false,
        message: 'API key not found'
      };
    }

    const actualApiKey: string | null = result[0].key;

    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ isActive: false })
      .where({ ID: keyId });
    
    const updateResult = await cds.run(UPDATE);
    
    // Invalidate cache for the disabled API key using the actual key string
    if (updateResult > 0 && actualApiKey) {
      try {
        await cacheInvalidationService.invalidateApiKey(actualApiKey, 'disabled', `disable-${Date.now()}`);
        logger.info('AdminService', `Cache invalidated for disabled API key using actual key: ${actualApiKey.substring(0, 10)}...`);
      } catch (error) {
        logger.warn('AdminService', `Failed to invalidate cache for API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
      }
    }
    
    return {
      success: updateResult > 0,
      message: updateResult > 0 ? 'API key disabled successfully' : 'API key not found'
    };
  }

  async enableApiKey(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    const { keyId } = req.data;
    
    // Extract user information for authorization
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);

    // Authorization check: only an administrator may change the active state, not even the owner
    // (the action is @(requires: 'admin'), so CAP normally answers 403 before this handler runs).
    if (!isAdmin) {
      return {
        success: false,
        message: 'Access denied: only an administrator can enable/disable API keys'
      };
    }

    const ownerRow = await cds.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiKeys').columns('email').where({ ID: keyId }));
    if (await this.rejectIfDeactivated(req, ownerRow?.email)) return { success: false, message: 'User is deactivated' };

    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ isActive: true })
      .where({ ID: keyId });

    const updateResult = await cds.run(UPDATE);

    return {
      success: updateResult > 0,
      message: updateResult > 0 ? 'API key enabled successfully' : 'API key not found'
    };
  }

  async deleteApiKey(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    const { keyId } = req.data;
    
    // Extract user information for authorization
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Get the actual API key string for cache invalidation
    let actualApiKey: string | null = null;
    
    // Authorization check: Non-admin users can only delete their own API keys
    if (!isAdmin) {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
        .columns('email', 'key')
        .where({ ID: keyId });
      
      const result = await cds.run(SELECT);

      if (result.length === 0) {
        await this.recordApiKeyAudit(req, userEmail, 'api_key.revoke', keyId, 'failure', 'API key not found');
        return {
          success: false,
          message: 'API key not found'
        };
      }

      if (result[0].email !== userEmail) {
        await this.recordApiKeyAudit(req, userEmail, 'api_key.revoke', keyId, 'failure', `Access denied: ${userEmail} attempted to delete a key owned by ${result[0].email}`);
        return {
          success: false,
          message: 'Access denied: You can only delete your own API keys'
        };
      }

      actualApiKey = result[0].key;
    } else {
      // Admin user - get the API key string for cache invalidation
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
        .columns('key')
        .where({ ID: keyId });

      const result = await cds.run(SELECT);

      if (result.length === 0) {
        await this.recordApiKeyAudit(req, userEmail, 'api_key.revoke', keyId, 'failure', 'API key not found');
        return {
          success: false,
          message: 'API key not found'
        };
      }

      actualApiKey = result[0].key;
    }
    
    // Implement soft delete instead of hard delete
    // This preserves usage history and allows for data recovery
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ 
        isActive: false,
        deletedAt: new Date()
      })
      .where({ ID: keyId });
    
    const updateResult = await cds.run(UPDATE);
    
    // Also soft delete related permissions and rate limits for consistency
    await cds.run(cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeyPermissions')
      .set({ deletedAt: new Date() })
      .where({ apiKey_ID: keyId }));
    await cds.run(cds.ql.UPDATE('sap.llm.gateway.admin.RateLimits')
      .set({ deletedAt: new Date() })
      .where({ apiKey_ID: keyId }));
    
    // Note: We intentionally keep ApiKeyUsage records for historical analytics
    
    // Invalidate cache for the deleted API key using the actual key string
    if (updateResult > 0 && actualApiKey) {
      try {
        await cacheInvalidationService.invalidateApiKey(actualApiKey, 'deleted', `delete-${Date.now()}`);
        logger.info('AdminService', `Cache invalidated for deleted API key using actual key: ${actualApiKey.substring(0, 10)}...`);
      } catch (error) {
        logger.warn('AdminService', `Failed to invalidate cache for API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
      }
    }

    await this.recordApiKeyAudit(
      req, userEmail, 'api_key.revoke', keyId,
      updateResult > 0 ? 'success' : 'failure',
      updateResult > 0 ? `API key revoked by ${userEmail}` : 'API key not found'
    );

    return {
      success: updateResult > 0,
      message: updateResult > 0 ? 'API key deleted successfully (soft delete)' : 'API key not found'
    };
  }

  async disableApiKeysByEmail(req: AdminRequest): Promise<{ 
    success: boolean; 
    disabledCount: number; 
    message: string 
  }> {
    const { email } = req.data;
    
    // Get all active API keys for this email before disabling them for cache invalidation
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .columns('key')
      .where({ email, isActive: true });
    
    const keys = await cds.run(SELECT);
    
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ isActive: false })
      .where({ email, isActive: true });
    
    const result = await cds.run(UPDATE);
    
    // Invalidate cache for all disabled API keys using their actual key strings
    if (result > 0 && keys.length > 0) {
      const invalidationPromises = keys.map(async (keyRecord: any) => {
        try {
          await cacheInvalidationService.invalidateApiKey(keyRecord.key, 'disabled', `disable-email-${Date.now()}`);
          logger.debug('AdminService', `Cache invalidated for API key: ${keyRecord.key.substring(0, 10)}...`);
        } catch (error) {
          logger.warn('AdminService', `Failed to invalidate cache for API key ${keyRecord.key.substring(0, 10)}...:`, error instanceof Error ? error.message : 'Unknown error');
        }
      });
      
      await Promise.allSettled(invalidationPromises);
      logger.info('AdminService', `Cache invalidation attempted for ${keys.length} disabled API keys for email: ${email}`);
    }
    
    return {
      success: result > 0,
      disabledCount: result,
      message: `Disabled ${result} API key(s) for ${email}`
    };
  }

  async updateApiKeyValue(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    const { keyId, newKey } = req.data;
    
    // Extract user information for authorization
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Validate the new key format
    if (!newKey || !newKey.startsWith('sk-')) {
      return {
        success: false,
        message: 'API key must start with "sk-" prefix'
      };
    }
    
    // 256, not 128. A real OpenAI platform key (sk-proj-…) is 164 characters,
    // so the old ceiling rejected exactly the bring-your-own-key case this
    // endpoint exists for. Still bounded — an unbounded key is a cost to hash
    // and index on every request.
    if (newKey.length > 256) {
      return {
        success: false,
        message: 'API key cannot exceed 256 characters'
      };
    }
    
    // Check if key already exists
    const EXISTING = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .where({ key: newKey, isActive: true });
    
    const existing = await cds.run(EXISTING);
    if (existing.length > 0) {
      return {
        success: false,
        message: 'API key already exists'
      };
    }
    
    // Authorization check: Non-admin users can only update their own API keys
    if (!isAdmin) {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
        .columns('email')
        .where({ ID: keyId });
      
      const result = await cds.run(SELECT);
      
      if (result.length === 0) {
        return {
          success: false,
          message: 'API key not found'
        };
      }
      
      if (result[0].email !== userEmail) {
        return {
          success: false,
          message: 'Access denied: You can only update your own API keys'
        };
      }
    }
    
    // Update the key
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ key: newKey })
      .where({ ID: keyId });
    
    const updateResult = await cds.run(UPDATE);
    
    return {
      success: updateResult > 0,
      message: updateResult > 0 ? 'API key updated successfully' : 'API key not found'
    };
  }

  async validateApiKey(req: AdminRequest): Promise<ValidationResponse> {
    const { key } = req.data;
    
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys', (k: any) => {
      k.ID, k.name, k.email, k.isActive,
      k.permissions((p: any) => p.permission)
    }).where({ key, isActive: true });
    
    const keyRecord = await cds.run(SELECT);
    
    if (keyRecord.length > 0) {
      const record = keyRecord[0];
      return {
        isValid: true,
        keyInfo: {
          id: record.ID,
          name: record.name,
          email: record.email,
          isActive: record.isActive,
          permissions: record.permissions?.map((p: any) => p.permission) || []
        }
      };
    }
    
    return { isValid: false, keyInfo: null };
  }

  async rotateApiKey(req: AdminRequest): Promise<{ success: boolean; newMaskedKey?: string; message: string }> {
    // Extract the entity ID from bound action context
    const keyId = (req as any).params?.[0]?.ID;
    const isActiveEntity = (req as any).params?.[0]?.IsActiveEntity;
    
    if (!keyId) {
      return { success: false, message: 'API Key ID is required' };
    }
    
    logger.info('AdminService', `rotateApiKey called`, {
      keyId,
      isActiveEntity,
      user: req.user?.id
    });
    
    // Extract user information for authorization
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Use transaction and read from the entity that was passed to the action
    const tx = cds.transaction(req);
    
    // For bound actions, read the entity instance from the context
    let apiKey;
    try {
      if (isActiveEntity === false) {
        // For draft entities, read from service with draft context
        const result = await tx.read('AdminService.ApiKeys.drafts').where({ ID: keyId });
        apiKey = result[0];
      } else {
        // For active entities, read from service
        const result = await tx.read('AdminService.ApiKeys').where({ ID: keyId });
        apiKey = result[0];
      }
    } catch (error) {
      logger.error('AdminService', `Error reading API key for rotation: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error : undefined, { keyId });
      await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'failure', 'API key not found or not accessible');
      return { success: false, message: 'API key not found or not accessible' };
    }

    if (!apiKey) {
      await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'failure', 'API key not found');
      return { success: false, message: 'API key not found' };
    }

    // Authorization check: Non-admin users can only rotate their own API keys
    if (!isAdmin) {
      if (apiKey.email !== userEmail) {
        logger.warn('AdminService', `Unauthorized API key rotation attempt by user ${userEmail} for key ${keyId} (owner: ${apiKey.email})`);
        await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'failure', `Access denied: ${userEmail} attempted to rotate a key owned by ${apiKey.email}`, 'high');
        return { success: false, message: 'Access denied: You can only rotate your own API keys' };
      }
    }

    // A refresh always moves the expiration forward, for the owner as well as an administrator.
    // An owner is still refused on an inactive or already-expired key.
    const rotation = rotationPolicy({
      isAdmin,
      stored: { isActive: apiKey.isActive, expiresAt: apiKey.expiresAt, neverExpires: apiKey.neverExpires }
    });
    if (!rotation.allowed) {
      logger.warn('AdminService', `Rotation refused for ${rotation.reason} API key ${keyId} by ${userEmail}`);
      await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'failure', `Rotation refused: key is ${rotation.reason}`, 'medium');
      return { success: false, message: `Access denied: an ${rotation.reason} API key can only be rotated by an administrator` };
    }

    // Generate new API key
    const newKey = 'sk-' + crypto.randomBytes(32).toString('hex');
    const newMaskedKey = maskApiKey(newKey);

    // Check if new key already exists (very unlikely but safety first)
    const EXISTING_CHECK = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .where({ key: newKey, isActive: true });

    const existingNewKey = await cds.run(EXISTING_CHECK);
    if (existingNewKey.length > 0) {
      await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'failure', 'Key collision detected, please retry');
      return { success: false, message: 'Key collision detected, please retry' };
    }

    // Update the API key - use transaction for proper draft handling
    try {
      if (isActiveEntity === false) {
        // For draft entities, update through service with draft context
        await tx.update('AdminService.ApiKeys.drafts').where({ ID: keyId }).set({
          key: newKey,
          maskedKey: newMaskedKey,
          modifiedAt: new Date(),
          modifiedBy: req.user?.id || 'system',
          expiresAt: rotation.expiresAt
        });
      } else {
        // For active entities, update through service
        await tx.update('AdminService.ApiKeys').where({ ID: keyId }).set({
          key: newKey,
          maskedKey: newMaskedKey,
          modifiedAt: new Date(),
          modifiedBy: req.user?.id || 'system',
          expiresAt: rotation.expiresAt
        });
      }
    } catch (error) {
      logger.error('AdminService', `Error updating API key during rotation: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error : undefined, { keyId });
      await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'failure', 'Failed to rotate API key');
      return { success: false, message: 'Failed to rotate API key' };
    }
    
    // Record rotation history
    try {
      const rotationId = uuidv4();
      const INSERT_ROTATION = cds.ql.INSERT.into('sap.llm.gateway.admin.ApiKeyRotations').entries({
        ID: rotationId,
        apiKey_ID: keyId,
        oldKey: apiKey.key,
        newKey: newKey,
        rotationType: 'manual',
        reason: 'Manual rotation via admin API',
        rotatedBy: req.user?.id || 'system',
        rotationSuccess: true,
        oldKeyDeactivatedAt: new Date()
      });
      
      await cds.run(INSERT_ROTATION);
      logger.info('AdminService', `Recorded API key rotation history: ${rotationId}`, {
        keyId,
        oldKey: apiKey.key.substring(0, 10) + '...',
        newKey: newKey.substring(0, 10) + '...'
      });
    } catch (error) {
      logger.warn('AdminService', `Failed to record API key rotation history ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }
    
    // Log rotation event in security events using SecurityEventService to ensure notifications are created
    try {
      const httpReq = (req as any).http?.req;
      await SecurityEventService.createApiKeySecurityEvent({
        keyId: keyId, // Use the UUID here since we're in admin service context
        eventType: 'key_rotation',
        severity: 'low',
        description: `API key rotated by ${req.user?.id || 'system'}`,
        clientIP: httpReq?.ip || httpReq?.connection?.remoteAddress || 'unknown',
        userAgent: httpReq?.headers?.['user-agent'] || 'unknown',
        endpoint: '/rotateApiKey',
        requestId: httpReq?.headers?.['x-request-id'] || uuidv4(),
        actionTaken: 'key_rotated',
        autoBlocked: false
      });
    } catch (error) {
      logger.warn('AdminService', `Failed to log security event for API key rotation ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }
    
    // Invalidate cache for the rotated API key (use the old API key string, not keyId)
    try {
      await cacheInvalidationService.invalidateApiKey(apiKey.key, 'manual', `rotate-api-key-${Date.now()}`);
      logger.info('AdminService', `Cache invalidated for rotated API key using old key: ${apiKey.key.substring(0, 10)}...`);
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate cache for rotated API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    // Also invalidate the local admin service validation cache for API key
    try {
      // Access the validation service singleton instance directly
      const validationServiceModule = require('./validation-service');
      const validationService = validationServiceModule.instance;
      
      if (!validationService || !validationService.cache) {
        logger.warn('AdminService', 'Validation service instance not available for API key cache invalidation');
      } else {
        // Clear local cache entries by directly accessing the cache Map and removing entries by key pattern
        // The cache uses keys like "apikey:${key}" and "unified_apikey:${key}"
        const oldApiKey = apiKey.key;
        let localCacheCleared = 0;
        
        // Clear both cache key patterns used for API keys
        const keysToCheck = [`apikey:${oldApiKey}`, `unified_apikey:${oldApiKey}`];
        
        for (const cacheKey of keysToCheck) {
          if (validationService.cache.apiKeys && validationService.cache.apiKeys.has(cacheKey)) {
            validationService.cache.apiKeys.delete(cacheKey);
            localCacheCleared++;
            logger.info('AdminService', `Cleared local cache key: ${cacheKey}`);
          }
        }
        
        logger.info('AdminService', `Local validation cache invalidated for rotated API key: ${oldApiKey.substring(0, 10)}... (cleared ${localCacheCleared} entries)`);
      }
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate local validation cache for rotated API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }
    
    logger.info('AdminService', `API key rotated successfully for user ${userEmail}, key ID: ${keyId}`);

    await this.recordApiKeyAudit(req, userEmail, 'api_key.rotate', keyId, 'success', `API key rotated by ${userEmail}`, 'low');

    return {
      success: true,
      newMaskedKey: newMaskedKey,
      message: 'API key rotated successfully'
    };
  }

  // ========================================
  // Helper Methods for API Key State Changes
  // ========================================
  
  /**
   * Enable API Key logic without authorization (used by UPDATE handler)
   */
  private async enableApiKeyLogic(keyId: string, req: any): Promise<void> {
    // Get the actual API key string for cache invalidation
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .columns('key')
      .where({ ID: keyId });

    const result = await cds.run(SELECT);

    if (result.length === 0) {
      throw new Error('API key not found');
    }

    const actualApiKey = result[0].key;

    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ isActive: true })
      .where({ ID: keyId });

    const updateResult = await cds.run(UPDATE);

    if (updateResult === 0) {
      throw new Error('API key not found or already enabled');
    }

    // Invalidate cache for the re-enabled API key so it is not served a stale negative for a TTL
    try {
      await cacheInvalidationService.invalidateApiKey(actualApiKey, 'manual', `enable-update-${Date.now()}`);
      logger.info('AdminService', `Cache invalidated for enabled API key using actual key: ${actualApiKey.substring(0, 10)}...`);
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate cache for API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    // Also invalidate the local admin service validation cache for API key (same as the disable logic)
    try {
      // Access the validation service singleton instance directly
      const validationServiceModule = require('./validation-service');
      const validationService = validationServiceModule.instance;

      if (!validationService || !validationService.cache) {
        logger.warn('AdminService', 'Validation service instance not available for API key cache invalidation');
      } else {
        // The cache uses keys like "apikey:${key}" and "unified_apikey:${key}"
        let localCacheCleared = 0;

        for (const cacheKey of [`apikey:${actualApiKey}`, `unified_apikey:${actualApiKey}`]) {
          if (validationService.cache.apiKeys && validationService.cache.apiKeys.has(cacheKey)) {
            validationService.cache.apiKeys.delete(cacheKey);
            localCacheCleared++;
            logger.info('AdminService', `Cleared local cache key: ${cacheKey}`);
          }
        }

        logger.info('AdminService', `Local validation cache invalidated for enabled API key: ${actualApiKey.substring(0, 10)}... (cleared ${localCacheCleared} entries)`);
      }
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate local validation cache for enabled API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    logger.info('AdminService', `API key ${keyId} enabled successfully via UPDATE operation`);
  }
  
  /**
   * Disable API Key logic without authorization (used by UPDATE handler)
   */
  private async disableApiKeyLogic(keyId: string, req: any): Promise<void> {
    // Get the actual API key string for cache invalidation before disabling
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .columns('key')
      .where({ ID: keyId });
    
    const result = await cds.run(SELECT);
    
    if (result.length === 0) {
      throw new Error('API key not found');
    }
    
    const actualApiKey = result[0].key;
    
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
      .set({ isActive: false })
      .where({ ID: keyId });
    
    const updateResult = await cds.run(UPDATE);
    
    if (updateResult === 0) {
      throw new Error('API key not found or already disabled');
    }
    
    // Invalidate cache for the disabled API key using the actual key string
    try {
      await cacheInvalidationService.invalidateApiKey(actualApiKey, 'disabled', `disable-update-${Date.now()}`);
      logger.info('AdminService', `Cache invalidated for disabled API key using actual key: ${actualApiKey.substring(0, 10)}...`);
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate cache for API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    // Also invalidate the local admin service validation cache for API key (same as rotation logic)
    try {
      // Access the validation service singleton instance directly
      const validationServiceModule = require('./validation-service');
      const validationService = validationServiceModule.instance;
      
      if (!validationService || !validationService.cache) {
        logger.warn('AdminService', 'Validation service instance not available for API key cache invalidation');
      } else {
        // Clear local cache entries by directly accessing the cache Map and removing entries by key pattern
        // The cache uses keys like "apikey:${key}" and "unified_apikey:${key}"
        let localCacheCleared = 0;
        
        // Clear both cache key patterns used for API keys
        const keysToCheck = [`apikey:${actualApiKey}`, `unified_apikey:${actualApiKey}`];
        
        for (const cacheKey of keysToCheck) {
          if (validationService.cache.apiKeys && validationService.cache.apiKeys.has(cacheKey)) {
            validationService.cache.apiKeys.delete(cacheKey);
            localCacheCleared++;
            logger.info('AdminService', `Cleared local cache key: ${cacheKey}`);
          }
        }
        
        logger.info('AdminService', `Local validation cache invalidated for disabled API key: ${actualApiKey.substring(0, 10)}... (cleared ${localCacheCleared} entries)`);
      }
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate local validation cache for disabled API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }
    
    logger.info('AdminService', `API key ${keyId} disabled successfully via UPDATE operation`);
  }

  // ========================================
  // Helper Methods for AWS Credentials State Changes
  // ========================================
  
  /**
   * Enable AWS Credentials logic without authorization (used by UPDATE handler)
   */
  private async enableAwsCredentialsLogic(credentialId: string, req: any): Promise<void> {
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.AwsCredentials')
      .set({ isActive: true })
      .where({ ID: credentialId });
    
    const updateResult = await cds.run(UPDATE);
    
    if (updateResult === 0) {
      throw new Error('AWS credentials not found or already enabled');
    }
    
    logger.info('AdminService', `AWS credentials ${credentialId} enabled successfully via UPDATE operation`);
  }
  
  /**
   * Disable AWS Credentials logic without authorization (used by UPDATE handler)
   */
  private async disableAwsCredentialsLogic(credentialId: string, req: any): Promise<void> {
    // Get accessKeyId before disabling for cache invalidation
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
      .columns('accessKeyId')
      .where({ ID: credentialId });
    
    const credential = await cds.run(SELECT);
    
    if (credential.length === 0) {
      throw new Error('AWS credentials not found');
    }
    
    const accessKeyId = credential[0].accessKeyId;
    
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.AwsCredentials')
      .set({ isActive: false })
      .where({ ID: credentialId });
    
    const updateResult = await cds.run(UPDATE);
    
    if (updateResult === 0) {
      throw new Error('AWS credentials already disabled');
    }
    
    // Invalidate cache for the disabled AWS credentials (using accessKeyId)
    try {
      await cacheInvalidationService.invalidateAwsCredential(accessKeyId, 'disabled', `disable-update-${Date.now()}`);
      logger.info('AdminService', `Cache invalidated for disabled AWS credentials using accessKeyId: ${accessKeyId}`);
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate cache for AWS credentials ${accessKeyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    // Also invalidate the local admin service validation cache (same as rotation logic)
    try {
      // Access the validation service singleton instance directly
      const validationServiceModule = require('./validation-service');
      const validationService = validationServiceModule.instance;
      
      if (!validationService || !validationService.cache) {
        logger.warn('AdminService', 'Validation service instance not available for cache invalidation');
      } else {
        // Clear local cache entries by directly accessing the cache Map and removing entries by key pattern
        // The cache uses keys like "aws:${accessKeyId}" and "unified_aws:${accessKeyId}"
        let localCacheCleared = 0;
        
        // Clear both cache key patterns used for AWS credentials
        const keysToCheck = [`aws:${accessKeyId}`, `unified_aws:${accessKeyId}`];
        
        for (const cacheKey of keysToCheck) {
          if (validationService.cache.awsCredentials && validationService.cache.awsCredentials.has(cacheKey)) {
            validationService.cache.awsCredentials.delete(cacheKey);
            localCacheCleared++;
            logger.info('AdminService', `Cleared local cache key: ${cacheKey}`);
          }
        }
        
        logger.info('AdminService', `Local validation cache invalidated for disabled AWS credentials: ${accessKeyId} (cleared ${localCacheCleared} entries)`);
      }
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate local validation cache for disabled AWS credentials ${accessKeyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }
    
    logger.info('AdminService', `AWS credentials ${credentialId} disabled successfully via UPDATE operation`);
  }

  // ========================================
  // UPDATE Operations for API Keys (Draft-Aware)
  // ========================================

  /**
   * Handler for UPDATE operations on active ApiKeys entities (during draft activation)
   */
  async beforeUpdateApiKeyActive(req: any): Promise<void> {
    logger.info('AdminService', `Active UPDATE handler called with fields: [${Object.keys(req.data).join(', ')}]`);
    
    const ID = req.params?.[0]?.ID || req.data?.ID;
    
    if (!ID) {
      req.error(400, 'API key ID is required');
      return;
    }
    
    // Extract user information (compatible with both mocked and JWT auth)
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    
    // Check if user is admin
    const isAdmin = this.isAdmin(userRoles);

    // Load the stored row once: ownership check for non-admins, and the admin-only lifecycle
    // guard for everyone (isActive / expiresAt may only be changed by an administrator).
    const STORED = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
      .columns('email', 'isActive', 'expiresAt', 'neverExpires')
      .where({ ID });
    const storedRows = await cds.run(STORED);
    if (storedRows.length === 0) {
      req.error(404, 'API key not found');
      return;
    }
    const stored = storedRows[0];

    if (!isAdmin && stored.email !== userEmail) {
      req.error(403, 'Access denied: You can only update your own API keys');
      return;
    }

    const lifecycleViolation = lifecycleChangeViolation({ isAdmin, data: req.data, stored });
    if (lifecycleViolation) {
      logger.warn('AdminService', `Lifecycle change refused for API key ${ID}: ${lifecycleViolation} (user: ${userEmail})`);
      req.error(403, `Access denied: ${lifecycleViolation} of an API key`);
      return;
    }

    // An expiration may only be moved forward in time. Draft activation resends the stored value,
    // so only an actual change is checked - a row that is already past its date stays editable.
    // A key being flagged as never-expiring has no date to validate.
    const willNeverExpire = 'neverExpires' in req.data
      ? req.data.neverExpires === true
      : stored.neverExpires === true;
    if (!willNeverExpire
      && 'expiresAt' in req.data
      && new Date(req.data.expiresAt ?? 0).getTime() !== new Date(stored.expiresAt ?? 0).getTime()
      && expiresAtInPast(req.data.expiresAt)) {
      req.error(400, 'Expires At must be in the future');
      return;
    }

    // Keep the pair consistent whenever an administrator writes either half: a never-expiring key
    // stores no date, and clearing the flag without supplying one falls back to the standard
    // period. Gated on isAdmin because draft activation resends the whole row: without the gate
    // this would fire on every owner rename and could hand a legacy row (neverExpires = false,
    // expiresAt = null, missed by the backfill) an expiration its owner is not allowed to set.
    // `?? stored` on the flag likewise matters - lifecycleChangeViolation treats an explicit
    // undefined as "not a change", so normalizing it as "not flagged" would silently unflag a row.
    if (isAdmin && ('neverExpires' in req.data || 'expiresAt' in req.data)) {
      const lifecycle = normalizeLifecycle({
        neverExpires: req.data.neverExpires ?? stored.neverExpires,
        expiresAt: 'expiresAt' in req.data ? req.data.expiresAt : stored.expiresAt
      });
      req.data.neverExpires = lifecycle.neverExpires;
      req.data.expiresAt = lifecycle.expiresAt;
    }

    // Role-based field guard: non-admins cannot change email
    if (!isAdmin && 'email' in req.data) {
      delete req.data.email;
      logger.info('AdminService', 'Removed email field - non-admin users cannot change email');
    }

    // Block key updates except via rotate action
    if ('key' in req.data) {
      delete req.data.key;
      logger.info('AdminService', 'Removed key field - key can only be changed via action');
    }
    
    // Strip computed and non-updatable fields that may have slipped through
    const NON_UPDATABLE = new Set([
      'key', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'salt', 'secretHash'
    ]);
    
    // Get computed properties from the target entity definition
    const target = req.target;
    const computedFields = new Set();
    if (target && target.elements) {
      for (const [fieldName, fieldDef] of Object.entries(target.elements)) {
        if ((fieldDef as any)['@Core.Computed']) {
          computedFields.add(fieldName);
        }
      }
    }
    
    // Remove these fields instead of blocking (they shouldn't reach active UPDATE)
    const originalFields = Object.keys(req.data);
    for (const fieldName of originalFields) {
      if (NON_UPDATABLE.has(fieldName) || computedFields.has(fieldName)) {
        logger.info('AdminService', `Removing non-updatable field from active UPDATE: ${fieldName}`);
        delete req.data[fieldName];
      }
    }
    
    // All sensitive fields should now be removed above, so we don't need additional blocking
    // If any still remain, they must be legitimate fields that we missed
    const remainingFields = Object.keys(req.data);
    if (remainingFields.length > 0) {
      logger.info('AdminService', `Proceeding with UPDATE for legitimate fields: [${remainingFields.join(', ')}]`);
    }
    
    // Handle isActive toggle by calling existing enable/disable logic
    if (req.data.isActive !== undefined) {
      logger.info('AdminService', `Processing isActive change for API key ${ID}`, {
        newValue: req.data.isActive,
        userEmail,
        isAdmin
      });
      
      try {
        // Get current state first
        const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys')
          .columns('isActive', 'email', 'name')
          .where({ ID });
        
        const currentKey = await cds.run(SELECT);
        
        if (currentKey.length === 0) {
          req.error(404, 'API key not found');
          return;
        }
        
        const currentState = currentKey[0].isActive;
        const newState = req.data.isActive;

        if (newState === true && (await this.rejectIfDeactivated(req, currentKey[0].email))) return;

        // Only process if the state is actually changing
        if (currentState !== newState) {
          if (newState) {
            // Enabling the key - call enable logic
            await this.enableApiKeyLogic(ID, req);
          } else {
            // Disabling the key - call disable logic  
            await this.disableApiKeyLogic(ID, req);
          }
          
          logger.info('AdminService', `Successfully ${newState ? 'enabled' : 'disabled'} API key ${ID}`, {
            keyName: currentKey[0].name,
            userEmail,
            previousState: currentState,
            newState
          });
          
          // Remove isActive from req.data so CAP doesn't persist it again
          // (our logic already handled the state change)
          delete req.data.isActive;
        } else {
          // No state change, remove from request to avoid unnecessary updates
          delete req.data.isActive;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        logger.error('AdminService', `Failed to process isActive change for API key ${ID}: ${errorMessage} (User: ${userEmail})`, error instanceof Error ? error : new Error(errorMessage));
        req.error(500, `Failed to ${req.data.isActive ? 'enable' : 'disable'} API key: ${errorMessage}`);
        return;
      }
    }
  }

  /**
   * Settle the neverExpires / expiresAt pair inside a draft, so the form shows the consequence of
   * the toggle immediately instead of only after activation.
   *
   * This is what makes the "clearing the flag assigns the standard period" rule reachable from the
   * apps at all. Expires At is Mandatory (FC 7) for administrators on AWS credentials, so a draft
   * left at { neverExpires: false, expiresAt: null } cannot be activated — Fiori refuses until a
   * date is typed, and the backend fallback never runs. Settling it here means unticking the box
   * fills the date in the draft, and ticking it clears the date rather than leaving a stale one
   * displayed beside a ticked flag.
   *
   * Administrators only: a non-admin's edits to either field have already been dropped by the
   * caller, so there is nothing to settle. If the draft row cannot be read the write is left
   * alone — the active-entity handler settles the pair again at activation regardless.
   */
  private async settleDraftLifecycle(req: any, draftEntity: string): Promise<void> {
    if (!('neverExpires' in req.data || 'expiresAt' in req.data)) return;
    const ID = req.params?.[0]?.ID ?? req.params?.[0] ?? req.data?.ID;
    if (!ID) return;

    let draft: any;
    try {
      const rows = await cds.transaction(req).read(draftEntity).where({ ID });
      draft = Array.isArray(rows) ? rows[0] : rows;
    } catch (error) {
      logger.warn('AdminService', `Could not read ${draftEntity} to settle the lifecycle pair:`, error instanceof Error ? error.message : 'Unknown error');
      return;
    }
    if (!draft) return;

    const lifecycle = normalizeLifecycle({
      neverExpires: req.data.neverExpires ?? draft.neverExpires,
      expiresAt: 'expiresAt' in req.data ? req.data.expiresAt : draft.expiresAt
    });
    req.data.neverExpires = lifecycle.neverExpires;
    req.data.expiresAt = lifecycle.expiresAt;
    logger.info('AdminService', `Settled lifecycle pair in ${draftEntity} draft ${ID}`, {
      neverExpires: lifecycle.neverExpires,
      expiresAt: lifecycle.expiresAt
    });
  }

  /**
   * Handler for UPDATE operations on draft ApiKeys entities (light validation only)
   */
  async beforeUpdateApiKeyDraft(req: any): Promise<void> {
    // For draft updates, we need to be less aggressive about field removal
    // Draft persistence requires certain fields to be present
    
    const isAdmin = req.user?.is ? req.user.is('admin') : false;
    const userEmail = this.getUserEmail(req);

    // Role-based field guard: non-admins cannot change email
    if (!isAdmin && 'email' in req.data) {
      req.data.email = userEmail;  // Force to user's email instead of deleting
      logger.info('AdminService', 'Enforced email to user email for non-admin user');
    }

    // Only administrators change isActive / expiresAt / neverExpires; a non-admin's draft edit of
    // them is dropped so activation carries the stored values and passes the active-entity guard.
    if (!isAdmin) {
      for (const field of ['isActive', 'expiresAt', 'neverExpires']) {
        if (field in req.data) {
          delete req.data[field];
          logger.info('AdminService', `Removed ${field} from draft update - only administrators may change it`);
        }
      }
    } else {
      await this.settleDraftLifecycle(req, 'AdminService.ApiKeys.drafts');
    }

    // Block key updates except via rotate action - but don't delete, just log
    if ('key' in req.data) {
      delete req.data.key;
      logger.info('AdminService', 'Removed key field - key can only be changed via action');
    }

    // Only strip the absolutely essential managed fields that CAP handles automatically
    // Don't touch virtual/computed fields during drafts as they may be needed for persistence
    const MANAGED_FIELDS = new Set([
      'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
    ]);
    
    const originalFields = Object.keys(req.data);
    const removedFields = [];
    
    // Only remove managed fields, leave virtual fields alone for draft operations
    for (const fieldName of originalFields) {
      if (MANAGED_FIELDS.has(fieldName)) {
        removedFields.push(fieldName);
        delete req.data[fieldName];
      }
    }
    
    if (removedFields.length > 0) {
      logger.info('AdminService', `Draft update - removed managed fields: [${removedFields.join(', ')}]`);
    }
    
    logger.info('AdminService', `Draft update processed`, {
      originalFields,
      removedFields,
      allowedFields: Object.keys(req.data),
      hasIsActiveChange: req.data.isActive !== undefined,
      isAdmin,
      userEmail
    });
  }

  async afterUpdateApiKey(results: any, req: any): Promise<void> {
    // In after handler, we need to get the ID from the results or params
    const ID = req.params?.[0] || results?.ID;
    
    if (!ID) {
      return;
    }
    
    // Update usage count if this is an activation
    if (req.data?.isActive === true) {
      const INCREMENT = cds.ql.UPDATE('sap.llm.gateway.admin.ApiKeys')
        .set('usageCount = usageCount + 1')
        .where({ ID });

      await cds.run(INCREMENT);
    }

    // An expiration change must reach the gateway before its cached validation expires - the
    // never-expires flag changes the same verdict, so it invalidates on the same terms.
    if (req.data && ('expiresAt' in req.data || 'neverExpires' in req.data)) {
      const keyId = req.params?.[0]?.ID ?? req.params?.[0] ?? results?.ID;
      const rows = await cds.run(cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys').columns('key').where({ ID: keyId }));
      if (rows.length > 0) {
        try {
          await cacheInvalidationService.invalidateApiKey(rows[0].key, 'manual', `expires-at-update-${Date.now()}`);
        } catch (error) {
          logger.warn('AdminService', `Failed to invalidate cache after expiresAt change for API key ${keyId}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }
  }

  // Removed afterReadApiKeys handler - calculated fields are now handled by CDS calculated elements
  // async afterReadApiKeys(results: any, req: any): Promise<void> {
  //   // Add calculated fields to ApiKeys after READ operations
  //   if (Array.isArray(results)) {
  //     for (const apiKey of results) {
  //       // Add maskedKey field
  //       if (apiKey.key) {
  //         apiKey.maskedKey = apiKey.key.substring(0, 6) + '****';
  //       }
  //       
  //       // Add statusCriticality field (1=Error, 2=Warning, 3=Success)
  //       apiKey.statusCriticality = apiKey.isActive ? 3 : 2;
  //     }
  //   } else if (results && results.key) {
  //     // Handle single result
  //     results.maskedKey = results.key.substring(0, 6) + '****';
  //     results.statusCriticality = results.isActive ? 3 : 2;
  //   }
  // }

  // ========================================
  // AWS Credentials Management
  // ========================================

  async createAwsCredentials(req: AdminRequest): Promise<AwsCredentialsResponse> {
    let { userId, email, name, description, expiresAt, permissions = [] } = req.data;
    
    // User-scoped authorization: Users can only create AWS credentials for themselves, admins for anyone
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);

    // Expiration is admin-managed: owners get the configured default, admins may pre-set a date
    // or flag the credential as never-expiring (which stores no date at all).
    const wantsNeverExpires = isAdmin && req.data.neverExpires === true;
    if (!wantsNeverExpires && expiresAtInPast(expiresAt)) {
      req.error(400, 'Expires At must be in the future');
      return {} as AwsCredentialsResponse;
    }
    const lifecycle = normalizeLifecycle({
      neverExpires: wantsNeverExpires,
      expiresAt: creationExpiresAt({
        isAdmin,
        requested: expiresAt,
        fallback: defaultExpiresAt()
      })
    });
    const storedExpiresAt: Date | null = lifecycle.expiresAt === null ? null : new Date(lifecycle.expiresAt);
    expiresAt = storedExpiresAt ?? undefined;

    // Auto-populate userId with current user's email if not provided
    if (!userId) {
      userId = userEmail;
      logger.info('AdminService', `Auto-populated userId with current user email: ${userEmail}`, {
        providedUserId: req.data.userId,
        autoPopulatedUserId: userId,
        isAdmin,
        endpoint: 'createAwsCredentials'
      });
    }
    
    // Auto-populate email field with current user's email if not provided
    if (!email) {
      email = userEmail;
      logger.info('AdminService', `Auto-populated email with current user email: ${userEmail}`, {
        providedEmail: req.data.email,
        autoPopulatedEmail: email,
        isAdmin,
        endpoint: 'createAwsCredentials'
      });
    }
    
    // For non-admin users, enforce that they can only create credentials for themselves
    if (!isAdmin) {
      if (userId && userId !== userEmail) {
        userId = userEmail;
        logger.info('AdminService', `Enforced userId to current user email for non-admin: ${userEmail}`, {
          requestedUserId: req.data.userId,
          enforcedUserId: userId,
          endpoint: 'createAwsCredentials'
        });
      }
      if (email && email !== userEmail) {
        email = userEmail;
        logger.info('AdminService', `Enforced email to current user email for non-admin: ${userEmail}`, {
          requestedEmail: req.data.email,
          enforcedEmail: email,
          endpoint: 'createAwsCredentials'
        });
      }
    }
    
    // Validation: At this point, non-admin users should have both fields set to their email
    // This is a safety check that should not normally trigger due to enforcement above
    if (!isAdmin && (userId !== userEmail || email !== userEmail)) {
      logger.error('AdminService', `[RBAC] Internal error: Non-admin user fields not properly enforced - userEmail: ${userEmail}, finalUserId: ${userId}, finalEmail: ${email}, endpoint: createAwsCredentials`);
      req.error(403, 'Access denied: Users can only create AWS credentials for themselves');
      await this.recordAwsCredentialAudit(req, userEmail, 'aws_credential.create', email || userId || 'unknown', 'failure', `Access denied: ${userEmail} attempted to create AWS credentials for ${email || userId}`);
      return {} as AwsCredentialsResponse;
    }
    
    logger.info('AdminService', `[RBAC] AWS credentials creation authorized for userId: ${userId}, email: ${email} by ${userEmail}`, {
      isOwnCredentials: userId === userEmail && email === userEmail,
      isAdmin,
      userRoles,
      endpoint: 'createAwsCredentials'
    });

    if (await this.rejectIfDeactivated(req, email)) return {} as AwsCredentialsResponse;

    // Generate AWS-style credentials using same format as gateway service
    const accessKeyId = 'AKIA' + crypto.randomBytes(8).toString('hex').toUpperCase(); // 16 chars total
    const secretAccessKey = crypto.randomBytes(20).toString('hex'); // 40 chars
    const salt = crypto.randomBytes(16).toString('hex'); // Random salt for security
    const secretHash = crypto.createHmac('sha256', salt).update(secretAccessKey).digest('hex');
    
    const credentialId = crypto.randomUUID(); // Use crypto.randomUUID() for consistency
    
    // Encrypt the secret access key for storage (can be decrypted for SigV4 validation)
    const encryptedSecret = this.encryptSecret(secretAccessKey);
    
    // Insert credential record
    const INSERT = cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentials').entries({
      ID: credentialId,
      accessKeyId,
      secretAccessKey: encryptedSecret, // Store encrypted secret for signature validation
      secretHash,
      salt,
      userId: userId || 'default',
      email: email || userEmail, // Store email for notifications and ownership tracking
      name,
      description,
      isActive: true,
      expiresAt: storedExpiresAt,
      neverExpires: lifecycle.neverExpires,
      region: this.getAwsRegionFromSapAi(process.env.SAP_AI_REGION || 'us-east-1'),
      sapAiRegion: process.env.SAP_AI_REGION || 'us-east-1',
      usageCount: 0
    });
    
    await cds.run(INSERT);
    await touchUser(cds, email!);

    // Insert permissions
    for (const permission of permissions as any[]) {
      const permissionId = uuidv4();
      
      // Handle both string format ("bedrock:InvokeModel") and object format
      let permissionData;
      if (typeof permission === 'string') {
        // Parse string format like "bedrock:InvokeModel"
        const parts = permission.split(':');
        permissionData = {
          service: parts[0] || 'bedrock',
          action: permission,
          resource: '*',
          effect: 'Allow'
        };
      } else {
        // Handle object format
        permissionData = {
          service: permission.service || 'bedrock',
          action: permission.action,
          resource: permission.resource || '*',
          effect: permission.effect || 'Allow'
        };
      }
      
      const INSERT_PERMISSION = cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentialPermissions').entries({
        ID: permissionId,
        credential_ID: credentialId,
        ...permissionData
      });
      await cds.run(INSERT_PERMISSION);
    }

    // Calculate AWS region from SAP AI region (same logic as gateway service)
    const awsRegion = this.getAwsRegionFromSapAi(process.env.SAP_AI_REGION || 'us-east-1');

    await this.recordAwsCredentialAudit(req, userEmail, 'aws_credential.create', credentialId, 'success', `AWS credentials created for ${email || userId} by ${userEmail}`);

    return {
      id: credentialId,
      accessKeyId,
      secretAccessKey, // Only returned once!
      region: awsRegion,
      sapAiRegion: process.env.SAP_AI_REGION || 'us-east-1',
      expiresAt
    };
  }

  async disableAwsCredentials(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    // Extract the entity ID from bound action context
    const credentialId = (req as any).params?.[0]?.ID;
    
    if (!credentialId) {
      return { success: false, message: 'AWS Credential ID is required' };
    }
    
    // Extract user information for authorization
    const userId = this.getUserId(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Authorization check: Non-admin users can only disable their own AWS credentials
    if (!isAdmin) {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('userId')
        .where({ ID: credentialId });
      
      const result = await cds.run(SELECT);
      
      if (result.length === 0) {
        req.error(404, 'AWS credentials not found');
        return { success: false, message: 'AWS credentials not found' };
      }
      
      if (result[0].userId !== userId) {
        req.error(403, 'Access denied: You can only disable your own AWS credentials');
        return { success: false, message: 'Access denied: You can only disable your own AWS credentials' };
      }
    }
    
    try {
      await this.disableAwsCredentialsLogic(credentialId, req);
      return {
        success: true,
        message: 'AWS credentials disabled successfully'
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'AWS credentials not found'
      };
    }
  }
  
  async enableAwsCredentials(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    // Extract the entity ID from bound action context
    const credentialId = (req as any).params?.[0]?.ID;
    
    if (!credentialId) {
      return { success: false, message: 'AWS Credential ID is required' };
    }
    
    // Extract user information for authorization
    const userId = this.getUserId(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Authorization check: Non-admin users can only enable their own AWS credentials
    if (!isAdmin) {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('userId')
        .where({ ID: credentialId });

      const result = await cds.run(SELECT);

      if (result.length === 0) {
        req.error(404, 'AWS credentials not found');
        return { success: false, message: 'AWS credentials not found' };
      }

      if (result[0].userId !== userId) {
        req.error(403, 'Access denied: You can only enable your own AWS credentials');
        return { success: false, message: 'Access denied: You can only enable your own AWS credentials' };
      }
    }

    const ownerRow = await cds.run(cds.ql.SELECT.one.from('sap.llm.gateway.admin.AwsCredentials').columns('email').where({ ID: credentialId }));
    if (await this.rejectIfDeactivated(req, ownerRow?.email)) return { success: false, message: 'User is deactivated' };

    try {
      await this.enableAwsCredentialsLogic(credentialId, req);
      return {
        success: true,
        message: 'AWS credentials enabled successfully'
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'AWS credentials not found'
      };
    }
  }
  
  async deleteAwsCredentials(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    // Extract the entity ID from bound action context
    const credentialId = (req as any).params?.[0]?.ID;
    
    if (!credentialId) {
      return { success: false, message: 'AWS Credential ID is required' };
    }
    
    // Extract user information for authorization
    const userId = this.getUserId(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Get credential info for authorization check and cache invalidation
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
      .columns('userId', 'accessKeyId')
      .where({ ID: credentialId });
    
    const result = await cds.run(SELECT);
    
    if (result.length === 0) {
      req.error(404, 'AWS credentials not found');
      await this.recordAwsCredentialAudit(req, userId, 'aws_credential.revoke', credentialId, 'failure', 'AWS credentials not found');
      return { success: false, message: 'AWS credentials not found' };
    }

    const credential = result[0];

    // Authorization check: Non-admin users can only delete their own AWS credentials
    if (!isAdmin) {
      if (credential.userId !== userId) {
        req.error(403, 'Access denied: You can only delete your own AWS credentials');
        await this.recordAwsCredentialAudit(req, userId, 'aws_credential.revoke', credentialId, 'failure', `Access denied: ${userId} attempted to delete credentials owned by ${credential.userId}`, 'high');
        return { success: false, message: 'Access denied: You can only delete your own AWS credentials' };
      }
    }
    
    // Delete related records first (foreign key constraints)
    await cds.run(cds.ql.DELETE.from('sap.llm.gateway.admin.AwsCredentialPermissions').where({ credential_ID: credentialId }));
    await cds.run(cds.ql.DELETE.from('sap.llm.gateway.admin.AwsCredentialIPRestrictions').where({ credential_ID: credentialId }));
    // Usage rows outlive the credential (spec §3.6): they keep the owner and the name snapshots, lose the link.
    await cds.run(cds.ql.UPDATE('sap.llm.gateway.admin.AwsCredentialUsage').set({ credential_ID: null }).where({ credential_ID: credentialId }));
    await cds.run(cds.ql.DELETE.from('sap.llm.gateway.admin.AwsCredentialSecurityEvents').where({ credential_ID: credentialId }));
    await cds.run(cds.ql.DELETE.from('sap.llm.gateway.admin.AwsCredentialRotations').where({ credential_ID: credentialId }));
    
    // Delete the AWS credential
    const DELETE = cds.ql.DELETE.from('sap.llm.gateway.admin.AwsCredentials')
      .where({ ID: credentialId });
    
    const deleteResult = await cds.run(DELETE);
    
    // Invalidate cache for the deleted AWS credentials (using accessKeyId)
    if (deleteResult > 0) {
      try {
        await cacheInvalidationService.invalidateAwsCredential(credential.accessKeyId, 'deleted', `delete-aws-${Date.now()}`);
        logger.info('AdminService', `Cache invalidated for deleted AWS credentials using accessKeyId: ${credential.accessKeyId}`);
      } catch (error) {
        logger.warn('AdminService', `Failed to invalidate cache for AWS credentials ${credential.accessKeyId}:`, error instanceof Error ? error.message : 'Unknown error');
      }
    }

    await this.recordAwsCredentialAudit(
      req, userId, 'aws_credential.revoke', credentialId,
      deleteResult > 0 ? 'success' : 'failure',
      deleteResult > 0 ? `AWS credentials revoked by ${userId}` : 'AWS credentials not found'
    );

    return {
      success: deleteResult > 0,
      message: deleteResult > 0 ? 'AWS credentials deleted successfully' : 'AWS credentials not found'
    };
  }

  async rotateAwsCredentials(req: AdminRequest): Promise<{
    success: boolean;
    newAccessKeyId?: string;
    newSecretAccessKey?: string;
    message: string;
  }> {
    // Extract the entity ID from bound action context (like API Keys)
    const credentialId = (req as any).params?.[0]?.ID;
    const isActiveEntity = (req as any).params?.[0]?.IsActiveEntity;
    
    if (!credentialId) {
      return { success: false, message: 'AWS Credential ID is required' };
    }
    
    logger.info('AdminService', `rotateAwsCredentials called`, {
      credentialId,
      isActiveEntity,
      user: req.user?.id
    });
    
    // Extract user information for authorization
    const userId = this.getUserId(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    // Find existing credential by ID
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
      .where({ ID: credentialId, isActive: true });
    
    const existing = await cds.run(SELECT);

    if (existing.length === 0) {
      await this.recordAwsCredentialAudit(req, userId, 'aws_credential.rotate', credentialId, 'failure', 'AWS credentials not found');
      return { success: false, message: 'AWS credentials not found' };
    }

    // Authorization check: Non-admin users can only rotate their own AWS credentials
    if (!isAdmin) {
      if (existing[0].userId !== userId) {
        logger.warn('AdminService', `[RBAC] User ${userId} attempted to rotate AWS credentials for ${existing[0].userId}`, {
          userId,
          credentialUserId: existing[0].userId,
          userRoles,
          isAdmin,
          endpoint: 'rotateAwsCredentials'
        });
        await this.recordAwsCredentialAudit(req, userId, 'aws_credential.rotate', credentialId, 'failure', `Access denied: ${userId} attempted to rotate credentials owned by ${existing[0].userId}`, 'high');
        return { success: false, message: 'Access denied: You can only rotate your own AWS credentials' };
      }
    }
    
    // Same refresh policy as rotateApiKey: the expiration always moves forward, and an owner is
    // refused on an inactive or already-expired credential. (The lookup above already filters on
    // isActive, so the inactive refusal is reached only if that filter ever loosens.)
    const rotation = rotationPolicy({
      isAdmin,
      stored: { isActive: existing[0].isActive, expiresAt: existing[0].expiresAt, neverExpires: existing[0].neverExpires }
    });
    if (!rotation.allowed) {
      logger.warn('AdminService', `Rotation refused for ${rotation.reason} AWS credentials ${credentialId} by ${userId}`);
      await this.recordAwsCredentialAudit(req, userId, 'aws_credential.rotate', credentialId, 'failure', `Rotation refused: credentials are ${rotation.reason}`, 'medium');
      return { success: false, message: `Access denied: ${rotation.reason} AWS credentials can only be rotated by an administrator` };
    }

    logger.info('AdminService', `[RBAC] AWS credentials rotation authorized for ${existing[0].userId} by ${userId}`, {
      isOwnCredentials: existing[0].userId === userId,
      isAdmin,
      userRoles,
      endpoint: 'rotateAwsCredentials'
    });

    // Generate new credentials
    const newAccessKeyId = 'AKIA' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const newSecretAccessKey = crypto.randomBytes(20).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const secretHash = crypto.createHmac('sha256', salt).update(newSecretAccessKey).digest('hex');
    
    // Encrypt the new secret for storage
    const encryptedSecretAccessKey = this.encryptSecret(newSecretAccessKey);
    
    // Update existing record
    const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.AwsCredentials')
      .set({ 
        accessKeyId: newAccessKeyId,
        secretAccessKey: encryptedSecretAccessKey,
        secretHash,
        salt,
        expiresAt: rotation.expiresAt
      })
      .where({ ID: credentialId });
    
    await cds.run(UPDATE);
    
    // Log rotation event
    const rotationId = uuidv4();
    const INSERT_ROTATION = cds.ql.INSERT.into('sap.llm.gateway.admin.AwsCredentialRotations').entries({
      ID: rotationId,
      credential_ID: existing[0].ID,
      oldAccessKeyId: existing[0].accessKeyId,
      newAccessKeyId,
      rotationType: 'manual',
      reason: 'Manual rotation via admin API',
      rotatedBy: req.user?.id || 'system',
      rotationSuccess: true,
      oldKeyDeactivatedAt: new Date()
    });
    
    await cds.run(INSERT_ROTATION);

    // Create notification for rotation event
    await this.createNotificationForRotation(rotationId, existing[0], true, 'manual');

    // Log rotation event in security events using SecurityEventService, matching rotateApiKey.
    // credential_rotation is SecurityEventType.CREDENTIAL_ROTATION from the gateway - this is
    // where it gets its first emission on the admin side.
    try {
      const { clientIP, userAgent } = this.getClientContext(req);
      await SecurityEventService.createAwsSecurityEvent({
        credentialId: existing[0].ID,
        eventType: 'credential_rotation',
        severity: 'low',
        description: `AWS credentials rotated by ${req.user?.id || 'system'}`,
        clientIP,
        userAgent,
        endpoint: '/rotateAwsCredentials',
        requestId: uuidv4(),
        actionTaken: 'credential_rotated',
        autoBlocked: false
      });
    } catch (error) {
      logger.warn('AdminService', `Failed to log security event for AWS credential rotation ${credentialId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    // Invalidate cache for the rotated AWS credentials (using old accessKeyId)
    try {
      // Cache is keyed by accessKeyId, not credential UUID, so we need to invalidate the old accessKeyId
      await cacheInvalidationService.invalidateAwsCredential(existing[0].accessKeyId, 'manual', `rotate-aws-${Date.now()}`);
      logger.info('AdminService', `Cache invalidated for rotated AWS credentials using old accessKeyId: ${existing[0].accessKeyId}`);
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate cache for rotated AWS credentials ${existing[0].accessKeyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    // Also invalidate the local admin service validation cache
    try {
      // Access the validation service singleton instance directly
      const validationServiceModule = require('./validation-service');
      const validationService = validationServiceModule.instance;
      
      if (!validationService || !validationService.cache) {
        logger.warn('AdminService', 'Validation service instance not available for cache invalidation');
      } else {
        // Clear local cache entries by directly accessing the cache Map and removing entries by key pattern
        // The cache uses keys like "aws:${accessKeyId}" and "unified_aws:${accessKeyId}"
        const accessKeyId = existing[0].accessKeyId;
        let localCacheCleared = 0;
        
        // Clear both cache key patterns used for AWS credentials
        const keysToCheck = [`aws:${accessKeyId}`, `unified_aws:${accessKeyId}`];
        
        for (const cacheKey of keysToCheck) {
          if (validationService.cache.awsCredentials && validationService.cache.awsCredentials.has(cacheKey)) {
            validationService.cache.awsCredentials.delete(cacheKey);
            localCacheCleared++;
            logger.info('AdminService', `Cleared local cache key: ${cacheKey}`);
          }
        }
        
        logger.info('AdminService', `Local validation cache invalidated for rotated AWS credentials: ${accessKeyId} (cleared ${localCacheCleared} entries)`);
      }
    } catch (error) {
      logger.warn('AdminService', `Failed to invalidate local validation cache for rotated AWS credentials ${existing[0].accessKeyId}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    await this.recordAwsCredentialAudit(req, userId, 'aws_credential.rotate', credentialId, 'success', `AWS credentials rotated by ${userId}`, 'low');

    return {
      success: true,
      newAccessKeyId,
      newSecretAccessKey, // Only returned once!
      message: 'AWS credentials rotated successfully'
    };
  }

  // ========================================
  // Gateway Validation Functions
  // ========================================

  async getApiKeyByKey(req: AdminRequest): Promise<{ found: boolean; keyInfo?: any }> {
    const { key } = req.data;
    
    if (!key) {
      return { found: false };
    }

    try {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeys', (k: any) => {
        k.ID, k.name, k.email, k.isActive, k.lastUsed,
        k.permissions((p: any) => p.permission)
      }).where({ key, isActive: true });
      
      const result = await cds.run(SELECT);
      
      if (result.length === 0) {
        return { found: false };
      }
      
      const record = result[0];
      return {
        found: true,
        keyInfo: {
          id: record.ID,
          name: record.name,
          email: record.email,
          isActive: record.isActive,
          permissions: record.permissions?.map((p: any) => p.permission) || [],
          lastUsed: record.lastUsed
        }
      };
    } catch (error) {
      logger.error('admin-service', 'Error looking up API key', error as Error);
      return { found: false };
    }
  }

  async getAwsCredentialByAccessKeyId(req: AdminRequest): Promise<{ found: boolean; credentialInfo?: any }> {
    const { accessKeyId } = req.data;
    
    if (!accessKeyId) {
      return { found: false };
    }

    try {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials', (c: any) => {
        c.ID, c.userId, c.name, c.isActive, c.region, c.expiresAt, c.lastUsed,
        c.accessKeyId, c.secretAccessKey,
        c.permissions((p: any) => p.action)
      }).where({ accessKeyId, isActive: true });
      
      const result = await cds.run(SELECT);
      
      if (result.length === 0) {
        return { found: false };
      }
      
      const record = result[0];
      return {
        found: true,
        credentialInfo: {
          id: record.ID,
          userId: record.userId,
          name: record.name,
          accessKeyId: record.accessKeyId,
          secretAccessKey: record.secretAccessKey,
          isActive: record.isActive,
          permissions: record.permissions?.map((p: any) => p.action) || [],
          region: record.region,
          expiresAt: record.expiresAt,
          lastUsed: record.lastUsed
        }
      };
    } catch (error) {
      logger.error('admin-service', 'Error looking up AWS credential', error as Error);
      return { found: false };
    }
  }

  /**
   * Encryption key for AWS secrets (in production, use proper key management like AWS KMS)
   */
  private getEncryptionKey(): string {
    // In production, use environment variable or key management service
    return process.env.AWS_SECRET_ENCRYPTION_KEY || 'default-dev-key-not-for-production-use-12345';
  }

  /**
   * Encrypt secret access key for database storage
   */
  private encryptSecret(secret: string): string {
    try {
      const key = crypto.scryptSync(this.getEncryptionKey(), 'salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(secret, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
      logger.error('admin-service', 'Error encrypting secret', error as Error);
      throw new Error('Failed to encrypt secret');
    }
  }

  /**
   * Decrypt secret access key from database storage
   */
  private decryptSecret(encryptedSecret: string): string | null {
    try {
      const parts = encryptedSecret.split(':');
      if (parts.length === 2) {
        // New format: iv:encrypted
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedData = parts[1];
        const key = crypto.scryptSync(this.getEncryptionKey(), 'salt', 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } else {
        // Handle legacy encryption format
        const key = this.getEncryptionKey();
        const decipher = crypto.createDecipher('aes-256-cbc', key);
        let decrypted = decipher.update(encryptedSecret, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    } catch (error) {
      logger.error('admin-service', 'Error decrypting secret', error as Error);
      return null;
    }
  }

  // ========================================
  // Configuration Management
  // ========================================

  async updateConfiguration(req: AdminRequest): Promise<{
    success: boolean;
    validationErrors: string[];
    message: string;
  }> {
    const { configId, configData, reason } = req.data;
    
    try {
      // Step 1: Validate JSON syntax
      const parsedConfig = JSON.parse(configData!);
      
      // Step 2: Auto-validate configuration before updating
      logger.info('AdminService', `🔍 Auto-validating configuration before update: ${configId}`);
      
      const validationResult = await this.validateConfiguration({ data: { configData } } as AdminRequest);
      
      if (!validationResult.isValid) {
        logger.warn('AdminService', `❌ Configuration validation failed for ${configId}:`, validationResult.errors);
        return {
          success: false,
          validationErrors: validationResult.errors,
          message: `Configuration validation failed: ${validationResult.errors.join(', ')}`
        };
      }
      
      logger.info('AdminService', `✅ Configuration validation passed for ${configId}, proceeding with update`);
      
      // Step 3: Proceed with update since validation passed
      const UPDATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfiguration')
        .set({ 
          configData,
          isValid: true,
          lastValidated: new Date()
        })
        .where({ ID: configId });
      
      const result = await cds.run(UPDATE);
      
      if (result > 0) {
        // Log change with validation success
        const changeId = uuidv4();
        const INSERT_CHANGE = cds.ql.INSERT.into('sap.llm.gateway.admin.ConfigurationChanges').entries({
          ID: changeId,
          configuration_ID: configId,
          changeType: 'update',
          changeDescription: reason || 'Configuration updated (auto-validated)',
          newValue: configData,
          changeReason: reason,
          validationPassed: true
        });
        
        await cds.run(INSERT_CHANGE);
        
        logger.info('AdminService', `✅ Configuration ${configId} updated successfully with validation`);
      }
      
      return {
        success: result > 0,
        validationErrors: [],
        message: result > 0 ? 'Configuration updated successfully (validated)' : 'Configuration not found'
      };
    } catch (error) {
      logger.error('AdminService', `❌ Error in updateConfiguration for ${configId}:`, error instanceof Error ? error : new Error(String(error)));
      return {
        success: false,
        validationErrors: [(error as Error).message],
        message: 'Invalid JSON configuration'
      };
    }
  }

  async validateConfiguration(req: AdminRequest): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const { configData } = req.data;
    
    try {
      const parsedConfig = JSON.parse(configData!);
      const errors: string[] = [];
      const warnings: string[] = [];
      
      // Basic validation
      if (!parsedConfig.api_config) {
        errors.push('Missing api_config root object');
      }
      
      // Add more specific validations here
      
      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [(error as Error).message],
        warnings: []
      };
    }
  }

  /**
   * True when `configurationId` names the currently active configuration. Only a change to
   * the active configuration's credentials should reach the running resolver immediately -
   * editing an inactive configuration must not force a refresh on the running system. The
   * refresh this gates is a latency optimisation, not the guard on WHICH credentials are
   * served: the running resolver is pinned to the configuration the dispatcher was built from
   * (see secretResolver.ts) and reloads only that configuration's credentials, whichever
   * configuration this call happens to be about.
   */
  private async isActiveConfiguration(configurationId: string): Promise<boolean> {
    const config = await SELECT.one
      .from('sap.llm.gateway.admin.ApiConfigurations')
      .columns('isActive')
      .where({ ID: configurationId });
    return config?.isActive === true;
  }

  /**
   * Stores a SIEM sink credential, scoped to the configuration it was set on. The
   * credential's NAME is the env var name that api_config.json already records for the
   * sink; the value never touches that file. Errors never echo the value - an error string
   * is a log line and a UI toast.
   */
  async setSiemCredential(req: AdminRequest): Promise<{ success: boolean; error?: string }> {
    // Normalised once and reused for validation, storage and the audit resourceId, so a
    // leading/trailing-whitespace variant of a name can never create a second row that
    // secretResolver's exact-name lookup then fails to find.
    const name = req.data.name?.trim();
    const { value, configurationId } = req.data;
    const actorId = req.user?.id || 'unknown';

    if (!configurationId) {
      return { success: false, error: 'configurationId is required' };
    }
    if (!name) {
      return { success: false, error: 'name is required' };
    }
    if (!value) {
      return { success: false, error: 'value is required' };
    }

    try {
      await setCredential(configurationId, name, value, actorId);
      // Rotation is the deliberate exception to "inactive configurations are read-only": a
      // compromised key cannot wait for a deactivate-edit-reactivate cycle. Waiting out the
      // resolver's periodic refresh is equally unacceptable, so the running resolver is
      // refreshed immediately - but only when the configuration just edited is the active one.
      if (await this.isActiveConfiguration(configurationId)) {
        await refreshSecretResolver();
      }
      await recordAuditEvent({
        actorId,
        actorType: 'admin_user',
        action: 'siem_credential.set',
        resourceType: 'SiemCredential',
        resourceId: name,          // the NAME, never the value
        outcome: 'success',
        severity: 'high',
        details: JSON.stringify({ configurationId }),
      });
      return { success: true };
    } catch (error) {
      logger.error('admin-service', `Failed to store SIEM credential '${name}'`, error as Error);
      await recordAuditEvent({
        actorId,
        actorType: 'admin_user',
        action: 'siem_credential.set',
        resourceType: 'SiemCredential',
        resourceId: name,
        outcome: 'failure',
        severity: 'high',
        details: JSON.stringify({ configurationId }),
      });
      // Names the missing configuration - the variable's NAME, never any value - because a
      // deployment that never wired SIEM_CREDENTIAL_KEY in fails EVERY set this way, and
      // 'Failed to store the credential' gives the operator nothing to act on. Every other
      // failure keeps the generic message: it must not describe the store's internals.
      return {
        success: false,
        error: error instanceof MissingCredentialKeyError
          ? 'SIEM_CREDENTIAL_KEY is not configured on the admin service; the credential was not stored'
          : 'Failed to store the credential',
      };
    }
  }

  async deleteSiemCredential(req: AdminRequest): Promise<{ success: boolean; error?: string }> {
    // Same normalisation as setSiemCredential - trims once, reused for validation, the store
    // lookup and the audit resourceId, so a whitespace-padded name still matches the row that
    // setSiemCredential (also trimmed) created.
    const name = req.data.name?.trim();
    const { configurationId } = req.data;
    const actorId = req.user?.id || 'unknown';

    if (!configurationId) {
      return { success: false, error: 'configurationId is required' };
    }
    if (!name) {
      return { success: false, error: 'name is required' };
    }

    try {
      await deleteCredential(configurationId, name);
      // Same immediate-refresh exception as setSiemCredential - only when the configuration
      // just edited is the active one.
      if (await this.isActiveConfiguration(configurationId)) {
        await refreshSecretResolver();
      }
      await recordAuditEvent({
        actorId,
        actorType: 'admin_user',
        action: 'siem_credential.delete',
        resourceType: 'SiemCredential',
        resourceId: name,
        outcome: 'success',
        severity: 'high',
        details: JSON.stringify({ configurationId }),
      });
      return { success: true };
    } catch (error) {
      logger.error('admin-service', `Failed to delete SIEM credential '${name}'`, error as Error);
      await recordAuditEvent({
        actorId,
        actorType: 'admin_user',
        action: 'siem_credential.delete',
        resourceType: 'SiemCredential',
        resourceId: name,
        outcome: 'failure',
        severity: 'high',
        details: JSON.stringify({ configurationId }),
      });
      return { success: false, error: 'Failed to delete the credential' };
    }
  }

  /**
   * Metadata only. Returning a value or ciphertext here would defeat the whole store.
   * A store failure is logged and rethrown rather than swallowed into `[]`: an empty array
   * here is indistinguishable from "nothing stored", and would render as "no credentials
   * configured" in the Settings UI to an administrator whose credentials are in fact stored,
   * inviting them to re-enter secrets against a store that is merely unreachable right now.
   * An unhandled rejection from a CAP action becomes an error response, not a crashed caller,
   * so there is no safety reason to hide this from the client.
   */
  async listSiemCredentials(req: AdminRequest): Promise<CredentialMetadata[]> {
    const { configurationId } = req.data;
    if (!configurationId) {
      throw new Error('configurationId is required');
    }
    try {
      return await listCredentialNames(configurationId);
    } catch (error) {
      logger.error('admin-service', 'Failed to list SIEM credentials', error as Error);
      throw new Error('Failed to list SIEM credentials');
    }
  }

  /**
   * Reports every SiemCredentials row nothing can reach any more - see credentialSweep.ts for
   * the classification. Never deletes; a credential value can never be read back, so cleanup
   * is a separate, explicit action (deleteOrphanedSiemCredentials). Same never-return-[]-on-
   * error reasoning as listSiemCredentials: an empty array here must mean "no orphans", not
   * "the sweep could not run".
   */
  async findOrphanedSiemCredentials(req: AdminRequest): Promise<OrphanedCredential[]> {
    try {
      return await findOrphanedCredentials();
    } catch (error) {
      logger.error('admin-service', 'Failed to find orphaned SIEM credentials', error as Error);
      throw new Error('Failed to find orphaned SIEM credentials');
    }
  }

  /**
   * Deletes exactly the (configurationIds[i], names[i]) pairs the caller confirmed. Re-derives
   * the current orphan set and filters it down to those pairs, rather than trusting the pairs
   * directly - so a slot that stopped being an orphan between the report and this call (a sink
   * re-added it, say) is never deleted, and deleteOrphanedCredentials gets the `reason` it
   * needs for the audit trail.
   */
  async deleteOrphanedSiemCredentials(
    req: AdminRequest,
  ): Promise<{ success: boolean; deleted: number; error?: string }> {
    const { names, configurationIds } = req.data;
    const actorId = req.user?.id || 'unknown';

    if (
      !Array.isArray(names) || !Array.isArray(configurationIds) ||
      names.length === 0 || names.length !== configurationIds.length
    ) {
      return { success: false, deleted: 0, error: 'names and configurationIds must be non-empty, equal-length arrays' };
    }

    try {
      const requested = new Set(names.map((name, i) => `${configurationIds[i]}::${name}`));
      const orphans = (await findOrphanedCredentials())
        .filter(o => requested.has(`${o.configurationId}::${o.name}`));
      const deleted = await deleteOrphanedCredentials(orphans, actorId);
      return { success: true, deleted };
    } catch (error) {
      logger.error('admin-service', 'Failed to delete orphaned SIEM credentials', error as Error);
      return { success: false, deleted: 0, error: 'Failed to delete orphaned credentials' };
    }
  }

  async getActiveConfiguration(req: AdminRequest): Promise<any> {
    const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfiguration')
      .where({ isActive: true, isDefault: true });
    
    const config = await cds.run(SELECT);
    
    if (config.length > 0) {
      const record = config[0];
      return {
        id: record.ID,
        name: record.name,
        version: record.version,
        environment: record.environment,
        configData: record.configData,
        lastModified: record.modifiedAt
      };
    }
    
    return null;
  }

  // ========================================
  // Analytics and Reporting
  // ========================================

  /**
   * Helper function to safely access database fields that might have case sensitivity differences
   * between PostgreSQL (lowercase) and SQLite (camelCase)
   */
  private safeGetField(record: any, fieldName: string): any {
    return record[fieldName] || record[fieldName.toLowerCase()] || record[fieldName.toUpperCase()];
  }

  /**
   * Helper function to safely parse float values from database fields with case sensitivity handling
   */
  private safeParseFloat(record: any, fieldName: string): number {
    const value = this.safeGetField(record, fieldName);
    return parseFloat(value) || 0;
  }

  async getUsageStatistics(req: AdminRequest): Promise<{
    apiKeyUsage: any[];
    awsCredentialUsage: any[];
    providerUsage: any[];
    emailUsage: any[];
    endpointUsage: any[];
    modelUsage: any[];
  }> {
    const { startDate, endDate, granularity } = req.data;
    
    // User-scoped authorization: Users can only see their own usage statistics
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    logger.info('AdminService', `[RBAC] Usage statistics request by ${userEmail}`, {
      userEmail,
      isAdmin,
      userRoles,
      endpoint: 'getUsageStatistics'
    });
    
    try {
      // Convert date strings to proper timestamp ranges
      // If dates are in simple format (YYYY-MM-DD), convert to full timestamp range
      let adjustedStartDate: any = startDate;
      let adjustedEndDate: any = endDate;
      
      // Convert string dates to full timestamps
      if (startDate && typeof startDate === 'string' && !(startDate as string).includes('T')) {
        adjustedStartDate = `${startDate}T00:00:00.000Z`;
      }
      
      if (endDate && typeof endDate === 'string' && !(endDate as string).includes('T')) {
        adjustedEndDate = `${endDate}T23:59:59.999Z`;
      }
      
      // Handle Date objects by converting to ISO strings
      if (startDate instanceof Date) {
        const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);
        adjustedStartDate = start.toISOString();
      }
      
      if (endDate instanceof Date) {
        const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59, 999);
        adjustedEndDate = end.toISOString();
      }
      
      // Build base where clause
      let whereClause: any = {
        validFrom: { between: adjustedStartDate, and: adjustedEndDate }
      };

      // Add user-scoped filtering for API key usage (non-admins can only see their own data)
      let apiKeyWhereClause = { ...whereClause, provider: { '!=': null } };
      if (!isAdmin) {
        // Join with ApiKeys table to filter by user email
        apiKeyWhereClause = { 
          ...apiKeyWhereClause, 
          'apiKey.email': userEmail 
        };
        
        logger.debug('AdminService', `[RBAC] Filtering API key usage for user: ${userEmail}`, {
          whereClause: apiKeyWhereClause
        });
      }

      // Query API key usage statistics
      const apiKeyUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.ApiKeyUsage')
          .where(apiKeyWhereClause)
          .columns([
            'apiKey_ID as keyId',
            'max(keyName) as keyName',
            'count(*) as totalRequests',
            'COALESCE(sum(inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(totalTokens), 0) as totalTokens',
            'COALESCE(sum(inputCost), 0) as totalInputCost',
            'COALESCE(sum(outputCost), 0) as totalOutputCost',
            'COALESCE(sum(cacheCreationInputCost), 0) as totalCacheCreationInputCost',
            'COALESCE(sum(cacheReadInputCost), 0) as totalCacheReadInputCost',
            'COALESCE(sum(totalCost), 0) as totalCost',
            'COALESCE(avg(responseTime), 0) as avgResponseTime',
            'max(validFrom) as lastActivity'
          ])
          .groupBy('apiKey_ID')
      );

      // Add user-scoped filtering for AWS credential usage
      let awsWhereClause = { ...whereClause };
      if (!isAdmin) {
        // Join with AwsCredentials table to filter by user ID
        awsWhereClause = { 
          ...awsWhereClause, 
          'credential.userId': userEmail 
        };
        
        logger.debug('AdminService', `[RBAC] Filtering AWS credential usage for user: ${userEmail}`, {
          whereClause: awsWhereClause
        });
      }
      

      // Query AWS credential usage statistics with proper name fallback
      const awsCredentialUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.AwsCredentialUsage as usage')
          .leftJoin('sap.llm.gateway.admin.AwsCredentials as cred').on('usage.credential_ID = cred.ID')
          .where(awsWhereClause)
          .columns([
            'usage.credential_ID as credentialId',
            'COALESCE(MAX(cred.name), MAX(usage.credentialName), (\'Credential-\' || usage.credential_ID)) as credentialName',
            'count(*) as totalRequests',
            'COALESCE(sum(usage.inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(usage.outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(usage.cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(usage.cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(usage.inputTokens + usage.outputTokens + COALESCE(usage.cacheCreationInputTokens, 0) + COALESCE(usage.cacheReadInputTokens, 0)), 0) as totalTokens',
            'COALESCE(sum(usage.inputCost), 0) as totalInputCost',
            'COALESCE(sum(usage.outputCost), 0) as totalOutputCost',
            'COALESCE(sum(usage.cacheCreationInputCost), 0) as totalCacheCreationInputCost',
            'COALESCE(sum(usage.cacheReadInputCost), 0) as totalCacheReadInputCost',
            'COALESCE(sum(usage.totalCost), 0) as totalCost',
            'COALESCE(avg(usage.responseTime), 0) as avgResponseTime',
            'count(case when usage.statusCode >= 400 then 1 end) as errorCount',
            'max(usage.validFrom) as lastActivity'
          ])
          .groupBy('usage.credential_ID')
      );

      // Query provider usage statistics from API key usage (with user filtering)
      const apiKeyProviderUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.ApiKeyUsage')
          .where(apiKeyWhereClause) // Use the same filtered clause
          .columns([
            'provider',
            'count(*) as totalRequests',
            'COALESCE(sum(inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(totalTokens), 0) as totalTokens',
            'COALESCE(avg(responseTime), 0) as avgResponseTime',
            'count(case when statusCode >= 400 then 1 end) as errorCount'
          ])
          .groupBy('provider')
      );

      // Query provider usage statistics from AWS credential usage
      const awsProviderUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.AwsCredentialUsage')
          .where({ ...whereClause, provider: { '!=': null } }) // Filter out null providers
          .columns([
            'provider',
            'count(*) as totalRequests',
            'COALESCE(sum(inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(inputTokens + outputTokens + COALESCE(cacheCreationInputTokens, 0) + COALESCE(cacheReadInputTokens, 0)), 0) as totalTokens',
            'COALESCE(avg(responseTime), 0) as avgResponseTime',
            'count(case when statusCode >= 400 then 1 end) as errorCount'
          ])
          .groupBy('provider')
      );

      // Combine provider usage results
      const providerUsageMap = new Map();
      
      // Process API key provider usage
      apiKeyProviderUsage.forEach((record: any) => {
        providerUsageMap.set(record.provider, {
          provider: record.provider,
          totalRequests: record.totalRequests,
          totalInputTokens: record.totalInputTokens,
          totalOutputTokens: record.totalOutputTokens,
          totalCacheCreationInputTokens: record.totalCacheCreationInputTokens,
          totalCacheReadInputTokens: record.totalCacheReadInputTokens,
          totalTokens: record.totalTokens,
          avgResponseTime: record.avgResponseTime,
          errorCount: record.errorCount
        });
      });
      
      // Process AWS provider usage and combine with API key usage
      awsProviderUsage.forEach((record: any) => {
        if (providerUsageMap.has(record.provider)) {
          const existing = providerUsageMap.get(record.provider);
          existing.totalRequests += record.totalRequests;
          existing.totalInputTokens += record.totalInputTokens;
          existing.totalOutputTokens += record.totalOutputTokens;
          existing.totalCacheCreationInputTokens += record.totalCacheCreationInputTokens;
          existing.totalCacheReadInputTokens += record.totalCacheReadInputTokens;
          existing.totalTokens += record.totalTokens;
          existing.avgResponseTime = (existing.avgResponseTime + record.avgResponseTime) / 2; // Simple average
          existing.errorCount += record.errorCount;
        } else {
          providerUsageMap.set(record.provider, {
            provider: record.provider,
            totalRequests: record.totalRequests,
            totalInputTokens: record.totalInputTokens,
            totalOutputTokens: record.totalOutputTokens,
            totalCacheCreationInputTokens: record.totalCacheCreationInputTokens,
            totalCacheReadInputTokens: record.totalCacheReadInputTokens,
            totalTokens: record.totalTokens,
            avgResponseTime: record.avgResponseTime,
            errorCount: record.errorCount
          });
        }
      });
      
      const providerUsage = Array.from(providerUsageMap.values());

      // Query email-based usage statistics (preserves data even after API key deletion)
      // Combine both API key and AWS credential usage by email (with user filtering)
      let emailWhereClause = { ...whereClause, provider: { '!=': null }, email: { '!=': null } };
      if (!isAdmin) {
        emailWhereClause = { ...emailWhereClause, email: userEmail };
      }

      const apiKeyEmailUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.ApiKeyUsage')
          .where(emailWhereClause)
          .columns([
            'email',
            'count(*) as totalRequests',
            'COALESCE(sum(inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(totalTokens), 0) as totalTokens',
            'COALESCE(sum(inputCost), 0) as totalInputCost',
            'COALESCE(sum(outputCost), 0) as totalOutputCost',
            'COALESCE(sum(cacheCreationInputCost), 0) as totalCacheCreationInputCost',
            'COALESCE(sum(cacheReadInputCost), 0) as totalCacheReadInputCost',
            'COALESCE(sum(totalCost), 0) as totalCost',
            'COALESCE(avg(responseTime), 0) as avgResponseTime',
            'count(distinct keyName) as uniqueApiKeysUsed',
            'max(validFrom) as lastActivity'
          ])
          .groupBy('email')
      );

      // Query AWS credential usage statistics by userId (which contains email addresses, with user filtering)
      let awsEmailWhereClause = { ...whereClause, provider: { '!=': null }, userId: { '!=': null } };
      if (!isAdmin) {
        awsEmailWhereClause = { ...awsEmailWhereClause, userId: userEmail };
      }

      const awsCredentialEmailUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.AwsCredentialUsage')
          .where(awsEmailWhereClause)
          .columns([
            'userId as email', // Map userId to email since it contains email addresses
            'count(*) as totalRequests',
            'COALESCE(sum(inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(inputTokens) + sum(outputTokens) + sum(COALESCE(cacheCreationInputTokens, 0)) + sum(COALESCE(cacheReadInputTokens, 0)), 0) as totalTokens',
            'COALESCE(sum(inputCost), 0) as totalInputCost',
            'COALESCE(sum(outputCost), 0) as totalOutputCost',
            'COALESCE(sum(cacheCreationInputCost), 0) as totalCacheCreationInputCost',
            'COALESCE(sum(cacheReadInputCost), 0) as totalCacheReadInputCost',
            'COALESCE(sum(totalCost), 0) as totalCost',
            'COALESCE(avg(responseTime), 0) as avgResponseTime',
            'count(distinct credentialName) as uniqueAwsCredentialsUsed',
            'max(validFrom) as lastActivity'
          ])
          .groupBy('userId')
      );

      // Combine and aggregate usage by email
      const emailUsageMap = new Map();
      
      // Process API key usage
      apiKeyEmailUsage.forEach((usage: any) => {
        const email = usage.email;
        if (emailUsageMap.has(email)) {
          const existing = emailUsageMap.get(email);
          existing.totalRequests += usage.totalRequests;
          existing.totalInputTokens += usage.totalInputTokens;
          existing.totalOutputTokens += usage.totalOutputTokens;
          existing.totalCacheCreationInputTokens += usage.totalCacheCreationInputTokens;
          existing.totalCacheReadInputTokens += usage.totalCacheReadInputTokens;
          existing.totalTokens += usage.totalTokens;
          existing.totalInputCost += usage.totalInputCost;
          existing.totalOutputCost += usage.totalOutputCost;
          existing.totalCacheCreationInputCost += usage.totalCacheCreationInputCost;
          existing.totalCacheReadInputCost += usage.totalCacheReadInputCost;
          existing.totalCost += usage.totalCost;
          existing.uniqueApiKeysUsed += usage.uniqueApiKeysUsed;
          existing.avgResponseTime = (existing.avgResponseTime + usage.avgResponseTime) / 2;
          existing.lastActivity = existing.lastActivity > usage.lastActivity ? existing.lastActivity : usage.lastActivity;
        } else {
          // Initialize with separate fields for API keys and AWS credentials
          const emailUsage = { 
            ...usage, 
            uniqueKeysUsed: usage.uniqueApiKeysUsed, // For backward compatibility
            uniqueAwsCredentialsUsed: 0 // Initialize AWS count to 0
          };
          emailUsageMap.set(email, emailUsage);
        }
      });

      // Process AWS credential usage
      awsCredentialEmailUsage.forEach((usage: any) => {
        const email = usage.email;
        if (emailUsageMap.has(email)) {
          const existing = emailUsageMap.get(email);
          existing.totalRequests += usage.totalRequests;
          existing.totalInputTokens += usage.totalInputTokens;
          existing.totalOutputTokens += usage.totalOutputTokens;
          existing.totalCacheCreationInputTokens += usage.totalCacheCreationInputTokens;
          existing.totalCacheReadInputTokens += usage.totalCacheReadInputTokens;
          existing.totalTokens += usage.totalTokens;
          existing.totalInputCost += usage.totalInputCost;
          existing.totalOutputCost += usage.totalOutputCost;
          existing.totalCacheCreationInputCost += usage.totalCacheCreationInputCost;
          existing.totalCacheReadInputCost += usage.totalCacheReadInputCost;
          existing.totalCost += usage.totalCost;
          existing.uniqueAwsCredentialsUsed += usage.uniqueAwsCredentialsUsed;
          existing.avgResponseTime = (existing.avgResponseTime + usage.avgResponseTime) / 2;
          existing.lastActivity = existing.lastActivity > usage.lastActivity ? existing.lastActivity : usage.lastActivity;
        } else {
          // Initialize with separate fields for API keys and AWS credentials
          const emailUsage = { 
            ...usage, 
            uniqueKeysUsed: usage.uniqueAwsCredentialsUsed, // For backward compatibility
            uniqueApiKeysUsed: 0 // Initialize API key count to 0
          };
          emailUsageMap.set(email, emailUsage);
        }
      });

      // Convert map to array
      const emailUsage = Array.from(emailUsageMap.values());

      // Query endpoint-based usage statistics for better granularity (with user filtering)
      let endpointWhereClause = { ...whereClause, provider: { '!=': null }, endpoint: { '!=': null } };
      if (!isAdmin) {
        endpointWhereClause = { ...endpointWhereClause, 'apiKey.email': userEmail };
      }

      const endpointUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.ApiKeyUsage')
          .where(endpointWhereClause)
          .columns([
            'endpoint',
            'count(*) as totalRequests',
            'COALESCE(sum(inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(totalTokens), 0) as totalTokens',
            'COALESCE(avg(responseTime), 0) as avgResponseTime',
            'count(case when statusCode >= 400 then 1 end) as errorCount'
          ])
          .groupBy('endpoint')
      );

      // Query model usage statistics from API key usage (with user filtering)
      let modelWhereClause = { ...whereClause, 'usage.provider': { '!=': null }, 'usage.model': { '!=': null } };
      if (!isAdmin) {
        modelWhereClause = { ...modelWhereClause, 'usage.apiKey.email': userEmail };
      }

      const apiKeyModelUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.ApiKeyUsage as usage')
          .leftJoin('sap.llm.gateway.admin.ModelCosts as costs').on('usage.model = costs.model AND costs.dateTo = \'9999-12-31T00:00:00.000Z\'')
          .where(modelWhereClause)
          .columns([
            'usage.model as modelId',
            'COALESCE(costs.displayName, usage.model) as displayName',
            'usage.provider',
            'count(*) as totalRequests',
            'COALESCE(sum(usage.inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(usage.outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(usage.cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(usage.cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(usage.totalTokens), 0) as totalTokens',
            'COALESCE(sum(usage.inputCost), 0) as totalInputCost',
            'COALESCE(sum(usage.outputCost), 0) as totalOutputCost',
            'COALESCE(sum(usage.cacheCreationInputCost), 0) as totalCacheCreationInputCost',
            'COALESCE(sum(usage.cacheReadInputCost), 0) as totalCacheReadInputCost',
            'COALESCE(sum(usage.totalCost), 0) as totalCost',
            'COALESCE(avg(usage.responseTime), 0) as avgResponseTime',
            'count(case when usage.statusCode >= 400 then 1 end) as errorCount'
          ])
          .groupBy('usage.model', 'usage.provider', 'costs.displayName')
      );

      // Query model usage statistics from AWS credential usage (with user filtering)
      let awsModelWhereClause = { ...whereClause, 'usage.provider': { '!=': null }, 'usage.modelId': { '!=': null } };
      if (!isAdmin) {
        awsModelWhereClause = { ...awsModelWhereClause, 'usage.credential.userId': userEmail };
      }

      const awsModelUsage = await cds.run(
        SELECT.from('sap.llm.gateway.admin.AwsCredentialUsage as usage')
          .leftJoin('sap.llm.gateway.admin.ModelCosts as costs').on('usage.modelId = costs.model AND costs.dateTo = \'9999-12-31T00:00:00.000Z\'')
          .where(awsModelWhereClause)
          .columns([
            'usage.modelId',
            'COALESCE(costs.displayName, usage.modelId) as displayName',
            'usage.provider',
            'count(*) as totalRequests',
            'COALESCE(sum(usage.inputTokens), 0) as totalInputTokens',
            'COALESCE(sum(usage.outputTokens), 0) as totalOutputTokens',
            'COALESCE(sum(usage.cacheCreationInputTokens), 0) as totalCacheCreationInputTokens',
            'COALESCE(sum(usage.cacheReadInputTokens), 0) as totalCacheReadInputTokens',
            'COALESCE(sum(usage.inputTokens + usage.outputTokens + COALESCE(usage.cacheCreationInputTokens, 0) + COALESCE(usage.cacheReadInputTokens, 0)), 0) as totalTokens',
            'COALESCE(sum(usage.inputCost), 0) as totalInputCost',
            'COALESCE(sum(usage.outputCost), 0) as totalOutputCost',
            'COALESCE(sum(usage.cacheCreationInputCost), 0) as totalCacheCreationInputCost',
            'COALESCE(sum(usage.cacheReadInputCost), 0) as totalCacheReadInputCost',
            'COALESCE(sum(usage.totalCost), 0) as totalCost',
            'COALESCE(avg(usage.responseTime), 0) as avgResponseTime',
            'count(case when usage.statusCode >= 400 then 1 end) as errorCount'
          ])
          .groupBy('usage.modelId', 'usage.provider', 'costs.displayName')
      );

      // Combine model usage results from both API key and AWS credential usage
      const modelUsageMap = new Map();
      
      // Process API key model usage
      apiKeyModelUsage.forEach((record: any) => {
        const key = `${record.modelId}-${record.provider}`;
        modelUsageMap.set(key, {
          modelId: record.modelId,
          displayName: record.displayName,
          provider: record.provider,
          totalRequests: record.totalRequests,
          totalInputTokens: record.totalInputTokens,
          totalOutputTokens: record.totalOutputTokens,
          totalCacheCreationInputTokens: record.totalCacheCreationInputTokens,
          totalCacheReadInputTokens: record.totalCacheReadInputTokens,
          totalTokens: record.totalTokens,
          totalInputCost: this.safeParseFloat(record, 'totalInputCost'),
          totalOutputCost: this.safeParseFloat(record, 'totalOutputCost'),
          totalCacheCreationInputCost: this.safeParseFloat(record, 'totalCacheCreationInputCost'),
          totalCacheReadInputCost: this.safeParseFloat(record, 'totalCacheReadInputCost'),
          totalCost: this.safeParseFloat(record, 'totalCost'),
          avgResponseTime: record.avgResponseTime,
          errorCount: record.errorCount
        });
      });
      
      // Process AWS model usage and combine with API key usage
      awsModelUsage.forEach((record: any) => {
        const key = `${record.modelId}-${record.provider}`;
        if (modelUsageMap.has(key)) {
          const existing = modelUsageMap.get(key);
          existing.totalRequests += record.totalRequests;
          existing.totalInputTokens += record.totalInputTokens;
          existing.totalOutputTokens += record.totalOutputTokens;
          existing.totalCacheCreationInputTokens += record.totalCacheCreationInputTokens;
          existing.totalCacheReadInputTokens += record.totalCacheReadInputTokens;
          existing.totalTokens += record.totalTokens;
          existing.totalInputCost += this.safeParseFloat(record, 'totalInputCost');
          existing.totalOutputCost += this.safeParseFloat(record, 'totalOutputCost');
          existing.totalCacheCreationInputCost += this.safeParseFloat(record, 'totalCacheCreationInputCost');
          existing.totalCacheReadInputCost += this.safeParseFloat(record, 'totalCacheReadInputCost');
          existing.totalCost += this.safeParseFloat(record, 'totalCost');
          existing.avgResponseTime = (existing.avgResponseTime + record.avgResponseTime) / 2; // Simple average
          existing.errorCount += record.errorCount;
        } else {
          modelUsageMap.set(key, {
            modelId: record.modelId,
            displayName: record.displayName,
            provider: record.provider,
            totalRequests: record.totalRequests,
            totalInputTokens: record.totalInputTokens,
            totalOutputTokens: record.totalOutputTokens,
            totalCacheCreationInputTokens: record.totalCacheCreationInputTokens,
            totalCacheReadInputTokens: record.totalCacheReadInputTokens,
            totalTokens: record.totalTokens,
            totalInputCost: this.safeParseFloat(record, 'totalInputCost'),
            totalOutputCost: this.safeParseFloat(record, 'totalOutputCost'),
            totalCacheCreationInputCost: this.safeParseFloat(record, 'totalCacheCreationInputCost'),
            totalCacheReadInputCost: this.safeParseFloat(record, 'totalCacheReadInputCost'),
            totalCost: this.safeParseFloat(record, 'totalCost'),
            avgResponseTime: record.avgResponseTime,
            errorCount: record.errorCount
          });
        }
      });
      
      const modelUsage = Array.from(modelUsageMap.values());

      logger.info('AdminService', 'Enhanced usage statistics retrieved', {
        apiKeyRecords: apiKeyUsage.length,
        awsCredentialRecords: awsCredentialUsage.length,
        providerRecords: providerUsage.length,
        emailRecords: emailUsage.length,
        endpointRecords: endpointUsage.length,
        modelRecords: modelUsage.length,
        originalDateRange: { startDate, endDate },
        adjustedDateRange: { adjustedStartDate, adjustedEndDate }
      });

      return {
        apiKeyUsage,
        awsCredentialUsage,
        providerUsage,
        emailUsage,
        endpointUsage,
        modelUsage
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to retrieve usage statistics: ${errorMsg} - Range: ${startDate} to ${endDate}, granularity: ${granularity}`);
      throw error;
    }
  }

  /**
   * Invoice reconciliation + calibration back-out (Task 13). Sums the SAP-native fields
   * already recorded on ApiKeyUsage over [from,to] and, given the operator-entered invoice
   * figures for that same period, backs out the implied calibration factors. Read-only: the
   * caller reviews the suggestion and sets sap_cache_*_token_billing_factor themselves - this
   * handler never writes anything.
   */
  async reconcileInvoice(req: AdminRequest): Promise<{
    capacityUnits: number;
    sapCostByCurrency: Array<{ currency: string; amount: number }>;
    capturedGenAiTokens: number;
    capturedCacheReadInputTokens: number;
    capturedCacheWriteInputTokens: number;
    impliedCuFactor: number | null;
    impliedCacheReadFactor: number | null;
    impliedCacheWriteFactor: number | null;
  }> {
    const {
      from, to,
      invoiceGenAiTokens, invoiceCapacityUnits,
      invoiceCacheReadInputTokens, invoiceCacheWriteInputTokens
    } = req.data;

    const toNumber = (v: number | string | undefined): number | undefined =>
      v === undefined || v === null || v === '' ? undefined : Number(v);

    const result = await reconcile({
      from: new Date(from as any),
      to: new Date(to as any),
      invoice: {
        genAiTokens: toNumber(invoiceGenAiTokens),
        capacityUnits: toNumber(invoiceCapacityUnits),
        cacheReadInputTokens: toNumber(invoiceCacheReadInputTokens),
        cacheWriteInputTokens: toNumber(invoiceCacheWriteInputTokens)
      }
    });

    return {
      capacityUnits: result.capacityUnits,
      sapCostByCurrency: Object.entries(result.sapCostByCurrency).map(([currency, amount]) => ({ currency, amount })),
      capturedGenAiTokens: result.capturedGenAiTokens,
      capturedCacheReadInputTokens: result.capturedCacheReadInputTokens,
      capturedCacheWriteInputTokens: result.capturedCacheWriteInputTokens,
      impliedCuFactor: result.impliedCuFactor,
      impliedCacheReadFactor: result.impliedCacheReadFactor,
      impliedCacheWriteFactor: result.impliedCacheWriteFactor
    };
  }

  async getSecurityEvents(req: AdminRequest): Promise<any[]> {
    const { startDate, endDate, severity } = req.data;
    
    try {
      // Query AWS credential security events
      const awsSelect = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentialSecurityEvents')
        .where({ createdAt: { between: startDate, and: endDate } });
      
      if (severity) {
        awsSelect.where({ severity });
      }
      
      // Query API key security events
      const apiKeySelect = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiKeySecurityEvents')
        .where({ createdAt: { between: startDate, and: endDate } });
      
      if (severity) {
        apiKeySelect.where({ severity });
      }
      
      // Execute both queries
      const [awsEvents, apiKeyEvents] = await Promise.all([
        cds.run(awsSelect),
        cds.run(apiKeySelect)
      ]);
      
      // Combine and normalize events
      const allEvents = [
        ...awsEvents.map((event: any) => ({
          ...event,
          credentialType: 'aws_credential',
          credentialId: event.credential_ID
        })),
        ...apiKeyEvents.map((event: any) => ({
          ...event,
          credentialType: 'api_key',
          credentialId: event.apiKey_ID
        }))
      ];
      
      // Group by event type and severity
      const grouped = allEvents.reduce((acc: any, event: any) => {
        const key = `${event.eventType}-${event.severity}`;
        if (!acc[key]) {
          acc[key] = {
            eventType: event.eventType,
            severity: event.severity,
            count: 0,
            lastOccurrence: event.createdAt,
            affectedCredentials: new Set(),
            credentialTypes: new Set()
          };
        }
        acc[key].count++;
        acc[key].affectedCredentials.add(event.credentialId);
        acc[key].credentialTypes.add(event.credentialType);
        if (event.createdAt > acc[key].lastOccurrence) {
          acc[key].lastOccurrence = event.createdAt;
        }
        return acc;
      }, {});
      
      return Object.values(grouped).map((g: any) => ({
        ...g,
        affectedCredentials: g.affectedCredentials.size,
        credentialTypes: Array.from(g.credentialTypes)
      }));
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to retrieve security events: ${errorMsg}`, error as Error);
      throw error;
    }
  }

  // Placeholder methods for missing handlers
  async patchConfiguration(req: AdminRequest): Promise<any> {
    // Implementation would be similar to updateConfiguration but for partial updates
    return { success: false, message: 'Not implemented' };
  }

  async resetConfiguration(req: AdminRequest): Promise<any> {
    // Implementation would reset configuration to defaults
    return { success: false, message: 'Not implemented' };
  }

  // ========================================
  // Helper Methods (from Gateway Service)
  // ========================================

  /**
   * Calculate AWS region from SAP AI region configuration
   * @param sapAiRegion - SAP AI region configuration  
   * @returns AWS region string
   */
  private getAwsRegionFromSapAi(sapAiRegion: string): string {
    // Same logic as gateway service: extract region from dotted notation
    return sapAiRegion.includes('.') ? (sapAiRegion.split('.')[1] || 'us-east-1') : sapAiRegion;
  }

  // ========================================
  // Authentication Helper Methods
  // ========================================

  /**
   * Extract user email from request (compatible with both mocked and JWT auth)
   * @param req - Request object
   * @returns User email string
   */
  private getUserEmail(req: any): string {
    // Mocked auth: req.user.id contains the email
    // JWT auth: req.user.email or req.user.sub
    const email = req.user?.id || req.user?.email || req.user?.sub || '';
    
    // Debug logging for authentication issues
    if (email === 'privileged' || !email) {
      logger.warn('AdminService', 'getUserEmail: Potential authentication issue detected', {
        userConstructor: req.user?.constructor?.name,
        userId: req.user?.id,
        userEmail: req.user?.email,
        userSub: req.user?.sub,
        userAttr: req.user?.attr,
        resolvedEmail: email
      });
    }
    
    return email;
  }
  
  /**
   * Extract user ID from request (compatible with both mocked and JWT auth)
   * For AWS credentials, this is used as userId field
   * @param req - Request object
   * @returns User ID string
   */
  private getUserId(req: any): string {
    // For AWS credentials, use email as userId (consistent with existing data)
    // Mocked auth: req.user.id contains the email
    // JWT auth: req.user.email or req.user.sub
    return req.user?.id || req.user?.email || req.user?.sub || '';
  }

  /**
   * Extract user roles from request (compatible with both mocked and JWT auth)
   * @param req - Request object
   * @returns Array of user roles
   */
  private getUserRoles(req: any): string[] {
    // Mocked auth: req.user.roles (can be object like {admin: 1, user: 1} or array)
    // JWT auth: req.user.scope (array) or req.user.roles
    const roles = req.user?.roles || req.user?.scope || [];
    
    // Handle object format from mocked auth: {admin: 1, user: 1}
    if (typeof roles === 'object' && !Array.isArray(roles)) {
      return Object.keys(roles);
    }
    
    // Handle array format: ["admin", "user"]
    return Array.isArray(roles) ? roles : [roles].filter(Boolean);
  }

  /**
   * Check if user has admin role
   * @param roles - Array of user roles
   * @returns True if user is admin
   */
  private isAdmin(roles: string[]): boolean {
    return roles.some(role => {
      if (typeof role !== 'string') return false;
      // Exact match or an xsuaa scope suffix only - a substring match would let a scope such as
      // 'non-admin' or 'admin-readonly' pass the admin-only lifecycle guards.
      return (
        role === 'admin' ||
        role === 'Admin' ||
        role.endsWith('.admin')
      );
    });
  }

  /**
   * Client IP and user agent of the CAP request, derived with the same trust rule as the gateway
   * (utils/clientIp.ts): never Express's req.ip unless platform.security.trust_forwarded_for is set.
   */
  private getClientContext(req: any): { clientIP: string; userAgent: string } {
    return clientContext(req);
  }

  /**
   * Record an operator audit event for an API key lifecycle action (create/rotate/revoke).
   */
  private async recordApiKeyAudit(
    req: any,
    actorId: string | undefined,
    action: string,
    resourceId: string | undefined,
    outcome: 'success' | 'failure',
    details: string,
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'
  ): Promise<void> {
    const { clientIP, userAgent } = this.getClientContext(req);
    await recordAuditEvent({
      actorId: actorId || 'unknown',
      actorType: 'admin_user',
      action,
      resourceType: 'ApiKey',
      resourceId: resourceId || 'unknown',
      outcome,
      severity,
      clientIP,
      userAgent,
      details
    });
  }

  /**
   * Record an operator audit event for an AWS credential lifecycle action (create/rotate/revoke).
   */
  private async recordAwsCredentialAudit(
    req: any,
    actorId: string | undefined,
    action: string,
    resourceId: string | undefined,
    outcome: 'success' | 'failure',
    details: string,
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'
  ): Promise<void> {
    const { clientIP, userAgent } = this.getClientContext(req);
    await recordAuditEvent({
      actorId: actorId || 'unknown',
      actorType: 'admin_user',
      action,
      resourceType: 'AwsCredential',
      resourceId: resourceId || 'unknown',
      outcome,
      severity,
      clientIP,
      userAgent,
      details
    });
  }

  /** 403 user_deactivated when the owner is deactivated; used by every credential-creating and enabling path. */
  private async rejectIfDeactivated(req: any, email: string | undefined): Promise<boolean> {
    if (!email || !(await isDeactivated(cds, email))) return false;
    req.reject({ status: 403, code: 'user_deactivated', message: `User ${email} is deactivated; no credentials can be created or enabled` });
    return true;
  }

  /**
   * Initialize usage event processor for tracking gateway usage
   */
  private async initializeUsageProcessor(): Promise<void> {
    try {
      logger.info('AdminService', 'Initializing usage event processor');
      await usageEventProcessor.initialize();
      logger.info('AdminService', 'Usage event processor initialized successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize usage event processor: ${errorMsg}`);
      // Don't throw - usage tracking is not critical for admin service functionality
    }
  }

  /**
   * Initialize cache invalidation service
   */
  private async initializeCacheInvalidation(): Promise<void> {
    try {
      logger.info('AdminService', 'Initializing cache invalidation service');
      await cacheInvalidationService.initialize();
      logger.info('AdminService', 'Cache invalidation service initialized successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize cache invalidation service: ${errorMsg}`);
      // Don't throw - cache invalidation is not critical for admin service functionality
    }
  }

  /** Valkey client for quota documents, first publication of every user, and the rollover timer. */
  private async initializeQuotaPublisher(): Promise<void> {
    try {
      await quotaStateStore.initialize();
      startRolloverTimer();
      // Users are backfilled in initializeUsers (awaited at the end of init); publish once it is done.
      setTimeout(() => this.publishQuotaDocuments(1), 5000).unref?.();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize quota publisher: ${errorMsg}`);
    }
  }

  /**
   * Rebuilds the usage buckets if empty, then republishes every quota document. A rejected
   * rebuild (or publish) leaves quota documents unwritten rather than publishing zero-usage
   * ones — a wrong zero would silently lift every quota, where a missing document instead fails
   * open with the gateway's `quota_unenforced` signal. Retried once, 60 s later.
   */
  private async publishQuotaDocuments(attempt: number): Promise<void> {
    try {
      const db = await cds.connect.to('db');
      const did = await rebuildIfEmpty(db);
      if (did) logger.info('AdminService', 'Usage buckets built from the usage rows (first start with counters)');
      const n = await republishAll();
      logger.info('AdminService', `Published ${n} quota documents`);
    } catch (e: any) {
      logger.warn('AdminService', `Usage buckets could not be built (${e?.message ?? e}); quota documents not published — quotas stay unenforced until rebuildUsageCounters or the next usage batch`);
      if (attempt === 1) setTimeout(() => this.publishQuotaDocuments(2), 60_000).unref?.();
    }
  }

  private async initializeSecurityEventSubscriber(): Promise<void> {
    try {
      logger.info('AdminService', 'Initializing security event subscriber');
      const subscriberStatus = securityEventSubscriber.getStatus();
      logger.info('AdminService', 'Security event subscriber status:', subscriberStatus);
      logger.info('AdminService', 'Security event subscriber initialized successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize security event subscriber: ${errorMsg}`);
      // Don't throw - security event subscription is not critical for admin service functionality
    }
  }

  private async initializeCostRecalculation(): Promise<void> {
    try {
      logger.info('AdminService', 'Initializing cost recalculation service');
      await costRecalculationService.initialize();
      logger.info('AdminService', 'Cost recalculation service initialized');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize cost recalculation: ${errorMsg}`);
      // Don't throw - cost recalculation is not critical for admin service functionality
    }
  }

  /**
   * Seed SapCapacityUnitPrice (CU -> currency, per usage type + temporal) on boot. Idempotent:
   * seedSapCapacityUnitPrice skips rows that already exist for a given usageType+dateFrom.
   */
  private async initializeSapCapacityUnitPrice(): Promise<void> {
    try {
      logger.info('AdminService', 'Seeding SAP capacity unit price');
      const db = await cds.connect.to('db');
      const inserted = await seedSapCapacityUnitPrice(db);
      logger.info('AdminService', `SapCapacityUnitPrice seeded ${inserted} rows`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to seed SAP capacity unit price: ${errorMsg}`);
      // Don't throw - SAP capacity unit price seeding is not critical for admin service functionality
    }
  }

  /**
   * Flag credentials that predate the expiration feature (no expiresAt) as never-expiring, so the
   * grandfathering is a stored, admin-visible property instead of an implicit null. Idempotent.
   */
  private async initializeNeverExpiresBackfill(): Promise<void> {
    try {
      const db = await cds.connect.to('db');
      const updated = await backfillNeverExpires(db);
      logger.info('AdminService', `neverExpires backfill flagged ${updated} legacy credential rows`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to backfill neverExpires: ${errorMsg}`);
      // Don't throw - the backfill is a one-off migration, not critical for serving requests
    }
  }

  /**
   * Users backfill (one row per known e-mail) and the one-shot ModelCatalogAssignments migration.
   * Both idempotent; never throws — an empty Users table only delays quotas until the first contact.
   */
  private async initializeUsers(): Promise<void> {
    try {
      const db = await cds.connect.to('db');
      const created = await backfillUsers(db);
      const migrated = await migrateCatalogAssignments(db);
      logger.info('AdminService', `Users backfill created ${created} rows; migrated ${migrated} catalog assignments`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize users: ${errorMsg}`);
    }
  }

  /**
   * Copy the request context of the source event into envelope rows that predate the context
   * columns, once. Idempotent; never throws.
   */
  private async initializeNotificationContextBackfill(): Promise<void> {
    try {
      const db = await cds.connect.to('db');
      const updated = await backfillNotificationContext(db);
      logger.info('AdminService', `Security notification context backfill filled ${updated} rows`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to backfill security notification context: ${errorMsg}`);
    }
  }

  /**
   * Guarantee the default entitlement catalog exists, so every unassigned caller resolves to
   * it on the first request. Idempotent; never throws.
   */
  private async initializeModelLibrary(): Promise<void> {
    await initializeModelLibrary();
  }

  /**
   * Starts the SIEM delivery dispatcher (siem/dispatcher.ts) against the sinks named in
   * the active configuration (ApiConfigurations.configData, simplified-api-config.cds:10-30),
   * read the same way getSiemDispatchConfig in securityEventSubscriber.ts reads it. The
   * decision to start at all, and the construction of each sink, is delegated to
   * resolveSiemDispatch (siem/siemConfigResolver.ts) — it returns null and this starts no
   * timers at all unless siem.enabled is true and at least one sink is both individually
   * enabled and passes validateConfig(); a misconfigured sink is skipped and logged there,
   * not allowed to stop the others. Never throws: SIEM forwarding is not critical for
   * admin service startup.
   */
  private async initializeSiemDispatcher(): Promise<void> {
    try {
      logger.info('AdminService', 'Initializing SIEM dispatcher');

      const cds = require('@sap/cds');
      const { SELECT } = cds.ql;
      const rows = await SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ isActive: true })
        .orderBy('version desc')
        .limit(1);

      if (!rows || rows.length === 0) {
        logger.info('AdminService', 'SIEM dispatcher not started: no active configuration found');
        return;
      }

      // Starts the live secret resolver and registers its handle (secretResolverHandle.ts)
      // before any sink is built, and refreshes it once synchronously first, so a sink whose
      // credential IS stored is not wrongly dropped below for "no credential stored" against
      // an empty, not-yet-refreshed snapshot. Without this, every sink's resolveSecret
      // (sink.ts) always returns undefined and the credential store this task built is dead
      // code in production - see setSiemCredential/deleteSiemCredential's immediate-refresh
      // call, which only does anything once this handle exists.
      //
      // Pinned to rows[0].ID - the very configuration whose configData builds the sinks below -
      // rather than letting the resolver re-select the active configuration on each refresh.
      // The sinks are built once here and never rebuilt, so a resolver that followed
      // activation would hand a running sink another configuration's credentials; see
      // createSecretResolver's doc comment.
      const secretResolver = await startSecretResolver(rows[0].ID);

      const configData = JSON.parse(rows[0].configData || '{}');
      const resolved = resolveSiemDispatch(configData?.api_config?.observability?.siem, secretResolver.resolve);

      for (const warning of resolved?.warnings ?? []) {
        logger.warn('AdminService', `SIEM dispatcher: ${warning}`);
      }

      if (!resolved) {
        logger.info('AdminService', 'SIEM dispatcher not started: siem.enabled is false, or no sink is both enabled and valid');
        // No dispatcher means nothing will ever call resolve() again - a resolver with no
        // consumer must not keep polling the DB every 60s for the life of the process.
        stopSecretResolver();
        return;
      }

      // Handed to dispatcherHandle.ts (not stored on `this`) so index.ts's gracefulShutdown
      // can stop it without requiring this module — see that file's doc comment for why.
      setSiemDispatcherHandle(startDispatcher(resolved.sinks, resolved.dispatcherConfig));

      logger.info('AdminService', 'SIEM dispatcher started', { sinks: resolved.sinks.map(s => s.name) });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to initialize SIEM dispatcher: ${errorMsg}`);
      // Don't throw - SIEM forwarding is not critical for admin service functionality. Also
      // tears down the resolver (a no-op if it was never started) so a failure partway
      // through this method never leaves an orphaned timer behind.
      stopSecretResolver();
    }
  }

  /**
   * Reports orphaned SIEM credentials at startup - never sweeps them away. A credential value
   * can never be read back (credentialSweep.ts), so deleting one is irreversible and must stay
   * an explicit, confirmed operator action (deleteOrphanedSiemCredentials), never something
   * that runs unattended on every restart. This only makes orphans visible: a count and their
   * slot names at `warn`, never a value. Never throws - a sweep must never prevent the admin
   * service from starting.
   */
  private async initializeCredentialSweepReport(): Promise<void> {
    try {
      const orphans = await findOrphanedCredentials();
      if (orphans.length > 0) {
        logger.warn('AdminService', `${orphans.length} orphaned SIEM credential(s) found`, {
          names: orphans.map(o => o.name),
        });
      } else {
        logger.info('AdminService', 'No orphaned SIEM credentials found');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('AdminService', `Failed to run orphaned SIEM credential sweep: ${errorMsg}`);
    }
  }

  /**
   * Process usage events from gateway (for when Redis is not available)
   * Called by gateway service to send usage events directly
   */
  async processUsageEvents(req: AdminRequest): Promise<{ processed: number; status: string }> {
    try {
      const events = req.data.events || req.data; // Handle both direct array and named parameter
      
      if (!Array.isArray(events)) {
        throw new Error('Events data must be an array');
      }

      await usageEventProcessor.processMemoryQueue(events);
      
      logger.info('AdminService', `Processed ${events.length} usage events from gateway`);
      
      return {
        processed: events.length,
        status: 'success'
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to process usage events: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Legacy recordUsage endpoint for backward compatibility
   * Converts single usage record to event format and forwards to processUsageEvents
   */
  async recordUsage(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    try {
      const { credentialId, endpoint, method, timestamp } = req.data;
      
      if (!credentialId) {
        throw new Error('credentialId is required');
      }

      // Convert legacy format to event format
      const event = {
        requestId: crypto.randomUUID(),
        timestamp: timestamp ? new Date(timestamp).getTime() : Date.now(),
        authType: 'aws_credential', // Assume AWS credential for legacy calls
        credentialId,
        provider: 'unknown',
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        responseTime: 0,
        statusCode: 200,
        endpoint: endpoint || '/legacy'
      };

      // Forward to processUsageEvents
      await this.processUsageEvents({ data: { events: [event] } } as AdminRequest);
      
      logger.debug('AdminService', 'Legacy recordUsage processed successfully', { credentialId });
      
      return {
        success: true,
        message: 'Usage recorded successfully'
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to record usage: ${errorMsg}`);
      return {
        success: false,
        message: errorMsg
      };
    }
  }

  /**
   * Called by gateway service to send security events directly
   */
  async processSecurityEvents(req: AdminRequest): Promise<{ processed: number; status: string }> {
    try {
      const { events, batchId, count } = req.data;
      
      if (!events || !Array.isArray(events)) {
        throw new Error('Events array is required');
      }

      logger.info('AdminService', `Processing ${events.length} security events from gateway (batch: ${batchId || 'unknown'})`);
      
      // Import SecurityEventService to persist events
      const { SecurityEventService } = await import('../services/securityEventService');
      
      let processedCount = 0;
      
      for (const event of events) {
        try {
          // Process security event based on auth type
          if (event.authType === 'aws_credential') {
            await SecurityEventService.createAwsSecurityEvent({
              credentialId: event.credentialId,
              eventType: event.eventType,
              severity: event.severity,
              description: event.description,
              clientIP: event.clientIP,
              userAgent: event.userAgent,
              endpoint: event.endpoint,
              requestId: event.requestId,
              actionTaken: event.actionTaken,
              autoBlocked: event.autoBlocked
            });
          } else if (event.authType === 'api_key') {
            await SecurityEventService.createApiKeySecurityEvent({
              keyId: event.credentialId,
              eventType: event.eventType,
              severity: event.severity,
              description: event.description,
              clientIP: event.clientIP,
              userAgent: event.userAgent,
              endpoint: event.endpoint,
              requestId: event.requestId,
              actionTaken: event.actionTaken,
              autoBlocked: event.autoBlocked
            });
          }
          
          processedCount++;
        } catch (error) {
          logger.warn('AdminService', `Failed to process security event ${event.eventId}:`, 
            error instanceof Error ? error.message : 'Unknown error');
        }
      }
      
      logger.info('AdminService', `Successfully processed ${processedCount}/${events.length} security events`);
      
      return {
        processed: processedCount,
        status: 'completed'
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to process security events: ${errorMsg}`);
      throw error;
    }
  }

  // ========================================
  // Cache Invalidation Management
  // ========================================

  /**
   * Manually invalidate cache for specific credentials
   */
  async invalidateCache(req: AdminRequest): Promise<{ 
    success: boolean; 
    message: string; 
    invalidated: number;
  }> {
    try {
      const { credentialId, authType, reason } = req.data;
      
      if (!credentialId || !authType) {
        throw new Error('credentialId and authType are required');
      }
      
      if (!['api_key', 'aws_credential'].includes(authType)) {
        throw new Error('authType must be either "api_key" or "aws_credential"');
      }
      
      const requestId = `manual-${Date.now()}`;
      let actualKey = credentialId;
      
      if (authType === 'api_key') {
        await cacheInvalidationService.invalidateApiKey(credentialId, 'manual', requestId);
      } else {
        // For AWS credentials, we need to handle both UUID and accessKeyId
        let accessKeyId = credentialId;
        
        // If credentialId looks like a UUID, try to get the accessKeyId
        if (credentialId.length === 36 && credentialId.includes('-')) {
          const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
            .columns('accessKeyId')
            .where({ ID: credentialId });
          
          const result = await cds.run(SELECT);
          if (result.length > 0) {
            accessKeyId = result[0].accessKeyId;
            logger.info('AdminService', `Resolved credential UUID to accessKeyId for cache invalidation`, {
              credentialUUID: credentialId,
              accessKeyId
            });
          }
        }
        
        actualKey = accessKeyId;
        await cacheInvalidationService.invalidateAwsCredential(accessKeyId, 'manual', requestId);
      }
      
      logger.info('AdminService', `Manual cache invalidation: ${authType}`, {
        originalCredentialId: credentialId,
        actualKeyUsed: actualKey,
        reason: reason || 'Manual request',
        requestId
      });
      
      return {
        success: true,
        message: `Cache invalidated for ${authType}: ${actualKey}`,
        invalidated: 1
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to invalidate cache: ${errorMsg}`);
      
      return {
        success: false,
        message: `Cache invalidation failed: ${errorMsg}`,
        invalidated: 0
      };
    }
  }

  /**
   * Clear cache entries matching a pattern
   */
  async clearCachePattern(req: AdminRequest): Promise<{ 
    success: boolean; 
    message: string; 
    cleared: number;
  }> {
    try {
      const { pattern, reason } = req.data;
      
      if (!pattern) {
        throw new Error('pattern is required');
      }
      
      const cleared = await cacheInvalidationService.clearCachePattern(pattern);
      
      logger.info('AdminService', `Manual cache pattern clear: ${pattern}`, {
        reason: reason || 'Manual request',
        cleared
      });
      
      return {
        success: true,
        message: `Cleared ${cleared} cache entries matching pattern: ${pattern}`,
        cleared
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to clear cache pattern: ${errorMsg}`);
      
      return {
        success: false,
        message: `Cache pattern clear failed: ${errorMsg}`,
        cleared: 0
      };
    }
  }

  // ========================================
  // Security Event Management
  // ========================================

  /**
   * Log a security event (called by gateway service)
   */
  async logSecurityEvent(req: AdminRequest): Promise<{ success: boolean; message: string }> {
    try {
      const { 
        credentialId, 
        authType, 
        eventType, 
        severity, 
        description, 
        clientIP, 
        userAgent, 
        endpoint, 
        requestId, 
        actionTaken 
      } = req.data;

      if (!credentialId || !authType || !eventType || !severity || !description) {
        return {
          success: false,
          message: 'Missing required fields: credentialId, authType, eventType, severity, description'
        };
      }

      if (!['api_key', 'aws_credentials'].includes(authType)) {
        return {
          success: false,
          message: 'authType must be either "api_key" or "aws_credentials"'
        };
      }

      if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
        return {
          success: false,
          message: 'severity must be one of: low, medium, high, critical'
        };
      }

      // The subset of the gateway's SecurityEventType (types/security.ts) that the gateway
      // actually emits over this action. It does not list every member of that enum, so a new
      // gateway event type has to be added here as well or it is rejected as invalid.
      // 'rate_limit_exceeded' is no longer in the gateway's enum (Task 6 replaced it with
      // quota_exceeded) but stays here: it is still accepted for already-stored rows and for
      // older gateway builds still running it, and SecurityEventService.logRateLimitExceeded
      // still constructs it directly.
      const validEventTypes = ['failed_auth', 'rate_limit_exceeded', 'credential_rotation', 'model_not_entitled', 'deployment_created', 'quota_exceeded', 'quota_unenforced'];
      if (!validEventTypes.includes(eventType)) {
        return {
          success: false,
          message: `eventType must be one of: ${validEventTypes.join(', ')}`
        };
      }

      // Create the security event based on auth type
      if (authType === 'aws_credentials') {
        await SecurityEventService.createAwsSecurityEvent({
          credentialId,
          eventType: eventType as any,
          severity: severity as any,
          description,
          clientIP,
          userAgent,
          endpoint,
          requestId,
          actionTaken: actionTaken || 'logged'
        });
      } else {
        await SecurityEventService.createApiKeySecurityEvent({
          keyId: credentialId,
          eventType: eventType as any,
          severity: severity as any,
          description,
          clientIP,
          userAgent,
          endpoint,
          requestId,
          actionTaken: actionTaken || 'logged'
        });
      }

      return {
        success: true,
        message: 'Security event logged successfully'
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to log security event: ${errorMsg}`);
      
      return {
        success: false,
        message: `Failed to log security event: ${errorMsg}`
      };
    }
  }

  /**
   * Prefill a NEW ApiKeys draft so the create form shows Expires At up front instead of an empty
   * field. Only fills what the client did not send. Field control (isActiveFC/expiresAtFC/
   * neverExpiresFC) comes from afterReadLifecycleFieldControl, which also runs on the draft row
   * this POST returns.
   */
  async beforeNewApiKey(req: any): Promise<void> {
    const isAdmin = req.user?.is ? req.user.is('admin') : false;
    const userEmail = this.getUserEmail(req);
    req.data = req.data || {};

    // Safe to prefill with ??=: beforeCreateApiKey re-derives and hard-locks identity and
    // expiresAt on activation, so a value the client sent here cannot smuggle anything through.
    req.data.expiresAt ??= defaultExpiresAt().toISOString();
    req.data.neverExpires ??= false;
    req.data.isActive ??= true;
    req.data.usageCount ??= 0;
    // Non-admins only ever own their own keys, so the form starts on them.
    if (!isAdmin) {
      req.data.email ??= userEmail;
    }

    logger.debug('AdminService', `NEW ApiKey draft prefilled for user ${userEmail}`, {
      isAdmin,
      defaultEmail: req.data.email,
      defaultExpiresAt: req.data.expiresAt
    });
  }

  /**
   * Guarantee afterReadLifecycleFieldControl sees row.neverExpires regardless of the client's
   * $select. expiresAtFC is derived from row.neverExpires (see below), so a narrow $select that
   * asks for an FC virtual but not neverExpires - such as the SideEffects re-read Fiori Elements
   * issues after toggling Never Expires in a draft - would otherwise compute expiresAtFC from an
   * undefined value and leave a never-expiring row's date field editable.
   */
  async beforeReadLifecycleFieldControl(req: any): Promise<void> {
    const columns = req.query?.SELECT?.columns;
    if (!Array.isArray(columns)) return; // no explicit column list (e.g. $select=*) - neverExpires already loads

    const fcVirtuals = ['isActiveFC', 'expiresAtFC', 'neverExpiresFC'];
    const columnNames = columns.map((col: any) => col?.ref?.[col.ref.length - 1]);
    const selectsFC = fcVirtuals.some(name => columnNames.includes(name));
    if (selectsFC && !columnNames.includes('neverExpires')) {
      columns.push({ ref: ['neverExpires'] });
    }
  }

  /**
   * Lifecycle fields are admin-only: expose them editable to administrators and read-only to
   * everyone else so the apps never provoke the before-UPDATE 403.
   *
   * Expires At is per-row rather than per-role, because a never-expiring credential stores no
   * date: leaving the AWS field at 7 (Mandatory) would leave the object page demanding a value
   * the flag is precisely there to suppress, so a flagged row shows the date read-only instead.
   */
  async afterReadLifecycleFieldControl(results: any, req: any): Promise<void> {
    if (!results) return;
    const isAdmin = this.isAdmin(this.getUserRoles(req));
    const isAws = String(req.target?.name || '').includes('AwsCredentials');
    const isActiveFC = isAdmin ? 3 : 1;
    const editableExpiresAtFC = isAdmin ? (isAws ? 7 : 3) : 1; // AWS expiration stays mandatory for admins
    const neverExpiresFC = isAdmin ? 3 : 1;
    for (const row of Array.isArray(results) ? results : [results]) {
      if (row && typeof row === 'object') {
        row.isActiveFC = isActiveFC;
        row.expiresAtFC = row.neverExpires === true ? 1 : editableExpiresAtFC;
        row.neverExpiresFC = neverExpiresFC;
      }
    }
  }

  /**
   * CREATE handler for ApiKeys - enforce role policy
   */
  async beforeCreateApiKey(req: any): Promise<void> {
    const isAdmin = req.user?.is ? req.user.is('admin') : false;
    const userEmail = this.getUserEmail(req);

    // Enforce role policy: non-admins must create keys for themselves only
    if (!isAdmin) {
      req.data.email = userEmail;  // lock to self
    }

    if (await this.rejectIfDeactivated(req, req.data.email)) return;

    // Set defaults
    req.data.isActive ??= true;

    // Expiration is admin-managed: owners get the configured default, admins may pre-set a date
    // or flag the key as never-expiring. Only an administrator may set the flag, so a non-admin's
    // value is forced to false here rather than refused - the same shape as the email lock above.
    const wantsNeverExpires = isAdmin && req.data.neverExpires === true;
    // The past-date guard intentionally runs before the isAdmin branch in creationExpiresAt below:
    // a non-admin's requested value is discarded there regardless, so checking it here first is
    // just an early, clearer 400 rather than a reordering of who owns the decision. A key that
    // will never expire carries no date, so there is nothing to validate.
    if (!wantsNeverExpires && expiresAtInPast(req.data.expiresAt)) {
      req.error(400, 'Expires At must be in the future');
      return;
    }
    const lifecycle = normalizeLifecycle({
      neverExpires: wantsNeverExpires,
      expiresAt: creationExpiresAt({
        isAdmin,
        requested: req.data.expiresAt,
        fallback: defaultExpiresAt()
      })
    });
    req.data.neverExpires = lifecycle.neverExpires;
    req.data.expiresAt = lifecycle.expiresAt === null ? null : new Date(lifecycle.expiresAt).toISOString();

    // Generate API key if not provided
    if (!req.data.key) {
      req.data.key = 'sk-' + crypto.randomBytes(32).toString('hex');
    }

    // Strip virtual fields before persistence (they shouldn't be saved to DB)
    const virtualFields = ['maskedKey', 'statusCriticality', 'emailFC', 'keyFC', 'isActiveFC', 'expiresAtFC', 'neverExpiresFC'];
    virtualFields.forEach(field => {
      if (field in req.data) {
        delete req.data[field];
      }
    });

    logger.info('AdminService', `CREATE ApiKey enforced for user ${userEmail}`, {
      isAdmin,
      finalEmail: req.data.email,
      isOwnKey: req.data.email === userEmail,
      generatedKey: !!req.data.key
    });
  }

  /**
   * Force CREATE operations to use base table instead of service view
   * This handles cases where CAP doesn't redirect due to lean-draft issues
   */
  async onCreateApiKey(req: any): Promise<any> {
    const tx = cds.transaction(req);
    const data = { ...req.data };
    const dbName = 'sap.llm.gateway.admin.ApiKeys';

    // Ensure ID is set and let CAP handle managed fields properly
    data.ID ??= cds.utils.uuid();
    
    // Set managed fields explicitly since we're bypassing CAP's automatic handling
    const now = new Date().toISOString();
    const user = req.user?.id || 'system';
    data.createdAt = now;
    data.createdBy = user;
    data.modifiedAt = now;
    data.modifiedBy = user;

    // Strip virtual/computed fields that might come from FE, but keep maskedKey (computed by handler)
    delete (data as any).statusCriticality;
    delete (data as any).emailFC;
    delete (data as any).keyFC;
    delete (data as any).isActiveFC;
    delete (data as any).expiresAtFC;
    delete (data as any).neverExpiresFC;

    // Ensure maskedKey is computed if we have a key
    if (data.key && !data.maskedKey) {
      data.maskedKey = maskApiKey(data.key);
    }

    logger.info('AdminService', `Forcing CREATE to base table: ${dbName}`, {
      id: data.ID,
      email: data.email,
      hasKey: !!data.key
    });

    await tx.run(INSERT.into(dbName).entries(data));

    // Return the created row via service read (maintains authorization)
    return tx.run(SELECT.one.from('AdminService.ApiKeys').where({ ID: data.ID }));
  }

  /**
   * Force UPDATE operations to use base table instead of service view
   * This handles cases where CAP doesn't redirect due to lean-draft issues
   */
  async onUpdateApiKey(req: any): Promise<any> {
    const tx = cds.transaction(req);
    const { ID, ...rest } = req.data || {};
    const dbName = 'sap.llm.gateway.admin.ApiKeys';
    
    if (!ID) {
      req.error(400, 'ID is required for UPDATE');
      return;
    }

    // Strip non-updatable and virtual fields, but handle managed fields properly
    const drop = new Set([
      'key', 'createdAt', 'createdBy', // Never allow these to be updated
      'maskedKey', 'statusCriticality', 'emailFC', 'keyFC', 'isActiveFC', 'expiresAtFC', 'neverExpiresFC' // Virtual fields
    ]);
    
    for (const k of Object.keys(rest)) {
      if (drop.has(k)) delete (rest as any)[k];
    }

    // Set modifiedAt/modifiedBy explicitly since we're bypassing CAP
    if (Object.keys(rest).length > 0) {
      rest.modifiedAt = new Date().toISOString();
      rest.modifiedBy = req.user?.id || 'system';
    }

    if (!Object.keys(rest).length) {
      logger.info('AdminService', `UPDATE had no valid fields after filtering`, { id: ID });
      return { ID }; // Nothing left to persist
    }

    logger.info('AdminService', `Forcing UPDATE to base table: ${dbName}`, {
      id: ID,
      fields: Object.keys(rest)
    });

    await tx.run(UPDATE(dbName).set(rest).where({ ID }));

    // Return the updated row via service read (maintains authorization)
    return tx.run(SELECT.one.from('AdminService.ApiKeys').where({ ID }));
  }

  /**
   * Force CREATE/UPDATE/DELETE to the base table instead of the service view - same
   * "cannot modify <entity> because it is a view" issue as ApiKeys/AwsCredentials above,
   * hit here even though SapCapacityUnitPrice is a draft-enabled projection.
   */
  async onCreateSapCapacityUnitPrice(req: any): Promise<any> {
    return this.onCreateViaBaseTable(req, 'sap.llm.gateway.admin.SapCapacityUnitPrice', 'AdminService.SapCapacityUnitPrice');
  }

  async onUpdateSapCapacityUnitPrice(req: any): Promise<any> {
    return this.onUpdateViaBaseTable(req, 'sap.llm.gateway.admin.SapCapacityUnitPrice', 'AdminService.SapCapacityUnitPrice');
  }

  async onDeleteSapCapacityUnitPrice(req: any): Promise<any> {
    const tx = cds.transaction(req);
    const dbName = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
    const END_OF_TIME = '9999-12-31T23:59:59.999Z';
    const ID = req.params?.[0]?.ID || req.data?.ID;

    // Capture the row before it is deleted so the temporal chain can be healed.
    const [deleted] = ID
      ? await tx.run(SELECT.from(dbName).columns('usageType', 'dateFrom', 'dateTo').where({ ID }))
      : [];

    const result = await this.onDeleteViaBaseTable(req, dbName);

    // Deleting the current (open) row would leave its usage type with no active price. Re-extend
    // the immediately-preceding row back to the end of time so the chain stays open - the inverse
    // of the create-time auto-delimit (beforeCreateSapCapacityUnitPrice). Only fires when the
    // deleted row was the open one; deleting a historical row is left untouched.
    if (deleted && deleted.usageType && deleted.dateFrom && String(deleted.dateTo).startsWith('9999-12-31')) {
      const predecessors = await tx.run(
        SELECT.from(dbName).columns('ID')
          .where('usageType =', deleted.usageType, 'and dateTo <', deleted.dateFrom)
          .orderBy('dateTo desc')
      );
      if (predecessors.length) {
        await tx.run(UPDATE(dbName).set({ dateTo: END_OF_TIME }).where({ ID: predecessors[0].ID }));
      }
    }
    return result;
  }

  /**
   * Prefill a NEW SapCapacityUnitPrice draft's Valid To with the end of time so the create form
   * shows it without manual entry. The CREATE auto-delimit (beforeCreateSapCapacityUnitPrice)
   * forces this same value on activation regardless; this just surfaces it in the draft up front.
   */
  async beforeNewSapCapacityUnitPrice(req: any): Promise<void> {
    const END_OF_TIME = '9999-12-31T23:59:59.999Z';
    req.data = req.data || {};
    if (!req.data.dateTo) {
      req.data.dateTo = END_OF_TIME;
    }
  }

  /**
   * Auto-delimit on CREATE of a SapCapacityUnitPrice (temporal supersession): a new price row
   * always extends to the end of time, and the currently-open row for the same usageType is
   * closed just before the new row starts, so the temporal chain never overlaps and never has a
   * gap. E.g. an open row valid to 9999-12-31 + a new row valid from today => the old row is
   * delimited to (today - 1 instant) and the new row runs today -> 9999-12-31. A row that starts
   * at or after the new row (a future/same-start record) can't be resolved by superseding and is
   * rejected instead - close it manually first.
   */
  async beforeCreateSapCapacityUnitPrice(req: any): Promise<void> {
    const tx = cds.transaction(req);
    const dbName = 'sap.llm.gateway.admin.SapCapacityUnitPrice';
    const END_OF_TIME = '9999-12-31T23:59:59.999Z';
    const data = req.data || {};
    const usageType = data.usageType;
    const fromRaw = data.dateFrom;
    if (!usageType || !fromRaw) {
      return; // missing mandatory fields are CAP's not-null concern
    }
    const from = new Date(fromRaw).getTime();
    if (isNaN(from)) {
      return; // malformed timestamp is a separate validation concern
    }

    // A new price row always runs to the end of time; its predecessor is auto-delimited.
    data.dateTo = END_OF_TIME;

    const rows = await tx.run(
      SELECT.from(dbName).columns('ID', 'dateFrom', 'dateTo').where('usageType =', usageType)
    );
    const delimitTo = new Date(from - 1).toISOString(); // the instant just before the new row starts
    const now = new Date().toISOString();
    const user = req.user?.id || 'system';

    for (const row of rows || []) {
      const eFrom = new Date(row.dateFrom).getTime();
      if (eFrom >= from) {
        req.error(409, `A price for usage type "${usageType}" already starts at or after ${fromRaw} (${row.dateFrom}); close or remove it before inserting an earlier record.`);
        return;
      }
      if (new Date(row.dateTo).getTime() >= from) {
        // The predecessor is still open at/after the new start - close it just before it.
        await tx.run(UPDATE(dbName).set({ dateTo: delimitTo, modifiedAt: now, modifiedBy: user }).where({ ID: row.ID }));
      }
    }
  }

  /**
   * Overlap guard for SapCapacityUnitPrice on UPDATE. Keyed on `usageType` to match _lookupPrice,
   * which filters on usageType only (currency/servicePlan/region are not part of the
   * lookup match, so they are not part of this uniqueness check either).
   */
  async beforeWriteSapCapacityUnitPrice(req: any): Promise<void> {
    return this.checkNoValidityOverlap(req, 'sap.llm.gateway.admin.SapCapacityUnitPrice', 'usageType', 'price for usage type');
  }

  /**
   * Shared validity-overlap validator for the two temporal SAP capacity entities.
   *
   * On CREATE req.data holds the full row; on UPDATE (including draft activation) it may
   * hold only the changed fields, so the effective key/dateFrom/dateTo are resolved by
   * overlaying req.data on the persisted row. Two windows overlap when
   * `newFrom < existingTo AND existingFrom < newTo` (strict) - back-to-back periods that
   * share a single boundary (the normal "close out the old row, add a new one"
   * correction) are intentionally allowed. `keyField` is a fixed internal literal, not
   * user input, so interpolating it into the where clause is safe.
   */
  private async checkNoValidityOverlap(req: any, dbName: string, keyField: string, label: string): Promise<void> {
    const tx = cds.transaction(req);
    const incoming = { ...(req.data || {}) };
    const id = incoming.ID ?? req.params?.[0]?.ID;

    // On UPDATE, fill unspecified fields from the persisted row.
    let base: any = {};
    if (id) {
      base = (await tx.run(SELECT.one.from(dbName).where({ ID: id }))) || {};
    }

    const keyValue = incoming[keyField] ?? base[keyField];
    const fromRaw = incoming.dateFrom ?? base.dateFrom;
    const toRaw = incoming.dateTo ?? base.dateTo;

    // Missing mandatory fields are CAP's not-null concern, not ours.
    if (!keyValue || !fromRaw || !toRaw) {
      return;
    }

    const from = new Date(fromRaw).getTime();
    const to = new Date(toRaw).getTime();
    if (isNaN(from) || isNaN(to)) {
      return; // malformed timestamps are a separate validation concern
    }
    if (from >= to) {
      req.error(400, `Valid-from must be before valid-to (got from ${fromRaw} to ${toRaw}).`);
      return;
    }

    // Existing rows sharing the lookup key, excluding self on edit.
    const rows = id
      ? await tx.run(SELECT.from(dbName).columns('ID', 'dateFrom', 'dateTo').where(`${keyField} =`, keyValue, 'and ID <>', id))
      : await tx.run(SELECT.from(dbName).columns('ID', 'dateFrom', 'dateTo').where(`${keyField} =`, keyValue));

    for (const row of rows || []) {
      const eFrom = new Date(row.dateFrom).getTime();
      const eTo = new Date(row.dateTo).getTime();
      if (from < eTo && eFrom < to) {
        req.error(409, `A ${label} "${keyValue}" already exists for an overlapping validity period (${row.dateFrom} to ${row.dateTo}).`);
        return;
      }
    }
  }

  /**
   * Shared CREATE-via-base-table implementation for the two SAP capacity entities above.
   */
  private async onCreateViaBaseTable(req: any, dbName: string, serviceEntity: string): Promise<any> {
    const tx = cds.transaction(req);
    const data = { ...req.data };

    data.ID ??= cds.utils.uuid();

    const now = new Date().toISOString();
    const user = req.user?.id || 'system';
    data.createdAt = now;
    data.createdBy = user;
    data.modifiedAt = now;
    data.modifiedBy = user;

    logger.info('AdminService', `Forcing CREATE to base table: ${dbName}`, { id: data.ID });

    await tx.run(INSERT.into(dbName).entries(data));

    // Return the created row via service read (maintains authorization)
    return tx.run(SELECT.one.from(serviceEntity).where({ ID: data.ID }));
  }

  /**
   * Shared UPDATE-via-base-table implementation for the two SAP capacity entities above.
   */
  private async onUpdateViaBaseTable(req: any, dbName: string, serviceEntity: string): Promise<any> {
    const tx = cds.transaction(req);
    const { ID, ...rest } = req.data || {};

    if (!ID) {
      req.error(400, 'ID is required for UPDATE');
      return;
    }

    // createdAt/createdBy are never updatable; modifiedAt/modifiedBy are always ours.
    delete (rest as any).createdAt;
    delete (rest as any).createdBy;
    rest.modifiedAt = new Date().toISOString();
    rest.modifiedBy = req.user?.id || 'system';

    logger.info('AdminService', `Forcing UPDATE to base table: ${dbName}`, {
      id: ID,
      fields: Object.keys(rest)
    });

    await tx.run(UPDATE(dbName).set(rest).where({ ID }));

    // Return the updated row via service read (maintains authorization)
    return tx.run(SELECT.one.from(serviceEntity).where({ ID }));
  }

  /**
   * Shared DELETE-via-base-table implementation for the two SAP capacity entities above.
   */
  private async onDeleteViaBaseTable(req: any, dbName: string): Promise<any> {
    const tx = cds.transaction(req);
    const ID = req.params?.[0]?.ID || req.data?.ID;

    if (!ID) {
      req.error(400, 'ID is required for DELETE');
      return;
    }

    logger.info('AdminService', `Forcing DELETE to base table: ${dbName}`, { id: ID });

    await tx.run(DELETE.from(dbName).where({ ID }));
    return {};
  }

  /**
   * Debug endpoint to check user claims and roles
   */
  async whoami(req: AdminRequest): Promise<{
    user: string;
    roles: string[];
    attr: string;
    isAdmin: boolean;
    isUser: boolean;
    deployTarget: string;
  }> {
    const userRoles = this.getUserRoles(req);
    await touchUser(cds, req.user?.id || '', { roles: userRoles });

    return {
      user: req.user?.id || 'anonymous',
      roles: userRoles,
      attr: JSON.stringify((req.user as any)?.attr || {}),
      isAdmin: this.isAdmin(userRoles),
      isUser: userRoles.includes('user'),
      deployTarget: process.env.DEPLOY_TARGET || 'development'
    };
  }

  /**
   * Populate SecurityNotifications from existing security events
   * Admin-only endpoint for development and backfill scenarios
   */
  async populateSecurityNotifications(req: AdminRequest): Promise<{
    success: boolean;
    message: string;
    notificationsCreated: number;
  }> {
    try {
      // Get count before population
      const beforeCount = await cds.run(
        SELECT.from('sap.llm.gateway.admin.SecurityNotifications').columns('count(*) as total')
      );
      const countBefore = beforeCount[0]?.total || 0;

      // Populate notifications
      await notificationPopulationService.populateFromAllSecurityEvents();

      // Get count after population
      const afterCount = await cds.run(
        SELECT.from('sap.llm.gateway.admin.SecurityNotifications').columns('count(*) as total')
      );
      const countAfter = afterCount[0]?.total || 0;

      const created = countAfter - countBefore;

      logger.info('AdminService', `Security notifications populated successfully`, {
        user: req.user?.id,
        beforeCount: countBefore,
        afterCount: countAfter,
        created
      });

      return {
        success: true,
        message: `Successfully populated ${created} security notifications`,
        notificationsCreated: created
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `Failed to populate security notifications: ${errorMsg}`, error instanceof Error ? error : new Error(errorMsg));

      return {
        success: false,
        message: `Failed to populate security notifications: ${errorMsg}`,
        notificationsCreated: 0
      };
    }
  }

  /**
   * Create SecurityNotification for AWS credential rotation
   */
  private async createNotificationForRotation(rotationId: string, credential: any, success: boolean, rotationType: string): Promise<void> {
    try {
      if (!credential.email) {
        logger.debug('AdminService', `Skipping notification for rotation ${rotationId} - no email on credential`);
        return;
      }

      const severity = success ? 'low' : 'high';
      const eventType = success ? 'credential_rotated' : 'rotation_failed';
      const title = `${rotationType === 'manual' ? 'Manual' : 'Automatic'} rotation ${success ? 'completed' : 'failed'} for ${credential.name}`;
      
      const message = success 
        ? `${rotationType} rotation completed for ${credential.name}. Your AWS credentials have been updated successfully.`
        : `${rotationType} rotation failed for ${credential.name}. Please check the credential configuration and retry.`;

      const notification = {
        ID: uuidv4(),
        type: 'rotation_event',
        sourceEntity: 'AwsCredentialRotations',
        sourceID: rotationId,
        ownerEmail: credential.email,
        title,
        message,
        severity,
        eventType,
        eventDate: new Date(),
        icon: success ? 'sap-icon://key' : 'sap-icon://error',
        actionable: !success,
        actionText: success ? null : 'Retry Rotation',
        actionUrl: `/app/aws-credentials/${credential.ID}`,
        createdAt: new Date(),
        createdBy: 'system'
      };

      await cds.run(
        cds.ql.INSERT.into('sap.llm.gateway.admin.SecurityNotifications').entries(notification)
      );

      logger.debug('AdminService', `Created notification for AWS credential rotation`, {
        rotationId,
        notificationId: notification.ID,
        ownerEmail: credential.email,
        success
      });

    } catch (error) {
      logger.error('AdminService', `Failed to create notification for rotation: ${error instanceof Error ? error.message : error}`, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Compute maskedKey when key field changes
   */
  async computeMaskedKey(req: any): Promise<void> {
    if (req.data?.key) {
      req.data.maskedKey = maskApiKey(req.data.key);
      logger.debug('AdminService', `Computed maskedKey for API key`, {
        hasKey: !!req.data.key,
        maskedLength: req.data.maskedKey?.length
      });
    }
  }

  // ========================================
  // AWS Credentials Draft and CRUD Handlers
  // ========================================

  /**
   * Prefill a NEW AwsCredentials draft, mirroring beforeNewApiKey: the create form opens with the
   * standard expiration and the caller's own identity rather than empty fields.
   */
  async beforeNewAwsCredentials(req: any): Promise<void> {
    const isAdmin = req.user?.is ? req.user.is('admin') : false;
    const userEmail = this.getUserEmail(req);
    req.data = req.data || {};

    // Safe to prefill with ??=: beforeCreateAwsCredentials re-derives and hard-locks identity
    // and expiresAt on activation, so a value the client sent here cannot smuggle anything through.
    req.data.expiresAt ??= defaultExpiresAt().toISOString();
    req.data.neverExpires ??= false;
    req.data.isActive ??= true;
    req.data.usageCount ??= 0;
    req.data.region ??= 'us-east-1';
    req.data.sapAiRegion ??= process.env.SAP_AI_REGION || 'us-east-1';
    if (!isAdmin) {
      req.data.userId ??= userEmail;
      req.data.email ??= userEmail;
    }

    logger.debug('AdminService', `NEW AwsCredentials draft prefilled for user ${userEmail}`, {
      isAdmin,
      defaultUserId: req.data.userId,
      defaultEmail: req.data.email,
      defaultExpiresAt: req.data.expiresAt
    });
  }

  /**
   * CREATE handler for AwsCredentials - enforce role policy and generate credentials
   */
  async beforeCreateAwsCredentials(req: any): Promise<void> {
    const isAdmin = req.user?.is ? req.user.is('admin') : false;
    const userEmail = this.getUserEmail(req);

    // Enforce role policy: non-admins must create credentials for themselves only
    if (!isAdmin) {
      req.data.userId = userEmail;  // lock to self
      req.data.email = userEmail;   // lock email to self
    }

    if (await this.rejectIfDeactivated(req, req.data.email)) return;

    // Validate that userId is not empty
    if (!req.data.userId || req.data.userId.trim() === '') {
      req.error(400, 'User ID is required');
      return;
    }

    // Set defaults
    req.data.isActive ??= true;
    req.data.usageCount ??= 0;
    req.data.region ??= 'us-east-1';
    req.data.sapAiRegion ??= process.env.SAP_AI_REGION || 'us-east-1';
    
    // Expiration is admin-managed: owners get the configured default, admins may pre-set a date
    // or flag the credential as never-expiring (only an administrator, so a non-admin's value is
    // forced to false). The past-date guard intentionally runs before the isAdmin branch in
    // creationExpiresAt below: a non-admin's requested value is discarded there regardless, so
    // checking it here first is just an early, clearer 400 rather than a reordering of who owns
    // the decision. A credential that will never expire carries no date to validate.
    const wantsNeverExpires = isAdmin && req.data.neverExpires === true;
    if (!wantsNeverExpires && expiresAtInPast(req.data.expiresAt)) {
      req.error(400, 'Expires At must be in the future');
      return;
    }
    const lifecycle = normalizeLifecycle({
      neverExpires: wantsNeverExpires,
      expiresAt: creationExpiresAt({
        isAdmin,
        requested: req.data.expiresAt,
        fallback: defaultExpiresAt()
      })
    });
    req.data.neverExpires = lifecycle.neverExpires;
    req.data.expiresAt = lifecycle.expiresAt === null ? null : new Date(lifecycle.expiresAt);

    // Generate AWS credentials if not provided
    if (!req.data.accessKeyId) {
      req.data.accessKeyId = 'AKIA' + crypto.randomBytes(8).toString('hex').toUpperCase();
    }
    if (!req.data.secretAccessKey) {
      const secretAccessKey = crypto.randomBytes(20).toString('hex');
      req.data.secretAccessKey = this.encryptSecret(secretAccessKey);
      
      // Generate salt and hash for signature validation
      const salt = crypto.randomBytes(16).toString('hex');
      const secretHash = crypto.createHmac('sha256', salt).update(secretAccessKey).digest('hex');
      req.data.salt = salt;
      req.data.secretHash = secretHash;
    }

    logger.info('AdminService', `CREATE AwsCredentials enforced for user ${userEmail}`, {
      isAdmin,
      finalUserId: req.data.userId,
      isOwnCredentials: req.data.userId === userEmail,
      generatedAccessKeyId: !!req.data.accessKeyId
    });
  }

  /**
   * Handler for UPDATE operations on active AwsCredentials entities (during draft activation)
   */
  async beforeUpdateAwsCredentialsActive(req: any): Promise<void> {
    logger.info('AdminService', `Active UPDATE handler called for AwsCredentials with fields: [${Object.keys(req.data).join(', ')}]`);
    
    const ID = req.params?.[0]?.ID || req.data?.ID;
    
    if (!ID) {
      req.error(400, 'AWS Credential ID is required');
      return;
    }
    
    // Extract user information
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);

    const STORED = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
      .columns('userId', 'isActive', 'expiresAt', 'neverExpires')
      .where({ ID });
    const storedRows = await cds.run(STORED);
    if (storedRows.length === 0) {
      req.error(404, 'AWS credentials not found');
      return;
    }
    const stored = storedRows[0];

    if (!isAdmin && stored.userId !== userEmail) {
      req.error(403, 'Access denied: You can only update your own AWS credentials');
      return;
    }

    const lifecycleViolation = lifecycleChangeViolation({ isAdmin, data: req.data, stored });
    if (lifecycleViolation) {
      logger.warn('AdminService', `Lifecycle change refused for AWS credentials ${ID}: ${lifecycleViolation} (user: ${userEmail})`);
      req.error(403, `Access denied: ${lifecycleViolation} of AWS credentials`);
      return;
    }

    // An expiration may only be moved forward in time, and the never-expires pair is normalized
    // whenever either half is written (see beforeUpdateApiKeyActive for both rules).
    const willNeverExpire = 'neverExpires' in req.data
      ? req.data.neverExpires === true
      : stored.neverExpires === true;
    if (!willNeverExpire
      && 'expiresAt' in req.data
      && new Date(req.data.expiresAt ?? 0).getTime() !== new Date(stored.expiresAt ?? 0).getTime()
      && expiresAtInPast(req.data.expiresAt)) {
      req.error(400, 'Expires At must be in the future');
      return;
    }

    // Administrators only, and falling back to the stored values - see beforeUpdateApiKeyActive
    // for why both matter on a path that receives the whole row on every draft activation.
    if (isAdmin && ('neverExpires' in req.data || 'expiresAt' in req.data)) {
      const lifecycle = normalizeLifecycle({
        neverExpires: req.data.neverExpires ?? stored.neverExpires,
        expiresAt: 'expiresAt' in req.data ? req.data.expiresAt : stored.expiresAt
      });
      req.data.neverExpires = lifecycle.neverExpires;
      req.data.expiresAt = lifecycle.expiresAt;
    }

    // Role-based field guard: non-admins cannot change userId
    if (!isAdmin && 'userId' in req.data) {
      delete req.data.userId;
      logger.info('AdminService', 'Removed userId field - non-admin users cannot change userId');
    }

    // Block credential updates except via rotate action
    if ('accessKeyId' in req.data || 'secretAccessKey' in req.data) {
      delete req.data.accessKeyId;
      delete req.data.secretAccessKey;
      logger.info('AdminService', 'Removed credential fields - credentials can only be changed via action');
    }
    
    // Strip computed and non-updatable fields
    const NON_UPDATABLE = new Set([
      'accessKeyId', 'secretAccessKey', 'secretHash', 'salt', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
    ]);
    
    const originalFields = Object.keys(req.data);
    for (const fieldName of originalFields) {
      if (NON_UPDATABLE.has(fieldName)) {
        logger.info('AdminService', `Removing non-updatable field from active UPDATE: ${fieldName}`);
        delete req.data[fieldName];
      }
    }
    
    const remainingFields = Object.keys(req.data);
    if (remainingFields.length > 0) {
      logger.info('AdminService', `Proceeding with UPDATE for legitimate fields: [${remainingFields.join(', ')}]`);
    }
    
    // Handle isActive toggle by calling existing enable/disable logic
    if (req.data.isActive !== undefined) {
      logger.info('AdminService', `Processing isActive change for AWS credentials ${ID}`, {
        newValue: req.data.isActive,
        userEmail,
        isAdmin
      });
      
      try {
        // Get current state first
        const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials')
          .columns('isActive', 'userId', 'name', 'email')
          .where({ ID });

        const currentCredential = await cds.run(SELECT);

        if (currentCredential.length === 0) {
          req.error(404, 'AWS credentials not found');
          return;
        }

        const currentState = currentCredential[0].isActive;
        const newState = req.data.isActive;

        if (newState === true && (await this.rejectIfDeactivated(req, currentCredential[0].email))) return;

        // Only process if the state is actually changing
        if (currentState !== newState) {
          if (newState) {
            // Enabling the credentials - call enable logic
            await this.enableAwsCredentialsLogic(ID, req);
          } else {
            // Disabling the credentials - call disable logic  
            await this.disableAwsCredentialsLogic(ID, req);
          }
          
          logger.info('AdminService', `Successfully ${newState ? 'enabled' : 'disabled'} AWS credentials ${ID}`, {
            credentialName: currentCredential[0].name,
            userEmail,
            previousState: currentState,
            newState
          });
          
          // Remove isActive from req.data so CAP doesn't persist it again
          // (our logic already handled the state change)
          delete req.data.isActive;
        } else {
          // No state change, remove from request to avoid unnecessary updates
          delete req.data.isActive;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        logger.error('AdminService', `Failed to process isActive change for AWS credentials ${ID}: ${errorMessage} (User: ${userEmail})`, error instanceof Error ? error : new Error(errorMessage));
        req.error(500, `Failed to ${req.data.isActive ? 'enable' : 'disable'} AWS credentials: ${errorMessage}`);
        return;
      }
    }
  }

  /**
   * Handler for UPDATE operations on draft AwsCredentials entities (light validation only)
   */
  async beforeUpdateAwsCredentialsDraft(req: any): Promise<void> {
    const isAdmin = req.user?.is ? req.user.is('admin') : false;
    const userEmail = this.getUserEmail(req);

    // Role-based field guard: non-admins cannot change userId
    if (!isAdmin && 'userId' in req.data) {
      req.data.userId = userEmail;  // Force to user's email instead of deleting
      logger.info('AdminService', 'Enforced userId to user email for non-admin user');
    }

    // Only administrators change isActive / expiresAt / neverExpires; a non-admin's draft edit of
    // them is dropped so activation carries the stored values and passes the active-entity guard.
    if (!isAdmin) {
      for (const field of ['isActive', 'expiresAt', 'neverExpires']) {
        if (field in req.data) {
          delete req.data[field];
          logger.info('AdminService', `Removed ${field} from draft update - only administrators may change it`);
        }
      }
    } else {
      await this.settleDraftLifecycle(req, 'AdminService.AwsCredentials.drafts');
    }

    // Block credential updates except via rotate action
    if ('accessKeyId' in req.data || 'secretAccessKey' in req.data) {
      delete req.data.accessKeyId;
      delete req.data.secretAccessKey;
      logger.info('AdminService', 'Removed credential fields - credentials can only be changed via action');
    }

    // Only strip the absolutely essential managed fields
    const MANAGED_FIELDS = new Set([
      'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'secretHash', 'salt'
    ]);
    
    const originalFields = Object.keys(req.data);
    const removedFields = [];
    
    for (const fieldName of originalFields) {
      if (MANAGED_FIELDS.has(fieldName)) {
        removedFields.push(fieldName);
        delete req.data[fieldName];
      }
    }
    
    if (removedFields.length > 0) {
      logger.info('AdminService', `Draft update - removed managed fields: [${removedFields.join(', ')}]`);
    }
    
    logger.info('AdminService', `Draft update processed for AwsCredentials`, {
      originalFields,
      removedFields,
      allowedFields: Object.keys(req.data),
      hasIsActiveChange: req.data.isActive !== undefined,
      isAdmin,
      userEmail
    });
  }

  async afterUpdateAwsCredentials(results: any, req: any): Promise<void> {
    const ID = req.params?.[0] || results?.ID;
    
    if (!ID) {
      return;
    }
    
    // Update usage count if this is an activation
    if (req.data?.isActive === true) {
      const INCREMENT = cds.ql.UPDATE('sap.llm.gateway.admin.AwsCredentials')
        .set('usageCount = usageCount + 1')
        .where({ ID });

      await cds.run(INCREMENT);
    }

    // Same as afterUpdateApiKeys: the never-expires flag changes the validation verdict too.
    if (req.data && ('expiresAt' in req.data || 'neverExpires' in req.data)) {
      const credentialId = req.params?.[0]?.ID ?? req.params?.[0] ?? results?.ID;
      const rows = await cds.run(cds.ql.SELECT.from('sap.llm.gateway.admin.AwsCredentials').columns('accessKeyId').where({ ID: credentialId }));
      if (rows.length > 0) {
        try {
          await cacheInvalidationService.invalidateAwsCredential(rows[0].accessKeyId, 'manual', `expires-at-update-${Date.now()}`);
        } catch (error) {
          logger.warn('AdminService', `Failed to invalidate cache after expiresAt change for AWS credentials ${credentialId}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }
  }

  /**
   * Force CREATE operations to use base table instead of service view
   */
  async onCreateAwsCredentials(req: any): Promise<any> {
    const tx = cds.transaction(req);
    const data = { ...req.data };
    const dbName = 'sap.llm.gateway.admin.AwsCredentials';

    // Ensure ID is set
    data.ID ??= cds.utils.uuid();
    
    // Set managed fields explicitly
    const now = new Date().toISOString();
    const user = req.user?.id || 'system';
    data.createdAt = now;
    data.createdBy = user;
    data.modifiedAt = now;
    data.modifiedBy = user;

    // Strip virtual fields before persistence (they shouldn't be saved to DB)
    delete (data as any).isActiveFC;
    delete (data as any).expiresAtFC;
    delete (data as any).neverExpiresFC;

    logger.info('AdminService', `Forcing CREATE to base table: ${dbName}`, {
      id: data.ID,
      userId: data.userId,
      hasAccessKeyId: !!data.accessKeyId
    });

    await tx.run(INSERT.into(dbName).entries(data));

    // Return the created row via service read (maintains authorization)
    return tx.run(SELECT.one.from('AdminService.AwsCredentials').where({ ID: data.ID }));
  }

  /**
   * Force UPDATE operations to use base table instead of service view
   */
  async onUpdateAwsCredentials(req: any): Promise<any> {
    const tx = cds.transaction(req);
    const { ID, ...rest } = req.data || {};
    const dbName = 'sap.llm.gateway.admin.AwsCredentials';
    
    if (!ID) {
      req.error(400, 'ID is required for UPDATE');
      return;
    }

    // Strip non-updatable and virtual fields
    const drop = new Set([
      'accessKeyId', 'secretAccessKey', 'secretHash', 'salt', 'createdAt', 'createdBy',
      'isActiveFC', 'expiresAtFC', 'neverExpiresFC' // Virtual fields
    ]);
    
    for (const k of Object.keys(rest)) {
      if (drop.has(k)) delete (rest as any)[k];
    }

    // Set modifiedAt/modifiedBy explicitly
    if (Object.keys(rest).length > 0) {
      rest.modifiedAt = new Date().toISOString();
      rest.modifiedBy = req.user?.id || 'system';
    }

    if (!Object.keys(rest).length) {
      logger.info('AdminService', `UPDATE had no valid fields after filtering`, { id: ID });
      return { ID }; // Nothing left to persist
    }

    logger.info('AdminService', `Forcing UPDATE to base table: ${dbName}`, {
      id: ID,
      fields: Object.keys(rest)
    });

    await tx.run(UPDATE(dbName).set(rest).where({ ID }));
    
    // Return the updated row via service read (maintains authorization)
    return tx.run(SELECT.one.from('AdminService.AwsCredentials').where({ ID }));
  }

  /**
   * After READ handler for AwsCredentials - decrypt secretAccessKey for display
   */
  async afterReadAwsCredentials(results: any, req: any): Promise<void> {
    if (!results) return;
    
    const credentials = Array.isArray(results) ? results : [results];
    
    for (const credential of credentials) {
      if (credential.secretAccessKey) {
        try {
          // Decrypt the secret access key for display
          const decryptedSecret = this.decryptSecret(credential.secretAccessKey);
          if (decryptedSecret) {
            credential.secretAccessKey = decryptedSecret;
          } else {
            // If decryption fails, show masked value for security
            credential.secretAccessKey = '••••••••••••••••••••••••••••••••••••••••';
          }
        } catch (error) {
          logger.warn('AdminService', `Failed to decrypt secret access key for credential ${credential.ID}:`, error instanceof Error ? error.message : 'Unknown error');
          // Show masked value for security
          credential.secretAccessKey = '••••••••••••••••••••••••••••••••••••••••';
        }
      }
    }
  }

  /**
   * Before READ handler for MySecurityNotifications - filter by ownerEmail for non-admin users,
   * rewrite virtual isSnoozed filters to DB-level conditions, and ensure unseen-by-default behavior
   */
  async beforeReadMySecurityNotifications(req: any): Promise<void> {
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    const isAdmin = this.isAdmin(userRoles);
    
    logger.debug('AdminService', '[beforeReadMySecurityNotifications] Filtering notifications:', {
      userEmail,
      isAdmin,
      existingWhere: req.query?.SELECT?.where
    });
    
    if (!req.query?.SELECT) {
      req.query = { SELECT: {} };
    }
    
    // Get existing WHERE clause as token array
    let where = req.query.SELECT.where ?? [];
    
    // STEP 1: Rewrite virtual filters to DB-level conditions
    // Look for isSnoozed, isSeen, and pinned filters
    let rewrittenWhere = this.rewriteIsSnoozedFilter(where, userEmail);
    rewrittenWhere = this.rewriteIsSeenFilter(rewrittenWhere, userEmail);
    rewrittenWhere = this.rewritePinnedFilter(rewrittenWhere, userEmail);
    where = rewrittenWhere;
    
    // STEP 2: Non-admin users can only see their own notifications
    if (!isAdmin && userEmail) {
      // If there's already a WHERE clause, add AND
      if (where.length) {
        where.push('and');
      }
      
      // Add ownerEmail filter as tokens: ownerEmail = $userEmail
      where.push({ ref: ['ownerEmail'] }, '=', { val: userEmail });
      
      logger.debug('AdminService', '[beforeReadMySecurityNotifications] Added ownerEmail filter for user');
    } else if (isAdmin) {
      logger.debug('AdminService', '[beforeReadMySecurityNotifications] Admin user - no additional email filtering needed');
    }
    
    // STEP 3: Always apply pinned sorting in afterRead for proper grouping
    if (userEmail) {
      if (req.query.SELECT.orderBy) {
        const hasPinnedOrderBy = req.query.SELECT.orderBy.some((item: any) => 
          item && typeof item === 'object' && item.ref && 
          Array.isArray(item.ref) && item.ref[0] === 'pinned'
        );
        
        if (hasPinnedOrderBy) {
          logger.debug('AdminService', '[beforeReadMySecurityNotifications] Found pinned orderBy, will sort in afterRead');
          // Store the original orderBy in the request context for afterRead sorting
          req._originalOrderBy = req.query.SELECT.orderBy;
          // Remove pinned from orderBy to avoid database errors, keep other sorts
          req.query.SELECT.orderBy = req.query.SELECT.orderBy.filter((item: any) => 
            !(item && typeof item === 'object' && item.ref && 
              Array.isArray(item.ref) && item.ref[0] === 'pinned')
          );
        } else {
          // No pinned orderBy found, add default sorting
          logger.debug('AdminService', '[beforeReadMySecurityNotifications] No pinned orderBy found, applying default sorting');
          req._originalOrderBy = [
            { ref: ['pinned'], sort: 'desc' },
            { ref: ['eventDate'], sort: 'desc' }
          ];
        }
      } else {
        // No orderBy at all, apply default pinned sorting
        logger.debug('AdminService', '[beforeReadMySecurityNotifications] No orderBy provided, applying default pinned sorting');
        req._originalOrderBy = [
          { ref: ['pinned'], sort: 'desc' },
          { ref: ['eventDate'], sort: 'desc' }
        ];
      }
    }
    
    // STEP 4: Ensure proper server-side filtering for unseen notifications
    // The OData filter (seenAt EQ null) should be sufficient, but we can add additional validation here if needed
    
    // Set the final WHERE clause; skip when empty (admin, no $filter) so a following $search
    // isn't AND-combined against an empty group — SQLite rejects "WHERE () and (...)".
    if (where.length) {
      req.query.SELECT.where = where;
    }

    logger.debug('AdminService', '[beforeReadMySecurityNotifications] Final WHERE clause:', {
      whereTokens: where.length,
      query: JSON.stringify(where)
    });
  }
  
  /**
   * Rewrite virtual isSeen filter to DB-level condition
   * Maps: isSeen = false → NOT EXISTS(user state with seenAt)
   * Maps: isSeen = true → EXISTS(user state with seenAt)
   */
  private rewriteIsSeenFilter(where: any[], userEmail: string): any[] {
    if (!where || !userEmail) return where;
    
    const newWhere = [];
    let i = 0;
    
    while (i < where.length) {
      const token = where[i];
      
      // Look for pattern: {ref: ['isSeen']}, '=', {val: boolean}
      if (token && typeof token === 'object' && token.ref && 
          Array.isArray(token.ref) && token.ref[0] === 'isSeen' &&
          i + 2 < where.length && where[i + 1] === '=' && 
          where[i + 2] && typeof where[i + 2] === 'object' && 'val' in where[i + 2]) {
        
        const isSeenValue = where[i + 2].val;
        
        logger.debug('AdminService', `[rewriteIsSeenFilter] Rewriting isSeen = ${isSeenValue} to DB condition`);
        
        if (isSeenValue === false) {
          // isSeen = false → show notifications that are NOT seen
          // This means: notifications that either have no user state OR have user state with seenAt IS NULL
          newWhere.push(
            '(', 
            'ID', 'not', 'in', {
              SELECT: {
                from: { ref: ['sap.llm.gateway.admin.SecurityNotificationUserState'] },
                columns: [{ ref: ['notification_ID'] }],
                where: [
                  { ref: ['email'] }, '=', { val: userEmail }, 'and',
                  { ref: ['seenAt'] }, 'is', 'not', 'null'
                ]
              }
            },
            ')'
          );
        } else {
          // isSeen = true → show only seen notifications
          newWhere.push(
            'ID', 'in', {
              SELECT: {
                from: { ref: ['sap.llm.gateway.admin.SecurityNotificationUserState'] },
                columns: [{ ref: ['notification_ID'] }],
                where: [
                  { ref: ['email'] }, '=', { val: userEmail }, 'and',
                  { ref: ['seenAt'] }, 'is', 'not', 'null'
                ]
              }
            }
          );
        }
        
        // Skip the next 2 tokens (operator and value)
        i += 3;
      } else {
        // Keep other tokens as-is
        newWhere.push(token);
        i++;
      }
    }
    
    return newWhere;
  }

  /**
   * Rewrite virtual isSnoozed filter to DB-level condition
   * Maps: isSnoozed = false → NOT EXISTS(user state with snoozeUntil > now)
   * Maps: isSnoozed = true → EXISTS(user state with snoozeUntil > now)
   */
  private rewriteIsSnoozedFilter(where: any[], userEmail: string): any[] {
    if (!where || !userEmail) return where;
    
    const newWhere = [];
    let i = 0;
    
    while (i < where.length) {
      const token = where[i];
      
      // Look for pattern: {ref: ['isSnoozed']}, '=', {val: boolean}
      if (token && typeof token === 'object' && token.ref && 
          Array.isArray(token.ref) && token.ref[0] === 'isSnoozed' &&
          i + 2 < where.length && where[i + 1] === '=' && 
          where[i + 2] && typeof where[i + 2] === 'object' && 'val' in where[i + 2]) {
        
        const isSnoozedValue = where[i + 2].val;
        const nowISO = new Date().toISOString();
        
        logger.debug('AdminService', `[rewriteIsSnoozedFilter] Rewriting isSnoozed = ${isSnoozedValue} to DB condition`);
        
        if (isSnoozedValue === false) {
          // isSnoozed = false → show notifications that are NOT actively snoozed
          // This means: notifications that either have no user state OR have user state with snoozeUntil <= now OR snoozeUntil is null
          newWhere.push(
            '(', 
            'ID', 'not', 'in', {
              SELECT: {
                from: { ref: ['sap.llm.gateway.admin.SecurityNotificationUserState'] },
                columns: [{ ref: ['notification_ID'] }],
                where: [
                  { ref: ['email'] }, '=', { val: userEmail }, 'and',
                  { ref: ['snoozeUntil'] }, 'is', 'not', 'null', 'and',
                  { ref: ['snoozeUntil'] }, '>', { val: nowISO }
                ]
              }
            },
            ')'
          );
        } else {
          // isSnoozed = true → show only actively snoozed notifications
          newWhere.push(
            'ID', 'in', {
              SELECT: {
                from: { ref: ['sap.llm.gateway.admin.SecurityNotificationUserState'] },
                columns: [{ ref: ['notification_ID'] }],
                where: [
                  { ref: ['email'] }, '=', { val: userEmail }, 'and',
                  { ref: ['snoozeUntil'] }, 'is', 'not', 'null', 'and',
                  { ref: ['snoozeUntil'] }, '>', { val: nowISO }
                ]
              }
            }
          );
        }
        
        // Skip the next 2 tokens (operator and value)
        i += 3;
      } else {
        // Keep other tokens as-is
        newWhere.push(token);
        i++;
      }
    }
    
    return newWhere;
  }

  /**
   * Rewrite virtual pinned filter to DB-level condition
   * For admin users: pinned = true → EXISTS(user state with pinned = true for ANY user)
   * For regular users: pinned = true → EXISTS(user state with pinned = true for current user)
   */
  private rewritePinnedFilter(where: any[], userEmail: string): any[] {
    logger.debug('AdminService', '[rewritePinnedFilter] Processing where clause for pinned filters');
    
    const newWhere: any[] = [];
    
    for (let i = 0; i < where.length; i++) {
      const token = where[i];
      
      // Look for pinned = true or pinned = false
      if (token && typeof token === 'object' && token.ref && 
          Array.isArray(token.ref) && token.ref[0] === 'pinned') {
        
        const operator = where[i + 1]; // Should be '='
        const value = where[i + 2];    // Should be { val: true } or { val: false }
        
        if (operator === '=' && value && typeof value === 'object' && 'val' in value) {
          const isPinnedTrue = value.val === true || value.val === 'true';
          
          logger.debug('AdminService', `[rewritePinnedFilter] Rewriting pinned = ${value.val} to DB condition`);
          
          if (isPinnedTrue) {
            // pinned = true → ID IN (SELECT notification_ID FROM UserState WHERE email = user AND pinned = true)
            newWhere.push(
              'ID', 'in', {
                SELECT: {
                  from: { ref: ['sap.llm.gateway.admin.SecurityNotificationUserState'] },
                  columns: [{ ref: ['notification_ID'] }],
                  where: [
                    { ref: ['email'] }, '=', { val: userEmail },
                    'and',
                    { ref: ['pinned'] }, '=', { val: true }
                  ]
                }
              }
            );
          } else {
            // pinned = false → ID NOT IN (SELECT notification_ID FROM UserState WHERE email = user AND pinned = true)
            newWhere.push(
              'ID', 'not', 'in', {
                SELECT: {
                  from: { ref: ['sap.llm.gateway.admin.SecurityNotificationUserState'] },
                  columns: [{ ref: ['notification_ID'] }],
                  where: [
                    { ref: ['email'] }, '=', { val: userEmail },
                    'and',
                    { ref: ['pinned'] }, '=', { val: true }
                  ]
                }
              }
            );
          }
          
          // Skip the next 2 tokens (operator and value)
          i += 2;
        } else {
          // Keep token as-is if it doesn't match expected pattern
          newWhere.push(token);
        }
      } else {
        // Keep other tokens as-is
        newWhere.push(token);
      }
    }
    
    logger.debug('AdminService', '[rewritePinnedFilter] Completed pinned filter rewrite');
    return newWhere;
  }

  /**
   * Sort notifications array according to original orderBy that included pinned field
   * This ensures proper sorting for visual grouping in the UI
   */
  private sortNotificationsByPinnedOrder(notifications: any[], originalOrderBy: any[]): void {
    logger.debug('AdminService', '[sortNotificationsByPinnedOrder] Sorting notifications with orderBy:', {
      count: notifications.length,
      orderBy: JSON.stringify(originalOrderBy)
    });

    notifications.sort((a, b) => {
      for (const orderItem of originalOrderBy) {
        if (!orderItem || typeof orderItem !== 'object' || !orderItem.ref || !Array.isArray(orderItem.ref)) {
          continue;
        }
        
        const fieldName = orderItem.ref[0];
        const isDescending = orderItem.sort === 'desc';
        
        let valueA = a[fieldName];
        let valueB = b[fieldName];
        
        // Handle different data types
        if (fieldName === 'pinned') {
          // Boolean field - pinned items should come first when desc
          valueA = valueA ? 1 : 0;
          valueB = valueB ? 1 : 0;
        } else if (fieldName === 'eventDate' || fieldName === 'createdAt') {
          // Date fields
          valueA = valueA ? new Date(valueA).getTime() : 0;
          valueB = valueB ? new Date(valueB).getTime() : 0;
        } else if (typeof valueA === 'string' && typeof valueB === 'string') {
          // String comparison
          valueA = valueA.toLowerCase();
          valueB = valueB.toLowerCase();
        }
        
        let comparison = 0;
        if (valueA < valueB) {
          comparison = -1;
        } else if (valueA > valueB) {
          comparison = 1;
        }
        
        if (comparison !== 0) {
          return isDescending ? -comparison : comparison;
        }
        
        // If values are equal, continue to next sort criteria
      }
      
      return 0; // All sort criteria are equal
    });

    logger.debug('AdminService', '[sortNotificationsByPinnedOrder] Sorted notifications - first few:', {
      firstThree: notifications.slice(0, 3).map(n => ({
        id: n.ID,
        pinned: n.pinned,
        eventDate: n.eventDate
      }))
    });
  }

  /**
   * Bulk action to mark multiple notifications as seen
   */
  async bulkMarkNotificationsSeen(req: AdminRequest): Promise<{
    success: boolean;
    updated: number;
    message: string;
  }> {
    try {
      const { IDs = [] } = req.data;
      const userEmail = this.getUserEmail(req);
      
      if (!Array.isArray(IDs) || IDs.length === 0) {
        return {
          success: false,
          updated: 0,
          message: 'No notification IDs provided'
        };
      }
      
      if (!userEmail) {
        return {
          success: false,
          updated: 0,
          message: 'User context required'
        };
      }

      logger.info('AdminService', `[bulkMarkNotificationsSeen] Processing ${IDs.length} notifications for user ${userEmail}`);

      let updated = 0;
      
      // Process each notification ID
      for (const notificationID of IDs) {
        try {
          // Check if record already exists
          const existing = await SELECT.one.from('sap.llm.gateway.admin.SecurityNotificationUserState')
            .where({ notification_ID: notificationID, email: userEmail });
          
          if (existing) {
            // Update existing record
            await UPDATE('sap.llm.gateway.admin.SecurityNotificationUserState')
              .set({
                seenAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString()
              })
              .where({ ID: existing.ID });
          } else {
            // Create new record
            await INSERT.into('sap.llm.gateway.admin.SecurityNotificationUserState').entries({
              ID: cds.utils.uuid(),
              notification_ID: notificationID,
              email: userEmail,
              seenAt: new Date().toISOString(),
              modifiedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              createdBy: userEmail
            });
          }
          updated++;
        } catch (error) {
          logger.warn('AdminService', `[bulkMarkNotificationsSeen] Failed to process notification ${notificationID}:`, error instanceof Error ? error.message : 'Unknown error');
        }
      }

      logger.info('AdminService', `[bulkMarkNotificationsSeen] Successfully processed ${updated}/${IDs.length} notifications`);

      // Trigger real-time notification update for all admin users
      if (updated > 0) {
        notificationStreamService.notifyAll('notification-bulk-changed', {
          action: 'bulk_marked_seen',
          notificationIds: IDs,
          userId: userEmail,
          updatedCount: updated,
          timestamp: new Date().toISOString()
        });
      }

      return {
        success: updated > 0,
        updated,
        message: `Marked ${updated} notification${updated !== 1 ? 's' : ''} as seen`
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `[bulkMarkNotificationsSeen] Error: ${errorMsg}`, error instanceof Error ? error : new Error(errorMsg));
      
      return {
        success: false,
        updated: 0,
        message: 'Failed to mark notifications as seen'
      };
    }
  }

  /**
   * Bulk action to delete multiple security notifications (admin only, 30+ days old)
   */
  async bulkDeleteSecurityNotifications(req: AdminRequest): Promise<{
    success: boolean;
    updated: number;
    failed: number;
    message: string;
  }> {
    try {
      const { IDs = [] } = req.data;
      const userEmail = this.getUserEmail(req);
      const userRoles = this.getUserRoles(req);
      const isAdmin = this.isAdmin(userRoles);
      
      if (!isAdmin) {
        return {
          success: false,
          updated: 0,
          failed: 0,
          message: 'Access denied: Admin role required'
        };
      }
      
      if (!Array.isArray(IDs) || IDs.length === 0) {
        return {
          success: false,
          updated: 0,
          failed: 0,
          message: 'No notification IDs provided'
        };
      }

      logger.info('AdminService', `[bulkDeleteSecurityNotifications] Processing ${IDs.length} notifications for admin user ${userEmail}`);

      let updated = 0;
      let failed = 0;
      const minAgeDate = new Date();
      minAgeDate.setDate(minAgeDate.getDate() - securityNotificationConfig.minDeleteAgeDays);
      
      // Process each notification ID
      for (const notificationID of IDs) {
        try {
          const tx = cds.transaction(req);
          
          // Get the notification to check its age and source info
          const notification = await tx.run(SELECT.one.from('sap.llm.gateway.admin.SecurityNotifications')
            .where({ ID: notificationID }));
          
          if (!notification) {
            logger.warn('AdminService', `[bulkDeleteSecurityNotifications] Notification ${notificationID} not found`);
            failed++;
            continue;
          }

          // Check if notification is at least the configured minimum age
          const notificationDate = new Date(notification.createdAt);
          if (notificationDate > minAgeDate) {
            logger.warn('AdminService', `[bulkDeleteSecurityNotifications] Notification ${notificationID} is not old enough (created: ${notificationDate.toISOString()})`);
            failed++;
            continue;
          }

          // 1) Delete per-user state records
          await tx.run(DELETE.from('sap.llm.gateway.admin.SecurityNotificationUserState')
            .where({ notification_ID: notificationID }));

          // 2) Delete source record based on sourceEntity
          if (notification.sourceEntity === 'ApiKeySecurityEvents') {
            await tx.run(DELETE.from('sap.llm.gateway.admin.ApiKeySecurityEvents')
              .where({ ID: notification.sourceID }));
          } else if (notification.sourceEntity === 'AwsCredentialSecurityEvents') {
            await tx.run(DELETE.from('sap.llm.gateway.admin.AwsCredentialSecurityEvents')
              .where({ ID: notification.sourceID }));
          } else if (notification.sourceEntity === 'AwsCredentialRotations') {
            await tx.run(DELETE.from('sap.llm.gateway.admin.AwsCredentialRotations')
              .where({ ID: notification.sourceID }));
          }

          // 3) Delete the notification itself
          await tx.run(DELETE.from('sap.llm.gateway.admin.SecurityNotifications')
            .where({ ID: notificationID }));

          updated++;
          logger.debug('AdminService', `[bulkDeleteSecurityNotifications] Successfully deleted notification ${notificationID}`);
        } catch (error) {
          logger.warn('AdminService', `[bulkDeleteSecurityNotifications] Failed to process notification ${notificationID}:`, error instanceof Error ? error.message : 'Unknown error');
          failed++;
        }
      }

      logger.info('AdminService', `[bulkDeleteSecurityNotifications] Successfully processed ${updated}/${IDs.length} notifications (${failed} failed)`);

      // Trigger real-time notification update for all admin users
      if (updated > 0) {
        notificationStreamService.notifyAll('notification-bulk-changed', {
          action: 'bulk_deleted',
          notificationIds: IDs,
          userId: userEmail,
          updatedCount: updated,
          failedCount: failed,
          timestamp: new Date().toISOString()
        });
      }

      const totalProcessed = updated + failed;
      let message = '';
      
      if (updated > 0 && failed === 0) {
        message = `Successfully deleted ${updated} notification${updated !== 1 ? 's' : ''}`;
      } else if (updated > 0 && failed > 0) {
        message = `Deleted ${updated} notification${updated !== 1 ? 's' : ''}, ${failed} failed (check age requirements)`;
      } else if (failed > 0) {
        message = `Failed to delete ${failed} notification${failed !== 1 ? 's' : ''} (check age requirements)`;
      } else {
        message = 'No notifications processed';
      }

      return {
        success: updated > 0,
        updated,
        failed,
        message
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('AdminService', `[bulkDeleteSecurityNotifications] Error: ${errorMsg}`, error instanceof Error ? error : new Error(errorMsg));
      
      return {
        success: false,
        updated: 0,
        failed: 0,
        message: 'Failed to delete notifications'
      };
    }
  }

  /**
   * After READ handler for MySecurityNotifications - filter user state by current user
   * This is needed because SQLite doesn't support $user.id in view definitions
   */
  async afterReadMySecurityNotifications(results: any, req: any): Promise<void> {
    try {
      if (!results) {
        logger.debug('AdminService', '[afterReadMySecurityNotifications] No results to process');
        return;
      }
      
      const notifications = Array.isArray(results) ? results : [results];
      const userEmail = this.getUserEmail(req);
      const userRoles = this.getUserRoles(req);
      const isAdmin = this.isAdmin(userRoles);
      
      logger.debug('AdminService', '[afterReadMySecurityNotifications] Processing notifications:', {
        count: notifications.length,
        userEmail,
        firstNotificationId: notifications[0]?.ID
      });
      
      if (!userEmail) {
        logger.debug('AdminService', '[afterReadMySecurityNotifications] No user email, leaving defaults');
        return;
      }
      
      // Get all notification IDs
      const notificationIds = notifications.map(n => n.ID);
      
      // Fetch user state for current user and these notifications
      const userStates = await cds.run(
        SELECT.from('sap.llm.gateway.admin.SecurityNotificationUserState')
          .where({ 
            notification_ID: { in: notificationIds },
            email: userEmail 
          })
      );
      
      logger.debug('AdminService', '[afterReadMySecurityNotifications] Found user states:', {
        count: userStates.length,
        userStates: userStates.map((s: any) => ({ 
          notificationId: s.notification_ID, 
          seenAt: s.seenAt,
          dismissedAt: s.dismissedAt,
          snoozeUntil: s.snoozeUntil,
          pinned: s.pinned,
          modifiedAt: s.modifiedAt
        }))
      });
      
      // Create a map for quick lookup - use most recent record if duplicates exist
      const userStateMap = new Map();
      userStates.forEach((state: any) => {
        const existing = userStateMap.get(state.notification_ID);
        if (!existing || (state.modifiedAt && existing.modifiedAt && new Date(state.modifiedAt) > new Date(existing.modifiedAt))) {
          userStateMap.set(state.notification_ID, state);
        }
      });
      
      logger.debug('AdminService', '[afterReadMySecurityNotifications] Created user state map:', {
        mapSize: userStateMap.size,
        keys: Array.from(userStateMap.keys())
      });
      
      // Populate user state fields for each notification
      notifications.forEach(notification => {
        const userState = userStateMap.get(notification.ID);
        if (userState) {
          notification.seenAt = userState.seenAt;
          notification.dismissedAt = userState.dismissedAt;
          notification.snoozeUntil = userState.snoozeUntil;
          notification.pinned = userState.pinned || false;
          logger.debug('AdminService', `[afterReadMySecurityNotifications] Updated notification ${notification.ID} with user state`);
        } else {
          logger.debug('AdminService', `[afterReadMySecurityNotifications] No user state found for notification ${notification.ID}`);
          // Ensure pinned is always set to false if no user state exists
          notification.pinned = false;
        }
        
        // CRITICAL: Set action availability flags based on current state
        // These virtual computed fields control button visibility in Fiori Elements
        notification.canPin = !notification.pinned;     // Can pin if not currently pinned
        notification.canUnpin = notification.pinned;    // Can unpin if currently pinned
        notification.canMarkSeen = !notification.seenAt;    // Can mark seen if currently unseen
        notification.canMarkUnseen = !!notification.seenAt; // Can mark unseen if currently seen
        notification.canDelete = isAdmin;                // Can delete if user is admin
        
        // Compute isSnoozed field: true if notification is snoozed (snoozeUntil exists and > now)
        const now = new Date();
        const snoozeUntil = notification.snoozeUntil ? new Date(notification.snoozeUntil) : null;
        notification.isSnoozed = snoozeUntil && snoozeUntil > now || false;
        
        logger.debug('AdminService', `[afterReadMySecurityNotifications] Set availability flags for ${notification.ID}: canPin=${notification.canPin}, canUnpin=${notification.canUnpin}, canMarkSeen=${notification.canMarkSeen}, canMarkUnseen=${notification.canMarkUnseen}, pinned=${notification.pinned}, isSnoozed=${notification.isSnoozed}`);
      });
      
      // STEP 4: Sort notifications if there was a pinned orderBy in the original request
      if (req._originalOrderBy) {
        logger.debug('AdminService', '[afterReadMySecurityNotifications] Sorting notifications according to original orderBy with pinned field');
        this.sortNotificationsByPinnedOrder(notifications, req._originalOrderBy);
      }
      
      logger.debug('AdminService', '[afterReadMySecurityNotifications] Processing completed successfully');
      logger.debug('AdminService', '[afterReadMySecurityNotifications] Final notification sample:', {
        sampleNotification: notifications[0] ? {
          ID: notifications[0].ID,
          title: notifications[0].title?.substring(0, 50),
          seenAt: notifications[0].seenAt,
          dismissedAt: notifications[0].dismissedAt,
          pinned: notifications[0].pinned
        } : 'No notifications'
      });
      
    } catch (error) {
      logger.error('AdminService', '[afterReadMySecurityNotifications] Error processing notifications:', error instanceof Error ? error : new Error(String(error)));
      // Don't throw - let the request continue with default values
    }
  }

  /**
   * Get current user preferences with computed role-based capabilities
   */
  async getCurrentUserPreferences(req: any): Promise<any> {
    const userEmail = this.getUserEmail(req);
    const userRoles = this.getUserRoles(req);
    
    if (!userEmail) {
      return req.reject(401, 'User not authenticated');
    }

    try {
      // Get or create user preferences
      let preferences = await cds.run(
        SELECT.one.from('sap.llm.gateway.admin.UserPreferences')
          .where({ email: userEmail })
      );

      if (!preferences) {
        // Create default preferences for new user
        preferences = await this.createDefaultUserPreferences(userEmail, userRoles);
      } else {
        // Update computed role-based fields
        await this.updateUserRoles(preferences.ID, userRoles);
      }

      await touchUser(cds, userEmail, { roles: userRoles, displayName: preferences.displayName ?? undefined });

      // Compute role-based capabilities
      const computed = this.computeUserCapabilities(userRoles);

      // Return flattened structure matching CDS action definition
      return {
        // User identity
        email: preferences.email,
        displayName: preferences.displayName,
        
        // Role-based capabilities (computed)
        isAdmin: computed.isAdmin,
        isUser: computed.isUser,
        canDeleteOld: computed.canDeleteOld,
        canManageKeys: computed.canManageKeys,
        canManageAWS: computed.canManageAWS,
        
        // UI preferences
        sidePanelCollapsed: preferences.sidePanelCollapsed || false,
        theme: preferences.theme || 'sap_horizon',
        density: preferences.density || 'cozy',
        tablePageSize: preferences.tablePageSize || 50,
        
        // App preferences
        defaultNotificationFilter: preferences.defaultNotificationFilter,
        showDismissedNotifications: preferences.showDismissedNotifications || false,
        autoMarkAsSeenOnView: preferences.autoMarkAsSeenOnView !== false,
        
        // Usage analytics preferences
        analyticsTimePeriod: preferences.analyticsTimePeriod || 'month',
        analyticsCustomRange: preferences.analyticsCustomRange
      };
    } catch (error) {
      logger.error('AdminService', '[getCurrentUserPreferences] Error:', error instanceof Error ? error : new Error(String(error)));
      return req.reject(500, 'Failed to retrieve user preferences');
    }
  }

  /**
   * Update a specific user preference
   */
  async updateUserPreference(req: any): Promise<any> {
    const { key, value } = req.data;
    const userEmail = this.getUserEmail(req);
    
    if (!userEmail) {
      return req.reject(401, 'User not authenticated');
    }

    if (!key) {
      return req.reject(400, 'Preference key is required');
    }

    try {
      // Get user preferences
      const preferences = await cds.run(
        SELECT.one.from('sap.llm.gateway.admin.UserPreferences')
          .where({ email: userEmail })
      );

      if (!preferences) {
        return req.reject(404, 'User preferences not found');
      }

      // Validate and update the preference
      const updateData = this.validatePreferenceUpdate(key, value);
      if (!updateData) {
        return req.reject(400, `Invalid preference key: ${key}`);
      }

      await cds.run(
        UPDATE('sap.llm.gateway.admin.UserPreferences')
          .set(updateData)
          .where({ ID: preferences.ID })
      );

      return {
        success: true,
        message: `Preference '${key}' updated successfully`
      };
    } catch (error) {
      logger.error('AdminService', `[updateUserPreference] Error updating ${key}:`, error instanceof Error ? error : new Error(String(error)));
      return req.reject(500, 'Failed to update user preference');
    }
  }

  /**
   * Create default user preferences for new user
   */
  private async createDefaultUserPreferences(email: string, roles: string[]): Promise<any> {
    const capabilities = this.computeUserCapabilities(roles);
    const now = new Date().toISOString();
    
    const defaultPreferences = {
      ID: cds.utils.uuid(),
      email,
      displayName: email.split('@')[0], // Use email prefix as default display name
      roles: JSON.stringify(roles),
      isAdmin: capabilities.isAdmin,
      isUser: capabilities.isUser,
      canDeleteOld: capabilities.canDeleteOld,
      canManageKeys: capabilities.canManageKeys,
      canManageAWS: capabilities.canManageAWS,
      sidePanelCollapsed: false,
      theme: 'sap_horizon',
      density: 'cozy',
      tablePageSize: 50,
      showDismissedNotifications: false,
      autoMarkAsSeenOnView: true,
      analyticsTimePeriod: 'month',
      analyticsCustomRange: null,
      createdAt: now,
      createdBy: email,
      modifiedAt: now,
      modifiedBy: email
    };

    await cds.run(
      INSERT.into('sap.llm.gateway.admin.UserPreferences').entries(defaultPreferences)
    );

    logger.info('AdminService', `[createDefaultUserPreferences] Created preferences for user: ${email}`);
    return defaultPreferences;
  }

  /**
   * Update user role-based capabilities (only when roles change)
   */
  private async updateUserRoles(preferencesId: string, roles: string[]): Promise<void> {
    const capabilities = this.computeUserCapabilities(roles);

    await cds.run(
      UPDATE('sap.llm.gateway.admin.UserPreferences')
        .set({
          roles: JSON.stringify(roles),
          isAdmin: capabilities.isAdmin,
          isUser: capabilities.isUser,
          canDeleteOld: capabilities.canDeleteOld,
          canManageKeys: capabilities.canManageKeys,
          canManageAWS: capabilities.canManageAWS,
          modifiedAt: new Date().toISOString()
        })
        .where({ ID: preferencesId })
    );
  }

  /**
   * Compute user capabilities based on roles
   */
  private computeUserCapabilities(roles: string[]): any {
    const isAdmin = this.isAdmin(roles);
    
    return {
      isAdmin,
      isUser: true, // All authenticated users are users
      canDeleteOld: isAdmin, // Only admins can delete old notifications
      canManageKeys: isAdmin, // Only admins can manage API keys globally
      canManageAWS: isAdmin   // Only admins can manage AWS credentials globally
    };
  }

  /**
   * Validate preference update and return update object
   */
  private validatePreferenceUpdate(key: string, value: string): any | null {
    const allowedPreferences: { [key: string]: (val: string) => any } = {
      'sidePanelCollapsed': (val) => val === 'true',
      'theme': (val) => ['sap_horizon', 'sap_fiori_3', 'sap_quartz_light', 'sap_quartz_dark'].includes(val) ? val : 'sap_horizon',
      'density': (val) => ['compact', 'cozy'].includes(val) ? val : 'cozy',
      'tablePageSize': (val) => {
        const num = parseInt(val, 10);
        return (num >= 10 && num <= 200) ? num : 50;
      },
      'defaultNotificationFilter': (val) => val.substring(0, 100),
      'showDismissedNotifications': (val) => val === 'true',
      'autoMarkAsSeenOnView': (val) => val === 'true',
      'displayName': (val) => val.substring(0, 255),
      'analyticsTimePeriod': (val) => ['today', 'week', 'month', 'quarter', 'year', 'overall', 'custom'].includes(val) ? val : 'month',
      'analyticsCustomRange': (val) => {
        try {
          // Validate JSON format: {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'}
          const parsed = JSON.parse(val);
          if (parsed && parsed.from && parsed.to && 
              /^\d{4}-\d{2}-\d{2}$/.test(parsed.from) && 
              /^\d{4}-\d{2}-\d{2}$/.test(parsed.to)) {
            return val.substring(0, 50);
          }
          return null;
        } catch {
          return null;
        }
      }
    };

    if (!allowedPreferences[key]) {
      return null;
    }

    return {
      [key]: allowedPreferences[key](value),
      modifiedAt: new Date().toISOString()
    };
  }

}

// Export the service class
const adminService = new AdminService();

// Initialize with CDS service when module is loaded
module.exports = (srv: any) => {
  // The init() promise is RETURNED, not dropped: cds awaits the impl function's return value
  // (@sap/cds lib/srv/factory.js:76, `await impl.call(srv, srv)`), so returning it is what makes
  // the awaited Model Library seed at the end of init() complete before the service is served.
  // Everything below registers synchronously first, so the 'served' hook and the nextTick mount
  // are in place regardless of when the seed settles.
  const initialized = adminService.init(srv).then(() => adminService);
  
  // Mount REST API routes during service initialization
  srv.on('served', () => {
    try {
      const app = cds.app || srv.app || (cds.server && cds.server.app);
      if (app) {
        app.use('/api/admin', configRestApi);
        // Add SSE endpoint for real-time notifications
        app.get('/api/notifications/stream', notificationStreamService.handleConnection);
        logger.info('AdminService', 'REST API endpoints mounted at /api/admin');
        logger.info('AdminService', 'SSE endpoint mounted at /api/notifications/stream');
      } else {
        logger.warn('AdminService', 'Express app not available - trying alternative mounting');
        // Alternative mounting approach
        try {
          const express = require('express');
          const cdsApp = cds.serve('AdminService');
          if (cdsApp && cdsApp.app) {
            cdsApp.app.use('/api/admin', configRestApi);
            cdsApp.app.get('/api/notifications/stream', notificationStreamService.handleConnection);
            logger.info('AdminService', 'REST API endpoints mounted via CDS app');
            logger.info('AdminService', 'SSE endpoint mounted via CDS app');
          }
        } catch (altError) {
          logger.error('AdminService', 'Alternative mounting also failed', altError as Error);
        }
      }
    } catch (error) {
      logger.error('AdminService', 'Failed to mount REST API endpoints', error as Error);
    }
  });
  
  // Also try to mount immediately after service init
  process.nextTick(() => {
    try {
      const app = cds.app || srv.app || (cds.server && cds.server.app);
      if (app && !app._router.stack.some((layer: any) => layer.regexp.source.includes('api/admin'))) {
        app.use('/api/admin', configRestApi);
        app.get('/api/notifications/stream', notificationStreamService.handleConnection);
        logger.info('AdminService', 'REST API endpoints mounted immediately at /api/admin');
        logger.info('AdminService', 'SSE endpoint mounted immediately');
      }
    } catch (error) {
      logger.debug('AdminService', 'Immediate mounting failed, will retry on served event', error as Error);
    }
  });
  
  return initialized;
};