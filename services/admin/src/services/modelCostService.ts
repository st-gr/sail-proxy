import axios from 'axios';
import * as crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import { SERVICE_KEYS, createServiceKeyData } from '@libs/service-auth';
import { mapModelToLibraryRow, deriveDeepContextRows, GatewayModel } from './librarySnapshot';
import { pricingTwins, DEEP_CONTEXT_SUFFIX } from './pricingTwins';

const logger = getDefaultLogger();
const cds = require('@sap/cds');
const { INSERT, SELECT, UPDATE, UPSERT } = cds.ql;

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
  imageOutputCost?: number; // per 1000 tokens (generated images; manual rows only)
  audioInputCost?: number; audioOutputCost?: number; // per 1000 tokens (realtime audio; manual rows only)
  provider?: string;
  version?: string;
  source?: string;
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
  private fallbackFetchDelay: number = 20000; // Valkey-events mode: wait this long for a model-list event before self-healing via a direct fetch

  constructor() {
    this.gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:3000';
    this.useValkeyEvents = !!(process.env.VALKEY_URL?.trim()); // Use Valkey events if available
  }

  /**
   * Get provider for a model from internal cache (1:1 mapping from model data owned_by field)
   * Handles model ID mapping for substituted/deployed models
   */
  getModelProvider(modelId: string): string {
    // A deep-context id names a pricing-only tier of its bare model; the gateway never lists a
    // provider mapping for the suffixed id itself, so every lookup below runs against the bare id.
    const bare = modelId.endsWith(DEEP_CONTEXT_SUFFIX) ? modelId.slice(0, -DEEP_CONTEXT_SUFFIX.length) : modelId;

    // Direct lookup first
    let provider = this.modelProviderMap.get(bare);
    if (provider) {
      return provider;
    }

    // Try to find deployed version (originalModel -> originalModel--deployed)
    const deployedModelId = `${bare}--deployed`;
    provider = this.modelProviderMap.get(deployedModelId);
    if (provider) {
      logger.debug('ModelCostService', `Found provider for deployed version: ${bare} -> ${deployedModelId} (${provider})`);
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
          if (bare.includes(baseModel) || baseModel.includes(bare)) {
            logger.debug('ModelCostService', `Found provider via pattern matching: ${bare} -> ${cachedModelId} (${cachedProvider})`);
            return cachedProvider;
          }
        }
      }
    }

    logger.debug('ModelCostService', `No provider found for model: ${bare}`);
    return 'unknown';
  }

  /**
   * Get current pricing for a model
   */
  async getModelPricing(modelId: string, date: Date = new Date()): Promise<{ inputCost: number; outputCost: number; cacheReadInputCost?: number; cacheCreationInputCost?: number; imageOutputCost?: number; audioInputCost?: number; audioOutputCost?: number; provider?: string; complexCost?: string } | null> {
    try {
      // Check the cache under every id this model's price may be maintained under: the exact id,
      // then (for a deep-context id) the bare model, then each of those with its --deployed twin -
      // so a deep-context call is never priced at nothing when only the base rate is maintained,
      // and the deployed/bare fallback (spec: usage is accounted against the DEPLOYMENT id while a
      // manual price may have been entered on the bare model, or vice versa) still applies.
      let cached: Awaited<ReturnType<ModelCostService['getCachedPricing']>> = null;
      for (const id of pricingTwins(modelId)) {
        cached = await this.getCachedPricing(id, date);
        if (cached) {
          if (id !== modelId) logger.debug('ModelCostService', `Found pricing via twin: ${modelId} -> ${id}`);
          return cached;
        }
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
  private async getCachedPricing(modelId: string, date: Date): Promise<{ inputCost: number; outputCost: number; cacheReadInputCost?: number; cacheCreationInputCost?: number; imageOutputCost?: number; audioInputCost?: number; audioOutputCost?: number; provider?: string; complexCost?: string } | null> {
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
        SELECT model, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost, provider, complexCost, dateFrom, dateTo
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
        SELECT model, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost, provider, complexCost, dateFrom, dateTo
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
        SELECT model, inputCost, outputCost, cacheReadInputCost, cacheCreationInputCost, imageOutputCost, audioInputCost, audioOutputCost, provider, complexCost, dateFrom, dateTo
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
      const imageOutputCostValue = cost.imageOutputCost ?? cost.imageoutputcost;
      const audioInputCostValue = cost.audioInputCost ?? cost.audioinputcost;
      const audioOutputCostValue = cost.audioOutputCost ?? cost.audiooutputcost;

      return {
        inputCost: parseFloat(inputCostValue) || 0,
        outputCost: parseFloat(outputCostValue) || 0,
        cacheReadInputCost: cacheReadInputCostValue ? parseFloat(cacheReadInputCostValue) : undefined,
        cacheCreationInputCost: cacheCreationInputCostValue ? parseFloat(cacheCreationInputCostValue) : undefined,
        imageOutputCost: imageOutputCostValue !== null && imageOutputCostValue !== undefined ? parseFloat(imageOutputCostValue) : undefined,
        audioInputCost: audioInputCostValue !== null && audioInputCostValue !== undefined ? parseFloat(audioInputCostValue) : undefined,
        audioOutputCost: audioOutputCostValue !== null && audioOutputCostValue !== undefined ? parseFloat(audioOutputCostValue) : undefined,
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

    // Each statement below runs in its own short root transaction (cds.tx), NOT in the caller's
    // request transaction. The admin's SQLite pool holds a single connection (@cap-js/sqlite
    // `max: 1`), and this lookup is followed by an HTTP call to the gateway whose key validation
    // calls back into this admin's database: a connection held across that round-trip deadlocks
    // the validation until the gateway's 5 s timeout and the call fails with 401. That was the
    // root cause of the "admin-service/model-cost" failed_auth events and of the first
    // refreshModelLibrary after a start failing.
    const db = { run: (q: any) => cds.tx((tx: any) => tx.run(q)) };
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
  private async refreshPricingData(force = false): Promise<void> {
    if (this.useValkeyEvents && !force) {
      logger.debug('ModelCostService', 'Skipping direct gateway fetch - using Valkey events');
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastFetch < this.fetchCooldown) {
      logger.debug('ModelCostService', 'Skipping pricing refresh due to cooldown');
      return;
    }

    try {
      logger.info('ModelCostService', 'Fetching model pricing data from gateway service (timer-based)');
      
      // Get service API key for authentication
      const apiKey = await this.getServiceApiKey();
      
      // include=unroutable so the library snapshot can list the foundation models the gateway
      // cannot route (no orchestration scenario). They are marked routable:false and reach
      // nothing but the snapshot — updatePricingDatabase skips them.
      const response = await axios.get(`${this.gatewayUrl}/v1/models?include=unroutable`, {
        timeout: 30000, // 30 seconds to handle unbuffered model list fetching
        headers: {
          'Accept': 'application/json',
          'X-API-Key': apiKey,
          'User-Agent': 'admin-service/model-cost'
        }
      });

      const models: ModelInfo[] = response.data.data || [];
      await this.trySnapshot(models as any);
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
      // A model the gateway cannot route never serves a request, so it gets no price row and no
      // provider mapping — the library snapshot is the only consumer of those entries.
      if ((model as { routable?: boolean }).routable === false) continue;
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
            if (existingCost.source === 'manual') {
              logger.debug('ModelCostService', `Keeping manual price for ${model.id}; SAP price ${inputCost}/${outputCost} recorded on the library snapshot only`);
              continue;
            }
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
                version: latestVersion.name,
                source: 'sap'
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
              version: latestVersion.name,
              source: 'sap'
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
        source: entry.source ?? 'sap',
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
   * The library snapshot is a display feature; pricing is what the usage processor bills from.
   * A snapshot write that fails (a schema drift, an over-long column, a locked table) must never
   * take pricing down with it, so every entry point goes through here and continues regardless.
   */
  private async trySnapshot(models: GatewayModel[]): Promise<{ upserted: number; absent: number; deployments: number }> {
    try {
      return await this.upsertLibrarySnapshot(models);
    } catch (error) {
      logger.error('ModelCostService', 'Library snapshot failed - continuing with the pricing update', error instanceof Error ? error : new Error(String(error)));
      return { upserted: 0, absent: 0, deployments: 0 };
    }
  }

  /**
   * Snapshot the gateway's model list into LibraryModels (spec section 2). UPSERT by modelId,
   * then mark every row not stamped in this run absent. Never deletes. An empty payload is a
   * no-op so a failed pull cannot blank the library.
   */
  async upsertLibrarySnapshot(models: GatewayModel[], now: Date = new Date()): Promise<{ upserted: number; absent: number; deployments: number }> {
    if (!Array.isArray(models) || models.length === 0) {
      return { upserted: 0, absent: 0, deployments: 0 };
    }
    const rows = models.filter(m => m && typeof m.id === 'string').map(m => mapModelToLibraryRow(m, now));
    if (rows.length === 0) {
      return { upserted: 0, absent: 0, deployments: 0 };
    }
    // Deep Context pricing-only rows, one per sap-rpt-*-large row in this snapshot. lastSeenAt is
    // stamped here (not inside deriveDeepContextRows, which is pure and carries none) so the
    // mark-absent sweep below - keyed on lastSeenAt - treats them as seen in this run and leaves
    // their mirrored `absent` alone, instead of nulling it and flipping them absent regardless.
    const derivedRows = deriveDeepContextRows(rows).map(r => ({ ...r, lastSeenAt: now }));
    const all = [...rows, ...derivedRows];
    const db = await cds.connect.to('db');
    const CHUNK = 50;
    for (let i = 0; i < all.length; i += CHUNK) {
      await db.run(UPSERT.into('sap.llm.gateway.admin.LibraryModels').entries(all.slice(i, i + CHUNK)));
    }
    const absent = await db.run(
      UPDATE('sap.llm.gateway.admin.LibraryModels')
        .set({ absent: true })
        .where([{ ref: ['lastSeenAt'] }, '<', { val: now }, 'or', { ref: ['lastSeenAt'] }, 'is', 'null'])
    );
    const deployments = rows.filter(r => r.accessType === 'deployment').length;
    logger.info('ModelCostService', `Library snapshot: ${rows.length} models upserted (${deployments} deployments), ${typeof absent === 'number' ? absent : 0} marked absent`);
    return { upserted: rows.length, absent: typeof absent === 'number' ? absent : 0, deployments };
  }

  /**
   * On-demand pull for the refreshModelLibrary action: same request as the timer path, but
   * independent of cooldown and Valkey mode. Snapshot first, pricing second.
   */
  async refreshFromGateway(): Promise<{ models: number; deployments: number; absent: number }> {
    const list = () => this.getServiceApiKey().then((apiKey) => axios.get(`${this.gatewayUrl}/v1/models?include=unroutable`, {
      timeout: 30000,
      headers: { 'Accept': 'application/json', 'X-API-Key': apiKey, 'User-Agent': 'admin-service/model-library' }
    }));
    let response;
    try {
      response = await list();
    } catch (error: any) {
      // The cached service key may have been deleted or deactivated underneath us (an admin
      // purging keys, a restored database): forget it, re-read or re-create it, and try once more.
      if (error?.response?.status !== 401 || !this.serviceApiKey) throw error;
      logger.warn('ModelCostService', 'Gateway rejected the cached service key (401); re-resolving it and retrying once');
      this.serviceApiKey = null;
      response = await list();
    }
    const models: GatewayModel[] = response.data?.data || [];
    const snap = await this.trySnapshot(models);
    await this.updatePricingDatabase(models as any);
    this.hasModelData = true;
    this.lastFetch = Date.now();
    return { models: models.length, deployments: snap.deployments, absent: snap.absent };
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
    cacheReadInputTokens: number,
    imageOutputTokens: number = 0,
    imageOutputCostRate?: number,
    audioInputTokens: number = 0,
    audioOutputTokens: number = 0,
    audioInputCostRate?: number,
    audioOutputCostRate?: number
  ): { inputCost: number; outputCost: number; cacheCreationInputCost: number; cacheReadInputCost: number; imageOutputCost: number; audioInputCost: number; audioOutputCost: number } | null {
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

      // Calculate costs using the tiered rates. Text output tokens exclude the generated-image
      // share (spec §3): outputCost prices only the text share, imageOutputCost prices the rest
      // at the manual imageOutputCost rate (falling back to the tier's output rate when unset).
      const safeImageOutputTokens = Math.max(0, imageOutputTokens || 0);
      const safeAudioInputTokens = Math.min(Math.max(0, audioInputTokens || 0), inputTokens);
      const safeAudioOutputTokens = Math.max(0, audioOutputTokens || 0);
      const textInputTokens = Math.max(0, inputTokens - safeAudioInputTokens);
      const textOutputTokens = Math.max(0, outputTokens - safeImageOutputTokens - safeAudioOutputTokens);
      const inputCost = (textInputTokens / 1000) * inputCostRate;
      const audioInputCost = (safeAudioInputTokens / 1000) * (audioInputCostRate ?? inputCostRate);
      const outputCost = (textOutputTokens / 1000) * outputCostRate;
      const imageOutputCost = (safeImageOutputTokens / 1000) * (imageOutputCostRate ?? outputCostRate);
      const audioOutputCost = (safeAudioOutputTokens / 1000) * (audioOutputCostRate ?? outputCostRate);

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
        cacheReadInputCost,
        imageOutputCost,
        audioInputCost,
        audioOutputCost
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
    cacheReadInputTokens?: number,
    imageOutputTokens: number = 0,
    audioInputTokens: number = 0,
    audioOutputTokens: number = 0
  ): Promise<{
    inputCost: number;
    outputCost: number;
    cacheCreationInputCost?: number;
    cacheReadInputCost?: number;
    imageOutputCost: number;
    audioInputCost: number;
    audioOutputCost: number;
    totalCost: number;
    provider?: string;
  }> {
    if (!inputTokens && !outputTokens && !cacheCreationInputTokens && !cacheReadInputTokens) {
      return { inputCost: 0, outputCost: 0, cacheCreationInputCost: 0, cacheReadInputCost: 0, imageOutputCost: 0, audioInputCost: 0, audioOutputCost: 0, totalCost: 0 };
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
    // Generated-image tokens are a subset of outputTokens (spec §3): price the text share at the
    // output rate and the image share at the manual imageOutputCost rate; outputTokens itself is
    // never changed.
    const safeImageOutputTokens = Math.max(0, imageOutputTokens || 0);
    // Realtime audio tokens are subsets of inputTokens/outputTokens (audio spec §3): text shares
    // at the text rates, audio shares at the manual audio rates; the totals never change.
    const safeAudioInputTokens = Math.min(Math.max(0, audioInputTokens || 0), safeInputTokens);
    const safeAudioOutputTokens = Math.max(0, audioOutputTokens || 0);
    const textInputTokens = Math.max(0, safeInputTokens - safeAudioInputTokens);
    const textOutputTokens = Math.max(0, safeOutputTokens - safeImageOutputTokens - safeAudioOutputTokens);

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
        safeCacheReadInputTokens,
        safeImageOutputTokens,
        pricing.imageOutputCost,
        safeAudioInputTokens,
        safeAudioOutputTokens,
        pricing.audioInputCost,
        pricing.audioOutputCost
      );

      if (tieredCosts) {
        const totalCost = tieredCosts.inputCost + tieredCosts.outputCost + tieredCosts.cacheCreationInputCost + tieredCosts.cacheReadInputCost + tieredCosts.imageOutputCost + tieredCosts.audioInputCost + tieredCosts.audioOutputCost;

        return {
          inputCost: Number(tieredCosts.inputCost.toFixed(6)),
          outputCost: Number(tieredCosts.outputCost.toFixed(6)),
          cacheCreationInputCost: Number(tieredCosts.cacheCreationInputCost.toFixed(6)),
          cacheReadInputCost: Number(tieredCosts.cacheReadInputCost.toFixed(6)),
          imageOutputCost: Number(tieredCosts.imageOutputCost.toFixed(6)),
          audioInputCost: Number(tieredCosts.audioInputCost.toFixed(6)),
          audioOutputCost: Number(tieredCosts.audioOutputCost.toFixed(6)),
          totalCost: Number(totalCost.toFixed(6)),
          provider: pricing.provider
        };
      } else {
        logger.warn('ModelCostService', `Failed to calculate tiered costs for model ${modelId}, falling back to simple pricing`);
      }
    }

    // Fall back to simple pricing calculation
    logger.debug('ModelCostService', `Using simple pricing for model ${modelId}`);
    const inputCost = (textInputTokens / 1000) * pricing.inputCost;
    const audioInputCost = (safeAudioInputTokens / 1000) * (pricing.audioInputCost ?? pricing.inputCost);
    const outputCost = (textOutputTokens / 1000) * pricing.outputCost;
    const imageOutputCost = (safeImageOutputTokens / 1000) * (pricing.imageOutputCost ?? pricing.outputCost);
    const audioOutputCost = (safeAudioOutputTokens / 1000) * (pricing.audioOutputCost ?? pricing.outputCost);

    // Cache token pricing - use actual cache pricing if available from model config,
    // otherwise fall back to 100% of regular input token cost
    const cacheCreationInputCost = safeCacheCreationInputTokens
      ? ((safeCacheCreationInputTokens / 1000) * (pricing.cacheCreationInputCost !== undefined ? pricing.cacheCreationInputCost : pricing.inputCost))
      : 0;
    const cacheReadInputCost = safeCacheReadInputTokens
      ? ((safeCacheReadInputTokens / 1000) * (pricing.cacheReadInputCost !== undefined ? pricing.cacheReadInputCost : pricing.inputCost))
      : 0;

    const totalCost = inputCost + outputCost + cacheCreationInputCost + cacheReadInputCost + imageOutputCost + audioInputCost + audioOutputCost;

    return {
      inputCost: Number(inputCost.toFixed(6)),
      outputCost: Number(outputCost.toFixed(6)),
      cacheCreationInputCost: Number(cacheCreationInputCost.toFixed(6)),
      cacheReadInputCost: Number(cacheReadInputCost.toFixed(6)),
      imageOutputCost: Number(imageOutputCost.toFixed(6)),
      audioInputCost: Number(audioInputCost.toFixed(6)),
      audioOutputCost: Number(audioOutputCost.toFixed(6)),
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

  /** The ADMIN_TO_GATEWAY key for other admin→gateway calls (deployments). */
  async getGatewayServiceKey(): Promise<string> {
    return this.getServiceApiKey();
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
        await this.trySnapshot(models as any);
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
      // Valkey model-list events are fire-and-forget: an admin (re)started after the gateway
      // last published never receives one, leaving ModelCosts empty and usage capture silently
      // gated off. Schedule a one-time direct-fetch fallback that self-heals that case.
      this.scheduleModelDataFallback();
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

  /**
   * Self-heal for Valkey-events mode: the gateway's `model-list-updated` publish is
   * fire-and-forget, so an admin (re)started after the gateway last published never receives it
   * and ModelCosts stays empty - which silently gates usage capture off. If no model-list event
   * has populated model data shortly after boot, fetch it once directly from the gateway.
   */
  private scheduleModelDataFallback(): void {
    setTimeout(() => {
      this.ensureModelDataFallback().catch(err =>
        logger.error('ModelCostService', 'Fallback model-data fetch failed', err instanceof Error ? err : new Error(String(err)))
      );
    }, this.fallbackFetchDelay);
  }

  /**
   * Fetch model data directly if a Valkey event has not already populated it. Broken out from the
   * timer so the boot fallback is unit-testable without waiting on the delay.
   */
  async ensureModelDataFallback(): Promise<void> {
    if (this.hasModelData) {
      return; // a model-list event already populated model data
    }
    logger.warn('ModelCostService', 'No model-list event received after boot - fetching model data directly (self-heal)');
    await this.refreshPricingData(true);
  }
}

export const modelCostService = new ModelCostService();
export default modelCostService;