import axios from 'axios';
import * as crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import { SERVICE_KEYS, createServiceKeyData } from '@libs/service-auth';

const logger = getDefaultLogger();
const cds = require('@sap/cds');
const { INSERT, SELECT, UPDATE } = cds.ql;

interface ModelVersion {
  cost: Array<{ inputCost?: string; outputCost?: string; cacheReadInputCost?: string; cacheCreationInputCost?: string }>;
  isLatest: boolean;
  name: string;
}

interface ModelInfo {
  id: string;
  displayName?: string;
  owned_by?: string;
  provider?: string;
  versions: ModelVersion[];
}

interface ModelCostEntry {
  model: string;
  displayName?: string;
  dateFrom: Date;
  dateTo: Date;
  inputCost: number;  // per 1000 tokens
  outputCost: number; // per 1000 tokens
  cacheReadInputCost?: number;     // per 1000 tokens (cache read pricing)
  cacheCreationInputCost?: number; // per 1000 tokens (cache creation/write pricing)
  provider?: string;
  version?: string;
}

/**
 * Service for managing model pricing data
 * Fetches pricing from gateway model service and maintains historical pricing table
 */
class ModelCostService {
  private gatewayUrl: string;
  private lastFetch: number = 0;
  private fetchCooldown: number = 24 * 60 * 60 * 1000; // 24 hours (once per day)
  private modelProviderMap: Map<string, string> = new Map(); // Cache model ID -> provider mapping
  private serviceApiKey: string | null = null; // Cache for service API key
  private static isCreatingServiceKey: boolean = false; // Prevent concurrent key creation
  private hasModelData: boolean = false; // Track whether model data has been fetched successfully
  private useValkeyEvents: boolean = false; // Track whether to use Valkey events or timer-based fetching

  constructor() {
    this.gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:3000';
    this.useValkeyEvents = !!(process.env.VALKEY_URL?.trim()); // Use Valkey events if available
  }

  /**
   * Get provider for a model from internal cache (1:1 mapping from model data owned_by field)
   * Handles model ID mapping for substituted/deployed models
   */
  getModelProvider(modelId: string): string {
    // Direct lookup first
    let provider = this.modelProviderMap.get(modelId);
    if (provider) {
      return provider;
    }

    // Try to find deployed version (originalModel -> originalModel--deployed)
    const deployedModelId = `${modelId}--deployed`;
    provider = this.modelProviderMap.get(deployedModelId);
    if (provider) {
      logger.debug('ModelCostService', `Found provider for deployed version: ${modelId} -> ${deployedModelId} (${provider})`);
      return provider;
    }

    // Try to find provider-prefixed deployed version (e.g., claude-3-5-haiku-20241022 -> anthropic--claude-3-haiku--deployed)
    for (const [cachedModelId, cachedProvider] of this.modelProviderMap.entries()) {
      if (cachedModelId.endsWith('--deployed')) {
        // Extract base model name from deployed model ID
        // e.g., "anthropic--claude-3-haiku--deployed" -> "claude-3-haiku"  
        const parts = cachedModelId.split('--');
        if (parts.length >= 3 && parts[parts.length - 1] === 'deployed') {
          const baseModel = parts.slice(1, -1).join('-'); // Skip provider prefix and --deployed suffix
          if (modelId.includes(baseModel) || baseModel.includes(modelId)) {
            logger.debug('ModelCostService', `Found provider via pattern matching: ${modelId} -> ${cachedModelId} (${cachedProvider})`);
            return cachedProvider;
          }
        }
      }
    }

    logger.debug('ModelCostService', `No provider found for model: ${modelId}`);
    return 'unknown';
  }

  /**
   * Get current pricing for a model
   */
  async getModelPricing(modelId: string, date: Date = new Date()): Promise<{ inputCost: number; outputCost: number; cacheReadInputCost?: number; cacheCreationInputCost?: number; provider?: string; complexCost?: string } | null> {
    try {
      // Check cache first with direct model ID
      let cached = await this.getCachedPricing(modelId, date);
      if (cached) {
        return cached;
      }

      // Try with deployed version if not found
      const deployedModelId = `${modelId}--deployed`;
      cached = await this.getCachedPricing(deployedModelId, date);
      if (cached) {
        logger.debug('ModelCostService', `Found pricing for deployed version: ${modelId} -> ${deployedModelId}`);
        return cached;
      }

      // Try to find pricing for provider-prefixed deployed version
      for (const [cachedModelId] of this.modelProviderMap.entries()) {
        if (cachedModelId.endsWith('--deployed')) {
          const parts = cachedModelId.split('--');
          if (parts.length >= 3 && parts[parts.length - 1] === 'deployed') {
            const baseModel = parts.slice(1, -1).join('-');
            
            if (modelId.includes(baseModel) || baseModel.includes(modelId)) {
              cached = await this.getCachedPricing(cachedModelId, date);
              if (cached) {
                logger.debug('ModelCostService', `Found pricing via pattern matching: ${modelId} -> ${cachedModelId}`);
                return cached;
              }
            }
          }
        }
      }

      // Try to fetch fresh pricing data if needed and gateway is available
      try {
        await this.refreshPricingData();
        // Try cache again after refresh
        return await this.getCachedPricing(modelId, date);
      } catch (fetchError) {
        logger.debug('ModelCostService', `Could not fetch pricing data from gateway: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
        // Fall through to fallback pricing
      }

      return null; // Will use fallback in calculateCosts
    } catch (error) {
      logger.error('ModelCostService', `Error getting pricing for model ${modelId}:`, error instanceof Error ? error : new Error(String(error)));
      return null; // Will use fallback in calculateCosts
    }
  }

  /**
   * Get cached pricing from database
   */
  private async getCachedPricing(modelId: string, date: Date): Promise<{ inputCost: number; outputCost: number; cacheReadInputCost?: number; cacheCreationInputCost?: number; provider?: string; complexCost?: string } | null> {
    const db = await cds.connect.to('db');

    // Use raw SQL for proper datetime comparison since CDS doesn't handle ISO timestamps with 'Z' suffix well
    const isoDateString = date.toISOString();

    logger.debug('ModelCostService', `Executing getCachedPricing for model: ${modelId}, date: ${isoDateString}`);

    // Detect database type for compatible SQL
    const isPostgreSQL = db.options?.credentials?.kind === 'postgres' ||
                         process.env.CDS_ENV === 'pg' ||
                         process.env.NODE_CONFIG_ENV === 'pg';

    let result;

    if (isPostgreSQL) {
      // PostgreSQL-compatible query using CAST for timestamp comparison
      result = await db.run(`
        SELECT model, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, provider, complexCost, dateFrom, dateTo
        FROM sap_llm_gateway_admin_ModelCosts
        WHERE model = ?
          AND CAST(dateFrom AS TIMESTAMP) <= CAST(? AS TIMESTAMP)
          AND CAST(dateTo AS TIMESTAMP) >= CAST(? AS TIMESTAMP)
        ORDER BY CAST(dateFrom AS TIMESTAMP) DESC
        LIMIT 1
      `, [modelId, isoDateString, isoDateString]);
    } else {
      // SQLite-compatible query using datetime() function
      result = await db.run(`
        SELECT model, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, provider, complexCost, dateFrom, dateTo
        FROM sap_llm_gateway_admin_ModelCosts
        WHERE model = ?
          AND datetime(dateFrom) <= datetime(?)
          AND datetime(dateTo) >= datetime(?)
        ORDER BY datetime(dateFrom) DESC
        LIMIT 1
      `, [modelId, isoDateString, isoDateString]);
    }

    // If no results with database-specific conversion, try without (for different setups)
    if ((!result || (Array.isArray(result) && result.length === 0))) {
      logger.debug('ModelCostService', 'No results with database-specific conversion, trying without');
      result = await db.run(`
        SELECT model, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, provider, complexCost, dateFrom, dateTo
        FROM sap_llm_gateway_admin_ModelCosts
        WHERE model = ?
          AND dateFrom <= ?
          AND dateTo >= ?
        ORDER BY dateFrom DESC
        LIMIT 1
      `, [modelId, isoDateString, isoDateString]);
    }

    logger.debug('ModelCostService', `SQL query result:`, {
      resultType: typeof result,
      resultLength: Array.isArray(result) ? result.length : 'not array',
      result: result
    });

    // Handle different result formats from CDS/SQLite
    let rows;
    if (Array.isArray(result)) {
      // Direct array result (most common case)
      rows = result;
    } else if (result && typeof result === 'object' && 'values' in result) {
      // Handle CDS result format with values array
      rows = result.values || [];
    } else if (result && typeof result === 'object') {
      // Handle single row result wrapped in object
      rows = [result];
    } else {
      // No result or null
      rows = [];
    }

    if (Array.isArray(rows) && rows.length > 0) {
      const cost = rows[0];
      logger.debug('ModelCostService', `Found pricing data:`, cost);

      // Fix case sensitivity issue: PostgreSQL returns lowercase field names
      const inputCostValue = cost.inputCost || cost.inputcost;
      const outputCostValue = cost.outputCost || cost.outputcost;
      const cacheReadInputCostValue = cost.cacheReadInputCost || cost.cachereadinputcost;
      const cacheCreationInputCostValue = cost.cacheCreationInputCost || cost.cachecreationinputcost;

      return {
        inputCost: parseFloat(inputCostValue) || 0,
        outputCost: parseFloat(outputCostValue) || 0,
        cacheReadInputCost: cacheReadInputCostValue ? parseFloat(cacheReadInputCostValue) : undefined,
        cacheCreationInputCost: cacheCreationInputCostValue ? parseFloat(cacheCreationInputCostValue) : undefined,
        provider: cost.provider,
        complexCost: cost.complexCost || cost.complexcost
      };
    }

    logger.debug('ModelCostService', `No pricing data found for model: ${modelId}`);
    return null;
  }

  /**
   * Get or create service API key for gateway communication
   */
  private async getServiceApiKey(): Promise<string> {
    if (this.serviceApiKey) {
      logger.debug('ModelCostService', 'Using cached service API key');
      return this.serviceApiKey;
    }

    const db = await cds.connect.to('db');
    const { INSERT, SELECT } = cds.ql;
    const serviceEmail = SERVICE_KEYS.ADMIN_TO_GATEWAY.EMAIL;

    try {
      // Check if service key already exists with more thorough query
      const existing = await db.run(
        SELECT.from('sap.llm.gateway.admin.ApiKeys')
          .where({ 
            email: serviceEmail, 
            isActive: true,
            deletedAt: null  // Ensure we don't get soft-deleted keys
          })
      );

      logger.debug('ModelCostService', `Service key lookup result:`, { 
        found: existing.length, 
        email: serviceEmail 
      });

      if (existing.length > 0 && existing[0].key) {
        this.serviceApiKey = existing[0].key;
        logger.info('ModelCostService', `Using existing service API key for ${serviceEmail}`);
        return this.serviceApiKey!;
      }

      // Check if another instance is already creating a key
      if (ModelCostService.isCreatingServiceKey) {
        logger.debug('ModelCostService', 'Another instance is creating service key, waiting...');
        // Wait a bit and check again
        await new Promise(resolve => setTimeout(resolve, 100));
        const retryExisting = await db.run(
          SELECT.from('sap.llm.gateway.admin.ApiKeys')
            .where({ 
              email: serviceEmail, 
              isActive: true,
              deletedAt: null 
            })
        );
        if (retryExisting.length > 0 && retryExisting[0].key) {
          this.serviceApiKey = retryExisting[0].key;
          logger.info('ModelCostService', `Using newly created service API key for ${serviceEmail}`);
          return this.serviceApiKey!;
        }
      }

      // Set flag to prevent concurrent creation
      ModelCostService.isCreatingServiceKey = true;

      try {
        // Create new service API key using shared utilities
        logger.info('ModelCostService', `Creating new service API key for ${serviceEmail}`);
        
        const serviceKeyData = createServiceKeyData('ADMIN_TO_GATEWAY');

      await db.run(
        INSERT.into('sap.llm.gateway.admin.ApiKeys').entries([serviceKeyData])
      );

        this.serviceApiKey = serviceKeyData.key!;
        logger.info('ModelCostService', `Created service API key for ${serviceEmail}`);
        return this.serviceApiKey;

      } finally {
        // Clear flag after creation attempt
        ModelCostService.isCreatingServiceKey = false;
      }

    } catch (error) {
      // Clear flag on error
      ModelCostService.isCreatingServiceKey = false;
      logger.error('ModelCostService', `Failed to get/create service API key: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Refresh pricing data from gateway service (only used when Valkey events are not available)
   */
  private async refreshPricingData(): Promise<void> {
    if (this.useValkeyEvents) {
      logger.debug('ModelCostService', 'Skipping direct gateway fetch - using Valkey events');
      return;
    }

    const now = Date.now();
    if (now - this.lastFetch < this.fetchCooldown) {
      logger.debug('ModelCostService', 'Skipping pricing refresh due to cooldown');
      return;
    }

    try {
      logger.info('ModelCostService', 'Fetching model pricing data from gateway service (timer-based)');
      
      // Get service API key for authentication
      const apiKey = await this.getServiceApiKey();
      
      const response = await axios.get(`${this.gatewayUrl}/v1/models`, {
        timeout: 30000, // 30 seconds to handle unbuffered model list fetching
        headers: {
          'Accept': 'application/json',
          'X-API-Key': apiKey,
          'User-Agent': 'admin-service/model-cost'
        }
      });

      const models: ModelInfo[] = response.data.data || [];
      await this.updatePricingDatabase(models);
      
      this.lastFetch = now;
      this.hasModelData = true; // Mark as successfully fetched
      logger.info('ModelCostService', `Updated pricing for ${models.length} models (timer-based)`);
    } catch (error) {
      logger.error('ModelCostService', 'Failed to fetch pricing data from gateway:', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Update pricing database with fresh model data and populate provider cache
   */
  private async updatePricingDatabase(models: ModelInfo[]): Promise<void> {
    const db = await cds.connect.to('db');
    const now = new Date();
    const costEntries: ModelCostEntry[] = [];

    // Clear and rebuild the provider map
    this.modelProviderMap.clear();

    for (const model of models) {
      // Cache the provider mapping
      if (model.owned_by) {
        this.modelProviderMap.set(model.id, model.owned_by);
      } else if (model.provider) {
        this.modelProviderMap.set(model.id, model.provider);
      }
      try {
        // Find the latest version with cost information
        const latestVersion = model.versions.find(v => v.isLatest) || model.versions[0];

        if (!latestVersion || !latestVersion.cost) continue;

        // Extract input, output, and cache costs
        let inputCost = 0;
        let outputCost = 0;
        let cacheReadInputCost: number | undefined = undefined;
        let cacheCreationInputCost: number | undefined = undefined;

        latestVersion.cost.forEach(costItem => {
          if (costItem.inputCost) {
            inputCost = parseFloat(costItem.inputCost);
          }
          if (costItem.outputCost) {
            outputCost = parseFloat(costItem.outputCost);
          }
          if (costItem.cacheReadInputCost) {
            cacheReadInputCost = parseFloat(costItem.cacheReadInputCost);
          }
          if (costItem.cacheCreationInputCost) {
            cacheCreationInputCost = parseFloat(costItem.cacheCreationInputCost);
          }
        });

        if (inputCost > 0 || outputCost > 0) {
          // Check if we already have current pricing for this model
          const existing = await db.run(
            SELECT.from('sap.llm.gateway.admin.ModelCosts')
              .where({
                model: model.id,
                dateTo: new Date('9999-12-31')
              })
          );

          if (existing.length > 0) {
            const existingCost = existing[0];
            const existingInputCost = parseFloat(existingCost.inputCost) || 0;
            const existingOutputCost = parseFloat(existingCost.outputCost) || 0;
            const existingCacheReadInputCost = existingCost.cacheReadInputCost ? parseFloat(existingCost.cacheReadInputCost) : undefined;
            const existingCacheCreationInputCost = existingCost.cacheCreationInputCost ? parseFloat(existingCost.cacheCreationInputCost) : undefined;

            // Only update if costs have changed (including cache costs)
            const costChanged = existingInputCost !== inputCost ||
                               existingOutputCost !== outputCost ||
                               existingCacheReadInputCost !== cacheReadInputCost ||
                               existingCacheCreationInputCost !== cacheCreationInputCost;

            if (costChanged) {
              // Close the existing record
              await db.run(
                UPDATE('sap.llm.gateway.admin.ModelCosts')
                  .set({ dateTo: now })
                  .where({ ID: existingCost.ID })
              );

              // Create new record with current costs
              costEntries.push({
                model: model.id,
                displayName: model.displayName,
                dateFrom: now,
                dateTo: new Date('9999-12-31'),
                inputCost,
                outputCost,
                cacheReadInputCost,
                cacheCreationInputCost,
                provider: model.owned_by || model.provider,
                version: latestVersion.name
              });

              logger.debug('ModelCostService', `Cost change detected for ${model.id}: input ${existingInputCost} -> ${inputCost}, output ${existingOutputCost} -> ${outputCost}, cacheRead ${existingCacheReadInputCost} -> ${cacheReadInputCost}, cacheCreation ${existingCacheCreationInputCost} -> ${cacheCreationInputCost}`);
            }
          } else {
            // No existing record, create new one
            costEntries.push({
              model: model.id,
              displayName: model.displayName,
              dateFrom: now,
              dateTo: new Date('9999-12-31'),
              inputCost,
              outputCost,
              cacheReadInputCost,
              cacheCreationInputCost,
              provider: model.owned_by || model.provider,
              version: latestVersion.name
            });
          }
        }
      } catch (error) {
        logger.warn('ModelCostService', `Error processing model ${model.id}:`, error);
      }
    }

    // Insert new cost entries
    if (costEntries.length > 0) {
      const insertEntries = costEntries.map(entry => ({
        ID: require('crypto').randomUUID(),
        model: entry.model,
        displayName: entry.displayName,
        dateFrom: entry.dateFrom,
        dateTo: entry.dateTo,
        inputCost: entry.inputCost.toString(),
        outputCost: entry.outputCost.toString(),
        cacheReadInputCost: entry.cacheReadInputCost !== undefined ? entry.cacheReadInputCost.toString() : null,
        cacheCreationInputCost: entry.cacheCreationInputCost !== undefined ? entry.cacheCreationInputCost.toString() : null,
        provider: entry.provider,
        version: entry.version,
        createdAt: now
      }));

      await db.run(
        INSERT.into('sap.llm.gateway.admin.ModelCosts').entries(insertEntries)
      );

      logger.info('ModelCostService', `Inserted ${insertEntries.length} new cost records`);
    }

    // Log provider cache statistics
    logger.info('ModelCostService', `Provider cache populated with ${this.modelProviderMap.size} models`);
    if (process.env.DEBUG === 'true') {
      logger.debug('ModelCostService', `Provider cache contents: ${JSON.stringify(Array.from(this.modelProviderMap.entries()))}`);
    }
  }

  /**
   * Get fallback pricing for unknown models
   */
  private getFallbackPricing(modelId: string): { inputCost: number; outputCost: number; provider?: string; complexCost?: string } {
    // Simple fallback based on model name patterns
    if (modelId.includes('claude')) {
      return { inputCost: 0.003, outputCost: 0.015, provider: 'Anthropic' };
    } else if (modelId.includes('gpt-4')) {
      return { inputCost: 0.03, outputCost: 0.06, provider: 'OpenAI' };
    } else if (modelId.includes('gpt')) {
      return { inputCost: 0.001, outputCost: 0.002, provider: 'OpenAI' };
    } else {
      return { inputCost: 0.001, outputCost: 0.002, provider: 'unknown' };
    }
  }

  /**
   * Calculate costs using tiered pricing structure from complexCost JSON
   */
  private calculateTieredCosts(
    complexCostJson: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number
  ): { inputCost: number; outputCost: number; cacheCreationInputCost: number; cacheReadInputCost: number } | null {
    try {
      const costStructure = JSON.parse(complexCostJson);
      
      if (!Array.isArray(costStructure)) {
        logger.warn('ModelCostService', 'Complex cost structure is not an array');
        return null;
      }

      // Calculate total input and output tokens separately for tier selection
      const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
      const totalOutputTokens = outputTokens;

      // Find appropriate tier based on token counts
      let inputTier: any = null;
      let outputTier: any = null;

      for (const tier of costStructure) {
        if (!tier.tierDescription || typeof tier.tierDescription !== 'string') {
          continue;
        }

        const description = tier.tierDescription.toLowerCase();
        let tierLimit = null;

        // Parse tier description to extract token limit and determine if it's upper or lower bound
        let isGreaterThan = false;
        if (description.includes('less than or equals to') || description.includes('<=')) {
          const match = description.match(/(\d+)k?\s*tokens/i);
          if (match) {
            tierLimit = parseInt(match[1]) * (description.includes('k') ? 1000 : 1);
            isGreaterThan = false;
          }
        } else if (description.includes('greater than') || description.includes('>')) {
          const match = description.match(/(\d+)k?\s*tokens/i);
          if (match) {
            tierLimit = parseInt(match[1]) * (description.includes('k') ? 1000 : 1);
            isGreaterThan = true;
          }
        }

        // Select tier based on token count and tier type
        if (tier.inputCost !== undefined) {
          // For input tiers, use total input tokens
          let tierMatches = false;
          if (tierLimit !== null) {
            if (isGreaterThan) {
              tierMatches = totalInputTokens > tierLimit;
            } else {
              tierMatches = totalInputTokens <= tierLimit;
            }
          } else {
            tierMatches = true; // No limit specified
          }

          if (tierMatches) {
            inputTier = tier;
          }
        }

        if (tier.outputCost !== undefined) {
          // For output tiers, use total output tokens
          let tierMatches = false;
          if (tierLimit !== null) {
            if (isGreaterThan) {
              tierMatches = totalOutputTokens > tierLimit;
            } else {
              tierMatches = totalOutputTokens <= tierLimit;
            }
          } else {
            tierMatches = true; // No limit specified
          }

          if (tierMatches) {
            outputTier = tier;
          }
        }
      }

      if (!inputTier || !outputTier) {
        logger.warn('ModelCostService', 'Could not find appropriate tiers for token count', { totalInputTokens, totalOutputTokens, inputTier, outputTier });
        return null;
      }

      const inputCostRate = parseFloat(inputTier.inputCost);
      const outputCostRate = parseFloat(outputTier.outputCost);

      if (isNaN(inputCostRate) || isNaN(outputCostRate)) {
        logger.warn('ModelCostService', 'Invalid cost rates in tiers', { inputCostRate, outputCostRate });
        return null;
      }

      // Calculate costs using the tiered rates
      const inputCost = (inputTokens / 1000) * inputCostRate;
      const outputCost = (outputTokens / 1000) * outputCostRate;

      // Cache token pricing - check if tiered cache pricing is available in the input tier
      // Some models like Gemini 2.5 Pro have tiered cache pricing (different rates per tier)
      // If not available, fall back to 100% of input rate from the selected tier
      let cacheReadInputCostRate = inputCostRate; // Default: 100% of input rate
      let cacheCreationInputCostRate = inputCostRate; // Default: 100% of input rate

      if (inputTier.cacheReadInputCost !== undefined) {
        const parsedRate = parseFloat(inputTier.cacheReadInputCost);
        if (!isNaN(parsedRate)) {
          cacheReadInputCostRate = parsedRate;
          logger.debug('ModelCostService', `Using tiered cache read pricing: ${cacheReadInputCostRate}`);
        }
      }

      if (inputTier.cacheCreationInputCost !== undefined) {
        const parsedRate = parseFloat(inputTier.cacheCreationInputCost);
        if (!isNaN(parsedRate)) {
          cacheCreationInputCostRate = parsedRate;
          logger.debug('ModelCostService', `Using tiered cache creation pricing: ${cacheCreationInputCostRate}`);
        }
      }

      const cacheCreationInputCost = (cacheCreationInputTokens / 1000) * cacheCreationInputCostRate;
      const cacheReadInputCost = (cacheReadInputTokens / 1000) * cacheReadInputCostRate;

      return {
        inputCost,
        outputCost,
        cacheCreationInputCost,
        cacheReadInputCost
      };

    } catch (error) {
      logger.error('ModelCostService', 'Error parsing complex cost structure:', error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Calculate costs for input, output, and cache tokens
   */
  async calculateCosts(
    modelId: string, 
    inputTokens: number, 
    outputTokens: number, 
    date: Date = new Date(),
    cacheCreationInputTokens?: number,
    cacheReadInputTokens?: number
  ): Promise<{
    inputCost: number;
    outputCost: number;
    cacheCreationInputCost?: number;
    cacheReadInputCost?: number;
    totalCost: number;
    provider?: string;
  }> {
    if (!inputTokens && !outputTokens && !cacheCreationInputTokens && !cacheReadInputTokens) {
      return { inputCost: 0, outputCost: 0, cacheCreationInputCost: 0, cacheReadInputCost: 0, totalCost: 0 };
    }

    let pricing = await this.getModelPricing(modelId, date);
    if (!pricing) {
      logger.warn('ModelCostService', `No pricing found for model ${modelId}, using fallback`);
      pricing = this.getFallbackPricing(modelId);
    }

    // Handle token counts safely
    const safeInputTokens = inputTokens || 0;
    const safeOutputTokens = outputTokens || 0;
    const safeCacheCreationInputTokens = cacheCreationInputTokens || 0;
    const safeCacheReadInputTokens = cacheReadInputTokens || 0;

    // Check if we have complex cost structure for tiered pricing
    if (pricing.complexCost) {
      const totalInputTokens = safeInputTokens + safeCacheCreationInputTokens + safeCacheReadInputTokens;
      const totalOutputTokens = safeOutputTokens;
      logger.debug('ModelCostService', `Using tiered pricing for model ${modelId} with ${totalInputTokens} input tokens and ${totalOutputTokens} output tokens`);
      
      const tieredCosts = this.calculateTieredCosts(
        pricing.complexCost,
        safeInputTokens,
        safeOutputTokens,
        safeCacheCreationInputTokens,
        safeCacheReadInputTokens
      );

      if (tieredCosts) {
        const totalCost = tieredCosts.inputCost + tieredCosts.outputCost + tieredCosts.cacheCreationInputCost + tieredCosts.cacheReadInputCost;
        
        return {
          inputCost: Number(tieredCosts.inputCost.toFixed(6)),
          outputCost: Number(tieredCosts.outputCost.toFixed(6)),
          cacheCreationInputCost: Number(tieredCosts.cacheCreationInputCost.toFixed(6)),
          cacheReadInputCost: Number(tieredCosts.cacheReadInputCost.toFixed(6)),
          totalCost: Number(totalCost.toFixed(6)),
          provider: pricing.provider
        };
      } else {
        logger.warn('ModelCostService', `Failed to calculate tiered costs for model ${modelId}, falling back to simple pricing`);
      }
    }

    // Fall back to simple pricing calculation
    logger.debug('ModelCostService', `Using simple pricing for model ${modelId}`);
    const inputCost = (safeInputTokens / 1000) * pricing.inputCost;
    const outputCost = (safeOutputTokens / 1000) * pricing.outputCost;

    // Cache token pricing - use actual cache pricing if available from model config,
    // otherwise fall back to 100% of regular input token cost
    const cacheCreationInputCost = safeCacheCreationInputTokens
      ? ((safeCacheCreationInputTokens / 1000) * (pricing.cacheCreationInputCost !== undefined ? pricing.cacheCreationInputCost : pricing.inputCost))
      : 0;
    const cacheReadInputCost = safeCacheReadInputTokens
      ? ((safeCacheReadInputTokens / 1000) * (pricing.cacheReadInputCost !== undefined ? pricing.cacheReadInputCost : pricing.inputCost))
      : 0;

    const totalCost = inputCost + outputCost + cacheCreationInputCost + cacheReadInputCost;

    return {
      inputCost: Number(inputCost.toFixed(6)),
      outputCost: Number(outputCost.toFixed(6)),
      cacheCreationInputCost: Number(cacheCreationInputCost.toFixed(6)),
      cacheReadInputCost: Number(cacheReadInputCost.toFixed(6)),
      totalCost: Number(totalCost.toFixed(6)),
      provider: pricing.provider
    };
  }

  /**
   * Check if model data has been successfully fetched
   */
  hasValidModelData(): boolean {
    return this.hasModelData && this.modelProviderMap.size > 0;
  }

  /**
   * Process model list from Valkey event (replaces timer-based fetching)
   */
  async processModelListFromEvent(modelListEvent: any): Promise<void> {
    if (!this.useValkeyEvents) {
      logger.debug('ModelCostService', 'Ignoring model list event - timer-based fetching is active');
      return;
    }

    try {
      logger.info('ModelCostService', 'Processing model list from Valkey event', {
        source: modelListEvent.source,
        modelCount: modelListEvent.modelCount,
        timestamp: modelListEvent.timestamp
      });

      const models: ModelInfo[] = modelListEvent.models || [];
      if (models.length > 0) {
        await this.updatePricingDatabase(models);
        this.hasModelData = true;
        logger.info('ModelCostService', `Updated pricing from event for ${models.length} models`);
      } else {
        logger.warn('ModelCostService', 'Received model list event with no models');
      }
    } catch (error) {
      logger.error('ModelCostService', 'Failed to process model list from event:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    if (this.useValkeyEvents) {
      logger.info('ModelCostService', 'Model cost service initialized - will use Valkey events for model data');
      // No timer-based fetching when using Valkey events
    } else {
      logger.info('ModelCostService', 'Model cost service initialized - will use timer-based fetching (Valkey not available)');
      // Try to fetch initial model data in the background with retries (non-blocking)
      this.scheduleInitialModelDataFetch();
    }
  }

  /**
   * Schedule initial model data fetch with retries (only used when Valkey is not available)
   */
  private scheduleInitialModelDataFetch(): void {
    if (this.useValkeyEvents) {
      logger.debug('ModelCostService', 'Skipping timer-based fetch - using Valkey events');
      return;
    }

    const maxRetries = 5;
    let retryCount = 0;
    
    const tryFetch = async (): Promise<void> => {
      try {
        await this.refreshPricingData();
        logger.info('ModelCostService', 'Initial model data fetched successfully (timer-based)');
      } catch (error) {
        retryCount++;
        if (retryCount < maxRetries) {
          const delay = Math.min(5000 * Math.pow(2, retryCount), 60000); // Exponential backoff, max 60s
          logger.debug('ModelCostService', `Initial model data fetch failed (attempt ${retryCount}/${maxRetries}, retrying in ${delay}ms): ${error instanceof Error ? error.message : String(error)}`);
          setTimeout(tryFetch, delay);
        } else {
          logger.debug('ModelCostService', `Initial model data fetch failed after ${maxRetries} attempts, will fetch on first usage`);
        }
      }
    };
    
    // Start first attempt after 10 seconds to allow gateway to start
    setTimeout(tryFetch, 10000);
  }
}

export const modelCostService = new ModelCostService();
export default modelCostService;