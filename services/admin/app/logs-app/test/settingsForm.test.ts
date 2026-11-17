import { clearedByFixed, componentHints, fieldOfErrorCode, formFromResult, formSignature, paramsFromForm, validateForm, type SettingsResult } from '../webapp/model/settingsForm';

const NOW = new Date('2026-11-11T12:00:00.000Z');

const result = (over: Partial<SettingsResult> = {}): SettingsResult => ({
  logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelUntil: null, componentLevels: [],
  configurationLogStorageEnabled: true, configurationPayloadCaptureEnabled: false, traceKeyStatus: 'strong',
  configurationDefaultLevel: 'INFO', configurationComponentLevels: [], configurationStoredLevel: 'INFO',
  environmentReported: true, environmentReportedAt: '2026-11-11T11:00:00.000Z', environmentFixed: [], warning: null,
  ...over
});

describe('formFromResult', () => {
  it('shows "as the configuration says" for everything the record leaves open', () => {
    const form = formFromResult(result(), NOW);
    expect(form).toMatchObject({ storage: 'config', capture: 'config', defaultLevel: 'config', defaultDuration: 'none', defaultUntil: null, components: [] });
    expect(form.configuration).toEqual({ storage: true, capture: false, defaultLevel: 'INFO', storedLevel: 'INFO', components: [] });
    expect(form.fixed).toEqual({ storage: null, defaultLevel: null });
  });

  it('takes the record\'s values, a time limit as "keep until" and the components in name order', () => {
    const form = formFromResult(result({
      logStorageEnabled: false, defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T13:00:00.000Z',
      componentLevels: [{ component: 'ModelService', level: 'WARN', until: null }, { component: 'ConfigService', level: 'TRACE', until: '2026-11-11T12:15:00.000Z' }],
      configurationComponentLevels: [{ component: 'ConfigService', level: 'INFO' }]
    }), NOW);
    expect(form.storage).toBe('off');
    expect(form.defaultLevel).toBe('DEBUG');
    expect(form.defaultDuration).toBe('keep');
    expect(form.defaultUntil).toBe('2026-11-11T13:00:00.000Z');
    expect(form.components).toEqual([
      { component: 'ConfigService', level: 'TRACE', duration: 'keep', until: '2026-11-11T12:15:00.000Z', configLevel: 'INFO' },
      { component: 'ModelService', level: 'WARN', duration: 'none', until: null, configLevel: null }
    ]);
  });

  it('names the variable that fixes a setting, with its value', () => {
    const form = formFromResult(result({ environmentFixed: [{ variable: 'LOG_LEVEL', value: 'debug' }, { variable: 'GATEWAY_LOG_SHIPPING', value: 'off' }, { variable: 'PAYLOAD_LOGGING_ENABLED', value: 'true' }] }), NOW);
    expect(form.fixed).toEqual({ storage: 'GATEWAY_LOG_SHIPPING=off', defaultLevel: 'LOG_LEVEL=debug' });
  });

  it('a time limit that has run out is shown as no limit', () => {
    const form = formFromResult(result({ defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T11:59:00.000Z' }), NOW);
    expect(form.defaultDuration).toBe('none');
    expect(form.defaultUntil).toBeNull();
  });
});

describe('paramsFromForm', () => {
  it('sends null for what follows the configuration', () => {
    expect(paramsFromForm(formFromResult(result(), NOW), NOW)).toEqual({ logStorageEnabled: null, payloadCaptureEnabled: null, defaultLevel: null, defaultLevelMinutes: null, componentLevels: null });
  });

  it('sends payload capture on, off, or null for "as the configuration says"', () => {
    const form = formFromResult(result({ payloadCaptureEnabled: true }), NOW);
    expect(form.capture).toBe('on');
    expect(paramsFromForm(form, NOW).payloadCaptureEnabled).toBe(true);
    form.capture = 'off';
    expect(paramsFromForm(form, NOW).payloadCaptureEnabled).toBe(false);
    expect(formFromResult(result({ payloadCaptureEnabled: false }), NOW).capture).toBe('off');
  });

  it('sends the switch, the level with its minutes and the components as JSON { [component]: { level, minutes? } }', () => {
    const form = formFromResult(result(), NOW);
    form.storage = 'on';
    form.defaultLevel = 'DEBUG';
    form.defaultDuration = '60';
    form.components = [
      { component: ' ConfigService ', level: 'TRACE', duration: '15', until: null, configLevel: null },
      { component: 'ModelService', level: 'WARN', duration: 'none', until: null, configLevel: null }
    ];
    const params = paramsFromForm(form, NOW);
    expect(params).toMatchObject({ logStorageEnabled: true, defaultLevel: 'DEBUG', defaultLevelMinutes: 60 });
    expect(JSON.parse(params.componentLevels!)).toEqual({ ConfigService: { level: 'TRACE', minutes: 15 }, ModelService: { level: 'WARN' } });
  });

  it('keeps a running time limit by sending the minutes that are left, rounded up', () => {
    const form = formFromResult(result({
      defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T12:30:20.000Z',
      componentLevels: [{ component: 'ConfigService', level: 'TRACE', until: '2026-11-11T12:00:10.000Z' }]
    }), NOW);
    const params = paramsFromForm(form, NOW);
    expect(params.defaultLevelMinutes).toBe(31);
    expect(JSON.parse(params.componentLevels!)).toEqual({ ConfigService: { level: 'TRACE', minutes: 1 } });
  });

  it('a level that follows the configuration carries no minutes', () => {
    const form = formFromResult(result(), NOW);
    form.defaultDuration = '60';
    expect(paramsFromForm(form, NOW).defaultLevelMinutes).toBeNull();
  });

  it('leaves a setting the environment fixes to the configuration, so the gateway\'s variable keeps the last word and the save is not refused', () => {
    const form = formFromResult(result({
      logStorageEnabled: true, defaultLevel: 'DEBUG',
      environmentFixed: [{ variable: 'LOG_LEVEL', value: 'warn' }, { variable: 'GATEWAY_LOG_SHIPPING', value: 'off' }]
    }), NOW);
    expect(paramsFromForm(form, NOW)).toMatchObject({ logStorageEnabled: null, defaultLevel: null, defaultLevelMinutes: null });
    form.storage = 'off';
    expect(paramsFromForm(form, NOW).logStorageEnabled).toBe(false);
  });
});

describe('validateForm', () => {
  it('finds a component row without a name and a name given twice', () => {
    const form = formFromResult(result(), NOW);
    form.components = [
      { component: '', level: 'DEBUG', duration: 'none', until: null, configLevel: null },
      { component: 'ConfigService', level: 'DEBUG', duration: 'none', until: null, configLevel: null },
      { component: ' ConfigService', level: 'WARN', duration: 'none', until: null, configLevel: null }
    ];
    expect(validateForm(form)).toEqual([
      { path: '/components/0/component', key: 'componentNameMissing' },
      { path: '/components/2/component', key: 'componentNameTwice' }
    ]);
  });

  it('is empty for a good form', () => {
    expect(validateForm(formFromResult(result({ componentLevels: [{ component: 'A', level: 'INFO', until: null }] }), NOW))).toEqual([]);
  });
});

describe('fieldOfErrorCode', () => {
  it('names the field a refusal of the service belongs to', () => {
    expect(fieldOfErrorCode('LOGGING_FIXED_LOG_SHIPPING')).toBe('storage');
    expect(fieldOfErrorCode('LOGGING_LEVEL_INVALID')).toBe('defaultLevel');
    expect(fieldOfErrorCode('LOGGING_FIXED_LOG_LEVEL')).toBe('defaultLevel');
    expect(fieldOfErrorCode('LOGGING_MINUTES_INVALID')).toBe('defaultDuration');
    expect(fieldOfErrorCode('LOGGING_MINUTES_WITHOUT_LEVEL')).toBe('defaultDuration');
  });

  it('has no field for the component table and unknown codes (shown as a message)', () => {
    expect(fieldOfErrorCode('LOGGING_COMPONENT_NAME_INVALID')).toBeNull();
    expect(fieldOfErrorCode('LOGGING_TOO_MANY_COMPONENTS')).toBeNull();
    expect(fieldOfErrorCode('SOMETHING_NEW')).toBeNull();
  });
});

describe('saving what the form shows', () => {
  it('a kept time limit that has run out while the form was open sends nothing for that level', () => {
    const form = formFromResult(result({
      defaultLevel: 'DEBUG', defaultLevelUntil: '2026-11-11T12:05:00.000Z',
      componentLevels: [{ component: 'ConfigService', level: 'TRACE', until: '2026-11-11T12:05:00.000Z' }, { component: 'Other', level: 'WARN', until: null }]
    }), NOW);
    const later = new Date('2026-11-11T12:06:00.000Z');
    const params = paramsFromForm(form, later);
    expect(params).toMatchObject({ defaultLevel: null, defaultLevelMinutes: null });
    expect(JSON.parse(params.componentLevels!)).toEqual({ Other: { level: 'WARN' } });
  });

  it('only run-out components left: no component levels at all', () => {
    const form = formFromResult(result({ componentLevels: [{ component: 'A', level: 'TRACE', until: '2026-11-11T12:05:00.000Z' }] }), NOW);
    expect(paramsFromForm(form, new Date('2026-11-11T12:06:00.000Z')).componentLevels).toBeNull();
  });

  it('names the variables whose stored value a save clears (the service refuses the value while the variable fixes it)', () => {
    const fixed = [{ variable: 'LOG_LEVEL', value: 'warn' }, { variable: 'GATEWAY_LOG_SHIPPING', value: 'off' }];
    expect(clearedByFixed(formFromResult(result({ logStorageEnabled: true, defaultLevel: 'DEBUG', environmentFixed: fixed }), NOW))).toEqual(['GATEWAY_LOG_SHIPPING', 'LOG_LEVEL']);
    expect(clearedByFixed(formFromResult(result({ logStorageEnabled: false, environmentFixed: fixed }), NOW))).toEqual([]);
    expect(clearedByFixed(formFromResult(result({ logStorageEnabled: true, defaultLevel: 'DEBUG' }), NOW))).toEqual([]);
  });
});

describe('componentHints', () => {
  const rows = (...names: string[]) => names.map((component) => ({ component, level: 'DEBUG', duration: 'none', until: null, configLevel: null }));
  const known = ['ConfigService', 'openaiController'];

  it('says nothing for a name the gateway logs with, an empty name, or while no names are known', () => {
    expect(componentHints(rows('ConfigService', ' openaiController ', ''), known)).toEqual([null, null, null]);
    expect(componentHints(rows('Anything'), [])).toEqual([null]);
  });

  it('suggests the exact spelling of a name that differs only in case', () => {
    expect(componentHints(rows('configservice'), known)).toEqual([{ key: 'componentCase', args: ['ConfigService'] }]);
  });

  it('warns about a name no stored log line has', () => {
    expect(componentHints(rows('ConfigServce'), known)).toEqual([{ key: 'componentUnknown', args: [] }]);
  });
});

describe('formSignature', () => {
  it('is the same for a form read twice, and changes with any choice', () => {
    const read = () => formFromResult(result({ defaultLevel: 'DEBUG', componentLevels: [{ component: 'A', level: 'WARN', until: null }] }), NOW);
    expect(formSignature(read())).toBe(formSignature(read()));
    const edits: ((f: any) => void)[] = [
      (f) => { f.storage = 'off'; }, (f) => { f.capture = 'on'; }, (f) => { f.defaultLevel = 'TRACE'; }, (f) => { f.defaultDuration = '15'; },
      (f) => { f.components[0].level = 'ERROR'; }, (f) => { f.components[0].component = 'B'; }, (f) => { f.components[0].duration = '60'; },
      (f) => { f.components.push({ component: '', level: 'DEBUG', duration: '60', until: null, configLevel: null }); },
      (f) => { f.components = []; }
    ];
    for (const edit of edits) {
      const changed = read();
      edit(changed);
      expect(formSignature(changed)).not.toBe(formSignature(read()));
    }
  });

  it('ignores what the page adds to a row for its own display', () => {
    const plain = formFromResult(result({ componentLevels: [{ component: 'A', level: 'WARN', until: null }] }), NOW);
    const shown: any = structuredClone(plain);
    Object.assign(shown.components[0], { componentState: 'Error', componentStateText: 'x', configText: 'y', endsText: 'z' });
    expect(formSignature(shown)).toBe(formSignature(plain));
  });
});
