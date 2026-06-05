import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { watch } from 'chokidar';
import { getDefaultLogger } from '@libs/logger';

// Initialize logger
const logger = getDefaultLogger();

interface ConfigData {
  config: any;
  version: number;
  checksum: string;
  lastModified: Date;
  environment: string;
}

interface ConfigSubscriber {
  serviceId: string;
  callbackUrl: string;
  environment: string;
  registeredAt: Date;
  lastNotified: Date | null;
}

/**
 * File-based Configuration Service
 * Serves api_config.json to gateway service with change notifications
 */
class FileConfigService {
  private configPath: string;
  private configCache: ConfigData | null = null;
  private subscribers: Map<string, ConfigSubscriber> = new Map();
  private fileWatcher: any = null;
  
  constructor() {
    // Look for api_config.json in multiple locations
    const possiblePaths = [
      path.join(process.cwd(), 'config', 'api_config.json'),
      path.join(process.cwd(), 'api_config.json'),
      path.join(__dirname, '..', '..', 'config', 'api_config.json'),
      path.join(__dirname, '..', '..', '..', '..', 'gateway', 'api_config.json')
    ];
    
    this.configPath = possiblePaths[0]; // Default to first path
    this.initializeService();
  }

  init(service: any): void {
    // Configuration endpoints
    service.on('getConfig', this.getConfig.bind(this));
    service.on('checkConfigUpdate', this.checkConfigUpdate.bind(this));
    service.on('reloadConfig', this.reloadConfig.bind(this));
    
    // Webhook subscription
    service.on('registerConfigWebhook', this.registerConfigWebhook.bind(this));
    service.on('unregisterConfigWebhook', this.unregisterConfigWebhook.bind(this));
    service.on('listConfigWebhooks', this.listConfigWebhooks.bind(this));
    
    // File management
    service.on('updateConfig', this.updateConfig.bind(this));
    service.on('getConfigStatus', this.getConfigStatus.bind(this));
  }

  /**
   * Initialize the configuration service
   */
  private async initializeService(): Promise<void> {
    try {
      // Find the actual config file
      await this.findConfigFile();
      
      // Load initial configuration
      await this.loadConfigFromFile();
      
      // Set up file watcher
      this.setupFileWatcher();
      
      logger.debug('file-config-service', 'File config service initialized', { configPath: this.configPath });
    } catch (error) {
      logger.error('file-config-service', 'Failed to initialize file config service', error as Error);
    }
  }

  /**
   * Find the api_config.json file in possible locations
   */
  private async findConfigFile(): Promise<void> {
    const possiblePaths = [
      path.join(process.cwd(), 'config', 'api_config.json'),
      path.join(process.cwd(), 'api_config.json'),
      path.join(__dirname, '..', '..', 'config', 'api_config.json'),
      path.join(__dirname, '..', '..', '..', '..', 'gateway', 'api_config.json'),
      // Try to find gateway service config
      path.join(__dirname, '..', '..', '..', 'gateway', 'api_config.json')
    ];
    
    for (const configPath of possiblePaths) {
      try {
        await fs.access(configPath);
        this.configPath = configPath;
        logger.debug('file-config-service', 'Found config file', { configPath });
        return;
      } catch {
        // File doesn't exist, try next
      }
    }
    
    // If no config file found, create a default one
    logger.warn('file-config-service', 'No api_config.json found, creating default configuration');
    await this.createDefaultConfig();
  }

  /**
   * Create a default configuration file
   */
  private async createDefaultConfig(): Promise<void> {
    const defaultConfig = {
      providers: {
        openai: {
          apiKey: "${OPENAI_API_KEY}",
          baseURL: "https://api.openai.com/v1",
          timeout: 30000
        },
        anthropic: {
          apiKey: "${ANTHROPIC_API_KEY}",
          baseURL: "https://api.anthropic.com",
          timeout: 30000
        },
        "aws-bedrock": {
          region: "${AWS_REGION}",
          timeout: 30000
        }
      },
      models: [
        {
          id: "gpt-4",
          provider: "openai",
          name: "GPT-4",
          maxTokens: 8192
        },
        {
          id: "claude-3-sonnet-20240229",
          provider: "anthropic", 
          name: "Claude 3 Sonnet",
          maxTokens: 200000
        }
      ],
      defaultModel: "gpt-4",
      rateLimits: {
        requestsPerMinute: 60,
        requestsPerHour: 1000
      },
      logging: {
        level: "info",
        requests: true,
        responses: false
      }
    };

    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2));
    
    logger.debug('file-config-service', 'Created default config', { configPath: this.configPath });
  }

  /**
   * Load configuration from file
   */
  private async loadConfigFromFile(): Promise<void> {
    try {
      const configData = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(configData);
      const stats = await fs.stat(this.configPath);
      
      this.configCache = {
        config,
        version: stats.mtimeMs, // Use file modification time as version
        checksum: this.generateChecksum(configData),
        lastModified: stats.mtime,
        environment: process.env.NODE_ENV || 'development'
      };
      
      logger.debug('file-config-service', 'Configuration loaded', { version: this.configCache.version });
    } catch (error) {
      logger.error('file-config-service', 'Failed to load configuration from file', error as Error);
      throw error;
    }
  }

  /**
   * Set up file watcher for configuration changes
   */
  private setupFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
    }
    
    this.fileWatcher = watch(this.configPath, { 
      persistent: true,
      ignoreInitial: true
    });
    
    this.fileWatcher.on('change', async () => {
      logger.debug('file-config-service', 'Configuration file changed, reloading');
      
      try {
        const oldVersion = this.configCache?.version || 0;
        await this.loadConfigFromFile();
        
        if (this.configCache && this.configCache.version !== oldVersion) {
          logger.debug('file-config-service', 'Configuration updated', { version: this.configCache.version });
          await this.notifySubscribers();
        }
      } catch (error) {
        logger.error('file-config-service', 'Failed to reload configuration', error as Error);
      }
    });
    
    this.fileWatcher.on('error', (error: any) => {
      logger.error('file-config-service', 'File watcher error', error as Error);
    });
  }

  /**
   * Get current configuration
   */
  async getConfig(req: any): Promise<{
    success: boolean;
    config?: any;
    version?: number;
    checksum?: string;
    lastModified?: Date;
    error?: string;
  }> {
    try {
      if (!this.configCache) {
        await this.loadConfigFromFile();
      }
      
      if (!this.configCache) {
        return {
          success: false,
          error: 'Configuration not available'
        };
      }
      
      return {
        success: true,
        config: this.configCache.config,
        version: this.configCache.version,
        checksum: this.configCache.checksum,
        lastModified: this.configCache.lastModified
      };
    } catch (error) {
      logger.error('file-config-service', 'Failed to get configuration', error as Error);
      return {
        success: false,
        error: 'Failed to retrieve configuration'
      };
    }
  }

  /**
   * Check if configuration has been updated
   */
  async checkConfigUpdate(req: any): Promise<{
    hasUpdate: boolean;
    currentVersion: number;
    currentChecksum: string;
    needsReload: boolean;
  }> {
    const { version = 0, checksum = '' } = req.data || {};
    
    try {
      if (!this.configCache) {
        await this.loadConfigFromFile();
      }
      
      if (!this.configCache) {
        return {
          hasUpdate: false,
          currentVersion: version,
          currentChecksum: checksum,
          needsReload: false
        };
      }
      
      const hasVersionUpdate = this.configCache.version > version;
      const hasChecksumChange = this.configCache.checksum !== checksum;
      
      return {
        hasUpdate: hasVersionUpdate || hasChecksumChange,
        currentVersion: this.configCache.version,
        currentChecksum: this.configCache.checksum,
        needsReload: hasVersionUpdate || hasChecksumChange
      };
    } catch (error) {
      logger.error('file-config-service', 'Failed to check configuration update', error as Error);
      return {
        hasUpdate: false,
        currentVersion: version,
        currentChecksum: checksum,
        needsReload: false
      };
    }
  }

  /**
   * Force reload configuration from file
   */
  async reloadConfig(): Promise<{
    success: boolean;
    version?: number;
    error?: string;
  }> {
    try {
      await this.loadConfigFromFile();
      await this.notifySubscribers();
      
      return {
        success: true,
        version: this.configCache?.version
      };
    } catch (error) {
      logger.error('file-config-service', 'Failed to reload configuration', error as Error);
      return {
        success: false,
        error: 'Failed to reload configuration'
      };
    }
  }

  /**
   * Register webhook for configuration changes
   */
  async registerConfigWebhook(req: any): Promise<{
    success: boolean;
    subscriberId?: string;
    error?: string;
  }> {
    const { serviceId, callbackUrl, environment = 'development' } = req.data || {};
    
    if (!serviceId || !callbackUrl) {
      return {
        success: false,
        error: 'serviceId and callbackUrl are required'
      };
    }
    
    const subscriberId = `${serviceId}-${environment}-${Date.now()}`;
    
    this.subscribers.set(subscriberId, {
      serviceId,
      callbackUrl,
      environment,
      registeredAt: new Date(),
      lastNotified: null
    });
    
    logger.debug('file-config-service', 'Registered config webhook', { serviceId, callbackUrl });
    
    return {
      success: true,
      subscriberId
    };
  }

  /**
   * Unregister webhook
   */
  async unregisterConfigWebhook(req: any): Promise<{
    success: boolean;
    removed?: number;
    error?: string;
  }> {
    const { serviceId, subscriberId } = req.data || {};
    
    if (subscriberId) {
      // Remove specific subscriber
      const removed = this.subscribers.delete(subscriberId);
      return {
        success: true,
        removed: removed ? 1 : 0
      };
    } else if (serviceId) {
      // Remove all subscribers for this service
      const toRemove = Array.from(this.subscribers.entries())
        .filter(([_, sub]) => sub.serviceId === serviceId)
        .map(([id]) => id);
      
      toRemove.forEach(id => this.subscribers.delete(id));
      
      return {
        success: true,
        removed: toRemove.length
      };
    } else {
      return {
        success: false,
        error: 'serviceId or subscriberId is required'
      };
    }
  }

  /**
   * List registered webhooks
   */
  async listConfigWebhooks(): Promise<{
    webhooks: Array<{
      subscriberId: string;
      serviceId: string;
      callbackUrl: string;
      environment: string;
      registeredAt: Date;
      lastNotified: Date | null;
    }>;
    total: number;
  }> {
    const webhooks = Array.from(this.subscribers.entries()).map(([id, sub]) => ({
      subscriberId: id,
      serviceId: sub.serviceId,
      callbackUrl: sub.callbackUrl,
      environment: sub.environment,
      registeredAt: sub.registeredAt,
      lastNotified: sub.lastNotified
    }));
    
    return {
      webhooks,
      total: webhooks.length
    };
  }

  /**
   * Update configuration file
   */
  async updateConfig(req: any): Promise<{
    success: boolean;
    version?: number;
    error?: string;
  }> {
    const { config } = req.data || {};
    
    if (!config) {
      return {
        success: false,
        error: 'Configuration data is required'
      };
    }
    
    try {
      // Validate configuration structure
      if (typeof config !== 'object') {
        throw new Error('Configuration must be an object');
      }
      
      // Write to file
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
      
      // Reload from file (this will trigger file watcher)
      await this.loadConfigFromFile();
      
      return {
        success: true,
        version: this.configCache?.version
      };
    } catch (error) {
      logger.error('file-config-service', 'Failed to update configuration', error as Error);
      return {
        success: false,
        error: `Failed to update configuration: ${(error as Error).message}`
      };
    }
  }

  /**
   * Get configuration service status
   */
  async getConfigStatus(): Promise<{
    status: string;
    configPath: string;
    exists: boolean;
    version: number | null;
    lastModified: Date | null;
    subscriberCount: number;
    fileWatcherActive: boolean;
  }> {
    let exists = false;
    try {
      await fs.access(this.configPath);
      exists = true;
    } catch {
      exists = false;
    }
    
    return {
      status: exists && this.configCache ? 'healthy' : 'degraded',
      configPath: this.configPath,
      exists,
      version: this.configCache?.version || null,
      lastModified: this.configCache?.lastModified || null,
      subscriberCount: this.subscribers.size,
      fileWatcherActive: !!this.fileWatcher
    };
  }

  /**
   * Notify subscribers of configuration changes
   */
  private async notifySubscribers(): Promise<void> {
    if (this.subscribers.size === 0 || !this.configCache) {
      return;
    }
    
    logger.debug('file-config-service', 'Notifying subscribers of configuration change', { count: this.subscribers.size });
    
    const payload = {
      event: 'configuration_changed',
      version: this.configCache.version,
      checksum: this.configCache.checksum,
      timestamp: new Date().toISOString()
    };
    
    const notifications = Array.from(this.subscribers.entries()).map(async ([subscriberId, subscriber]) => {
      try {
        const response = await axios.post(subscriber.callbackUrl, payload, {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'X-Config-Event': 'configuration_changed',
            'X-Config-Version': this.configCache!.version.toString()
          }
        });
        
        if (response.status === 200) {
          subscriber.lastNotified = new Date();
          logger.debug('file-config-service', 'Successfully notified subscriber', { serviceId: subscriber.serviceId });
        } else {
          logger.warn('file-config-service', 'Unexpected response from subscriber', { serviceId: subscriber.serviceId, status: response.status });
        }
      } catch (error: any) {
        logger.error('file-config-service', 'Failed to notify subscriber', new Error(`Failed to notify ${subscriber.serviceId}`), {
          error: error.message,
          subscriberId,
          callbackUrl: subscriber.callbackUrl
        });
      }
    });
    
    await Promise.allSettled(notifications);
  }

  /**
   * Generate checksum for configuration data
   */
  private generateChecksum(configData: string): string {
    return crypto.createHash('sha256').update(configData).digest('hex');
  }

  /**
   * Cleanup on service shutdown
   */
  destroy(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }
}

// Export the service class
const fileConfigService = new FileConfigService();

// Cleanup on process exit
process.on('exit', () => fileConfigService.destroy());
process.on('SIGINT', () => fileConfigService.destroy());
process.on('SIGTERM', () => fileConfigService.destroy());

// Initialize with CDS service when module is loaded
module.exports = (srv: any) => {
  fileConfigService.init(srv);
  return fileConfigService;
};