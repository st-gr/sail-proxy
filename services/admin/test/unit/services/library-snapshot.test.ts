/**
 * mapModelToLibraryRow turns one /v1/models entry (extended attributes on) into one
 * LibraryModels row. The fixture is a byte copy of eight live entries captured 2026-09-05.
 */
import sample from '../../fixtures/v1-models-sample.json';
import { mapModelToLibraryRow, provisioningFor, SNAPSHOT_WIDTHS, GatewayModel } from '../../../src/services/librarySnapshot';

const byId = (id: string): GatewayModel => {
  const m = (sample as any).data.find((x: any) => x.id === id);
  if (!m) throw new Error(`fixture lacks ${id}`);
  return m;
};
const NOW = new Date('2026-09-05T12:00:00Z');

describe('provisioningFor', () => {
  it.each([
    ['aicore-mistralai', 'hosted'], ['aicore-cohere', 'hosted'], ['aicore-nvidia', 'hosted'],
    ['aws-bedrock', 'managed'], ['azure-openai', 'managed'], ['gcp-vertexai', 'managed'],
    ['perplexity-ai', 'remote'], ['something-new', 'managed'], [undefined, 'managed']
  ])('%s -> %s', (exec, expected) => {
    expect(provisioningFor(exec as any)).toBe(expected);
  });
});

describe('mapModelToLibraryRow', () => {
  it('maps a foundation model from its latest version', () => {
    const row = mapModelToLibraryRow(byId('anthropic--claude-4.5-haiku'), NOW);
    expect(row.modelId).toBe('anthropic--claude-4.5-haiku');
    expect(row.baseModel).toBe('anthropic--claude-4.5-haiku');
    expect(row.accessType).toBe('foundation');
    expect(row.provider).toBe('Anthropic');
    expect(row.executableId).toBe('aws-bedrock');
    expect(row.provisioning).toBe('managed');
    expect(row.llmAccess).toBe(true);
    expect(row.orchestration).toBe(true);
    expect(row.latestVersion).toBe('1');
    expect(row.contextLength).toBe(200000);
    expect(row.streamingSupported).toBe(true);
    expect(row.capText).toBe(true);
    expect(row.capImageRecognition).toBe(true);
    expect(row.capReasoning).toBe(false);
    expect(row.inText).toBe(true);
    expect(row.inImage).toBe(true);
    expect(row.inAudio).toBe(false);
    expect(row.sapInputCost).toBe('0.00079');
    expect(row.sapOutputCost).toBe('0.00367');
    expect(row.sapCacheReadCost).toBe('0.00008');
    expect(row.sapCacheCreationCost).toBe('0.00099');
    expect(JSON.parse(row.benchmarks!)).toEqual(expect.arrayContaining([{ lmArenaTextArenaScore: '1410' }]));
    expect(row.deployment).toBeNull();
    expect(row.retirementDate).toBeNull();
    expect(row.absent).toBe(false);
    expect(row.lastSeenAt).toEqual(NOW);
  });

  it('maps a deployment row: base model stripped, llmAccess forced, deployment JSON filled', () => {
    const row = mapModelToLibraryRow(byId('anthropic--claude-4.5-haiku--deployed'), NOW);
    expect(row.accessType).toBe('deployment');
    expect(row.baseModel).toBe('anthropic--claude-4.5-haiku');
    expect(row.llmAccess).toBe(true);
    const dep = JSON.parse(row.deployment!);
    expect(dep).toEqual(expect.objectContaining({ configurationId: expect.any(String), deploymentUrl: expect.any(String), scenarioId: 'foundation-models' }));
  });

  it('keeps a retirement date as a date string and leaves missing costs null', () => {
    const row = mapModelToLibraryRow(byId('mistralai--mistral-small'), NOW);
    expect(row.retirementDate).toBe('2026-10-30');
    const emb = mapModelToLibraryRow(byId('text-embedding-3-large'), NOW);
    expect(emb.capEmbedding).toBe(true);
    expect(emb.capText).toBe(false);
  });

  it('picks the isLatest version, else the first, and counts versions', () => {
    const m = byId('gpt-5.4');
    const row = mapModelToLibraryRow(m, NOW);
    const latest = m.versions.find(v => v.isLatest) || m.versions[0];
    expect(row.latestVersion).toBe(latest.name);
    expect(row.versionCount).toBe(m.versions.length);
    expect(JSON.parse(row.versions!)).toHaveLength(m.versions.length);
  });

  // SAP publishes free text with no length guarantee; a value wider than its CDS column is an
  // INSERT error that would take the whole 50-row chunk - and the model list with it - down.
  it('clamps every string column to its CDS width and keeps the JSON columns parseable', () => {
    const row = mapModelToLibraryRow({
      id: 'x'.repeat(300),
      owned_by: 'P'.repeat(120),
      displayName: 'D'.repeat(400),
      description: 'L'.repeat(2000),
      executableId: 'e'.repeat(200),
      allowedScenarios: [{ scenarioId: 'orchestration' }],
      versions: [{
        name: 'v'.repeat(180),
        isLatest: true,
        capabilities: Array.from({ length: 30 }, (_, i) => `capability-number-${i}`),
        inputTypes: ['text', 'image', 'audio', 'video', 'text-extra-one', 'text-extra-two', 'text-extra-three']
      }]
    } as any, NOW);

    expect(row.modelId.length).toBe(SNAPSHOT_WIDTHS.modelId);
    expect(row.baseModel.length).toBe(SNAPSHOT_WIDTHS.baseModel);
    expect(row.displayName!.length).toBe(SNAPSHOT_WIDTHS.displayName);
    expect(row.description!.length).toBe(SNAPSHOT_WIDTHS.description);
    expect(row.provider!.length).toBe(SNAPSHOT_WIDTHS.provider);
    expect(row.executableId!.length).toBe(SNAPSHOT_WIDTHS.executableId);
    expect(row.latestVersion!.length).toBe(SNAPSHOT_WIDTHS.latestVersion);
    expect(row.capabilities.length).toBeLessThanOrEqual(SNAPSHOT_WIDTHS.capabilities);
    expect(row.inputTypes.length).toBeLessThanOrEqual(SNAPSHOT_WIDTHS.inputTypes);

    // truncated, but still a document the detail page can parse
    const caps = JSON.parse(row.capabilities);
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.length).toBeLessThan(30);
    expect(JSON.parse(row.inputTypes)).toContain('text');

    // the flag columns are computed from the payload, not from the clamped JSON
    expect(row.inVideo).toBe(true);
    expect(row.orchestration).toBe(true);
  });

  it('leaves values inside their width untouched', () => {
    const row = mapModelToLibraryRow(byId('gpt-5.4'), NOW);
    expect(row.modelId).toBe('gpt-5.4');
    expect(JSON.parse(row.capabilities)).toEqual((byId('gpt-5.4').versions.find(v => v.isLatest) || byId('gpt-5.4').versions[0]).capabilities);
  });

  it('a model without versions still maps (nulls, no throw)', () => {
    const row = mapModelToLibraryRow({ id: 'x', owned_by: 'SAP', versions: [] } as any, NOW);
    expect(row.latestVersion).toBeNull();
    expect(row.contextLength).toBeNull();
    expect(row.capabilities).toBe('[]');
    expect(row.versionCount).toBe(0);
  });
});

/**
 * A deployment whose base model the gateway no longer lists: `anthropic--claude-4-opus--deployed`
 * arrives with no `owned_by`/`provider` and no `displayName`, because the entry the gateway would
 * have copied those from is gone. The row then showed up in the library under the provider
 * "unknown" and with no name of its own.
 *
 * The model id still says who made it - SAP's ids are `<vendor>--<model>` - so the vendor prefix
 * is the fallback, and the base model id is the fallback name. Neither ever overrides what the
 * gateway did send.
 */
describe('mapModelToLibraryRow - a provider the payload does not name', () => {
  const retiredDeployment = {
    id: 'anthropic--claude-4-opus--deployed',
    accessType: 'deployment',
    configurationId: 'c-1',
    scenarioId: 'foundation-models',
    versions: []
  } as any;

  it('derives the provider from the model id\'s vendor prefix and names the row after the base model', () => {
    const row = mapModelToLibraryRow(retiredDeployment, NOW);
    expect(row.provider).toBe('Anthropic');
    expect(row.displayName).toBe('anthropic--claude-4-opus');
    expect(row.baseModel).toBe('anthropic--claude-4-opus');
    expect(row.accessType).toBe('deployment');
  });

  it('treats the literal "unknown" the same as a missing provider', () => {
    const row = mapModelToLibraryRow({ ...retiredDeployment, owned_by: 'unknown' }, NOW);
    expect(row.provider).toBe('Anthropic');
  });

  it.each([
    ['openai--gpt-5', 'OpenAI'],
    ['gemini--2.5-pro', 'Google'],
    ['google--gemini-2.5-flash', 'Google'],
    ['cohere--command-a', 'Cohere'],
    ['mistralai--mistral-small', 'Mistral AI'],
    ['amazon--nova-pro', 'Amazon'],
    ['nvidia--llama-3.3-nemotron', 'NVIDIA'],
    ['perplexity-ai--sonar', 'Perplexity'],
    ['meta-llama--llama-4', 'Meta'],
    ['sap--document-grounding', 'SAP']
  ])('maps the %s prefix to %s', (id, expected) => {
    expect(mapModelToLibraryRow({ id, versions: [] } as any, NOW).provider).toBe(expected);
  });

  it('keeps "unknown" where the id carries no vendor prefix to read', () => {
    expect(mapModelToLibraryRow({ id: 'some-local-model', owned_by: 'unknown', versions: [] } as any, NOW).provider).toBe('unknown');
    // A prefix that is not a vendor this map knows is not guessed at either.
    expect(mapModelToLibraryRow({ id: 'acme--model-one', owned_by: 'unknown', versions: [] } as any, NOW).provider).toBe('unknown');
    // Nothing to fall back to and nothing declared stays null, as it always was.
    expect(mapModelToLibraryRow({ id: 'some-local-model', versions: [] } as any, NOW).provider).toBeNull();
  });

  it('never overrides a provider the payload does name', () => {
    const row = mapModelToLibraryRow({ id: 'anthropic--claude-4-opus', owned_by: 'Anthropic PBC', versions: [] } as any, NOW);
    expect(row.provider).toBe('Anthropic PBC');
  });

  it('leaves a foundation model without a displayName as it was', () => {
    // The name fallback is the deployment's, whose base entry is the thing that went missing; a
    // foundation row with no display name is the gateway saying it has none.
    expect(mapModelToLibraryRow({ id: 'anthropic--claude-4-opus', versions: [] } as any, NOW).displayName).toBeNull();
  });

  it('keeps a deployment\'s own displayName when it has one', () => {
    const row = mapModelToLibraryRow({ ...retiredDeployment, displayName: 'Claude 4 Opus' }, NOW);
    expect(row.displayName).toBe('Claude 4 Opus');
  });
});

/**
 * M: SAP AI Core publishes foundation models the gateway cannot route by name - no `orchestration`
 * scenario, the GPT realtime models among them. The library lists them with the flags SAP's
 * scenarios give: LLM Access when the model can be deployed (a deployment is always routable),
 * orchestration only when it has the scenario. The gateway's routable flag is not consulted.
 */
describe('mapModelToLibraryRow - a model the gateway cannot route by name', () => {
  const realtime = {
    id: 'openai--gpt-4o-realtime',
    owned_by: 'OpenAI',
    routable: false,
    accessType: 'foundation',
    allowedScenarios: [{ scenarioId: 'foundation-models' }],
    versions: [{ name: '2026-01-01', isLatest: true }]
  } as any;

  it('keeps LLM Access from the foundation-models scenario and clears only orchestration', () => {
    const row = mapModelToLibraryRow(realtime, NOW);
    expect(row.llmAccess).toBe(true);
    expect(row.orchestration).toBe(false);
    // everything else is mapped as usual - the row is a normal library row
    expect(row.accessType).toBe('foundation');
    expect(row.provider).toBe('OpenAI');
    expect(row.latestVersion).toBe('2026-01-01');
  });

  it('clears both flags only when SAP allows neither scenario', () => {
    const row = mapModelToLibraryRow({ ...realtime, allowedScenarios: [] }, NOW);
    expect(row.llmAccess).toBe(false);
    expect(row.orchestration).toBe(false);
  });

  it('leaves a routable model alone, whether or not the gateway sends the flag', () => {
    const routable = { ...realtime, routable: true, allowedScenarios: [{ scenarioId: 'foundation-models' }, { scenarioId: 'orchestration' }] };
    expect(mapModelToLibraryRow(routable, NOW).llmAccess).toBe(true);
    expect(mapModelToLibraryRow(routable, NOW).orchestration).toBe(true);
    // an older gateway sends no flag at all: it only ever listed routable models
    const { routable: _omitted, ...noFlag } = routable;
    expect(mapModelToLibraryRow(noFlag as any, NOW).llmAccess).toBe(true);
    expect(mapModelToLibraryRow(noFlag as any, NOW).orchestration).toBe(true);
  });
});
