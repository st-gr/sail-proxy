/**
 * Turns a parsed `siem` config block (services/gateway/api_config.json, under
 * `api_config.observability.siem`) into the sinks and DispatcherConfig that startDispatcher needs. Kept
 * separate from admin-service.ts's initializeSiemDispatcher(), which owns the CAP/CDS side
 * (reading the active configuration row) so this half — deciding whether to start at all,
 * building each sink, resolving the webhook sink's token through the injected getSecret
 * (the other five sinks resolve their own credential inside the sink itself, via
 * resolveSecret in sink.ts) — stays pure and importable on its own for unit tests. The
 * encrypted credential store is the only source; there is no environment fallback.
 *
 * That separation is not cosmetic: admin-service.ts cannot be required in a Jest test.
 * Probed directly — importing it (transitively, via config-service.ts and
 * securityEventSubscriber.ts) opens a real Valkey connection and starts an uncancelled
 * `setInterval`/`setTimeout` as import-time side effects of sibling singletons, independent
 * of this change. This module has none of that.
 */
import { getDefaultLogger } from '@libs/logger';
import { SiemSink } from './sink';
import type { SecretResolver } from './secretResolver';
import { DispatcherConfig } from './dispatcher';
import { createWebhookSink } from './sinks/webhookSink';
import { createOtelSink } from './sinks/otelSink';
import { createDatadogSink } from './sinks/datadogSink';
import { createAzureSentinelSink } from './sinks/azureSentinelSink';
import { createGcsPubSubSink } from './sinks/gcsPubSubSink';
import { createS3Sink } from './sinks/s3Sink';

const logger = getDefaultLogger();

export interface SiemSinkDefinition {
  name: string;
  type: string;
  enabled?: boolean;
  url?: string;
  token_env?: string;
  /** OTLP/HTTP collector endpoint (type: 'otel'). */
  endpoint?: string;
  /** Name of an env var holding extra headers as JSON (type: 'otel'). */
  headers_env?: string;
  /** Datadog regional site, e.g. 'datadoghq.com', 'datadoghq.eu' (type: 'datadog'). */
  site?: string;
  /** Name of an env var holding the Datadog API key (type: 'datadog'). */
  api_key_env?: string;
  /** Data Collection Endpoint host (type: 'azure_sentinel'). */
  dcr_endpoint?: string;
  /** Data Collection Rule immutable ID (type: 'azure_sentinel'). */
  dcr_immutable_id?: string;
  /** Data Collection Rule stream name (type: 'azure_sentinel'). */
  stream_name?: string;
  /** Microsoft Entra tenant ID (type: 'azure_sentinel'). */
  tenant_id?: string;
  /** Microsoft Entra app registration client ID (type: 'azure_sentinel'). */
  client_id?: string;
  /** Name of an env var holding the client secret (type: 'azure_sentinel'). */
  client_secret_env?: string;
  /** GCP project ID (type: 'gcs_pubsub'). */
  project_id?: string;
  /** Pub/Sub topic ID (type: 'gcs_pubsub'). */
  topic_id?: string;
  /** Name of an env var holding the service-account JSON key (type: 'gcs_pubsub'). */
  service_account_json_env?: string;
  /** S3 bucket name (type: 's3'). */
  bucket?: string;
  /** AWS region, e.g. 'us-east-1' (type: 's3'). */
  region?: string;
  /** Key prefix objects are written under, e.g. 'sail-proxy/siem' (type: 's3'). */
  prefix?: string;
  /** Name of an env var holding the AWS access key ID (type: 's3'). */
  access_key_id_env?: string;
  /** Name of an env var holding the AWS secret access key (type: 's3'). */
  secret_access_key_env?: string;
  /** Per-sink override of the dispatcher's global batch_size. Ignored (with a warn) if not a positive number. */
  batch_size?: number;
  /** Per-sink override of the dispatcher's global interval_ms. Ignored (with a warn) if not a positive number — a zero would make the dispatcher tick continuously. */
  interval_ms?: number;
  /**
   * Per-sink opt-in to ship the full raw value of an unresolved credential
   * (SiemEvent.actor.credential_material) to THIS sink. Default false. Separate from
   * include_content: prompt/response text and credential material are different risk
   * categories an operator may decide differently. Risk: enabling this sends secret-shaped
   * values (an unrecognized API key, AWS access key ID) to this sink in full — only enable
   * it for a sink an operator trusts with that material and has a specific forensic need
   * for it (see SiemSink.includeCredentialMaterial, siem/dispatcher.ts).
   */
  include_credential_material?: boolean;
  /**
   * Per-sink opt-in to ship the request's prompt and response (SiemEvent.content) to THIS
   * sink. Default false. What it ships is the MASKED form — pseudonymized placeholders, not
   * raw PII — unless allow_unmasked_content is also set. Risk: even masked, this is
   * conversation content leaving the box; enable it only for a sink an operator trusts with
   * it (see SiemSink.includeContent, siem/dispatcher.ts).
   */
  include_content?: boolean;
  /**
   * Per-sink opt-in to receive content the pseudonymization pipeline never masked, because
   * masking was disabled or bypassed for that request. Default false, and only consulted
   * alongside include_content. Risk: this is the one setting under which a raw prompt — real
   * names, emails, secrets a user pasted — leaves this system in full. Without it, such a
   * request ships metadata only and records `content.omitted: 'not-masked'`.
   */
  allow_unmasked_content?: boolean;
  [key: string]: any;
}

export interface SiemConfigBlock {
  enabled?: boolean;
  batch_size?: number;
  interval_ms?: number;
  /**
   * How far back reconcileOutbox (siem/outbox.ts) scans/backfills, in ms. Defaults to
   * outbox.ts's own DEFAULT_RECONCILE_LOOKBACK_MS (24h) when absent. See reconcileOutbox's
   * doc comment for why this exists: an unbounded reconcile scan grows with the whole
   * retained outbox, and backfills a newly enabled sink's entire retained history.
   */
  reconcile_lookback_ms?: number;
  sinks?: SiemSinkDefinition[];
}

export interface ResolvedDispatch {
  sinks: SiemSink[];
  dispatcherConfig: DispatcherConfig;
  /** One entry per sink that was skipped, or whose named token env var is unset — the caller logs these. */
  warnings: string[];
}

/**
 * Returns null when the dispatcher should not start at all: `siem.enabled` is not true, or
 * no configured sink is both individually enabled and passes validateConfig(). A
 * misconfigured or unsupported-type sink is skipped with a warning rather than stopping
 * the others from starting.
 */
export function resolveSiemDispatch(
  siem: SiemConfigBlock | undefined,
  getSecret?: SecretResolver
): ResolvedDispatch | null {
  if (!siem?.enabled) return null;

  const warnings: string[] = [];
  const sinks: SiemSink[] = [];
  const perSink: Record<string, { batchSize?: number; intervalMs?: number }> = {};

  for (const sinkCfg of siem.sinks ?? []) {
    if (!sinkCfg?.enabled) continue;

    let sink: SiemSink;
    if (sinkCfg.type === 'webhook') {
      // The token itself never lives in config — only the name of the credential slot that
      // holds it. Logged below is the slot NAME, never its value. Resolved through the
      // injected getSecret so a stored, rotated credential applies without a restart; there
      // is no environment fallback for a caller that injects nothing.
      const token = sinkCfg.token_env ? getSecret?.(sinkCfg.token_env) : undefined;
      if (sinkCfg.token_env && !token) {
        warnings.push(`sink '${sinkCfg.name}' names credential slot '${sinkCfg.token_env}' with no credential stored; the sink cannot authenticate`);
      }
      sink = createWebhookSink({
        name: sinkCfg.name,
        url: sinkCfg.url ?? '',
        token,
        includeCredentialMaterial: sinkCfg.include_credential_material === true,
        includeContent: sinkCfg.include_content === true,
        allowUnmaskedContent: sinkCfg.allow_unmasked_content === true,
      });
    } else if (sinkCfg.type === 'otel') {
      // headersEnv is passed through as the env var NAME — the otel sink itself resolves
      // and parses it at validateConfig()/send() time, never here.
      sink = createOtelSink({
        name: sinkCfg.name,
        endpoint: sinkCfg.endpoint ?? '',
        headersEnv: sinkCfg.headers_env,
        includeCredentialMaterial: sinkCfg.include_credential_material === true,
        includeContent: sinkCfg.include_content === true,
        allowUnmaskedContent: sinkCfg.allow_unmasked_content === true,
        getSecret,
      });
    } else if (sinkCfg.type === 'datadog') {
      // apiKeyEnv is passed through as the env var NAME — the datadog sink itself
      // resolves it at validateConfig()/send() time, never here, so a rotated key is
      // picked up without a restart.
      sink = createDatadogSink({
        name: sinkCfg.name,
        site: sinkCfg.site,
        apiKeyEnv: sinkCfg.api_key_env ?? '',
        includeCredentialMaterial: sinkCfg.include_credential_material === true,
        includeContent: sinkCfg.include_content === true,
        allowUnmaskedContent: sinkCfg.allow_unmasked_content === true,
        getSecret,
      });
    } else if (sinkCfg.type === 'azure_sentinel') {
      // clientSecretEnv is passed through as the env var NAME — the azure_sentinel sink
      // itself resolves it at token-acquisition time, never here, so a rotated secret is
      // picked up without a restart.
      sink = createAzureSentinelSink({
        name: sinkCfg.name,
        dcrEndpoint: sinkCfg.dcr_endpoint ?? '',
        dcrImmutableId: sinkCfg.dcr_immutable_id ?? '',
        streamName: sinkCfg.stream_name ?? '',
        tenantId: sinkCfg.tenant_id ?? '',
        clientId: sinkCfg.client_id ?? '',
        clientSecretEnv: sinkCfg.client_secret_env ?? '',
        includeCredentialMaterial: sinkCfg.include_credential_material === true,
        includeContent: sinkCfg.include_content === true,
        allowUnmaskedContent: sinkCfg.allow_unmasked_content === true,
        getSecret,
      });
    } else if (sinkCfg.type === 'gcs_pubsub') {
      // serviceAccountJsonEnv is passed through as the env var NAME — the gcs_pubsub sink
      // itself resolves and parses it at validateConfig()/send() time, never here, so a
      // rotated key is picked up without a restart.
      sink = createGcsPubSubSink({
        name: sinkCfg.name,
        projectId: sinkCfg.project_id ?? '',
        topicId: sinkCfg.topic_id ?? '',
        serviceAccountJsonEnv: sinkCfg.service_account_json_env ?? '',
        includeCredentialMaterial: sinkCfg.include_credential_material === true,
        includeContent: sinkCfg.include_content === true,
        allowUnmaskedContent: sinkCfg.allow_unmasked_content === true,
        getSecret,
      });
    } else if (sinkCfg.type === 's3') {
      // accessKeyIdEnv/secretAccessKeyEnv are passed through as env var NAMES — the s3
      // sink itself resolves them at send() time, never here, so a rotated credential is
      // picked up without a restart.
      sink = createS3Sink({
        name: sinkCfg.name,
        bucket: sinkCfg.bucket ?? '',
        region: sinkCfg.region ?? '',
        prefix: sinkCfg.prefix,
        accessKeyIdEnv: sinkCfg.access_key_id_env ?? '',
        secretAccessKeyEnv: sinkCfg.secret_access_key_env ?? '',
        includeCredentialMaterial: sinkCfg.include_credential_material === true,
        includeContent: sinkCfg.include_content === true,
        allowUnmaskedContent: sinkCfg.allow_unmasked_content === true,
        getSecret,
      });
    } else {
      warnings.push(`skipping sink '${sinkCfg.name}' — unsupported type '${sinkCfg.type}'`);
      continue;
    }

    const problems = sink.validateConfig();
    if (problems.length > 0) {
      warnings.push(`skipping sink '${sinkCfg.name}' due to config problems: ${problems.join('; ')}`);
      continue;
    }

    sinks.push(sink);

    // A bad override must not reach the dispatcher: an invalid interval_ms in particular
    // (zero, negative, or non-numeric) would make the dispatcher tick continuously.
    const batchSize = parsePositiveNumber(sinkCfg.batch_size, sinkCfg.name, 'batch_size');
    const intervalMs = parsePositiveNumber(sinkCfg.interval_ms, sinkCfg.name, 'interval_ms');
    if (batchSize !== undefined || intervalMs !== undefined) {
      perSink[sinkCfg.name] = {
        ...(batchSize !== undefined ? { batchSize } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
      };
    }
  }

  if (sinks.length === 0) return null;

  return {
    sinks,
    dispatcherConfig: {
      batchSize: siem.batch_size ?? 100,
      intervalMs: siem.interval_ms ?? 15000,
      ...(siem.reconcile_lookback_ms !== undefined ? { reconcileLookbackMs: siem.reconcile_lookback_ms } : {}),
      ...(Object.keys(perSink).length > 0 ? { perSink } : {}),
    },
    warnings,
  };
}

/**
 * Validates an optional per-sink `batch_size`/`interval_ms` override. Returns undefined for
 * an unset value (no override), and also for a non-numeric or non-positive one — logged with
 * a warn rather than thrown, since a bad override should not stop the sink itself from
 * starting.
 */
function parsePositiveNumber(value: unknown, sinkName: string, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    logger.warn('SiemConfigResolver', `sink '${sinkName}' has an invalid '${field}'; ignoring override`, {
      value,
    });
    return undefined;
  }
  return value;
}
