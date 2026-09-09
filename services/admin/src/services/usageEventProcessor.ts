// Make Valkey optional since it may not be installed
let Redis: any;
try {
  Redis = require('iovalkey');
} catch (error) {
  // Valkey not available, will use fallback mode only
}
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import modelCostService from './modelCostService';
import { computeSapNative, isProductive } from './sapCapacityService';
import { touch as touchUser } from './usersService';
import { publishMany } from './userQuotaService';
import { foldIncrements, applyIncrements, OWNER_EMAIL_FALLBACKS } from './usageCounters';

const logger = getDefaultLogger();
const cds = require('@sap/cds');
const { SELECT } = cds.ql;

/**
 * Deterministic content signature for a usage event — the same field set used by the shipped
 * intra-batch dedup below. Used AS-IS (no length limit) for that in-memory dedup; NEVER written
 * to the DB directly — see `hashUsageSignature` for the fixed-length form that is. NOT
 * requestId alone: AWS Bedrock usage events all carry the fallback requestId 'unknown'
 * (verified on the Kyma DB — 193 AwsCredentialUsage rows share it), so a requestId-only key
 * would wrongly merge genuinely distinct AWS requests.
 */
function computeUsageSignature(e: UsageEvent): string {
  return [
    e.requestId, e.authType, e.credentialId, e.model, e.statusCode,
    e.inputTokens, e.outputTokens, e.cacheCreationInputTokens ?? '',
    e.cacheReadInputTokens ?? '', e.responseTime, e.timestamp
  ].join('|');
}

/**
 * Fixed-length (64 hex chars) form of `computeUsageSignature`, used for the persisted
 * `usageSignature` column and the DB conflict key. The raw signature is unbounded — a long AWS
 * Bedrock inference-profile ARN in `modelId` (itself `String(200)`) alone can push it well past
 * the column's `String(200)` limit, which SQLite silently ignores but PostgreSQL enforces
 * (INSERT fails outright), permanently stalling that event's batch. Hashing sidesteps the limit
 * entirely while keeping the same collision behavior: two events collapse to one row iff their
 * raw signatures are identical.
 */
function hashUsageSignature(e: UsageEvent): string {
  return createHash('sha256').update(computeUsageSignature(e)).digest('hex');
}

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
  // True when inputTokens/outputTokens were derived locally (e.g. tokenizing a
  // mid-stream abort's already-streamed text) rather than read off a
  // provider-reported usage object. Absent/false means provider-reported.
  usageEstimated?: boolean;
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

    // Intra-batch de-duplication. The callers' `processedRequestIds` guard only
    // rejects a requestId already persisted by an EARLIER batch; it is marked
    // after persist, so two copies of the same request's usage within ONE batch
    // (the gateway can publish a request's usage more than once into a single
    // flush window) both pass that guard and would each be inserted, producing
    // duplicate usage rows. Both ingestion paths (processBatch and
    // processMemoryQueue) funnel through here, so collapse duplicates at this
    // single chokepoint before persisting.
    //
    // Keyed on a full content signature, NOT requestId alone: AWS Bedrock usage
    // events all carry the fallback requestId `'unknown'` (verified on the Kyma
    // DB — 193 AwsCredentialUsage rows share it), so a requestId-only key would
    // wrongly merge genuinely distinct AWS requests that happen to land in the
    // same batch. A content signature only collapses byte-identical events,
    // which is exactly the observed defect (same requestId AND same tokens,
    // metrics, and timing) while preserving every distinct event.
    //
    // This is defense-in-depth ON TOP OF the DB-level unique `usageSignature` index
    // (same field set, computed again per-record in persistApiKeyUsage/
    // persistAwsCredentialUsage): collapsing here first reduces how often the
    // conflict-tolerant insert below has to actually eat a rejected row.
    const seen = new Set<string>();
    const dedupedEvents = events.filter(event => {
      const key = computeUsageSignature(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    try {
      // Group events by auth type for efficient processing
      const apiKeyEvents = dedupedEvents.filter(e => e.authType === 'api_key');
      const awsCredentialEvents = dedupedEvents.filter(e => e.authType === 'aws_credential');

      // Process API key usage events
      const apiKeyEmails = apiKeyEvents.length > 0 ? await this.persistApiKeyUsage(db, apiKeyEvents) : [];

      // Process AWS credential usage events
      const awsCredentialEmails = awsCredentialEvents.length > 0 ? await this.persistAwsCredentialUsage(db, awsCredentialEvents) : [];

      // Refresh the Users row (task 7 publishes the quota document from the same set) for every
      // distinct owner e-mail this batch touched.
      const emails = new Set([...apiKeyEmails, ...awsCredentialEmails]);
      for (const email of emails) await touchUser(db, email);
      await publishMany(db, emails);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('UsageEventProcessor', `Database operation failed during usage persistence: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Persist API key usage events. Returns the distinct owner e-mails resolved from the batch
   * (skipping the 'unknown@example.com' fallback), for the caller to touch afterwards.
   */
  private async persistApiKeyUsage(db: any, events: UsageEvent[]): Promise<string[]> {
    // All events are valid - provider will be resolved from model data
    const validEvents = events;

    if (validEvents.length === 0) {
      logger.warn('UsageEventProcessor', 'No valid API key usage events to persist after filtering');
      return [];
    }

    // Fetch API key details for email and name preservation
    const keyIds = [...new Set(validEvents.map(event => event.credentialId))];
    const keyDetails = await db.run(
      SELECT.from('sap.llm.gateway.admin.ApiKeys')
        .columns('ID', 'email', 'name')
        .where({ ID: { in: keyIds } })
    );
    
    const keyDetailsMap = new Map(keyDetails.map((key: any) => [key.ID, key]));

    // Read the productive flag once per batch, not per row.
    const productive = isProductive();

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
      
      const imageInputTokens = (event as any).imageInputTokens || 0;
      const sap = await computeSapNative({
        model: event.model,
        provider: resolvedProvider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadInputTokens: event.cacheReadInputTokens || 0,
        cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
        imageInputTokens,
        at: event.timestamp ? new Date(event.timestamp * 1000) : new Date(),
        productive
      });
      if (!sap) {
        logger.info('UsageEventProcessor', 'No ModelCosts rate for model — SAP-native fields left null', { model: event.model });
      }

      return {
        ID: uuidv4(),
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
        validTo: new Date('9999-12-31T23:59:59.999Z'),
        usageEstimated: event.usageEstimated ?? null,
        imageInputTokens,
        genAiTokens: sap?.genAiTokens ?? null,
        capacityUnits: sap?.capacityUnits ?? null,
        sapCost: sap?.sapCost ?? null,
        sapCostCurrency: sap?.sapCostCurrency ?? null,
        usageSignature: hashUsageSignature(event)
      };
    }));

    // Rows, usageCount and the usage buckets land together or not at all (spec §3.2): one
    // transaction per table batch. The cost lookups above stay outside it — the single SQLite
    // connection is never held across a gateway call, and the transaction only touches the DB.
    // db.tx(fn) would open a root transaction and deadlock the single connection from inside a
    // request; db.run(fn) joins the ambient one or opens its own.
    const inserted: boolean[] = await db.run(async (tx: any) => {
      const flags = await this.insertIgnoringDuplicateSignature(tx, 'sap_llm_gateway_admin_ApiKeyUsage', usageRecords);
      await this.bumpUsageCount(tx, 'sap_llm_gateway_admin_ApiKeys', validEvents.filter((_, i) => flags[i]));
      await applyIncrements(tx, foldIncrements(usageRecords.filter((_, i) => flags[i]), (r) => r.email));
      return flags;
    });
    const insertedEvents = validEvents.filter((_, i) => inserted[i]);

    logger.debug('UsageEventProcessor', `Persisted ${insertedEvents.length} API key usage records (filtered from ${events.length} events, ${usageRecords.length - insertedEvents.length} duplicate signature(s) skipped)`);

    return [...new Set(
      Array.from(keyDetailsMap.values())
        .map((key: any) => key?.email)
        .filter((email: any) => email && !OWNER_EMAIL_FALLBACKS.has(email))
    )] as string[];
  }

  /**
   * Persist AWS credential usage events. Returns the distinct owner e-mails resolved from the
   * batch (skipping the 'unknown-user' fallback), for the caller to touch afterwards.
   */
  private async persistAwsCredentialUsage(db: any, events: UsageEvent[]): Promise<string[]> {
    // All events are valid - provider will be resolved from model data
    const validEvents = events;

    if (validEvents.length === 0) {
      logger.warn('UsageEventProcessor', 'No valid AWS credential usage events to persist after filtering');
      return [];
    }

    // Fetch AWS credential details for email and name preservation
    const credentialIds = [...new Set(validEvents.map(event => event.credentialId))];
    const credentialDetails = await db.run(
      SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('ID', 'userId', 'email', 'name')
        .where({ ID: { in: credentialIds } })
    );
    
    const credentialDetailsMap = new Map(credentialDetails.map((cred: any) => [cred.ID, cred]));

    // Read the productive flag once per batch, not per row.
    const productive = isProductive();

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
      
      const imageInputTokens = (event as any).imageInputTokens || 0;
      const sap = await computeSapNative({
        model: event.model,
        provider: resolvedProvider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadInputTokens: event.cacheReadInputTokens || 0,
        cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
        imageInputTokens,
        at: event.timestamp ? new Date(event.timestamp * 1000) : new Date(),
        productive
      });
      if (!sap) {
        logger.info('UsageEventProcessor', 'No ModelCosts rate for model — SAP-native fields left null', { model: event.model });
      }

      return {
        ID: uuidv4(),
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
        validTo: new Date('9999-12-31T23:59:59.999Z'),
        usageEstimated: event.usageEstimated ?? null,
        imageInputTokens,
        genAiTokens: sap?.genAiTokens ?? null,
        capacityUnits: sap?.capacityUnits ?? null,
        sapCost: sap?.sapCost ?? null,
        sapCostCurrency: sap?.sapCostCurrency ?? null,
        usageSignature: hashUsageSignature(event)
      };
    }));

    // db.tx(fn) would open a root transaction and deadlock the single connection from inside a
    // request; db.run(fn) joins the ambient one or opens its own.
    const inserted: boolean[] = await db.run(async (tx: any) => {
      const flags = await this.insertIgnoringDuplicateSignature(tx, 'sap_llm_gateway_admin_AwsCredentialUsage', usageRecords);
      await this.bumpUsageCount(tx, 'sap_llm_gateway_admin_AwsCredentials', validEvents.filter((_, i) => flags[i]));
      await applyIncrements(tx, foldIncrements(usageRecords.filter((_, i) => flags[i]),
        (r) => (credentialDetailsMap.get(r.credential_ID) as any)?.email ?? null));
      return flags;
    });
    const insertedEvents = validEvents.filter((_, i) => inserted[i]);

    logger.debug('UsageEventProcessor', `Persisted ${insertedEvents.length} AWS credential usage records (filtered from ${events.length} events, ${usageRecords.length - insertedEvents.length} duplicate signature(s) skipped)`);

    return [...new Set(
      Array.from(credentialDetailsMap.values())
        .map((cred: any) => cred?.email)
        .filter((email: any) => email && !OWNER_EMAIL_FALLBACKS.has(email))
    )] as string[];
  }

  /** Adds each credential's landed-row count to its usageCount, in one statement. `db` may be a transaction. */
  private async bumpUsageCount(db: any, table: 'sap_llm_gateway_admin_ApiKeys' | 'sap_llm_gateway_admin_AwsCredentials', events: UsageEvent[]): Promise<void> {
    const counts = events.reduce((acc, event) => { acc[event.credentialId] = (acc[event.credentialId] || 0) + 1; return acc; }, {} as Record<string, number>);
    const ids = Object.keys(counts);
    if (ids.length === 0) return;
    const caseStatements = Object.entries(counts).map(([id, count]) => `WHEN '${id}' THEN ${count}`).join(' ');
    await db.run(`
      UPDATE ${table}
      SET usageCount = usageCount + CASE ID
        ${caseStatements}
        ELSE 0
      END
      WHERE ID IN (${ids.map(id => `'${id}'`).join(',')})
    `);
  }

  /**
   * Insert `records` into `table`, silently dropping any row whose `usageSignature` collides
   * with one already persisted — the DB-level guard against the multi-subscriber double-insert
   * (see the class doc on `persistUsageEvents`). CAP's `INSERT.into(...).entries(...)` does not
   * emit a conflict clause, so this issues the dialect-specific statement as raw SQL via
   * `db.run`, dialect-detected the same way `costRecalculationService` does. Returns, per
   * record (same order as `records`), whether that row was actually inserted — callers use this
   * to avoid double-incrementing usageCount for a row the DB silently ignored.
   */
  private async insertIgnoringDuplicateSignature(
    db: any,
    table: string,
    records: Record<string, any>[]
  ): Promise<boolean[]> {
    if (records.length === 0) return [];

    const isPostgreSQL = (db.options ?? db.service?.options)?.credentials?.kind === 'postgres' || process.env.CDS_ENV === 'pg' || process.env.NODE_CONFIG_ENV === 'pg';

    // Every record is built from the same object-literal shape (see the two callers), so the
    // key set/order is stable across all of them — safe to derive columns from the first row.
    const columns = Object.keys(records[0]);
    const placeholders = isPostgreSQL
      ? columns.map((_, i) => `$${i + 1}`).join(', ')
      : columns.map(() => '?').join(', ');
    const sql = isPostgreSQL
      ? `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (usageSignature) DO NOTHING`
      : `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

    const inserted: boolean[] = [];
    for (const record of records) {
      const values = columns.map(col => this.toDbParam(record[col], isPostgreSQL));
      // One row per round trip, not one multi-row VALUES: keeps per-row placeholder numbering
      // (Postgres $1..$n) trivial and lets us read back changes/rowCount per row below.
      const result = await db.run(sql, values);
      const changes = result?.changes ?? result?.rowCount ?? 0;
      inserted.push(changes > 0);
    }
    return inserted;
  }

  /**
   * Convert a JS record value into something the raw SQL driver can actually bind. Raw
   * `db.run(sql, params)` bypasses CAP's CQN-to-SQL layer (which normally does this type-aware
   * conversion for `INSERT.entries()`), so it must be done by hand here:
   *  - `better-sqlite3` (the SQLite driver) rejects Boolean and Date params outright — only
   *    number/string/bigint/buffer/null are bindable.
   *  - `node-postgres` binds JS `boolean` correctly against a `boolean` column, but an
   *    integer 0/1 would not implicitly cast to one.
   * ISO date strings, in contrast, bind correctly against a timestamp column on both drivers.
   */
  private toDbParam(value: any, isPostgreSQL: boolean): any {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return isPostgreSQL ? value : (value ? 1 : 0);
    return value;
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