const cds = require('@sap/cds');
import crypto from 'crypto';
import axios from 'axios';
import Valkey from 'iovalkey';
import Ajv from 'ajv';
import { getDefaultLogger } from '@libs/logger';
import { modelCostService } from '../services/modelCostService';
import * as configSchema from '../schemas/api-config-schema.json';
import { MINIMAL_DEFAULT_CONFIG } from './minimal-default-config';
import { formatSchemaError } from './schemaErrors';
import { invalidateQuotaDefaults } from '../services/quotaLimits';
import { costRecalculationService } from '../services/costRecalculationService';
import { republishAll } from '../services/userQuotaService';
import { invalidateForEmails } from '../services/credentialInvalidation';
import { invalidateToolRetentionDefaults } from '../services/toolUsageService';

const logger = getDefaultLogger();

// JSON Schema validator (without formats for now to avoid import issues)
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateConfigSchema = ajv.compile(configSchema);

/**
 * Reports every SIEM sink after the first that reuses another sink's `name`.
 *
 * JSON Schema draft-07 cannot express this: there is no cross-item uniqueness
 * keyword, and `uniqueItems` compares whole objects, so two sinks differing in
 * any other field satisfy it while still colliding on `name`. The schema check
 * above therefore passes a config with two sinks called "s3", and only the
 * config-app's form gate (webapp/model/validateSection.ts) rejected it — a JSON
 * PUT or a raw-editor save went straight through.
 *
 * It has to be caught, because `name` keys a sink's delivery rows
 * (`SiemDelivery.sinkName`) and its dispatcher backoff state. Two sinks sharing
 * a name share delivery rows and mark each other's events delivered: the events
 * are never exported and nothing reports them missing.
 *
 * Mirrors the form's rule — comparison on the trimmed name, blank/missing names
 * left to the schema's own `required`/`minLength`, the collision reported
 * against the later of the two sinks, which is the one to rename. Written out
 * here rather than imported: validateSection.ts belongs to the config-app's own
 * package and build, and the server must not depend on the frontend.
 */
/**
 * Substitution may target a Connection model (`<model>--<connection>`, spec 2026-10-23 §4.3).
 * Connections live outside configuration versions, so a target whose suffix names an existing
 * connection but none of its models is only a warning: it may be added later, and at runtime an
 * unknown target is a 404 as today. SAP ids carry `--` as well (vendor prefixes such as
 * `anthropic--claude-4.5-haiku`), so a suffix that names no connection is not looked at. A database
 * that cannot be read here yields no warning rather than a failed validation.
 */
const CONNECTION_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const suffix = (id: string) => id.slice(id.lastIndexOf('--') + 2);

async function unknownConnectionTargets(providers: Record<string, any>): Promise<string[]> {
  const targets: Array<{ provider: string; to: string }> = [];
  for (const [provider, config] of Object.entries(providers || {})) {
    for (const s of (config && Array.isArray(config.substitute_models) ? config.substitute_models : [])) {
      if (typeof s?.to === 'string' && s.to.includes('--') && CONNECTION_NAME.test(suffix(s.to))) targets.push({ provider, to: s.to });
    }
  }
  if (targets.length === 0) return [];
  let connections: Set<string>;
  let known: Set<string>;
  try {
    const names = await cds.run(cds.ql.SELECT.from('sap.llm.gateway.admin.ProviderConnections').columns('name')
      .where({ name: { in: [...new Set(targets.map((t) => suffix(t.to)))] } }));
    connections = new Set(names.map((r: any) => r.name));
    if (connections.size === 0) return [];
    const rows = await cds.run(cds.ql.SELECT.from('sap.llm.gateway.admin.ConnectionModels').columns('modelId')
      .where({ modelId: { in: [...new Set(targets.map((t) => t.to))] } }));
    known = new Set(rows.map((r: any) => r.modelId));
  } catch {
    return [];
  }
  return targets.filter((t) => connections.has(suffix(t.to)) && !known.has(t.to))
    .map((t) => `Model substitution in ${t.provider}: target '${t.to}' is not a known connection model`);
}

function findDuplicateSinkNames(siem: any): string[] {
  const sinks = siem?.sinks;
  if (!Array.isArray(sinks)) {
    return [];
  }

  const errors: string[] = [];
  const seen = new Map<string, number>();

  sinks.forEach((sink: any, index: number) => {
    const rawName = sink && typeof sink === 'object' ? sink.name : undefined;
    if (typeof rawName !== 'string') {
      return;
    }
    const name = rawName.trim();
    if (name.length === 0) {
      return;
    }

    const firstIndex = seen.get(name);
    if (firstIndex === undefined) {
      seen.set(name, index);
      return;
    }
    errors.push(
      `Duplicate sink name at 'api_config/observability/siem/sinks/${index}/name': ` +
      `"${name}" is already used by sink #${firstIndex}. Delivery rows are keyed by sink name, ` +
      `so two sinks sharing one would mark each other's events delivered.`
    );
  });

  return errors;
}

// Event channels (must match Gateway Service)
const CONFIG_CHANGE_CHANNEL = 'sap-llm-gateway:config-changed';
const MODEL_LIST_CHANNEL = 'sap-llm-gateway:model-list-updated';
const STARTUP_READY_CHANNEL = 'sap-llm-gateway:service-ready';

// Valkey connections
let valkeyPublisher: Valkey | null = null;
let valkeySubscriber: Valkey | null = null;

// Startup coordination
let startupEventPublished = false;

interface ConfigurationVersion {
  id: string;
  version: string;
  configData: any;
  checksum: string;
  isActive: boolean;
  deployedAt?: Date;
  deployedBy?: string;
  rollbackReason?: string;
  createdAt: Date;
  createdBy: string;
}

interface ConfigChangeEvent {
  eventType: 'config-changed' | 'config-activated' | 'config-rollback';
  configId: string;
  configName: string;
  version: string;
  checksum: string;
  timestamp: string;
}

/** Columns derived from a configuration's document: computed by the service, never taken from a client. */
const DERIVED_COLUMNS = ['checksum', 'isValid', 'validationErrors', 'validationWarnings', 'lastValidated'];

/**
 * Columns only activation and rollback write (db-level cds.run, which no service handler sees):
 * which configuration is active, and when and by whom it was deployed.
 */
const ACTIVATION_COLUMNS = ['isActive', 'deployedAt', 'deployedBy'];

/** How long a configuration event publish may hold a request before it is given up. */
const PUBLISH_TIMEOUT_MS = 3000;

/** UPDATE requests whose configData differs from the stored document (set before, read after). */
const documentChanged = new WeakSet<object>();

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Simplified Configuration Service for Production
 * Focuses on core requirements: versioning, validation, events, rollback
 */
class ConfigurationService {
  private valkeyClient: Valkey | null = null;
  private isValkeyAvailable = false;

  constructor() {
    this.initializeValkey();
    this.initializeStartupEventPublishing();
  }

  /**
   * Initialize the configuration service with CDS service
   */
  init(service: any): void {
    // Register event handlers
    service.on('createConfiguration', this.createConfiguration.bind(this));
    service.on('activateConfiguration', this.activateConfiguration.bind(this));
    service.on('validateConfiguration', this.validateConfiguration.bind(this));
    service.on('rollbackConfiguration', this.rollbackConfiguration.bind(this));
    service.on('getActiveConfiguration', this.getActiveConfiguration.bind(this));
    service.on('getConfigurationHistory', this.getConfigurationHistory.bind(this));
    service.on('getConfigurationStatus', this.getConfigurationStatus.bind(this));

    // Register OData event handlers
    service.before('CREATE', 'ApiConfigurations', this.onBeforeConfigurationCreate.bind(this));
    service.before('UPDATE', 'ApiConfigurations', this.onBeforeConfigurationUpdate.bind(this));
    service.after('CREATE', 'ApiConfigurations', this.onConfigurationCreated.bind(this));
    service.after('UPDATE', 'ApiConfigurations', this.onConfigurationUpdated.bind(this));

    logger.info('ConfigService', 'Configuration service initialized successfully');
  }

  private async initializeValkey(): Promise<void> {
    const valkeyUrl = process.env.VALKEY_URL;
    if (!valkeyUrl) {
      logger.info('ConfigService', 'No VALKEY_URL configured - event publishing disabled');
      return;
    }

    try {
      // Initialize publisher connection
      this.valkeyClient = new Valkey(valkeyUrl, {
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      // Initialize separate connections for pub/sub
      valkeyPublisher = new Valkey(valkeyUrl, {
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      valkeySubscriber = new Valkey(valkeyUrl, {
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      await this.valkeyClient.ping();
      await valkeyPublisher.ping();

      // Load stored model list on startup (before subscribing)
      try {
        const storedModelList = await valkeyPublisher.get('model-list:latest');

        if (storedModelList) {
          logger.info('ConfigService', 'Found stored model list in Valkey, loading...');

          try {
            const modelListEvent = JSON.parse(storedModelList);

            // Validate structure
            if (modelListEvent.models && Array.isArray(modelListEvent.models)) {
              await this.handleModelListEvent(modelListEvent);
              logger.info('ConfigService', `Loaded ${modelListEvent.modelCount} models from Valkey storage on startup`);
            } else {
              logger.warn('ConfigService', 'Stored model list has invalid structure, ignoring');
            }
          } catch (parseError: any) {
            logger.warn('ConfigService', `Failed to parse stored model list: ${parseError.message}`);
          }
        } else {
          logger.debug('ConfigService', 'No stored model list found in Valkey, will wait for pub/sub event');
        }
      } catch (storageError: any) {
        // Log warning but continue - pub/sub can still work
        logger.warn('ConfigService', `Failed to read model list from Valkey storage: ${storageError.message}`);
      }

      // Subscribe to model list updates from Gateway Service
      await valkeySubscriber.subscribe(MODEL_LIST_CHANNEL, STARTUP_READY_CHANNEL);
      valkeySubscriber.on('message', this.handleValkeyEvent.bind(this));

      this.isValkeyAvailable = true;
      logger.info('ConfigService', 'Connected to Valkey for event publishing and subscriptions');
    } catch (error) {
      logger.warn('ConfigService', 'Failed to connect to Valkey - event publishing disabled', { error });
      this.isValkeyAvailable = false;
    }
  }

  /**
   * Get active configuration
   */
  async getActiveConfiguration(req: any): Promise<any> {
    try {
      // Check if database is connected before trying to query
      if (!cds.db) {
        logger.warn('ConfigService', 'Database not connected yet - cannot get active configuration');
        return {
          success: false,
          error: 'Database not connected'
        };
      }

      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ isActive: true })
        .orderBy('version desc')
        .limit(1);

      const results = await cds.run(SELECT);
      
      if (results.length === 0) {
        return {
          success: false,
          error: 'No active configuration found'
        };
      }

      const config = results[0];
      return {
        success: true,
        data: {
          id: config.ID,
          name: config.name,
          version: config.version,
          configData: JSON.parse(config.configData || '{}'),
          checksum: config.checksum,
          deployedAt: config.deployedAt,
          deployedBy: config.deployedBy
        }
      };
    } catch (error) {
      logger.error('ConfigService', 'Failed to get active configuration', error as Error);
      return { success: false, error: 'Failed to retrieve configuration' };
    }
  }

  /**
   * Create new configuration version
   */
  async createConfiguration(req: any): Promise<any> {
    const { name, configData, description } = req.data;
    const user = req.user?.id || 'system';
    
    try {
      // Parse configData if it's a string
      let parsedConfigData;
      if (typeof configData === 'string') {
        try {
          parsedConfigData = JSON.parse(configData);
        } catch (error) {
          return {
            success: false,
            errors: ['Invalid JSON format in configData'],
            warnings: []
          };
        }
      } else {
        parsedConfigData = configData;
      }
      
      // Validate configuration
      const validation = await this.validateConfigurationData(parsedConfigData);
      if (!validation.valid) {
        return {
          success: false,
          errors: validation.errors,
          warnings: validation.warnings
        };
      }

      // Generate version and checksum
      const version = this.generateVersion();
      const checksum = this.generateChecksum(JSON.stringify(parsedConfigData));
      
      // Create configuration record
      const configId = cds.utils.uuid();
      const now = new Date().toISOString();
      const INSERT = cds.ql.INSERT.into('sap.llm.gateway.admin.ApiConfigurations').entries({
        ID: configId,
        name: name || `Config-${version}`,
        version,
        description,
        configData: JSON.stringify(parsedConfigData),
        checksum,
        isActive: false,  // Created but not activated
        ...this.validationColumns(validation, now),  // Store validation result
        createdAt: now,
        createdBy: user
      });

      await cds.run(INSERT);

      logger.info('ConfigService', 'Created new configuration version', {
        configId,
        version,
        user
      });

      return {
        success: true,
        configId,
        version,
        checksum,
        warnings: validation.warnings
      };
    } catch (error) {
      logger.error('ConfigService', 'Failed to create configuration', error as Error);
      return { success: false, error: 'Failed to create configuration' };
    }
  }

  /**
   * Activate configuration version
   */
  async activateConfiguration(req: any): Promise<any> {
    const { configId } = req.data;
    const user = req.user?.id || 'system';
    
    try {
      // Get configuration to activate
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ ID: configId });
        
      const configs = await cds.run(SELECT);
      if (configs.length === 0) {
        return { success: false, error: 'Configuration not found' };
      }

      const config = configs[0];

      // Check if configuration is already active
      if (config.isActive) {
        return { 
          success: true, 
          message: 'Configuration is already active',
          version: config.version,
          checksum: config.checksum,
          activatedAt: config.deployedAt || new Date()
        };
      }

      // Validate before activation
      const configData = JSON.parse(config.configData || '{}');
      const validation = await this.validateConfigurationData(configData);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Configuration validation failed',
          errors: validation.errors
        };
      }

      // Simple activation approach: avoid complex transactions that cause SQLite locks
      try {
        const now = new Date().toISOString();
        
        // Step 1: First deactivate all currently active configurations
        const deactivateResult = await cds.run(
          `UPDATE sap_llm_gateway_admin_ApiConfigurations 
           SET isActive = false, modifiedAt = ?, modifiedBy = ? 
           WHERE isActive = true`,
          [now, user]
        );
        
        logger.debug('ConfigService', 'Deactivated configs', { affectedRows: deactivateResult });
        
        // Step 2: Then activate the target configuration, storing the checksum and validation
        // result of its document (valid, so isValid is the literal true and there are no errors);
        // rows saved before saves recomputed them get current values here.
        const stored = this.validationColumns(validation, now);
        config.checksum = this.generateChecksum(JSON.stringify(configData));
        const activateResult = await cds.run(
          `UPDATE sap_llm_gateway_admin_ApiConfigurations
           SET isActive = true, deployedAt = ?, deployedBy = ?, modifiedAt = ?, modifiedBy = ?,
               checksum = ?, isValid = true, validationErrors = ?, validationWarnings = ?, lastValidated = ?
           WHERE ID = ?`,
          [now, user, now, user, config.checksum, stored.validationErrors, stored.validationWarnings, stored.lastValidated, configId]
        );
        
        logger.debug('ConfigService', 'Activated config', { affectedRows: activateResult, configId });
        
        if (activateResult === 0) {
          return { success: false, error: 'Configuration not found or could not be activated' };
        }
        
      } catch (error) {
        logger.error('ConfigService', 'Database operations failed during activation', error as Error);
        return { success: false, error: 'Database operations failed: ' + (error as Error).message };
      }

      // Publish event with timeout protection
      try {
        await this.publishWithTimeout({
          eventType: 'config-activated',
          configId: config.ID,
          configName: config.name,
          version: config.version,
          checksum: config.checksum,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.warn('ConfigService', 'Event publishing failed during activation', { error: (error as Error).message });
        // Don't fail the activation if event publishing fails
      }

      // platform.quotas may have changed: every state document carries the effective limits.
      invalidateQuotaDefaults();
      // platform.toolGovernance.retention may have changed too: the next nightly purge must use it.
      invalidateToolRetentionDefaults();
      // platform.maintenance.dailyRunAtUtc may have changed too: re-arm the daily run, don't run it.
      costRecalculationService.rearm().catch((e: any) => logger.warn('ConfigService', `daily maintenance re-arm failed: ${e?.message ?? e}`));
      republishAll().catch((e: any) => logger.warn('ConfigService', `quota republish failed: ${e?.message ?? e}`));
      // The gateway (and this admin's own local cache) may hold validation responses that still
      // carry the old platform.quotas limits for up to an hour; a config activation must not wait
      // that out.
      invalidateForEmails(cds, 'everyone', 'platform_quotas').catch((e: any) => logger.warn('ConfigService', `platform quota cache invalidation failed: ${e?.message ?? e}`));

      logger.info('ConfigService', 'Activated configuration', {
        configId,
        version: config.version,
        user
      });

      return {
        success: true,
        version: config.version,
        checksum: config.checksum,
        activatedAt: new Date()
      };
    } catch (error) {
      logger.error('ConfigService', 'Failed to activate configuration', error as Error);
      return { success: false, error: 'Failed to activate configuration' };
    }
  }

  /**
   * Rollback to previous configuration
   */
  async rollbackConfiguration(req: any): Promise<any> {
    const { reason } = req.data;
    const user = req.user?.id || 'system';
    
    try {
      // Get current active configuration
      const CURRENT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ isActive: true });
      
      const currentConfigs = await cds.run(CURRENT);
      if (currentConfigs.length === 0) {
        return { success: false, error: 'No active configuration to rollback from' };
      }

      const currentConfig = currentConfigs[0];

      // Get previous configuration (last activated before current)
      const PREVIOUS = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ 
          deployedAt: { '<': currentConfig.deployedAt }
        })
        .orderBy('deployedAt desc')
        .limit(1);
      
      const previousConfigs = await cds.run(PREVIOUS);
      if (previousConfigs.length === 0) {
        return { success: false, error: 'No previous configuration available for rollback' };
      }

      const previousConfig = previousConfigs[0];

      // Deactivate current configuration
      const DEACTIVATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
        .set({ 
          isActive: false,
          rollbackReason: reason
        })
        .where({ ID: currentConfig.ID });
      
      await cds.run(DEACTIVATE);

      // Activate previous configuration
      const now = new Date().toISOString();
      const ACTIVATE = cds.ql.UPDATE('sap.llm.gateway.admin.ApiConfigurations')
        .set({ 
          isActive: true,
          deployedAt: now,
          deployedBy: user,
          rollbackReason: reason
        })
        .where({ ID: previousConfig.ID });
      
      await cds.run(ACTIVATE);

      // Publish rollback event
      await this.publishConfigurationEvent({
        eventType: 'config-rollback',
        configId: previousConfig.ID,
        configName: previousConfig.name,
        version: previousConfig.version,
        checksum: previousConfig.checksum,
        timestamp: new Date().toISOString()
      });

      // platform.quotas may have changed: every state document carries the effective limits.
      invalidateQuotaDefaults();
      // platform.toolGovernance.retention may have changed too: the next nightly purge must use it.
      invalidateToolRetentionDefaults();
      // platform.maintenance.dailyRunAtUtc may have changed too: re-arm the daily run, don't run it.
      costRecalculationService.rearm().catch((e: any) => logger.warn('ConfigService', `daily maintenance re-arm failed: ${e?.message ?? e}`));
      republishAll().catch((e: any) => logger.warn('ConfigService', `quota republish failed: ${e?.message ?? e}`));
      // The gateway (and this admin's own local cache) may hold validation responses that still
      // carry the old platform.quotas limits for up to an hour; a config activation must not wait
      // that out.
      invalidateForEmails(cds, 'everyone', 'platform_quotas').catch((e: any) => logger.warn('ConfigService', `platform quota cache invalidation failed: ${e?.message ?? e}`));

      logger.info('ConfigService', 'Rolled back configuration', {
        from: currentConfig.version,
        to: previousConfig.version,
        reason,
        user
      });

      return {
        success: true,
        rolledBackFrom: currentConfig.version,
        rolledBackTo: previousConfig.version,
        reason,
        rolledBackAt: new Date()
      };
    } catch (error) {
      logger.error('ConfigService', 'Failed to rollback configuration', error as Error);
      return { success: false, error: 'Failed to rollback configuration' };
    }
  }

  /**
   * Validate configuration data
   */
  async validateConfiguration(req: any): Promise<ValidationResult> {
    const { configData } = req.data;
    
    // Parse configData if it's a string
    let parsedConfigData;
    if (typeof configData === 'string') {
      try {
        parsedConfigData = JSON.parse(configData);
      } catch (error) {
        return {
          valid: false,
          errors: ['Invalid JSON format in configData'],
          warnings: []
        };
      }
    } else {
      parsedConfigData = configData;
    }
    
    return this.validateConfigurationData(parsedConfigData);
  }

  /**
   * Get configuration history
   */
  async getConfigurationHistory(req: any): Promise<any> {
    const { limit = 50 } = req.data;
    
    try {
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations', (c: any) => {
        c.ID, c.name, c.version, c.isActive, c.deployedAt, c.deployedBy, 
        c.rollbackReason, c.createdAt, c.createdBy, c.checksum
      }).orderBy('createdAt desc')
        .limit(limit);

      const results = await cds.run(SELECT);
      
      return {
        success: true,
        history: results.map((config: any) => ({
          id: config.ID,
          name: config.name,
          version: config.version,
          isActive: config.isActive,
          deployedAt: config.deployedAt,
          deployedBy: config.deployedBy,
          rollbackReason: config.rollbackReason,
          createdAt: config.createdAt,
          createdBy: config.createdBy,
          checksum: config.checksum
        })),
        total: results.length
      };
    } catch (error) {
      logger.error('ConfigService', 'Failed to get configuration history', error as Error);
      return { success: false, error: 'Failed to retrieve configuration history' };
    }
  }

  /**
   * Get configuration service status
   */
  async getConfigurationStatus(): Promise<any> {
    try {
      const status: any = {
        timestamp: new Date().toISOString(),
        eventPublishing: this.isValkeyAvailable,
        activeConfig: {}
      };

      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .where({ isActive: true })
        .limit(1);
      
      const results = await cds.run(SELECT);
      status.activeConfig = results.length > 0 ? {
        hasActiveConfig: true,
        version: results[0].version,
        deployedAt: results[0].deployedAt,
        checksum: results[0].checksum
      } : {
        hasActiveConfig: false
      };

      return { success: true, status };
    } catch (error) {
      logger.error('ConfigService', 'Failed to get configuration status', error as Error);
      return { success: false, error: 'Failed to get configuration status' };
    }
  }

  /**
   * Every OData CREATE of ApiConfigurations is refused (400): the createConfiguration action is
   * the one way to create a configuration, because it validates the document and stores its
   * checksum and validation result. The entity is writable where it is a table (Postgres), so
   * without this a POST would store an unchecked row. The action, Duplicate and the REST PUT
   * insert through db-level cds.run and never pass here.
   */
  onBeforeConfigurationCreate(req: any): void {
    req.reject(400, 'CONFIG_CREATE_USE_ACTION');
  }

  /**
   * An OData UPDATE of ApiConfigurations (the config app's Save) stores what createConfiguration
   * stores with a document: its checksum and validation result, recomputed here from the
   * document sent. Refused with 400: a document that is not valid (create refuses it too, so every
   * stored row stays valid), and any change to the active configuration's document (it is what
   * the gateway runs; edit a copy and activate that). Without configData in the payload the
   * derived columns are not the client's to set, and are dropped. isActive, deployedAt and
   * deployedBy are refused outright (400): only Activate and Rollback change which configuration
   * is active - they write through db-level cds.run, which this handler never sees.
   *
   * The stored row is read with cds.run inside the request's own transaction - never cds.tx(fn)
   * here: the admin's SQLite has one connection, and a new root transaction would wait for this
   * one forever.
   */
  async onBeforeConfigurationUpdate(req: any): Promise<void> {
    const data = req.data ?? {};
    if (ACTIVATION_COLUMNS.some((column) => column in data)) {
      req.reject(400, 'CONFIG_SAVE_ACTIVATION_COLUMNS');
      return;
    }
    if (!('configData' in data)) {
      for (const column of DERIVED_COLUMNS) {
        delete data[column];
      }
      return;
    }

    let parsedConfigData: any;
    if (typeof data.configData === 'string') {
      try {
        parsedConfigData = JSON.parse(data.configData);
      } catch (error) {
        req.reject(400, 'CONFIG_SAVE_INVALID_JSON');
        return;
      }
    } else {
      parsedConfigData = data.configData;
    }
    const canonical = JSON.stringify(parsedConfigData);

    const key = req.params?.[0];
    const ID = data.ID ?? (key && typeof key === 'object' ? key.ID : key);
    if (!ID) {
      // No row to judge the active-save guard by; no caller sends this today.
      req.reject(400, 'CONFIG_SAVE_NO_KEY');
      return;
    }
    const stored = await cds.run(
      cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiConfigurations').columns('isActive', 'configData').where({ ID })
    );
    const changed = this.canonicalDocument(stored?.configData) !== canonical;
    if (stored?.isActive && changed) {
      req.reject(400, 'CONFIG_SAVE_ACTIVE');
      return;
    }

    const validation = await this.validateConfigurationData(parsedConfigData);
    if (!validation.valid) {
      req.reject(400, 'CONFIG_SAVE_INVALID', [validation.errors.join('; ')]);
      return;
    }

    data.checksum = this.generateChecksum(canonical);
    Object.assign(data, this.validationColumns(validation, new Date().toISOString()));
    if (changed) {
      documentChanged.add(req);
    }
  }

  /** A stored document in the form its checksum is taken of; text that is not JSON as it is. */
  private canonicalDocument(configData: unknown): unknown {
    if (typeof configData !== 'string') {
      return JSON.stringify(configData);
    }
    try {
      return JSON.stringify(JSON.parse(configData));
    } catch (error) {
      return configData;
    }
  }

  /**
   * The columns a validation result is stored in: errors and warnings as JSON arrays of strings,
   * or null when there are none.
   */
  private validationColumns(validation: ValidationResult, now: string) {
    return {
      isValid: validation.valid,
      validationErrors: validation.errors.length > 0 ? JSON.stringify(validation.errors) : null,
      validationWarnings: validation.warnings.length > 0 ? JSON.stringify(validation.warnings) : null,
      lastValidated: now
    };
  }

  /**
   * After an UPDATE: an active configuration whose document changed is pushed to the gateway.
   * Via OData that cannot happen (the before handler refuses changing the active document and
   * isActive), so this serves service-level updates only. The publish is given up after
   * PUBLISH_TIMEOUT_MS like activation's, so a dead Valkey cannot hold the request's transaction.
   */
  private async onConfigurationUpdated(results: any, req: any): Promise<void> {
    if (!req || !documentChanged.has(req)) {
      return;
    }
    // An OData PATCH hands a single object here (never an array), holding only what was sent:
    // the row's isActive, name and version are read back within the request.
    const updated = Array.isArray(results) ? results[0] : results;
    const ID = updated?.ID ?? req.data?.ID;
    if (!ID) {
      return;
    }
    const config = await cds.run(
      cds.ql.SELECT.one.from('sap.llm.gateway.admin.ApiConfigurations').columns('ID', 'name', 'version', 'checksum', 'isActive').where({ ID })
    );
    if (!config?.isActive) {
      return;
    }
    try {
      await this.publishWithTimeout({
        eventType: 'config-changed',
        configId: config.ID,
        configName: config.name,
        version: config.version,
        checksum: config.checksum,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      // The update is stored; a failed publish must not fail (and roll back) the request.
      logger.warn('ConfigService', 'Event publishing failed after a configuration update', { error: (error as Error).message });
    }
  }

  /** publishConfigurationEvent, rejected with 'Event publish timeout' after PUBLISH_TIMEOUT_MS. */
  private async publishWithTimeout(event: ConfigChangeEvent): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.publishConfigurationEvent(event),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Event publish timeout')), PUBLISH_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Event handler for configuration creation
   */
  private async onConfigurationCreated(results: any, req: any): Promise<void> {
    // Log configuration creation but don't publish events until activation
    if (results && results.length > 0) {
      logger.info('ConfigService', 'Configuration created', {
        configId: results[0].ID,
        version: results[0].version
      });
    }
  }

  /**
   * Validate configuration data structure and business rules
   */
  private async validateConfigurationData(configData: any): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (!configData) {
        errors.push('Configuration data is required');
        return { valid: false, errors, warnings };
      }

      // JSON Schema validation first
      const isValidSchema = validateConfigSchema(configData);
      if (!isValidSchema) {
        if (validateConfigSchema.errors) {
          for (const error of validateConfigSchema.errors) {
            const message = formatSchemaError(error);
            if (message !== null) {
              errors.push(message);
            }
          }
        }
        return { valid: false, errors, warnings };
      }

      // Validate api_config structure (redundant after schema validation, but kept for backward compatibility)
      if (!configData.api_config) {
        errors.push('Configuration must include api_config object');
        return { valid: false, errors, warnings };
      }

      const apiConfig = configData.api_config as any;

      // Validate timeouts
      const timeouts = apiConfig.platform?.timeouts;
      if (timeouts) {
        if (timeouts.default && timeouts.default < 1000) {
          warnings.push('Default timeout is very low (< 1 second)');
        }
        if (timeouts.streaming && timeouts.streaming < 30000) {
          warnings.push('Streaming timeout is very low (< 30 seconds)');
        }
      }

      // Validate providers
      if (apiConfig.providers) {
        // Validate model substitutions
        for (const [provider, config] of Object.entries(apiConfig.providers)) {
          if (typeof config === 'object' && config !== null) {
            const providerConfig = config as any;
            if (providerConfig.substitute_models && Array.isArray(providerConfig.substitute_models)) {
              for (const substitution of providerConfig.substitute_models) {
                if (!substitution.from || !substitution.to) {
                  errors.push(`Invalid model substitution in ${provider}: missing 'from' or 'to' field`);
                }
              }
            }
          }
        }
        warnings.push(...await unknownConnectionTargets(apiConfig.providers));
      }

      // Validate SIEM sink names are distinct
      errors.push(...findDuplicateSinkNames(apiConfig.observability?.siem));

      // Validate models.overrides
      if (apiConfig.models?.overrides) {
        for (const [modelId, modelConfig] of Object.entries(apiConfig.models.overrides as Record<string, unknown>)) {
          const config = modelConfig as any;
          if (config.hooks) {
            for (const [subpath, hooks] of Object.entries(config.hooks)) {
              if (!Array.isArray(hooks)) {
                errors.push(`Invalid hooks configuration for model ${modelId}, subpath ${subpath}: must be an array`);
              }
            }
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings
      };
    } catch (error) {
      return {
        valid: false,
        errors: ['Configuration validation failed: Invalid JSON structure'],
        warnings: []
      };
    }
  }

  /**
   * Publish configuration change event to Valkey
   */
  private async publishConfigurationEvent(event: ConfigChangeEvent): Promise<void> {
    if (!this.isValkeyAvailable || !this.valkeyClient) {
      logger.warn('ConfigService', 'Skipping event publishing - Valkey not available', {
        isValkeyAvailable: this.isValkeyAvailable,
        hasValkeyClient: !!this.valkeyClient
      });
      return;
    }

    try {
      // Use the standard CONFIG_CHANGE_CHANNEL that Gateway expects
      const channel = CONFIG_CHANGE_CHANNEL; // 'sap-llm-gateway:config-changed'
      
      // Include the full configuration data for immediate gateway reload
      const fullConfig = await this.getActiveConfiguration({});
      const enhancedEvent = {
        ...event,
        configData: fullConfig.success ? fullConfig.data?.configData : undefined,
        source: 'admin-service-activation'
      };
      
      const message = JSON.stringify(enhancedEvent);
      
      const subscriberCount = await this.valkeyClient.publish(channel, message);
      
      logger.info('ConfigService', 'Published configuration event to gateway', {
        channel,
        eventType: event.eventType,
        version: event.version,
        configName: event.configName,
        subscriberCount,
        messageSize: message.length
      });
      
      // Also publish to the specific event type channel for backwards compatibility
      const specificChannel = `sap-llm-gateway:${event.eventType}`;
      await this.valkeyClient.publish(specificChannel, JSON.stringify(event));
      
      logger.debug('ConfigService', 'Also published to specific channel', {
        channel: specificChannel
      });
      
    } catch (error) {
      logger.error('ConfigService', 'Failed to publish configuration event', error as Error, {
        event: event.eventType,
        configName: event.configName
      });
      throw error; // Re-throw to trigger timeout handling
    }
  }

  /**
   * Generate semantic version string
   */
  private generateVersion(): string {
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const major = date.getFullYear();
    const minor = date.getMonth() + 1;
    const patch = date.getDate() * 10000 + date.getHours() * 100 + date.getMinutes();
    
    return `${major}.${minor}.${patch}`;
  }

  /**
   * Generate SHA-256 checksum for configuration data
   */
  private generateChecksum(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Initialize startup event publishing
   */
  private async initializeStartupEventPublishing(): Promise<void> {
    // Delay startup event publishing to ensure service and database are fully initialized
    setTimeout(async () => {
      // Wait for database connection to be established
      let retries = 0;
      const maxRetries = 30;
      while (!cds.db && retries < maxRetries) {
        logger.debug('ConfigService', `Waiting for database connection... (attempt ${retries + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        retries++;
      }
      
      if (cds.db) {
        await this.publishStartupEvent();
      } else {
        logger.warn('ConfigService', 'Database connection not established after 30 seconds - skipping startup event');
      }
    }, 3000); // 3 second initial delay
  }

  /**
   * Publish admin service startup event with current configuration
   */
  private async publishStartupEvent(): Promise<void> {
    if (!this.isValkeyAvailable || !valkeyPublisher || startupEventPublished) {
      logger.debug('ConfigService', 'Skipping startup event - Valkey unavailable or already published');
      return;
    }

    try {
      // Check if database is connected before trying to query
      if (!cds.db) {
        logger.warn('ConfigService', 'Database not connected yet - skipping startup event');
        return;
      }

      // Get current active configuration
      const activeConfigResult = await this.getActiveConfiguration({});
      
      if (activeConfigResult.success && activeConfigResult.data) {
        // Publish configuration change event with current active config
        const configEvent = {
          eventType: 'config-activated',
          configId: activeConfigResult.data.id,
          configName: activeConfigResult.data.name,
          version: activeConfigResult.data.version,
          checksum: activeConfigResult.data.checksum,
          timestamp: new Date().toISOString(),
          source: 'admin-service-startup',
          configData: activeConfigResult.data.configData
        };

        await valkeyPublisher.publish(CONFIG_CHANGE_CHANNEL, JSON.stringify(configEvent));
        
        logger.info('ConfigService', 'Published startup configuration event', {
          configId: activeConfigResult.data.id,
          configName: activeConfigResult.data.name,
          version: activeConfigResult.data.version
        });
      } else {
        logger.warn('ConfigService', 'No active configuration found during startup - Gateway Service will use fallback/local config');
        
        // Optionally, create a default configuration if none exists
        await this.createDefaultConfigurationIfNeeded();
      }

      // Publish admin service ready event
      const startupEvent = {
        eventType: 'admin-service-started',
        service: 'admin-service',
        timestamp: new Date().toISOString(),
        hasActiveConfig: activeConfigResult.success,
        configVersion: activeConfigResult.success ? activeConfigResult.data?.version : null
      };

      await valkeyPublisher.publish(STARTUP_READY_CHANNEL, JSON.stringify(startupEvent));
      
      startupEventPublished = true;
      logger.info('ConfigService', 'Admin Service startup event published successfully');
      
    } catch (error) {
      logger.error('ConfigService', 'Failed to publish startup event', error as Error);
    }
  }

  /**
   * Handle incoming Valkey events (model lists, startup coordination)
   */
  private async handleValkeyEvent(channel: string, message: string): Promise<void> {
    try {
      const event = JSON.parse(message);
      
      switch (channel) {
        case MODEL_LIST_CHANNEL:
          await this.handleModelListEvent(event);
          break;
        case STARTUP_READY_CHANNEL:
          await this.handleStartupReadyEvent(event);
          break;
        default:
          logger.debug('ConfigService', `Received unknown channel event: ${channel}`);
      }
    } catch (error) {
      logger.error('ConfigService', `Failed to handle Valkey event from channel ${channel}`, error as Error);
    }
  }

  /**
   * Handle model list updates from Gateway Service
   */
  private async handleModelListEvent(modelListEvent: any): Promise<void> {
    logger.info('ConfigService', 'Received model list update from Gateway Service', {
      source: modelListEvent.source,
      modelCount: modelListEvent.modelCount,
      configurationReceived: modelListEvent.configurationReceived
    });
    
    try {
      // Pass the model list to ModelCostService for pricing updates
      await modelCostService.processModelListFromEvent(modelListEvent);
      
      // Store model list information for admin UI or other purposes
      // This could be stored in database or cache for admin service access
      logger.debug('ConfigService', 'Model list details', {
        eventType: modelListEvent.eventType,
        timestamp: modelListEvent.timestamp,
        models: modelListEvent.models?.length || 0
      });
    } catch (error) {
      logger.error('ConfigService', 'Error processing model list event', error as Error);
    }
  }

  /**
   * Handle startup ready events from other services
   */
  private async handleStartupReadyEvent(startupEvent: any): Promise<void> {
    logger.info('ConfigService', 'Received startup ready event', {
      service: startupEvent.service,
      eventType: startupEvent.eventType
    });
    
    // Ignore our own startup events to avoid self-processing
    if (startupEvent.service === 'admin-service') {
      logger.debug('ConfigService', 'Ignoring self-published startup event');
      return;
    }
    
    if (startupEvent.service === 'gateway-service' && startupEvent.eventType === 'gateway-startup-request') {
      // Gateway service is requesting initial configuration
      logger.info('ConfigService', 'Gateway Service requesting configuration - republishing current config');
      
      // Re-publish current configuration for the requesting gateway
      await this.republishCurrentConfiguration();
    }
  }

  /**
   * Republish current active configuration
   */
  private async republishCurrentConfiguration(): Promise<void> {
    if (!this.isValkeyAvailable || !valkeyPublisher) {
      return;
    }

    try {
      const activeConfigResult = await this.getActiveConfiguration({});
      
      if (activeConfigResult.success && activeConfigResult.data) {
        const configEvent = {
          eventType: 'config-activated',
          configId: activeConfigResult.data.id,
          configName: activeConfigResult.data.name,
          version: activeConfigResult.data.version,
          checksum: activeConfigResult.data.checksum,
          timestamp: new Date().toISOString(),
          source: 'admin-service-republish',
          configData: activeConfigResult.data.configData
        };

        await valkeyPublisher.publish(CONFIG_CHANGE_CHANNEL, JSON.stringify(configEvent));
        
        logger.info('ConfigService', 'Republished current configuration', {
          configId: activeConfigResult.data.id,
          configName: activeConfigResult.data.name,
          version: activeConfigResult.data.version
        });
      }
    } catch (error) {
      logger.error('ConfigService', 'Failed to republish configuration', error as Error);
    }
  }

  /**
   * Create default configuration if none exists
   */
  private async createDefaultConfigurationIfNeeded(): Promise<void> {
    try {
      // Check if database is connected before trying to query
      if (!cds.db) {
        logger.warn('ConfigService', 'Database not connected yet - skipping default configuration creation');
        return;
      }

      // Check if any configuration exists
      const SELECT = cds.ql.SELECT.from('sap.llm.gateway.admin.ApiConfigurations')
        .columns(['ID'])
        .limit(1);
      
      const existing = await cds.run(SELECT);
      
      if (existing.length === 0) {
        logger.info('ConfigService', 'No configurations found - creating default configuration from api_config.json');
        
        // Load default configuration from api_config.json file
        const fs = require('fs');
        const path = require('path');
        
        const configPath = path.join(process.cwd(), 'api_config.json');
        let defaultConfig;
        
        try {
          const configData = fs.readFileSync(configPath, 'utf8');
          defaultConfig = JSON.parse(configData);
          logger.info('ConfigService', 'Loaded default configuration from api_config.json');
        } catch (fileError) {
          logger.warn('ConfigService', 'Could not load api_config.json, using minimal default', {
            error: fileError instanceof Error ? fileError.message : String(fileError)
          });
          
          // Fallback to minimal default if file doesn't exist
          defaultConfig = MINIMAL_DEFAULT_CONFIG;
        }
        
        const createResult = await this.createConfiguration({
          data: {
            name: 'Default Configuration',
            description: 'Auto-generated default configuration loaded from api_config.json',
            configData: JSON.stringify(defaultConfig)
          },
          user: { id: 'system' }
        });
        
        if (createResult.success) {
          // Activate the default configuration
          const activateResult = await this.activateConfiguration({
            data: { configId: createResult.configId },
            user: { id: 'system' }
          });
          
          if (activateResult.success) {
            logger.info('ConfigService', 'Default configuration created and activated', {
              configId: createResult.configId,
              version: activateResult.version
            });
            
            // Publish the newly activated configuration
            const configEvent = {
              eventType: 'config-activated',
              version: activateResult.version,
              checksum: activateResult.checksum,
              timestamp: new Date().toISOString(),
              source: 'admin-service-default-config'
            };
            
            if (this.isValkeyAvailable && valkeyPublisher) {
              await valkeyPublisher.publish(CONFIG_CHANGE_CHANNEL, JSON.stringify(configEvent));
              logger.info('ConfigService', 'Published default configuration event');
            }
          } else {
            logger.warn('ConfigService', 'Failed to activate default configuration', {
              error: activateResult.error
            });
          }
        } else {
          logger.warn('ConfigService', 'Failed to create default configuration', {
            errors: createResult.errors
          });
        }
      }
    } catch (error) {
      logger.error('ConfigService', 'Error creating default configuration', error as Error);
    }
  }

  /**
   * Cleanup resources
   */
  async shutdown(): Promise<void> {
    if (this.valkeyClient) {
      await this.valkeyClient.quit();
    }
    if (valkeyPublisher) {
      await valkeyPublisher.quit();
    }
    if (valkeySubscriber) {
      await valkeySubscriber.quit();
    }
  }
}

// Export singleton instance
const configurationService = new ConfigurationService();

// Initialize with CDS service
module.exports = (srv: any) => {
  configurationService.init(srv);
  return configurationService;
};

export default configurationService;