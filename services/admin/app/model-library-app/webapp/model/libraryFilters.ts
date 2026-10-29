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
// The visible filter labels (the "View settings" tokens) are resolved through the injected
// translator by their i18n key; the English defaults in EN_TEXTS below are byte-identical to the
// literals they replaced, so the pure tests (which pass no translator) hold.
const CAPABILITY_LABEL_KEY: Record<Exclude<Capability, 'all'>, string> = {
  text: 'capText', imageRecognition: 'capImageRecognition', imageGeneration: 'capImageGeneration',
  reasoning: 'capReasoning', embedding: 'capEmbedding', speechToText: 'capSpeechToText'
};
const INPUT_COLUMN = { text: 'inText', image: 'inImage', audio: 'inAudio', video: 'inVideo' } as const;
const INPUT_LABEL_KEY = { text: 'inText', image: 'inImage', audio: 'inAudio', video: 'inVideo' } as const;
const PROVISIONING_LABEL_KEY = { hosted: 'provHosted', managed: 'provManaged', remote: 'provRemote' } as const;
const ACCESS_COLUMN = { llmAccess: 'llmAccess', orchestration: 'orchestration' } as const;
const ACCESS_LABEL_KEY = { llmAccess: 'accessLlm', orchestration: 'accessOrchestration' } as const;

/**
 * Resolves an i18n key — the controller injects the resource bundle; jest passes none and gets the
 * English defaults below, so the module keeps no UI5 imports (like shell/model/homeTiles.ts).
 */
export type Translator = (key: string) => string;
/** English defaults: each value is byte-identical to the literal it replaced. */
const EN_TEXTS: Record<string, string> = {
  capAll: 'All', capText: 'Text Generation', capImageRecognition: 'Image Recognition',
  capImageGeneration: 'Image Generation', capReasoning: 'Reasoning', capEmbedding: 'Embedding',
  capSpeechToText: 'Speech To Text', inText: 'Text', inImage: 'Image', inAudio: 'Audio', inVideo: 'Video',
  provHosted: 'SAP Hosted', provManaged: 'SAP Managed', provRemote: 'Remote', accessLlm: 'LLM Access',
  accessOrchestration: 'Orchestration', otherLatestOnly: 'Latest Version Only',
  otherStreaming: 'Streaming Support', otherDeployments: 'Show Deployments'
};
const defaultTranslate: Translator = (key) => EN_TEXTS[key] ?? key;

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const group = (clauses: string[]) => (clauses.length ? `(${clauses.join(' or ')})` : null);

export function buildFilterExpression(state: LibraryFilterState): string | null {
  const parts: string[] = [];
  if (state.capability !== 'all') parts.push(`${CAPABILITY_COLUMN[state.capability]} eq true`);
  const inputs = group((Object.keys(INPUT_COLUMN) as (keyof typeof INPUT_COLUMN)[]).filter(k => state.inputTypes[k]).map(k => `${INPUT_COLUMN[k]} eq true`));
  if (inputs) parts.push(inputs);
  const prov = group((Object.keys(PROVISIONING_LABEL_KEY) as (keyof typeof PROVISIONING_LABEL_KEY)[]).filter(k => state.provisioning[k]).map(k => `provisioning eq ${quote(k)}`));
  if (prov) parts.push(prov);
  const providers = group(Object.keys(state.providers).filter(p => state.providers[p]).sort().map(p => `provider eq ${quote(p)}`));
  if (providers) parts.push(providers);
  const access = group((Object.keys(ACCESS_COLUMN) as (keyof typeof ACCESS_COLUMN)[]).filter(k => state.accessType[k]).map(k => `${ACCESS_COLUMN[k]} eq true`));
  if (access) parts.push(access);
  if (state.other.latestOnly) parts.push('versionCount eq 1');
  if (state.other.streaming) parts.push('streamingSupported eq true');
  // Deployments are hidden unless explicitly requested — this is the single place that rule
  // lives; the controller passes this result straight through. An untouched state therefore
  // yields "(accessType eq 'foundation' or accessType eq 'external')" (SAP models and Connection
  // models; a Connection row's accessType is 'external'), never null; null only occurs with "Show Deployments" on
  // and nothing else ticked (the binding then has no $filter at all). Nothing filters on
  // "deprecated" any more (G): the gateway already drops deprecated foundation models, so the
  // only deprecated rows are deployments, which their own tile badge identifies.
  if (!state.other.deployments) parts.push("(accessType eq 'foundation' or accessType eq 'external')");
  return parts.length ? parts.join(' and ') : null;
}

/** Human labels of the active filters, in sidebar order, for the "View settings" tokens. */
export function describeActive(state: LibraryFilterState, t: Translator = defaultTranslate): string[] {
  const out: string[] = [];
  if (state.capability === 'all') out.push(t('capAll'));
  else out.push(t(CAPABILITY_LABEL_KEY[state.capability]));
  (Object.keys(INPUT_LABEL_KEY) as (keyof typeof INPUT_LABEL_KEY)[]).forEach(k => { if (state.inputTypes[k]) out.push(t(INPUT_LABEL_KEY[k])); });
  (Object.keys(PROVISIONING_LABEL_KEY) as (keyof typeof PROVISIONING_LABEL_KEY)[]).forEach(k => { if (state.provisioning[k]) out.push(t(PROVISIONING_LABEL_KEY[k])); });
  Object.keys(state.providers).filter(p => state.providers[p]).sort().forEach(p => out.push(providerLabel(p, t)));
  (Object.keys(ACCESS_LABEL_KEY) as (keyof typeof ACCESS_LABEL_KEY)[]).forEach(k => { if (state.accessType[k]) out.push(t(ACCESS_LABEL_KEY[k])); });
  if (state.other.latestOnly) out.push(t('otherLatestOnly'));
  if (state.other.streaming) out.push(t('otherStreaming'));
  if (state.other.deployments) out.push(t('otherDeployments'));
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
export function activeTokens(state: LibraryFilterState, t: Translator = defaultTranslate): ActiveToken[] {
  const out: ActiveToken[] = [];
  if (state.capability === 'all') out.push({ key: 'capability', text: t('capAll') });
  else out.push({ key: 'capability', text: t(CAPABILITY_LABEL_KEY[state.capability]) });
  (Object.keys(INPUT_LABEL_KEY) as (keyof typeof INPUT_LABEL_KEY)[]).forEach(k => { if (state.inputTypes[k]) out.push({ key: `input:${k}`, text: t(INPUT_LABEL_KEY[k]) }); });
  (Object.keys(PROVISIONING_LABEL_KEY) as (keyof typeof PROVISIONING_LABEL_KEY)[]).forEach(k => { if (state.provisioning[k]) out.push({ key: `prov:${k}`, text: t(PROVISIONING_LABEL_KEY[k]) }); });
  Object.keys(state.providers).filter(p => state.providers[p]).sort().forEach(p => out.push({ key: `provider:${p}`, text: providerLabel(p, t) }));
  (Object.keys(ACCESS_LABEL_KEY) as (keyof typeof ACCESS_LABEL_KEY)[]).forEach(k => { if (state.accessType[k]) out.push({ key: `access:${ACCESS_KEY[k]}`, text: t(ACCESS_LABEL_KEY[k]) }); });
  if (state.other.latestOnly) out.push({ key: 'other:latestOnly', text: t('otherLatestOnly') });
  if (state.other.streaming) out.push({ key: 'other:streaming', text: t('otherStreaming') });
  if (state.other.deployments) out.push({ key: 'other:deployments', text: t('otherDeployments') });
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
