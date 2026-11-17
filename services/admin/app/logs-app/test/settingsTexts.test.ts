import { formFromResult, type SettingsResult } from '../webapp/model/settingsForm';
import { describeForm } from '../webapp/model/settingsTexts';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const t = (key: string, args?: (string | number)[]) => (args && args.length ? `${key}(${args.join('|')})` : key);
const time = (iso: string) => `T<${iso}>`;
const base: SettingsResult = {
  logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: [],
  configurationLogStorageEnabled: false, configurationPayloadCaptureEnabled: true, traceKeyStatus: 'strong',
  configurationDefaultLevel: 'INFO', configurationComponentLevels: [], configurationStoredLevel: 'INFO',
  environmentReported: true, environmentReportedAt: null, environmentFixed: [], warning: null
};

describe('describeForm', () => {
  it('puts the configured value into the first item of each list', () => {
    const texts = describeForm(formFromResult(base, NOW), t, time, NOW);
    expect(texts.storageConfigItem).toBe('asConfigured(storageOff)');
    expect(texts.captureConfigItem).toBe('asConfigured(storageOn)');
    expect(texts.defaultConfigItem).toBe('asConfigured(INFO)');
    expect(texts.storageFixed).toBe('');
    expect(texts.defaultFixed).toBe('');
    expect(texts.defaultEnds).toBe('');
    expect(texts.verboseNote).toBe('');
    expect(texts.configurationComponents).toBe('configurationComponentsNone');
  });

  it('a configuration without a default level says so', () => {
    expect(describeForm(formFromResult({ ...base, configurationDefaultLevel: null }, NOW), t, time, NOW).defaultConfigItem).toBe('asConfigured(configurationNotSet)');
  });

  it('shows a setting the environment fixes as its value and the variable', () => {
    const form = formFromResult({ ...base, environmentFixed: [{ variable: 'LOG_LEVEL', value: 'debug' }, { variable: 'GATEWAY_LOG_SHIPPING', value: 'off' }] }, NOW);
    const texts = describeForm(form, t, time, NOW);
    expect(texts.storageFixed).toBe('fixedValue(storageOff|GATEWAY_LOG_SHIPPING)');
    expect(texts.defaultFixed).toBe('fixedValue(DEBUG|LOG_LEVEL)');
  });

  it('says when a level with a time limit ends, for the default and each component, and each component\'s configured level', () => {
    const form = formFromResult({
      ...base, defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T13:00:00.000Z',
      componentLevels: [{ component: 'ConfigService', level: 'TRACE', until: '2026-11-11T12:15:00.000Z' }, { component: 'Other', level: 'WARN', until: null }],
      configurationComponentLevels: [{ component: 'ConfigService', level: 'INFO' }, { component: 'Server', level: 'WARN' }]
    }, NOW);
    const texts = describeForm(form, t, time, NOW);
    expect(texts.defaultEnds).toBe('endsAt(T<2026-11-11T13:00:00.000Z>)');
    expect(texts.components).toEqual([
      { configText: 'INFO', endsText: 'endsAt(T<2026-11-11T12:15:00.000Z>)' },
      { configText: 'configurationDefault(INFO)', endsText: '' }
    ]);
    expect(texts.configurationComponents).toBe('configurationComponents(ConfigService: INFO, Server: WARN)');
  });

  it('a duration changed away from the running limit no longer shows the old end', () => {
    const form = formFromResult({ ...base, defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T13:00:00.000Z' }, NOW);
    form.defaultDuration = '15';
    expect(describeForm(form, t, time, NOW).defaultEnds).toBe('');
  });
});

describe('describeForm, the note on levels this page does not store', () => {
  const note = (over: Partial<SettingsResult>, edit?: (f: any) => void) => {
    const form = formFromResult({ ...base, ...over }, NOW);
    edit?.(form);
    return describeForm(form, t, time, NOW).verboseNote;
  };

  it('appears for a default level chosen here that is more verbose than the stored level', () => {
    expect(note({}, (f) => { f.defaultLevel = 'DEBUG'; })).toBe('verboseNote(INFO)');
  });

  it('appears for a level the environment fixes, a component level, or a configured component level', () => {
    expect(note({ environmentFixed: [{ variable: 'LOG_LEVEL', value: 'trace' }] })).toBe('verboseNote(INFO)');
    expect(note({ componentLevels: [{ component: 'A', level: 'DEBUG', until: null }] })).toBe('verboseNote(INFO)');
    expect(note({ configurationComponentLevels: [{ component: 'B', level: 'TRACE' }] })).toBe('verboseNote(INFO)');
  });

  it('does not appear when the stored level takes those lines, or nothing is more verbose', () => {
    expect(note({ configurationStoredLevel: 'DEBUG' }, (f) => { f.defaultLevel = 'DEBUG'; })).toBe('');
    expect(note({}, (f) => { f.defaultLevel = 'WARN'; })).toBe('');
    expect(note({ configurationDefaultLevel: 'DEBUG' }, (f) => { f.defaultLevel = 'INFO'; })).toBe('');
  });

  it('follows the configured default level while the form follows the configuration', () => {
    expect(note({ configurationDefaultLevel: 'DEBUG' })).toBe('verboseNote(INFO)');
  });
});

describe('describeForm, a limit that has run out', () => {
  it('says that a kept level has run out and is not saved again', () => {
    const form = formFromResult({ ...base, defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T12:05:00.000Z',
      componentLevels: [{ component: 'A', level: 'TRACE', until: '2026-11-11T12:05:00.000Z' }] }, NOW);
    const texts = describeForm(form, t, time, new Date('2026-11-11T12:06:00.000Z'));
    expect(texts.defaultEnds).toBe('levelRanOut');
    expect(texts.components[0].endsText).toBe('levelRanOut');
  });
});
