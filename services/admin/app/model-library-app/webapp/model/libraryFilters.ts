/**
 * Filter state → OData $filter (spec §6). Deployments (`accessType eq 'deployment'`) are hidden
 * unless "Show Deployments" is on; every other group only narrows.
 */
import { providerLabel } from './providerLabel';

export type Capability = 'all' | 'text' | 'imageRecognition' | 'imageGeneration' | 'reasoning' | 'embedding' | 'speechToText';

export interface LibraryFilterState {
  capability: Capability;
  inputTypes: { text: boolean; image: boolean; audio: boolean; video: boolean };
  provisioning: { hosted: boolean; managed: boolean; remote: boolean };
  providers: Record<string, boolean>;
  accessType: { llmAccess: boolean; orchestration: boolean };
  other: { latestOnly: boolean; streaming: boolean; deployments: boolean };
}

export function emptyFilters(): LibraryFilterState {
  return {
    capability: 'all',
    inputTypes: { text: false, image: false, audio: false, video: false },
    provisioning: { hosted: false, managed: false, remote: false },
    providers: {},
    accessType: { llmAccess: false, orchestration: false },
    other: { latestOnly: false, streaming: false, deployments: false }
  };
}

const CAPABILITY_COLUMN: Record<Exclude<Capability, 'all'>, string> = {
  text: 'capText', imageRecognition: 'capImageRecognition', imageGeneration: 'capImageGeneration',
  reasoning: 'capReasoning', embedding: 'capEmbedding', speechToText: 'capSpeechToText'
};
const CAPABILITY_LABEL: Record<Exclude<Capability, 'all'>, string> = {
  text: 'Text Generation', imageRecognition: 'Image Recognition', imageGeneration: 'Image Generation',
  reasoning: 'Reasoning', embedding: 'Embedding', speechToText: 'Speech To Text'
};
const INPUT_COLUMN = { text: 'inText', image: 'inImage', audio: 'inAudio', video: 'inVideo' } as const;
const INPUT_LABEL = { text: 'Text', image: 'Image', audio: 'Audio', video: 'Video' } as const;
const PROVISIONING_LABEL = { hosted: 'SAP Hosted', managed: 'SAP Managed', remote: 'Remote' } as const;
const ACCESS_COLUMN = { llmAccess: 'llmAccess', orchestration: 'orchestration' } as const;
const ACCESS_LABEL = { llmAccess: 'LLM Access', orchestration: 'Orchestration' } as const;

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const group = (clauses: string[]) => (clauses.length ? `(${clauses.join(' or ')})` : null);

export function buildFilterExpression(state: LibraryFilterState): string | null {
  const parts: string[] = [];
  if (state.capability !== 'all') parts.push(`${CAPABILITY_COLUMN[state.capability]} eq true`);
  const inputs = group((Object.keys(INPUT_COLUMN) as (keyof typeof INPUT_COLUMN)[]).filter(k => state.inputTypes[k]).map(k => `${INPUT_COLUMN[k]} eq true`));
  if (inputs) parts.push(inputs);
  const prov = group((Object.keys(PROVISIONING_LABEL) as (keyof typeof PROVISIONING_LABEL)[]).filter(k => state.provisioning[k]).map(k => `provisioning eq ${quote(k)}`));
  if (prov) parts.push(prov);
  const providers = group(Object.keys(state.providers).filter(p => state.providers[p]).sort().map(p => `provider eq ${quote(p)}`));
  if (providers) parts.push(providers);
  const access = group((Object.keys(ACCESS_COLUMN) as (keyof typeof ACCESS_COLUMN)[]).filter(k => state.accessType[k]).map(k => `${ACCESS_COLUMN[k]} eq true`));
  if (access) parts.push(access);
  if (state.other.latestOnly) parts.push('versionCount eq 1');
  if (state.other.streaming) parts.push('streamingSupported eq true');
  // Deployments are hidden unless explicitly requested — this is the single place that rule
  // lives; the controller passes this result straight through. An untouched state therefore
  // yields "accessType eq 'foundation'", never null; null only occurs with "Show Deployments" on
  // and nothing else ticked (the binding then has no $filter at all). Nothing filters on
  // "deprecated" any more (G): the gateway already drops deprecated foundation models, so the
  // only deprecated rows are deployments, which their own tile badge identifies.
  if (!state.other.deployments) parts.push("accessType eq 'foundation'");
  return parts.length ? parts.join(' and ') : null;
}

/** Human labels of the active filters, in sidebar order, for the "View settings" tokens. */
export function describeActive(state: LibraryFilterState): string[] {
  const out: string[] = [];
  if (state.capability === 'all') out.push('All');
  else out.push(CAPABILITY_LABEL[state.capability]);
  (Object.keys(INPUT_LABEL) as (keyof typeof INPUT_LABEL)[]).forEach(k => { if (state.inputTypes[k]) out.push(INPUT_LABEL[k]); });
  (Object.keys(PROVISIONING_LABEL) as (keyof typeof PROVISIONING_LABEL)[]).forEach(k => { if (state.provisioning[k]) out.push(PROVISIONING_LABEL[k]); });
  Object.keys(state.providers).filter(p => state.providers[p]).sort().forEach(p => out.push(providerLabel(p)));
  (Object.keys(ACCESS_LABEL) as (keyof typeof ACCESS_LABEL)[]).forEach(k => { if (state.accessType[k]) out.push(ACCESS_LABEL[k]); });
  if (state.other.latestOnly) out.push('Latest Version Only');
  if (state.other.streaming) out.push('Streaming Support');
  if (state.other.deployments) out.push('Show Deployments');
  return out;
}

const ACCESS_KEY = { llmAccess: 'llm', orchestration: 'orchestration' } as const;

export interface ActiveToken { key: string; text: string; }

/**
 * Same active filters as describeActive, each paired with a key that maps back to the one filter
 * it came from — for the "View settings" tokens (A4): pressing a token's x calls resetFilterKey
 * with this key. Keys: 'capability', 'input:<type>', 'prov:<kind>', 'provider:<name>',
 * 'access:llm'|'access:orchestration', 'other:<flag>'.
 *
 * Like the SAP reference, the capability radio always contributes a token — "All" for the
 * untouched radio — since it is the one filter whose "active" state is the default;
 * resetFilterKey('capability') is a no-op when it is already 'all', matching the reference's
 * no-op "All ×".
 */
export function activeTokens(state: LibraryFilterState): ActiveToken[] {
  const out: ActiveToken[] = [];
  if (state.capability === 'all') out.push({ key: 'capability', text: 'All' });
  else out.push({ key: 'capability', text: CAPABILITY_LABEL[state.capability] });
  (Object.keys(INPUT_LABEL) as (keyof typeof INPUT_LABEL)[]).forEach(k => { if (state.inputTypes[k]) out.push({ key: `input:${k}`, text: INPUT_LABEL[k] }); });
  (Object.keys(PROVISIONING_LABEL) as (keyof typeof PROVISIONING_LABEL)[]).forEach(k => { if (state.provisioning[k]) out.push({ key: `prov:${k}`, text: PROVISIONING_LABEL[k] }); });
  Object.keys(state.providers).filter(p => state.providers[p]).sort().forEach(p => out.push({ key: `provider:${p}`, text: providerLabel(p) }));
  (Object.keys(ACCESS_LABEL) as (keyof typeof ACCESS_LABEL)[]).forEach(k => { if (state.accessType[k]) out.push({ key: `access:${ACCESS_KEY[k]}`, text: ACCESS_LABEL[k] }); });
  if (state.other.latestOnly) out.push({ key: 'other:latestOnly', text: 'Latest Version Only' });
  if (state.other.streaming) out.push({ key: 'other:streaming', text: 'Streaming Support' });
  if (state.other.deployments) out.push({ key: 'other:deployments', text: 'Show Deployments' });
  return out;
}

function cloneFilters(state: LibraryFilterState): LibraryFilterState {
  return {
    ...state,
    inputTypes: { ...state.inputTypes },
    provisioning: { ...state.provisioning },
    providers: { ...state.providers },
    accessType: { ...state.accessType },
    other: { ...state.other }
  };
}

/** Clears exactly the one filter a "View settings" token's x maps to, from its activeTokens key. */
export function resetFilterKey(state: LibraryFilterState, key: string): LibraryFilterState {
  const next = cloneFilters(state);
  const sep = key.indexOf(':');
  const group = sep === -1 ? key : key.slice(0, sep);
  const sub = sep === -1 ? '' : key.slice(sep + 1);
  if (group === 'capability') next.capability = 'all';
  else if (group === 'input' && sub in next.inputTypes) next.inputTypes[sub as keyof typeof next.inputTypes] = false;
  else if (group === 'prov' && sub in next.provisioning) next.provisioning[sub as keyof typeof next.provisioning] = false;
  else if (group === 'provider') delete next.providers[sub];
  else if (group === 'access' && sub === 'llm') next.accessType.llmAccess = false;
  else if (group === 'access' && sub === 'orchestration') next.accessType.orchestration = false;
  else if (group === 'other' && sub in next.other) next.other[sub as keyof typeof next.other] = false;
  return next;
}

export type FilterGroup = 'capability' | 'inputTypes' | 'provisioning' | 'provider' | 'accessType' | 'other';

/** Clears every filter in one sidebar group at once — the per-group reset icon buttons (A7). */
export function resetFilterGroup(state: LibraryFilterState, group: FilterGroup): LibraryFilterState {
  const next = cloneFilters(state);
  const empty = emptyFilters();
  switch (group) {
    case 'capability': next.capability = empty.capability; break;
    case 'inputTypes': next.inputTypes = empty.inputTypes; break;
    case 'provisioning': next.provisioning = empty.provisioning; break;
    case 'provider': next.providers = {}; break;
    case 'accessType': next.accessType = empty.accessType; break;
    case 'other': next.other = empty.other; break;
  }
  return next;
}
