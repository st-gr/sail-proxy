/**
 * Pure mapping from one gateway /v1/models entry (SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true) to
 * one LibraryModels row. No I/O here: modelCostService.upsertLibrarySnapshot owns the database.
 * Field inventory verified against the live payload on 2026-09-05 (spec "Facts").
 */
import { DEEP_CONTEXT_SUFFIX } from './pricingTwins';

export interface GatewayModelVersion {
  name: string;
  isLatest?: boolean;
  deprecated?: boolean;
  retirementDate?: string;
  contextLength?: number;
  inputTypes?: string[];
  capabilities?: string[];
  metadata?: Array<Record<string, string>>;
  cost?: Array<{ inputCost?: string; outputCost?: string; cacheReadInputCost?: string; cacheCreationInputCost?: string }>;
  streamingSupported?: boolean;
  suggestedReplacements?: unknown[];
}

export interface GatewayModel {
  id: string;
  /**
   * Whether a request for this model can be routed through the gateway. The gateway sets it on
   * every model of the `include=unroutable` list; a foundation model without an `orchestration`
   * scenario (the GPT realtime models, for instance) is false. Absent on an older gateway, which
   * only ever listed routable models — hence `!== false` everywhere it is read.
   */
  routable?: boolean;
  owned_by?: string;
  provider?: string;
  model?: string;
  displayName?: string;
  description?: string;
  executableId?: string;
  accessType?: 'foundation' | 'deployment' | string;
  streamingSupported?: boolean;
  allowedScenarios?: Array<{ executableId?: string; scenarioId?: string }>;
  versions: GatewayModelVersion[];
  scenarioId?: string;
  configurationId?: string;
  configurationName?: string;
  deploymentUrl?: string;
  [key: string]: unknown;
}

export interface LibraryModelRow {
  modelId: string;
  baseModel: string;
  displayName: string | null;
  description: string | null;
  provider: string | null;
  executableId: string | null;
  provisioning: 'hosted' | 'managed' | 'remote';
  accessType: string;
  llmAccess: boolean;
  orchestration: boolean;
  latestVersion: string | null;
  versionCount: number;
  contextLength: number | null;
  streamingSupported: boolean;
  deprecated: boolean;
  retirementDate: string | null;
  capabilities: string;
  inputTypes: string;
  capText: boolean; capImageRecognition: boolean; capImageGeneration: boolean;
  capReasoning: boolean; capEmbedding: boolean; capSpeechToText: boolean;
  inText: boolean; inImage: boolean; inAudio: boolean; inVideo: boolean;
  benchmarks: string | null;
  versions: string | null;
  deployment: string | null;
  sapInputCost: string | null;
  sapOutputCost: string | null;
  sapCacheReadCost: string | null;
  sapCacheCreationCost: string | null;
  lastSeenAt: Date;
  absent: boolean;
}

/** SAP's "Model Provisioning" facet, derived from the executable that serves the model. */
export const PROVISIONING_BY_EXECUTABLE: Record<string, 'hosted' | 'managed' | 'remote'> = {
  'aicore-mistralai': 'hosted',
  'aicore-cohere': 'hosted',
  'aicore-nvidia': 'hosted',
  'aws-bedrock': 'managed',
  'azure-openai': 'managed',
  'gcp-vertexai': 'managed',
  'perplexity-ai': 'remote'
};

export function provisioningFor(executableId?: string | null): 'hosted' | 'managed' | 'remote' {
  if (!executableId) return 'managed';
  if (PROVISIONING_BY_EXECUTABLE[executableId]) return PROVISIONING_BY_EXECUTABLE[executableId];
  return executableId.startsWith('aicore-') ? 'hosted' : 'managed';
}

/**
 * The provider a SAP model id names in its own `<vendor>--<model>` prefix, as the provider facet
 * spells it. Read only where the payload names no provider of its own - see `providerFor`.
 */
export const PROVIDER_BY_VENDOR_PREFIX: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  gemini: 'Google',
  cohere: 'Cohere',
  mistralai: 'Mistral AI',
  amazon: 'Amazon',
  nvidia: 'NVIDIA',
  perplexity: 'Perplexity',
  'perplexity-ai': 'Perplexity',
  meta: 'Meta',
  'meta-llama': 'Meta',
  sap: 'SAP'
};

/**
 * Who made this model, for the library's provider facet.
 *
 * The payload's own `owned_by`/`provider` wins whenever it says anything. It does not always: a
 * DEPLOYMENT whose base model the gateway no longer lists (`anthropic--claude-4-opus--deployed`,
 * a deployment still running against a retired entry) arrives with no provider at all, or with
 * the literal "unknown", because the entry those fields are copied from is gone. The filter then
 * offers "unknown" as a provider to filter by, which is not one.
 *
 * The model id still says it: SAP ids are `<vendor>--<model>`. A vendor this map knows is used;
 * anything else is left exactly as it arrived, "unknown" included - a guess from an unrecognised
 * prefix would be a provider nobody can check.
 */
export function providerFor(model: GatewayModel): string | null {
  const declared = model.owned_by ?? model.provider ?? null;
  if (declared && declared.trim() !== '' && declared.trim().toLowerCase() !== 'unknown') {
    return declared;
  }
  const separator = model.id.indexOf('--');
  const vendor = separator > 0 ? model.id.slice(0, separator).toLowerCase() : '';
  return PROVIDER_BY_VENDOR_PREFIX[vendor] ?? declared;
}

const DEPLOYED_SUFFIX = '--deployed';

/**
 * Column widths from model-library.cds. SAP publishes free text (descriptions, capability
 * arrays) with no guaranteed length, and an over-long value is a database error that takes the
 * whole snapshot chunk - and with it the model list - down. Clamp instead of failing: the
 * library is a display snapshot, a truncated description is better than no row.
 */
export const SNAPSHOT_WIDTHS = {
  modelId: 120,
  baseModel: 100,
  displayName: 100,
  description: 500,
  provider: 50,
  executableId: 50,
  latestVersion: 50,
  capabilities: 200,
  inputTypes: 100
} as const;

function clamp(value: string | null, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * capabilities and inputTypes hold a JSON array that the detail page parses, so a raw slice
 * would hand it a broken document. Drop whole entries from the end until the array fits, and
 * only fall back to a plain clamp if even the empty array would not (it always does).
 */
function clampJsonArray(values: string[], max: number): string {
  let items = Array.isArray(values) ? [...values] : [];
  let json = JSON.stringify(items);
  while (json.length > max && items.length > 0) {
    items.pop();
    json = JSON.stringify(items);
  }
  return json.length > max ? (clamp(json, max) as string) : json;
}

function costOf(version: GatewayModelVersion | undefined, field: 'inputCost' | 'outputCost' | 'cacheReadInputCost' | 'cacheCreationInputCost'): string | null {
  if (!version?.cost) return null;
  for (const item of version.cost) {
    const v = item[field];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return null;
}

function toDateOnly(value?: string): string | null {
  if (!value || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function mapModelToLibraryRow(model: GatewayModel, seenAt: Date): LibraryModelRow {
  const versions = Array.isArray(model.versions) ? model.versions : [];
  const latest = versions.find(v => v.isLatest) || versions[0];
  const capabilities = latest?.capabilities || [];
  const inputTypes = latest?.inputTypes || [];
  const scenarios = (model.allowedScenarios || []).map(s => s.scenarioId);
  const isDeployment = model.accessType === 'deployment' || model.id.endsWith(DEPLOYED_SUFFIX);
  const baseModel = model.id.endsWith(DEPLOYED_SUFFIX) ? model.id.slice(0, -DEPLOYED_SUFFIX.length) : model.id;

  const deployment = isDeployment ? JSON.stringify({
    configurationId: model.configurationId ?? null,
    configurationName: model.configurationName ?? null,
    deploymentUrl: model.deploymentUrl ?? null,
    scenarioId: model.scenarioId ?? null
  }) : null;

  return {
    modelId: clamp(model.id, SNAPSHOT_WIDTHS.modelId) as string,
    baseModel: clamp(baseModel, SNAPSHOT_WIDTHS.baseModel) as string,
    // A deployment carries no display name of its own when its base model is gone from the
    // payload; the base model id is then the only name there is for it, and a row with no name at
    // all is worse than one named after the model it deploys.
    displayName: clamp(model.displayName ?? (isDeployment ? baseModel : null), SNAPSHOT_WIDTHS.displayName),
    description: clamp(model.description ?? null, SNAPSHOT_WIDTHS.description),
    provider: clamp(providerFor(model), SNAPSHOT_WIDTHS.provider),
    executableId: clamp(model.executableId ?? null, SNAPSHOT_WIDTHS.executableId),
    provisioning: provisioningFor(model.executableId),
    accessType: isDeployment ? 'deployment' : 'foundation',
    // Straight from SAP's scenarios. `orchestration` is what the gateway calls routable: only such a
    // model answers to its bare name. `llmAccess` (the foundation-models scenario) is what makes a
    // model deployable - and every deployment is routable, so a model with LLM Access but no
    // orchestration is "deployment only", not unusable. The gateway's routable flag adds nothing
    // the scenarios do not already say, so it is not read here.
    llmAccess: isDeployment || scenarios.includes('foundation-models'),
    orchestration: scenarios.includes('orchestration'),
    latestVersion: clamp(latest?.name ?? null, SNAPSHOT_WIDTHS.latestVersion),
    versionCount: versions.length,
    contextLength: typeof latest?.contextLength === 'number' ? latest.contextLength : null,
    streamingSupported: model.streamingSupported ?? latest?.streamingSupported ?? false,
    deprecated: latest?.deprecated === true,
    retirementDate: toDateOnly(latest?.retirementDate),
    capabilities: clampJsonArray(capabilities, SNAPSHOT_WIDTHS.capabilities),
    inputTypes: clampJsonArray(inputTypes, SNAPSHOT_WIDTHS.inputTypes),
    capText: capabilities.includes('text-generation'),
    capImageRecognition: capabilities.includes('image-recognition'),
    capImageGeneration: capabilities.includes('image-generation'),
    capReasoning: capabilities.includes('reasoning'),
    capEmbedding: capabilities.includes('embedding'),
    capSpeechToText: capabilities.includes('speech-to-text'),
    inText: inputTypes.includes('text'),
    inImage: inputTypes.includes('image'),
    inAudio: inputTypes.includes('audio'),
    inVideo: inputTypes.includes('video'),
    benchmarks: latest?.metadata ? JSON.stringify(latest.metadata) : null,
    versions: versions.length ? JSON.stringify(versions) : null,
    deployment,
    sapInputCost: costOf(latest, 'inputCost'),
    sapOutputCost: costOf(latest, 'outputCost'),
    sapCacheReadCost: costOf(latest, 'cacheReadInputCost'),
    sapCacheCreationCost: costOf(latest, 'cacheCreationInputCost'),
    lastSeenAt: seenAt,
    absent: false
  };
}

/**
 * Derives one pricing-only LibraryModels row per `sap-rpt-*-large` row in the snapshot: the Deep
 * Context tier the gateway accounts under `<id>--deep-context` (spec: RPT usage above the deep
 * context threshold). Not itself callable - `deployment` is null - it exists only so a price can
 * be maintained on it (modelCostService.getModelPricing / sapCapacityService._lookupRate resolve
 * the suffix to it, falling back to the parent). Mirrors the parent's `absent` so a withdrawn
 * model takes its tier with it, and is excluded from the default entitlement catalog
 * (modelEntitlementService.effectiveModelIds) so it never appears as an offerable model.
 */
export function deriveDeepContextRows(rows: any[]): any[] {
  return rows
    .filter((r) => typeof r.modelId === 'string' && /^sap-rpt-.*-large$/.test(r.modelId))
    .map((r) => ({
      modelId: `${r.modelId}${DEEP_CONTEXT_SUFFIX}`,
      displayName: clamp(`${r.displayName} (Deep Context)`, SNAPSHOT_WIDTHS.displayName),
      provider: r.provider,
      executableId: r.executableId,
      // Pricing-only: never deployable. The parent's accessType ('foundation') would offer
      // Deploy on this row too (Detail.controller.ts gates canDeploy on accessType ===
      // 'foundation'), so this row is always 'deployment' regardless of the parent's.
      accessType: 'deployment',
      absent: r.absent,
      deployment: null,
      description: `Pricing entry for the Deep Context tier of ${r.modelId}; not callable`
    }));
}
