const cds = require('@sap/cds');
import crypto from 'crypto';
import axios from 'axios';
import Valkey from 'iovalkey';
import Ajv from 'ajv';
import { getDefaultLogger } from '@libs/logger';
import { modelCostService } from '../services/modelCostService';
import * as configSchema from '../schemas/api-config-schema.json';

const logger = getDefaultLogger();

// JSON Schema validator (without formats for now to avoid import issues)
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateConfigSchema = ajv.compile(configSchema);

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
        isValid: validation.valid,  // Store validation result
        validationErrors: validation.errors.length > 0 ? JSON.stringify(validation.errors) : null,
        validationWarnings: validation.warnings.length > 0 ? JSON.stringify(validation.warnings) : null,
        lastValidated: now,
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
        
        // Step 2: Then activate the target configuration
        const activateResult = await cds.run(
          `UPDATE sap_llm_gateway_admin_ApiConfigurations 
           SET isActive = true, deployedAt = ?, deployedBy = ?, modifiedAt = ?, modifiedBy = ?
           WHERE ID = ?`,
          [now, user, now, user, configId]
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
        await Promise.race([
          this.publishConfigurationEvent({
            eventType: 'config-activated',
            configId: config.ID,
            configName: config.name,
            version: config.version,
            checksum: config.checksum,
            timestamp: new Date().toISOString()
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Event publish timeout')), 3000)
          )
        ]);
      } catch (error) {
        logger.warn('ConfigService', 'Event publishing failed during activation', { error: (error as Error).message });
        // Don't fail the activation if event publishing fails
      }

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
   * Event handler for configuration updates
   */
  private async onConfigurationUpdated(results: any, req: any): Promise<void> {
    if (results && results.length > 0) {
      const config = results[0];
      if (config.isActive) {
        await this.publishConfigurationEvent({
          eventType: 'config-changed',
          configId: config.ID,
          configName: config.name,
          version: config.version,
          checksum: config.checksum,
          timestamp: new Date().toISOString()
        });
      }
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
            const path = error.instancePath || error.schemaPath || 'root';
            const message = error.message || 'Unknown validation error';
            errors.push(`Schema validation error at '${path}': ${message}`);
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
      if (apiConfig.timeouts) {
        if (apiConfig.timeouts.default && apiConfig.timeouts.default < 1000) {
          warnings.push('Default timeout is very low (< 1 second)');
        }
        if (apiConfig.timeouts.streaming && apiConfig.timeouts.streaming < 30000) {
          warnings.push('Streaming timeout is very low (< 30 seconds)');
        }
      }

      // Validate providers
      if (apiConfig.anthropic || apiConfig.openai || apiConfig['aws-bedrock'] || apiConfig.openrouter) {
        // Validate model substitutions
        for (const [provider, config] of Object.entries(apiConfig)) {
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
      }

      // Validate model_list_changes
      if (apiConfig.model_list_changes) {
        for (const [modelId, modelConfig] of Object.entries(apiConfig.model_list_changes)) {
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
          defaultConfig = {
            api_config: {
              openai: {
                substitute_models: [
                  { from: "GPT-4", to: "o1" },
                  { from: "GPT-3.5", to: "GPT-4" }
                ],
                emulate_streaming_for_models: []
              },
              anthropic: {
                substitute_models: [
                  { from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" },
                  { from: "claude-3-7-sonnet-20250219", to: "anthropic--claude-3.7-sonnet" }
                ],
                emulate_streaming_for_models: ["anthropic--claude-3.7-sonnet"]
              },
              timeouts: {
                default: 120000,
                streaming: 240000
              },
              logging: {
                defaultLevel: "info"
              }
            }
          };
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