/**
 * The sidebar filters compile to one OData $filter string over the flag columns plan A put on
 * LibraryModels. Capability is a radio ("all" = no clause); the others are AND-ed groups where
 * ticked boxes inside a group OR together. Deployments are hidden by default:
 * buildFilterExpression appends `accessType eq 'foundation'` whenever "Show Deployments" is off,
 * so an untouched state yields that one clause (never null); null only occurs with "Show
 * Deployments" on and nothing else ticked. Deprecated rows are no longer filtered out (G) - the
 * gateway drops deprecated foundation models before the snapshot, so the only deprecated rows are
 * deployments, and their tile says so.
 */
import { buildFilterExpression, describeActive, emptyFilters, activeTokens, resetFilterKey, resetFilterGroup } from '../webapp/model/libraryFilters';

describe('buildFilterExpression', () => {
  it('untouched state yields the foundation clause', () => {
    expect(buildFilterExpression(emptyFilters())).toBe("accessType eq 'foundation'");
  });
  it('deployments on with nothing else yields null', () => {
    const s = emptyFilters(); s.other.deployments = true;
    expect(buildFilterExpression(s)).toBeNull();
  });
  it('never filters on deprecated', () => {
    const s = emptyFilters(); s.other.deployments = true; s.other.streaming = true;
    expect(buildFilterExpression(s)).toBe('streamingSupported eq true');
  });
  it('maps the capability radio to its flag column', () => {
    const s = emptyFilters(); s.capability = 'reasoning';
    expect(buildFilterExpression(s)).toBe("capReasoning eq true and accessType eq 'foundation'");
  });
  it('ORs ticked boxes inside a group and ANDs groups', () => {
    const s = emptyFilters();
    s.inputTypes.image = true; s.inputTypes.audio = true;
    s.provisioning.hosted = true;
    s.providers['Mistral AI'] = true; s.providers.NVIDIA = true;
    expect(buildFilterExpression(s)).toBe(
      "(inImage eq true or inAudio eq true) and (provisioning eq 'hosted') and (provider eq 'Mistral AI' or provider eq 'NVIDIA') and accessType eq 'foundation'");
  });
  it('maps access type and the other filters', () => {
    const s = emptyFilters();
    s.accessType.llmAccess = true; s.accessType.orchestration = true;
    s.other.latestOnly = true; s.other.streaming = true;
    expect(buildFilterExpression(s)).toBe(
      '(llmAccess eq true or orchestration eq true) and versionCount eq 1 and streamingSupported eq true and accessType eq \'foundation\'');
  });
  it('shows deployments only when asked; escapes quotes in provider names', () => {
    const s = emptyFilters(); s.other.deployments = true; s.providers["O'Brien"] = true;
    expect(buildFilterExpression(s)).toBe("(provider eq 'O''Brien')");
  });
  it('describeActive lists the human labels of every active filter for the toolbar tokens', () => {
    const s = emptyFilters(); s.capability = 'embedding'; s.other.streaming = true; s.providers.SAP = true;
    expect(describeActive(s)).toEqual(['Embedding', 'SAP', 'Streaming Support']);
  });
  it('describeActive shows "All" for the untouched capability radio', () => {
    expect(describeActive(emptyFilters())).toEqual(['All']);
  });
});

describe('activeTokens', () => {
  it('pairs every active filter with a key that maps back to it', () => {
    const s = emptyFilters();
    s.capability = 'embedding';
    s.inputTypes.image = true;
    s.provisioning.hosted = true;
    s.providers.SAP = true;
    s.accessType.llmAccess = true;
    s.other.streaming = true;
    expect(activeTokens(s)).toEqual([
      { key: 'capability', text: 'Embedding' },
      { key: 'input:image', text: 'Image' },
      { key: 'prov:hosted', text: 'SAP Hosted' },
      { key: 'provider:SAP', text: 'SAP' },
      { key: 'access:llm', text: 'LLM Access' },
      { key: 'other:streaming', text: 'Streaming Support' }
    ]);
  });
  it('the untouched state yields the single "All" token, like the SAP reference', () => {
    expect(activeTokens(emptyFilters())).toEqual([{ key: 'capability', text: 'All' }]);
  });
  // L: the facet reads "Other" but filters on the value LibraryModels actually holds.
  it('shows a literal "unknown" provider as "Other" while keeping "unknown" as its key', () => {
    const s = emptyFilters(); s.providers.unknown = true;
    expect(activeTokens(s)).toContainEqual({ key: 'provider:unknown', text: 'Other' });
    expect(describeActive(s)).toContain('Other');
    expect(buildFilterExpression(s)).toBe("(provider eq 'unknown') and accessType eq 'foundation'");
  });
});

describe('resetFilterKey', () => {
  it('clears only the one filter its key names, leaving the rest untouched', () => {
    const s = emptyFilters();
    s.capability = 'embedding'; s.inputTypes.image = true; s.provisioning.hosted = true;
    s.providers.SAP = true; s.accessType.llmAccess = true; s.other.streaming = true;
    expect(resetFilterKey(s, 'capability').capability).toBe('all');
    expect(resetFilterKey(s, 'input:image').inputTypes.image).toBe(false);
    expect(resetFilterKey(s, 'prov:hosted').provisioning.hosted).toBe(false);
    expect(resetFilterKey(s, 'provider:SAP').providers.SAP).toBeUndefined();
    expect(resetFilterKey(s, 'access:llm').accessType.llmAccess).toBe(false);
    expect(resetFilterKey(s, 'other:streaming').other.streaming).toBe(false);
    // untouched fields survive, and the input object passed in is never mutated
    const cleared = resetFilterKey(s, 'capability');
    expect(cleared.inputTypes.image).toBe(true);
    expect(s.capability).toBe('embedding');
  });
});

describe('resetFilterGroup', () => {
  it('clears every filter in one group and leaves the other groups untouched', () => {
    const s = emptyFilters();
    s.capability = 'embedding'; s.inputTypes.image = true; s.inputTypes.audio = true;
    s.providers.SAP = true; s.other.streaming = true;
    const next = resetFilterGroup(s, 'inputTypes');
    expect(next.inputTypes).toEqual(emptyFilters().inputTypes);
    expect(next.capability).toBe('embedding');
    expect(next.providers).toEqual({ SAP: true });
    expect(resetFilterGroup(s, 'provider').providers).toEqual({});
    expect(resetFilterGroup(s, 'capability').capability).toBe('all');
  });
});
