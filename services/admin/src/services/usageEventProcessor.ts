// Make Valkey optional since it may not be installed
let Redis: any;
try {
  Redis = require('iovalkey');
} catch (error) {
  // Valkey not available, will use fallback mode only
}
import { getDefaultLogger } from '@libs/logger';
import modelCostService from './modelCostService';

const logger = getDefaultLogger();
const cds = require('@sap/cds');
const { INSERT, SELECT } = cds.ql;

export interface UsageEvent {
  requestId: string;
  timestamp: number;
  authType: 'api_key' | 'aws_credential';
  credentialId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number; // Separate tracking for cache creation tokens
  cacheReadInputTokens?: number; // Separate tracking for cache read tokens
  responseTime: number;
  statusCode: number;
  endpoint?: string; // Add endpoint information for better granularity
}

interface UsageProcessorConfig {
  valkeyUrl?: string;
  batchSize: number;
  batchInterval: number; // milliseconds
  enableCostCalculation: boolean;
}

/**
 * Usage event processor for admin service
 * Handles incoming usage events from gateway and persists them to database
 */
class UsageEventProcessor {
  private config: UsageProcessorConfig;
  private valkeyClient?: any;
  private batchBuffer: UsageEvent[] = [];
  private batchTimer?: NodeJS.Timeout;
  private isProcessing = false;
  private processedRequestIds = new Set<string>(); // Track processed request IDs to prevent duplicates
  private readonly maxProcessedIds = 10000; // Limit memory usage

  constructor(config: Partial<UsageProcessorConfig> = {}) {
    this.config = {
      valkeyUrl: process.env.VALKEY_URL,
      batchSize: 100,
      batchInterval: 30000, // 30 seconds
      enableCostCalculation: true,
      ...config
    };
  }

  /**
   * Initialize the usage event processor
   */
  async initialize(): Promise<void> {
    try {
      // Initialize model cost service first
      await modelCostService.initialize();
      
      if (this.config.valkeyUrl) {
        logger.info('UsageEventProcessor', 'Initializing Valkey subscription for usage events');
        await this.initializeValkeySubscription();
      } else {
        logger.info('UsageEventProcessor', 'Valkey not configured, usage events will need to be manually fed');
      }

      // Start batch processing timer
      this.startBatchTimer();
      logger.info('UsageEventProcessor', 'Usage event processor initialized');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('UsageEventProcessor', `Failed to initialize usage event processor: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Initialize Valkey subscription to listen for usage events
   */
  private async initializeValkeySubscription(): Promise<void> {
    if (!this.config.valkeyUrl) return;

    try {
      if (!Redis) {
        logger.warn('UsageEventProcessor', 'iovalkey not available, skipping Valkey subscription');
        return;
      }
      this.valkeyClient = new Redis(this.config.valkeyUrl);
      
      this.valkeyClient.on('error', (err: Error) => {
        logger.warn('UsageEventProcessor', 'Valkey client error:', err.message);
      });

      this.valkeyClient.on('connect', () => {
        logger.info('UsageEventProcessor', 'Connected to Valkey for usage event subscription');
      });

      // Set up message handler first
      this.valkeyClient.on('message', (channel: string, message: string) => {
        try {
          logger.debug('UsageEventProcessor', `Received message on channel ${channel}: ${message ? message.substring(0, 100) + '...' : 'NULL'}`);
          
          if (channel !== 'usage-events') return;
          
          // Skip null or empty messages
          if (message === null || message === undefined || message === '') {
            logger.debug('UsageEventProcessor', 'Skipping null/empty usage event message');
            return;
          }
          
          const event: UsageEvent = JSON.parse(message);
          this.queueEvent(event);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          logger.warn('UsageEventProcessor', `Failed to parse usage event: ${errorMsg} - Message: ${message}`);
        }
      });
      
      // Subscribe to usage events (iovalkey auto-connects)
      await this.valkeyClient.subscribe('usage-events');

      logger.info('UsageEventProcessor', 'Subscribed to usage-events channel');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('UsageEventProcessor', `Failed to initialize Valkey subscription: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Queue usage event for batch processing
   */
  private queueEvent(event: UsageEvent): void {
    // Check for duplicate requests
    if (this.processedRequestIds.has(event.requestId)) {
      logger.debug('UsageEventProcessor', `Skipping duplicate usage event with requestId: ${event.requestId}`);
      return;
    }
    
    this.batchBuffer.push(event);
    logger.info('UsageEventProcessor', `Queued usage event - requestId: ${event.requestId}, bufferSize: ${this.batchBuffer.length}`);
    
    // Process immediately if batch is full
    if (this.batchBuffer.length >= this.config.batchSize) {
      this.processBatch();
    }
  }

  /**
   * Start the batch processing timer
   */
  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      if (this.batchBuffer.length > 0) {
        this.processBatch();
      }
    }, this.config.batchInterval);
  }

  /**
   * Process batched usage events
   */
  private async processBatch(): Promise<void> {
    logger.debug('UsageEventProcessor', `processBatch called - isProcessing: ${this.isProcessing}, bufferLength: ${this.batchBuffer.length}`);
    
    if (this.isProcessing || this.batchBuffer.length === 0) {
      return;
    }

    // Check if model data is available before processing
    if (!modelCostService.hasValidModelData()) {
      logger.debug('UsageEventProcessor', `Skipping batch processing - model data not yet available (${this.batchBuffer.length} events queued)`);
      return;
    }
    
    logger.info('UsageEventProcessor', `Starting batch processing of ${this.batchBuffer.length} usage events`);

    this.isProcessing = true;
    const batch = [...this.batchBuffer];
    this.batchBuffer = [];

    try {
      logger.debug('UsageEventProcessor', `Processing batch of ${batch.length} usage events`);
      
      await this.persistUsageEvents(batch);
      
      // Mark all request IDs as processed
      batch.forEach(event => {
        this.processedRequestIds.add(event.requestId);
      });
      
      // Limit memory usage by removing oldest entries
      if (this.processedRequestIds.size > this.maxProcessedIds) {
        const idsToRemove = Array.from(this.processedRequestIds).slice(0, this.processedRequestIds.size - this.maxProcessedIds);
        idsToRemove.forEach(id => this.processedRequestIds.delete(id));
      }
      
      logger.debug('UsageEventProcessor', `Successfully processed ${batch.length} usage events`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('UsageEventProcessor', `Failed to process usage event batch (size: ${batch.length}): ${errorMsg}`);
      
      // Re-queue events on failure (simple retry mechanism)
      this.batchBuffer = [...batch, ...this.batchBuffer];
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Persist usage events to database
   */
  private async persistUsageEvents(events: UsageEvent[]): Promise<void> {
    const db = await cds.connect.to('db');
    
    try {
      // Group events by auth type for efficient processing
      const apiKeyEvents = events.filter(e => e.authType === 'api_key');
      const awsCredentialEvents = events.filter(e => e.authType === 'aws_credential');

      // Process API key usage events
      if (apiKeyEvents.length > 0) {
        await this.persistApiKeyUsage(db, apiKeyEvents);
      }

      // Process AWS credential usage events  
      if (awsCredentialEvents.length > 0) {
        await this.persistAwsCredentialUsage(db, awsCredentialEvents);
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('UsageEventProcessor', `Database operation failed during usage persistence: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Persist API key usage events
   */
  private async persistApiKeyUsage(db: any, events: UsageEvent[]): Promise<void> {
    // All events are valid - provider will be resolved from model data
    const validEvents = events;

    if (validEvents.length === 0) {
      logger.warn('UsageEventProcessor', 'No valid API key usage events to persist after filtering');
      return;
    }

    // Fetch API key details for email and name preservation
    const keyIds = [...new Set(validEvents.map(event => event.credentialId))];
    const keyDetails = await db.run(
      SELECT.from('sap.llm.gateway.admin.ApiKeys')
        .columns('ID', 'email', 'name')
        .where({ ID: { in: keyIds } })
    );
    
    const keyDetailsMap = new Map(keyDetails.map((key: any) => [key.ID, key]));

    const usageRecords = await Promise.all(validEvents.map(async event => {
      const keyDetail = keyDetailsMap.get(event.credentialId) as any;
      
      // Calculate costs using model cost service with separate cache token handling
      const costs = this.config.enableCostCalculation ? 
        await modelCostService.calculateCosts(
          event.model, 
          event.inputTokens, 
          event.outputTokens, 
          new Date(event.timestamp * 1000),
          event.cacheCreationInputTokens,
          event.cacheReadInputTokens
        ) :
        { inputCost: 0, outputCost: 0, totalCost: 0, provider: modelCostService.getModelProvider(event.model), cacheCreationInputCost: 0, cacheReadInputCost: 0 };
      
      // Resolve provider from model data instead of using event.provider (which is now 'unknown')
      const resolvedProvider = costs.provider || modelCostService.getModelProvider(event.model);
      
      return {
        apiKey_ID: event.credentialId,
        endpoint: event.endpoint || `/${resolvedProvider.toLowerCase()}/api/v1/chat/completions`, // Use resolved provider
        method: 'POST',
        statusCode: event.statusCode,
        responseTime: event.responseTime,
        email: keyDetail?.email || 'unknown@example.com', // Preserve email
        keyName: keyDetail?.name || 'Unknown Key', // Preserve key name
        provider: resolvedProvider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
        cacheReadInputTokens: event.cacheReadInputTokens || 0,
        totalTokens: event.inputTokens + event.outputTokens + (event.cacheCreationInputTokens || 0) + (event.cacheReadInputTokens || 0),
        inputCost: costs.inputCost,
        outputCost: costs.outputCost,
        cacheCreationInputCost: costs.cacheCreationInputCost || 0,
        cacheReadInputCost: costs.cacheReadInputCost || 0,
        totalCost: costs.totalCost,
        requestId: event.requestId,
        validFrom: new Date(event.timestamp * 1000),
        validTo: new Date('9999-12-31T23:59:59.999Z')
      };
    }));

    await db.run(
      INSERT.into('sap.llm.gateway.admin.ApiKeyUsage').entries(usageRecords)
    );

    // Batch increment usageCount for API keys
    const keyUsageCounts = validEvents.reduce((acc, event) => {
      acc[event.credentialId] = (acc[event.credentialId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    if (Object.keys(keyUsageCounts).length > 0) {
      const keyIds = Object.keys(keyUsageCounts);
      const caseStatements = Object.entries(keyUsageCounts)
        .map(([keyId, count]) => `WHEN '${keyId}' THEN ${count}`)
        .join(' ');
      
      await db.run(`
        UPDATE sap_llm_gateway_admin_ApiKeys 
        SET usageCount = usageCount + CASE ID
          ${caseStatements}
          ELSE 0
        END
        WHERE ID IN (${keyIds.map(id => `'${id}'`).join(',')})
      `);
    }

    logger.debug('UsageEventProcessor', `Persisted ${usageRecords.length} API key usage records (filtered from ${events.length} events)`);
  }

  /**
   * Persist AWS credential usage events
   */
  private async persistAwsCredentialUsage(db: any, events: UsageEvent[]): Promise<void> {
    // All events are valid - provider will be resolved from model data
    const validEvents = events;

    if (validEvents.length === 0) {
      logger.warn('UsageEventProcessor', 'No valid AWS credential usage events to persist after filtering');
      return;
    }

    // Fetch AWS credential details for email and name preservation
    const credentialIds = [...new Set(validEvents.map(event => event.credentialId))];
    const credentialDetails = await db.run(
      SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('ID', 'userId', 'email', 'name')
        .where({ ID: { in: credentialIds } })
    );
    
    const credentialDetailsMap = new Map(credentialDetails.map((cred: any) => [cred.ID, cred]));

    const usageRecords = await Promise.all(validEvents.map(async event => {
      const credentialDetail = credentialDetailsMap.get(event.credentialId) as any;
      
      // Calculate costs using model cost service with separate cache token handling
      const costs = this.config.enableCostCalculation ? 
        await modelCostService.calculateCosts(
          event.model, 
          event.inputTokens, 
          event.outputTokens, 
          new Date(event.timestamp * 1000),
          event.cacheCreationInputTokens,
          event.cacheReadInputTokens
        ) :
        { inputCost: 0, outputCost: 0, totalCost: 0, provider: modelCostService.getModelProvider(event.model), cacheCreationInputCost: 0, cacheReadInputCost: 0 };
      
      // Resolve provider from model data instead of using event.provider (which is now 'unknown')
      const resolvedProvider = costs.provider || modelCostService.getModelProvider(event.model);
      
      return {
        credential_ID: event.credentialId,
        requestId: event.requestId,
        method: 'POST',
        endpoint: event.endpoint || `/${resolvedProvider.toLowerCase()}/api/v1/chat/completions`, // Use resolved provider
        service: 'bedrock',
        operation: 'invoke',
        statusCode: event.statusCode,
        responseTime: event.responseTime,
        userId: credentialDetail?.userId || credentialDetail?.email || 'unknown-user', // Preserve userId (which contains the user email) for aggregation
        credentialName: credentialDetail?.name || 'Unknown Credential', // Preserve credential name
        modelId: event.model,
        provider: resolvedProvider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
        cacheReadInputTokens: event.cacheReadInputTokens || 0,
        inputCost: costs.inputCost,
        outputCost: costs.outputCost,
        cacheCreationInputCost: costs.cacheCreationInputCost || 0,
        cacheReadInputCost: costs.cacheReadInputCost || 0,
        totalCost: costs.totalCost,
        validFrom: new Date(event.timestamp * 1000),
        validTo: new Date('9999-12-31T23:59:59.999Z')
      };
    }));

    await db.run(
      INSERT.into('sap.llm.gateway.admin.AwsCredentialUsage').entries(usageRecords)
    );

    // Batch increment usageCount for AWS credentials
    const credentialUsageCounts = validEvents.reduce((acc, event) => {
      acc[event.credentialId] = (acc[event.credentialId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    if (Object.keys(credentialUsageCounts).length > 0) {
      const credentialIds = Object.keys(credentialUsageCounts);
      const caseStatements = Object.entries(credentialUsageCounts)
        .map(([credentialId, count]) => `WHEN '${credentialId}' THEN ${count}`)
        .join(' ');
      
      await db.run(`
        UPDATE sap_llm_gateway_admin_AwsCredentials 
        SET usageCount = usageCount + CASE ID
          ${caseStatements}
          ELSE 0
        END
        WHERE ID IN (${credentialIds.map(id => `'${id}'`).join(',')})
      `);
    }

    logger.debug('UsageEventProcessor', `Persisted ${usageRecords.length} AWS credential usage records (filtered from ${events.length} events)`);
  }


  /**
   * Process events from memory queue (when Valkey unavailable)
   */
  async processMemoryQueue(events: UsageEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Check if model data is available before processing
    if (!modelCostService.hasValidModelData()) {
      logger.info('UsageEventProcessor', `Skipping memory queue processing - model data not yet available (${events.length} events provided)`);
      return;
    }

    // Filter out already processed events
    const newEvents = events.filter(event => {
      if (this.processedRequestIds.has(event.requestId)) {
        logger.debug('UsageEventProcessor', `Skipping duplicate event with requestId: ${event.requestId}`);
        return false;
      }
      return true;
    });

    if (newEvents.length === 0) {
      logger.info('UsageEventProcessor', `All ${events.length} events were duplicates - skipping processing`);
      return;
    }

    logger.info('UsageEventProcessor', `Processing ${newEvents.length} new events from memory queue (${events.length - newEvents.length} duplicates filtered)`);
    
    // Add detailed logging to understand the double-request issue
    newEvents.forEach((event, index) => {
      logger.info('UsageEventProcessor', `Event ${index + 1}/${newEvents.length}:`, {
        requestId: event.requestId,
        provider: event.provider,
        model: event.model,
        authType: event.authType,
        credentialId: event.credentialId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        statusCode: event.statusCode
      });
    });
    
    await this.persistUsageEvents(newEvents);
    
    // Mark processed events
    newEvents.forEach(event => {
      this.processedRequestIds.add(event.requestId);
    });
    
    // Limit memory usage
    if (this.processedRequestIds.size > this.maxProcessedIds) {
      const idsToRemove = Array.from(this.processedRequestIds).slice(0, this.processedRequestIds.size - this.maxProcessedIds);
      idsToRemove.forEach(id => this.processedRequestIds.delete(id));
    }
  }

  /**
   * Get processor statistics
   */
  getStats(): { queueSize: number; isProcessing: boolean; valkeyConnected: boolean } {
    return {
      queueSize: this.batchBuffer.length,
      isProcessing: this.isProcessing,
      valkeyConnected: !!this.valkeyClient?.isOpen
    };
  }

  /**
   * Shutdown the processor
   */
  async shutdown(): Promise<void> {
    logger.info('UsageEventProcessor', 'Shutting down usage event processor');
    
    // Process remaining events
    if (this.batchBuffer.length > 0) {
      await this.processBatch();
    }

    // Clear timer
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    // Close Valkey connection
    if (this.valkeyClient) {
      await this.valkeyClient.quit();
    }

    logger.info('UsageEventProcessor', 'Usage event processor shutdown complete');
  }
}

// Export singleton instance
export const usageEventProcessor = new UsageEventProcessor();

export default UsageEventProcessor;