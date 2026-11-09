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
import { priceExternalEvent } from './externalUsagePricing';
import { computeSapNative } from './sapCapacityService';
import { billingForTenants, unknownTenants, upsertTenant } from './sapTenants';
import { backfillEnvironmentTenantOnce, environmentTenant } from '../db/data/sap-tenant-backfill';
import { touch as touchUser, isServiceKeyEmail } from './usersService';
import { publishMany } from './userQuotaService';
import { foldIncrements, applyIncrements, foldTeamIncrements, applyTeamIncrements, OWNER_EMAIL_FALLBACKS } from './usageCounters';
import { primaryTeamIdsFor, getTeamsByIds } from './teamLookups';
import { publishTeams } from './teamQuotaService';
import { recordToolUsage, ToolEntryLike, UNKNOWN_TOOL_OWNER } from './toolUsageService';

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

/** Same shape check as the gateway's acting-user header (gateway middlewares/actingEmailPattern.ts);
 *  test/unit/acting-email-pattern-parity.test.ts fails when the two drift. */
export const EMAIL_PATTERN = /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/;
const MAX_EMAIL_LENGTH = 255;

/**
 * The e-mail a usage row is booked to: the acting user a platform service key worked for
 * (`onBehalfOf`, Grounding cockpit), else the key owner. `onBehalfOf` is honoured only when the
 * key is a service key and the value is a well-formed e-mail, so a user's own key can never move
 * its usage onto someone else.
 */
export function rowOwnerEmail(event: Pick<UsageEvent, 'onBehalfOf'>, keyEmail: string | undefined): string | undefined {
  const actor = event.onBehalfOf;
  if (keyEmail && isServiceKeyEmail(keyEmail) && typeof actor === 'string'
    && actor.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(actor)) return actor;
  return keyEmail;
}

/**
 * The team a row is booked to (spec §6): the gateway's teamId (what was enforced), else the
 * credential's own team, else the owner's primary. A service key books to the ACTING user's primary
 * team, never to the service key's. Unknown owners get no team.
 */
export function rowTeamId(event: Pick<UsageEvent, 'teamId' | 'onBehalfOf'>, credential: { email?: string; team_ID?: string | null } | undefined, ownerEmail: string | undefined, primaryByEmail: Map<string, string>): string | null {
  if (credential?.email && isServiceKeyEmail(credential.email)) return (ownerEmail && primaryByEmail.get(ownerEmail)) || null;
  return event.teamId || credential?.team_ID || (ownerEmail && primaryByEmail.get(ownerEmail)) || null;
}

/** Unpriced file_search usage (embeddings, rerank) costs nothing; every other endpoint keeps the fallback price. */
export const isFileSearchEndpoint = (endpoint?: string): boolean => typeof endpoint === 'string' && endpoint.startsWith('file_search/');

/**
 * A Connection model's usage (spec 2026-10-23 §6.1): the gateway marks it origin external. It is
 * recorded with its connection and upstream model and no SAP cost: the SAP pricing would read the
 * connection's list-price row as a GenAI rate and write it into the SAP-labelled columns. Its own
 * price goes into listCost/listCostCurrency/pricingMissing (externalUsagePricing.ts). `connection` is the connection name, the id's suffix.
 */
export function externalOf(event: UsageEvent): { connection: string; upstreamModel: string | null } | null {
  if (event.origin !== 'external') return null;
  const cut = event.model.lastIndexOf('--');
  return { connection: cut === -1 ? '' : event.model.slice(cut + 2), upstreamModel: event.upstreamModel ?? null };
}

const COST_COLUMNS = ['inputCost', 'outputCost', 'cacheCreationInputCost', 'cacheReadInputCost', 'totalCost', 'imageOutputCost',
  'audioInputCost', 'audioOutputCost', 'genAiTokens', 'capacityUnits', 'sapCost', 'sapCostCurrency'];

/** The row with every cost column it has set to null. */
function unpriced<T extends Record<string, any>>(row: T): T {
  for (const column of COST_COLUMNS) if (column in row) (row as any)[column] = null;
  return row;
}

const NO_COSTS = { inputCost: 0, outputCost: 0, totalCost: 0, cacheCreationInputCost: 0, cacheReadInputCost: 0, imageOutputCost: 0, audioInputCost: 0, audioOutputCost: 0 };

/** The units a row counts: table cells and rerank search units are kept, everything else is model tokens. */
const unitOf = (event: UsageEvent): 'tokens' | 'cells' | 'units' => (event.unit === 'cells' || event.unit === 'units' ? event.unit : 'tokens');

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
  imageInputTokens?: number;
  imageOutputTokens?: number; // subset of outputTokens, priced separately
  audioInputTokens?: number; // subset of inputTokens, priced separately
  audioOutputTokens?: number; // subset of outputTokens, priced separately
  responseTime: number;
  statusCode: number;
  endpoint?: string; // Add endpoint information for better granularity
  /** The cockpit user a platform service key acted for (Grounding); honoured only for service keys. */
  onBehalfOf?: string;
  /** The team the gateway enforced the request under; absent from older gateways or without a team. */
  teamId?: string;
  /** What inputTokens/outputTokens count: model tokens (default), table cells or rerank search units. */
  unit?: 'tokens' | 'cells' | 'units';
  /** The caller's User-Agent (tool governance). */
  userAgent?: string;
  // True when inputTokens/outputTokens were derived locally (e.g. tokenizing a
  // mid-stream abort's already-streamed text) rather than read off a
  // provider-reported usage object. Absent/false means provider-reported.
  usageEstimated?: boolean;
  /** Tools the request declared and the response invoked, with policy decisions (tool governance); absent when none. */
  tools?: ToolEntryLike[];
  /** A Connection model's usage: the connection id, the provider's model name, and origin external (spec 2026-10-23 §5.5). */
  connectionId?: string;
  upstreamModel?: string;
  origin?: 'external';
  /** The SAP AI Core tenant (auth-URL zone) that served the request; null for Connection traffic and older gateways. */
  sapTenant?: string | null;
  /** Where the serving target came from: the environment key or an SAP AI Core connection. */
  sapTenantSource?: 'environment' | 'connection' | null;
}

/** The gateway's tenant for an environment without a usable AUTH_URL (services/gateway/src/sap/sapTarget.ts). */
const UNKNOWN_TENANT = 'unknown';

/** The SAP tenants that served a batch; Connection events have none. */
const sapZonesOf = (events: UsageEvent[]): string[] => [...new Set(events
  .filter((e) => !externalOf(e))
  .map((e) => e.sapTenant)
  .filter((z): z is string => typeof z === 'string' && z !== ''))];

/**
 * A tenant without a row gets one, without billing settings (the installation default prices it): a
 * connection's tenant normally has its row from the moment its key was stored, the environment
 * key's appears here. Never fails the batch.
 */
async function recordNewTenants(db: any, events: UsageEvent[]): Promise<void> {
  try {
    const env = environmentTenant();
    for (const zone of await unknownTenants(db, sapZonesOf(events).filter((z) => z !== UNKNOWN_TENANT))) {
      await upsertTenant({ zone, zoneId: null, region: env?.zone === zone ? env.region : UNKNOWN_TENANT }, {});
      logger.info('UsageEventProcessor', `SAP tenant ${zone} recorded at first sight`);
    }
  } catch (error) {
    logger.warn('UsageEventProcessor', `SAP tenants not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The first usage event served by the environment key names the environment tenant: the SAP rows
 * recorded before rows carried a tenant take it, once ever (sap-tenant-backfill.ts) - the admin's
 * own environment seldom holds the AUTH_URL the boot-time backfill needs. Never fails the batch.
 */
async function backfillFromEnvironmentEvent(db: any, events: UsageEvent[]): Promise<void> {
  const first = events
    .filter((e) => e.sapTenantSource === 'environment' && typeof e.sapTenant === 'string' && e.sapTenant && e.sapTenant !== UNKNOWN_TENANT && !externalOf(e))
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  if (!first) return;
  try {
    const updated = await backfillEnvironmentTenantOnce(db, first.sapTenant as string, new Date(first.timestamp * 1000));
    if (updated !== null) logger.info('UsageEventProcessor', `SAP tenant backfill gave ${updated} older usage rows the environment tenant ${first.sapTenant}`);
  } catch (error) {
    logger.warn('UsageEventProcessor', `SAP tenant backfill not run: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    // Check for duplicate requests. A missing or 'unknown' requestId (e.g. AWS
    // Bedrock events, historically always 'unknown' when the gateway's payload
    // logging was off) is never treated as a dedup key here — doing so would
    // silently drop every later such event once one had been marked processed.
    // The DB-level usageSignature unique index still guards against genuine
    // duplicate inserts for these events.
    if (event.requestId && event.requestId !== 'unknown' && this.processedRequestIds.has(event.requestId)) {
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

    // Without SAP model data only external (Connection) events can be persisted: they need none.
    // The SAP events stay in the buffer, in order.
    let batch = [...this.batchBuffer];
    let held: UsageEvent[] = [];
    if (!modelCostService.hasValidModelData()) {
      batch = this.batchBuffer.filter(event => externalOf(event));
      held = this.batchBuffer.filter(event => !externalOf(event));
      if (batch.length === 0) {
        logger.debug('UsageEventProcessor', `Skipping batch processing - model data not yet available (${this.batchBuffer.length} events queued)`);
        return;
      }
    }
    
    logger.info('UsageEventProcessor', `Starting batch processing of ${batch.length} usage events`);

    this.isProcessing = true;
    this.batchBuffer = held;

    try {
      logger.debug('UsageEventProcessor', `Processing batch of ${batch.length} usage events`);
      
      await this.persistUsageEvents(batch);
      
      // Mark all request IDs as processed (see queueEvent: never a missing/'unknown' id)
      batch.forEach(event => {
        if (event.requestId && event.requestId !== 'unknown') {
          this.processedRequestIds.add(event.requestId);
        }
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
      await recordNewTenants(db, dedupedEvents);
      await backfillFromEnvironmentEvent(db, dedupedEvents);

      // Group events by auth type for efficient processing
      const apiKeyEvents = dedupedEvents.filter(e => e.authType === 'api_key');
      const awsCredentialEvents = dedupedEvents.filter(e => e.authType === 'aws_credential');

      // Process API key usage events
      const apiKey = apiKeyEvents.length > 0 ? await this.persistApiKeyUsage(db, apiKeyEvents) : { emails: [], teamIds: [] };

      // Process AWS credential usage events
      const aws = awsCredentialEvents.length > 0 ? await this.persistAwsCredentialUsage(db, awsCredentialEvents) : { emails: [], teamIds: [] };

      // Refresh the Users row (task 7 publishes the quota document from the same set) for every
      // distinct owner e-mail this batch touched.
      const emails = new Set([...apiKey.emails, ...aws.emails]);
      for (const email of emails) await touchUser(db, email);
      await publishMany(db, emails);
      await publishTeams(db, new Set([...apiKey.teamIds, ...aws.teamIds]));

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
  private async persistApiKeyUsage(db: any, events: UsageEvent[]): Promise<{ emails: string[]; teamIds: string[] }> {
    // All events are valid - provider will be resolved from model data
    const validEvents = events;

    if (validEvents.length === 0) {
      logger.warn('UsageEventProcessor', 'No valid API key usage events to persist after filtering');
      return { emails: [], teamIds: [] };
    }

    // Fetch API key details for email and name preservation
    const keyIds = [...new Set(validEvents.map(event => event.credentialId))];
    const keyDetails = await db.run(
      SELECT.from('sap.llm.gateway.admin.ApiKeys')
        .columns('ID', 'email', 'name', 'team_ID')
        .where({ ID: { in: keyIds } })
    );
    
    const keyDetailsMap = new Map(keyDetails.map((key: any) => [key.ID, key]));

    const ownerOf = (e: UsageEvent) => rowOwnerEmail(e, (keyDetailsMap.get(e.credentialId) as any)?.email);
    const primaryByEmail = await primaryTeamIdsFor(db, validEvents.map(ownerOf).filter((x): x is string => !!x));
    const teamOf = (e: UsageEvent) => rowTeamId(e, keyDetailsMap.get(e.credentialId) as any, ownerOf(e), primaryByEmail);
    const teamNames = await getTeamsByIds(db, validEvents.map(teamOf).filter((x): x is string => !!x));

    // Read the tenants' billing terms once per batch, not per row.
    const billing = await billingForTenants(db, sapZonesOf(validEvents));

    const usageRecords = await Promise.all(validEvents.map(async event => {
      const keyDetail = keyDetailsMap.get(event.credentialId) as any;
      const fileSearch = isFileSearchEndpoint(event.endpoint);

      const imageOutputTokens = event.imageOutputTokens || 0;
      const audioInputTokens = event.audioInputTokens || 0;
      const audioOutputTokens = event.audioOutputTokens || 0;
      const external = externalOf(event);
      const listPriced = external ? await priceExternalEvent(db, event) : null;
      // Calculate costs using model cost service with separate cache token handling
      const costs = external ? { ...NO_COSTS, provider: event.provider } : this.config.enableCostCalculation ?
        await modelCostService.calculateCosts(
          event.model,
          event.inputTokens,
          event.outputTokens,
          new Date(event.timestamp * 1000),
          event.cacheCreationInputTokens,
          event.cacheReadInputTokens,
          imageOutputTokens,
          audioInputTokens,
          audioOutputTokens,
          { zeroWhenUnpriced: fileSearch }
        ) :
        { inputCost: 0, outputCost: 0, totalCost: 0, provider: modelCostService.getModelProvider(event.model), cacheCreationInputCost: 0, cacheReadInputCost: 0, imageOutputCost: 0, audioInputCost: 0, audioOutputCost: 0 };

      // Resolve provider from model data instead of using event.provider (which is now 'unknown')
      const resolvedProvider = costs.provider || modelCostService.getModelProvider(event.model);

      const imageInputTokens = event.imageInputTokens || 0;
      const sap = external ? null : await computeSapNative({
        model: event.model,
        provider: resolvedProvider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadInputTokens: event.cacheReadInputTokens || 0,
        cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
        imageInputTokens,
        imageOutputTokens,
        audioInputTokens,
        audioOutputTokens,
        at: event.timestamp ? new Date(event.timestamp * 1000) : new Date(),
        ...billing(event.sapTenant)
      });
      if (!sap && !external) {
        logger.info('UsageEventProcessor', 'No ModelCosts rate for model — SAP-native fields left null', { model: event.model });
      }

      const row = {
        ID: uuidv4(),
        apiKey_ID: event.credentialId,
        endpoint: event.endpoint || `/${resolvedProvider.toLowerCase()}/api/v1/chat/completions`, // Use resolved provider
        method: 'POST',
        statusCode: event.statusCode,
        responseTime: event.responseTime,
        email: rowOwnerEmail(event, keyDetail?.email) || 'unknown@example.com', // the acting user (service key + onBehalfOf) or the key owner
        keyName: keyDetail?.name || 'Unknown Key', // Preserve key name
        team_ID: teamOf(event),
        teamName: null as string | null,
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
        unit: unitOf(event),
        imageInputTokens,
        imageOutputTokens,
        imageOutputCost: costs.imageOutputCost || 0,
        audioInputTokens,
        audioOutputTokens,
        audioInputCost: costs.audioInputCost || 0,
        audioOutputCost: costs.audioOutputCost || 0,
        genAiTokens: sap?.genAiTokens ?? null,
        capacityUnits: sap?.capacityUnits ?? null,
        // An unpriced file_search event costs zero on the SAP side too (it is not "unknown").
        sapCost: sap?.sapCost ?? (fileSearch ? 0 : null),
        sapCostCurrency: sap?.sapCostCurrency ?? null,
        usageSignature: hashUsageSignature(event),
        origin: external ? 'external' : 'sap',
        connection: external?.connection ?? null,
        upstreamModel: external?.upstreamModel ?? null,
        sapTenant: external ? null : event.sapTenant || null
      };
      return external ? { ...unpriced(row), ...listPriced } : row;
    }));
    for (const r of usageRecords) r.teamName = r.team_ID ? teamNames.get(r.team_ID)?.name ?? null : null;

    // Rows, usageCount and the usage buckets land together or not at all (spec §3.2): one
    // transaction per table batch. The cost lookups above stay outside it — the single SQLite
    // connection is never held across a gateway call, and the transaction only touches the DB.
    // db.tx(fn) would open a root transaction and deadlock the single connection from inside a
    // request; db.run(fn) joins the ambient one or opens its own.
    const inserted: boolean[] = await db.run(async (tx: any) => {
      const flags = await this.insertIgnoringDuplicateSignature(tx, 'sap_llm_gateway_admin_ApiKeyUsage', usageRecords);
      await this.bumpUsageCount(tx, 'sap_llm_gateway_admin_ApiKeys', validEvents.filter((_, i) => flags[i]));
      await applyIncrements(tx, foldIncrements(usageRecords.filter((_, i) => flags[i]), (r) => r.email));
      await applyTeamIncrements(tx, foldTeamIncrements(usageRecords.filter((_, i) => flags[i]), (r) => r.team_ID));
      const emailByRequest = new Map(usageRecords.map((r) => [r.requestId, r.email]));
      await recordToolUsage(tx, validEvents.filter((_, i) => flags[i]), (e) => emailByRequest.get(e.requestId ?? '') ?? UNKNOWN_TOOL_OWNER);
      return flags;
    });
    const insertedEvents = validEvents.filter((_, i) => inserted[i]);

    logger.debug('UsageEventProcessor', `Persisted ${insertedEvents.length} API key usage records (filtered from ${events.length} events, ${usageRecords.length - insertedEvents.length} duplicate signature(s) skipped)`);

    // From the inserted rows, not the key list: a service-key row is booked to its acting user,
    // whose Users row and quota document must follow; the service key itself has neither.
    return {
      emails: [...new Set(
        usageRecords.filter((_, i) => inserted[i])
          .map((r) => r.email)
          .filter((email) => email && !OWNER_EMAIL_FALLBACKS.has(email) && !isServiceKeyEmail(email))
      )],
      teamIds: [...new Set(usageRecords.filter((_, i) => inserted[i]).map((r) => r.team_ID).filter(Boolean) as string[])]
    };
  }

  /**
   * Persist AWS credential usage events. Returns the distinct owner e-mails resolved from the
   * batch (skipping the 'unknown-user' fallback), for the caller to touch afterwards.
   */
  private async persistAwsCredentialUsage(db: any, events: UsageEvent[]): Promise<{ emails: string[]; teamIds: string[] }> {
    // All events are valid - provider will be resolved from model data
    const validEvents = events;

    if (validEvents.length === 0) {
      logger.warn('UsageEventProcessor', 'No valid AWS credential usage events to persist after filtering');
      return { emails: [], teamIds: [] };
    }

    // Fetch AWS credential details for email and name preservation
    const credentialIds = [...new Set(validEvents.map(event => event.credentialId))];
    const credentialDetails = await db.run(
      SELECT.from('sap.llm.gateway.admin.AwsCredentials')
        .columns('ID', 'userId', 'email', 'name', 'team_ID')
        .where({ ID: { in: credentialIds } })
    );
    
    const credentialDetailsMap = new Map(credentialDetails.map((cred: any) => [cred.ID, cred]));

    const ownerOf = (e: UsageEvent) => (credentialDetailsMap.get(e.credentialId) as any)?.email as string | undefined;
    const primaryByEmail = await primaryTeamIdsFor(db, validEvents.map(ownerOf).filter((x): x is string => !!x));
    const teamOf = (e: UsageEvent) => rowTeamId(e, credentialDetailsMap.get(e.credentialId) as any, ownerOf(e), primaryByEmail);
    const teamNames = await getTeamsByIds(db, validEvents.map(teamOf).filter((x): x is string => !!x));

    // Read the tenants' billing terms once per batch, not per row.
    const billing = await billingForTenants(db, sapZonesOf(validEvents));

    const usageRecords = await Promise.all(validEvents.map(async event => {
      const credentialDetail = credentialDetailsMap.get(event.credentialId) as any;
      
      const imageOutputTokens = (event as any).imageOutputTokens || 0;
      const audioInputTokens = (event as any).audioInputTokens || 0;
      const audioOutputTokens = (event as any).audioOutputTokens || 0;
      const external = externalOf(event);
      const listPriced = external ? await priceExternalEvent(db, event) : null;
      // Calculate costs using model cost service with separate cache token handling
      const costs = external ? { ...NO_COSTS, provider: event.provider } : this.config.enableCostCalculation ?
        await modelCostService.calculateCosts(
          event.model,
          event.inputTokens,
          event.outputTokens,
          new Date(event.timestamp * 1000),
          event.cacheCreationInputTokens,
          event.cacheReadInputTokens,
          imageOutputTokens,
          audioInputTokens,
          audioOutputTokens
        ) :
        { inputCost: 0, outputCost: 0, totalCost: 0, provider: modelCostService.getModelProvider(event.model), cacheCreationInputCost: 0, cacheReadInputCost: 0, imageOutputCost: 0, audioInputCost: 0, audioOutputCost: 0 };

      // Resolve provider from model data instead of using event.provider (which is now 'unknown')
      const resolvedProvider = costs.provider || modelCostService.getModelProvider(event.model);

      const imageInputTokens = (event as any).imageInputTokens || 0;
      const sap = external ? null : await computeSapNative({
        model: event.model,
        provider: resolvedProvider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadInputTokens: event.cacheReadInputTokens || 0,
        cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
        imageInputTokens,
        imageOutputTokens,
        audioInputTokens,
        audioOutputTokens,
        at: event.timestamp ? new Date(event.timestamp * 1000) : new Date(),
        ...billing(event.sapTenant)
      });
      if (!sap && !external) {
        logger.info('UsageEventProcessor', 'No ModelCosts rate for model — SAP-native fields left null', { model: event.model });
      }

      const row = {
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
        team_ID: teamOf(event),
        teamName: null as string | null,
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
        unit: (event as any).unit === 'cells' ? 'cells' : 'tokens',
        imageInputTokens,
        imageOutputTokens,
        imageOutputCost: costs.imageOutputCost || 0,
        audioInputTokens,
        audioOutputTokens,
        audioInputCost: costs.audioInputCost || 0,
        audioOutputCost: costs.audioOutputCost || 0,
        genAiTokens: sap?.genAiTokens ?? null,
        capacityUnits: sap?.capacityUnits ?? null,
        sapCost: sap?.sapCost ?? null,
        sapCostCurrency: sap?.sapCostCurrency ?? null,
        usageSignature: hashUsageSignature(event),
        origin: external ? 'external' : 'sap',
        connection: external?.connection ?? null,
        upstreamModel: external?.upstreamModel ?? null,
        sapTenant: external ? null : event.sapTenant || null
      };
      return external ? { ...unpriced(row), ...listPriced } : row;
    }));
    for (const r of usageRecords) r.teamName = r.team_ID ? teamNames.get(r.team_ID)?.name ?? null : null;

    // db.tx(fn) would open a root transaction and deadlock the single connection from inside a
    // request; db.run(fn) joins the ambient one or opens its own.
    const inserted: boolean[] = await db.run(async (tx: any) => {
      const flags = await this.insertIgnoringDuplicateSignature(tx, 'sap_llm_gateway_admin_AwsCredentialUsage', usageRecords);
      await this.bumpUsageCount(tx, 'sap_llm_gateway_admin_AwsCredentials', validEvents.filter((_, i) => flags[i]));
      await applyIncrements(tx, foldIncrements(usageRecords.filter((_, i) => flags[i]),
        (r) => (credentialDetailsMap.get(r.credential_ID) as any)?.email ?? null));
      await applyTeamIncrements(tx, foldTeamIncrements(usageRecords.filter((_, i) => flags[i]), (r) => r.team_ID));
      // The tool rows must carry the same owner the quota buckets above just folded by - not
      // usageRecords[i].userId, a documented legacy field distinct from email (AwsCredentials).
      const emailByRequest = new Map(usageRecords.map((r) => [r.requestId, (credentialDetailsMap.get(r.credential_ID) as any)?.email]));
      await recordToolUsage(tx, validEvents.filter((_, i) => flags[i]), (e) => emailByRequest.get(e.requestId ?? '') ?? UNKNOWN_TOOL_OWNER);
      return flags;
    });
    const insertedEvents = validEvents.filter((_, i) => inserted[i]);

    logger.debug('UsageEventProcessor', `Persisted ${insertedEvents.length} AWS credential usage records (filtered from ${events.length} events, ${usageRecords.length - insertedEvents.length} duplicate signature(s) skipped)`);

    return {
      emails: [...new Set(
        Array.from(credentialDetailsMap.values())
          .map((cred: any) => cred?.email)
          .filter((email: any) => email && !OWNER_EMAIL_FALLBACKS.has(email))
      )] as string[],
      teamIds: [...new Set(usageRecords.filter((_, i) => inserted[i]).map((r) => r.team_ID).filter(Boolean) as string[])]
    };
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
    // Without SAP model data only external (Connection) events are persisted; the others wait in the buffer.
    if (!modelCostService.hasValidModelData()) {
      const sapEvents = events.filter(event => !externalOf(event));
      events = events.filter(event => externalOf(event));
      if (sapEvents.length > 0) {
        logger.info('UsageEventProcessor', `Model data not yet available - ${sapEvents.length} SAP events queued, ${events.length} external events processed`);
        this.batchBuffer.push(...sapEvents);
      }
      if (events.length === 0) return;
    }

    // Filter out already processed events (see queueEvent: never a missing/'unknown' id)
    const newEvents = events.filter(event => {
      if (event.requestId && event.requestId !== 'unknown' && this.processedRequestIds.has(event.requestId)) {
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
    
    // Mark processed events (see queueEvent: never a missing/'unknown' id)
    newEvents.forEach(event => {
      if (event.requestId && event.requestId !== 'unknown') {
        this.processedRequestIds.add(event.requestId);
      }
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