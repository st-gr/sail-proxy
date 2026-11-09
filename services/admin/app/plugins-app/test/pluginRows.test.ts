import { builtinRows, compareVersions, helpFor, pageState, pluginRows, rowsForAction, selectionActions, withSelectedVersion } from '../webapp/model/pluginRows';

const version = (v: string, over: Record<string, unknown> = {}) => ({
  version: v, sha256: 'abc', sizeBytes: 10, uploadedBy: 'ada@example.test', uploadedAt: '2026-11-04T10:00:00.000Z',
  gateway: '*', compatible: true, help: { en: { summary: 'Masks secrets' } }, hasSettings: false, ...over
});
const report = (state: string, over: Record<string, unknown> = {}) => ({
  instance: 'gw-1', version: '1.0.0', state, rules: [{ id: 'mask', strategy: 'invoke' }], at: '2026-11-04T10:00:00.000Z', ...over
});
const instance = (name: string, over: Record<string, unknown> = {}) => ({ instance: name, gatewayVersion: '0.12.0', at: '2026-11-04T10:00:00.000Z', plugins: [], ...over });
const response = (plugin: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  enabled: true,
  adminVersion: '0.12.0',
  gatewayStatus: { available: true, instances: [instance('gw-1')] },
  builtins: [],
  plugins: [{ id: 'acme', enabledVersion: '1.0.0', versions: [version('1.0.0')], status: [], ...plugin }],
  ...over
});
const one = (plugin: Record<string, unknown> = {}, over: Record<string, unknown> = {}, inst = '') => pluginRows(response(plugin, over), inst)[0];

describe('pluginRows: state', () => {
  it('a running plugin reads Running, in the success state', () => {
    expect(one({ status: [report('running')] })).toMatchObject({ stateKey: 'running', statusText: 'Running', statusState: 'Success', errorText: '' });
  });

  it('a failed plugin reads Failed with the error', () => {
    expect(one({ status: [report('failed', { error: 'Cannot find module x' })] }))
      .toMatchObject({ stateKey: 'failed', statusText: 'Failed', statusState: 'Error', errorText: 'Cannot find module x' });
  });

  it('a failed row with an empty version does not name a version', () => {
    const row = one({ status: [report('failed', { version: '', error: 'unreadable zip' })] });
    expect(row.statusText).toBe('Failed');
    expect(row.errorText).toBe('unreadable zip');
    expect(row.detailText).toBe('');
  });

  it('an incompatible plugin names the gateway version and keeps the gateway\'s reason', () => {
    expect(one({ status: [report('incompatible', { error: 'needs >=9' })] }))
      .toMatchObject({ stateKey: 'incompatible', statusText: 'Not compatible with gateway 0.12.0', statusState: 'Warning', errorText: 'needs >=9' });
  });

  it('a plugin unpacked but not loaded yet says so', () => {
    expect(one({ status: [report('installed')] })).toMatchObject({ stateKey: 'installed', statusText: 'Installed, not loaded yet', statusState: 'Information' });
  });

  it('no gateway report means not responding, and that the change applies at the next start', () => {
    expect(one({}, { gatewayStatus: { available: true, instances: [] } })).toMatchObject({
      stateKey: 'notResponding', statusText: 'Gateway not responding', statusState: 'Warning',
      detailText: 'The change applies at the gateway\'s next start.'
    });
  });

  it('no status store means status unavailable, never not responding', () => {
    expect(one({}, { gatewayStatus: { available: false, instances: [] } }))
      .toMatchObject({ stateKey: 'unavailable', statusText: 'Status unavailable', statusState: 'None' });
  });

  it('a gateway that reports but does not list the enabled plugin is still fetching it', () => {
    expect(one()).toMatchObject({ stateKey: 'pending', statusText: 'Waiting for the gateway', statusState: 'Information' });
  });

  it('a gateway still running the old version after a switch says which', () => {
    expect(one({ enabledVersion: '1.1.0', versions: [version('1.1.0'), version('1.0.0')], status: [report('running')] }))
      .toMatchObject({ stateKey: 'pending', statusText: 'Waiting for the gateway', detailText: 'Running 1.0.0' });
  });

  it('a disabled plugin reads Disabled whatever the gateways report', () => {
    expect(one({ enabledVersion: null })).toMatchObject({ stateKey: 'disabled', statusText: 'Disabled', statusState: 'None' });
    expect(one({ enabledVersion: null }, { gatewayStatus: { available: false, instances: [] } })).toMatchObject({ stateKey: 'disabled' });
  });
});

describe('pluginRows: several gateway instances', () => {
  const two = { gatewayStatus: { available: true, instances: [instance('gw-1'), instance('gw-2')] } };
  const mixed = { status: [report('running'), report('failed', { instance: 'gw-2', error: 'boom', rules: [] })] };

  it('without an instance the worst state wins and each instance is named', () => {
    const row = one(mixed, two);
    expect(row).toMatchObject({ stateKey: 'failed', errorText: 'boom' });
    expect(row.detailText).toBe('gw-1: Running; gw-2: Failed');
  });

  it('an instance shows only its own report', () => {
    expect(one(mixed, two, 'gw-1')).toMatchObject({ stateKey: 'running', errorText: '', detailText: '' });
    expect(one(mixed, two, 'gw-2')).toMatchObject({ stateKey: 'failed', errorText: 'boom' });
  });

  it('an instance that has not reported the plugin counts as waiting', () => {
    expect(one({ status: [report('running')] }, two)).toMatchObject({ stateKey: 'pending', detailText: 'gw-1: Running; gw-2: Waiting for the gateway' });
  });

  it('an instance that has gone is not responding, not a blank row', () => {
    expect(one(mixed, two, 'gw-9')).toMatchObject({ stateKey: 'notResponding' });
  });
});

describe('pluginRows: the rest of a row', () => {
  it('lists the reported rule ids once, sorted', () => {
    const row = one({ status: [report('running', { rules: [{ id: 'z', strategy: 'invoke' }, { id: 'a', strategy: 'invoke' }] }), report('running', { instance: 'gw-2', rules: [{ id: 'a', strategy: 'invoke' }] })] });
    expect(row.rulesText).toBe('a, z');
  });

  it('shows who uploaded the selected version and when', () => {
    const row = pluginRows(response({}), '', { locale: 'en-US' })[0];
    expect(row.uploadedBy).toBe('ada@example.test');
    expect(row.uploadedAtText).toContain('2026');
  });

  it('selects the enabled version, else the newest', () => {
    expect(one({ enabledVersion: '1.0.0', versions: [version('1.0.0'), version('1.2.0')] }).selectedVersion).toBe('1.0.0');
    expect(one({ enabledVersion: null, versions: [version('1.0.0'), version('1.10.0'), version('1.2.0')] }).selectedVersion).toBe('1.10.0');
  });

  it('offers the versions newest first and marks the enabled one', () => {
    const row = one({ enabledVersion: '1.0.0', versions: [version('1.0.0'), version('1.2.0')] });
    expect(row.versionOptions).toEqual([{ key: '1.2.0', text: '1.2.0' }, { key: '1.0.0', text: '1.0.0 (enabled)' }]);
  });

  it('carries package text as data, unchanged', () => {
    const summary = '{"a": 1} {i18n>x} <b>bold</b>';
    const row = one({ status: [report('failed', { error: '{boom} <img>' })], versions: [version('1.0.0', { help: { en: { summary } } })] });
    expect(row.summaryText).toBe(summary);
    expect(row.errorText).toBe('{boom} <img>');
  });

  it('survives a response without the optional parts', () => {
    expect(pluginRows(null, '')).toEqual([]);
    expect(pluginRows({ plugins: [{ id: 'x' }] }, '')[0]).toMatchObject({ id: 'x', selectedVersion: '', canEnable: false, canRemove: false, canDisable: false });
  });
});

describe('pluginRows: actions', () => {
  it('enables a stored, compatible, disabled version', () => {
    expect(one({ enabledVersion: null })).toMatchObject({ canEnable: true, enableText: 'Enable', canDisable: false, canRemove: true, canAddHooks: false });
  });

  it('with the setting off enable is off; disable and remove stay', () => {
    const row = one({ enabledVersion: '1.0.0', versions: [version('1.0.0'), version('1.2.0')] }, { enabled: false });
    expect(row).toMatchObject({ canEnable: false, canDisable: true });
    expect(withSelectedVersion(row, '1.2.0', false)).toMatchObject({ canEnable: false, canRemove: true, canDisable: true });
  });

  it('refuses to enable an incompatible version and says why', () => {
    expect(one({ enabledVersion: null, versions: [version('1.0.0', { compatible: false, gateway: '>=9.0.0' })] }))
      .toMatchObject({ canEnable: false, compatibilityText: 'Needs gateway >=9.0.0; this installation is 0.12.0.' });
  });

  it('the enabled version cannot be enabled again or removed', () => {
    expect(one()).toMatchObject({ canEnable: false, canRemove: false, canDisable: true, canAddHooks: true });
  });

  it('choosing another version offers a switch', () => {
    const row = one({ enabledVersion: '1.0.0', versions: [version('1.0.0'), version('1.2.0', { uploadedBy: 'grace@example.test', help: { en: { summary: 'Newer' } } })] });
    expect(withSelectedVersion(row, '1.2.0', true)).toMatchObject({
      selectedVersion: '1.2.0', canEnable: true, enableText: 'Switch to this version', canRemove: true, uploadedBy: 'grace@example.test', summaryText: 'Newer'
    });
  });

  it('an unknown version leaves the row as it is', () => {
    const row = one();
    expect(withSelectedVersion(row, '9.9.9', true)).toBe(row);
  });
});

describe('helpFor', () => {
  const help = { de: { summary: 'Deutsch' }, pt: { summary: 'Português' }, en: { summary: 'English' } };
  it('matches the language exactly, with no note', () => {
    expect(helpFor(help, 'de')).toEqual({ summary: 'Deutsch', fallback: '' });
  });
  it('then the base language, with no note', () => {
    expect(helpFor(help, 'pt-BR')).toEqual({ summary: 'Português', fallback: '' });
  });
  it('then the first language the manifest lists, named for the note', () => {
    expect(helpFor(help, 'fr')).toEqual({ summary: 'Deutsch', fallback: 'de' });
  });
  it('a manifest without help has no summary and no note', () => {
    expect(helpFor(undefined, 'en')).toEqual({ summary: '', fallback: '' });
  });
  it('shows the note on the row', () => {
    const row = pluginRows(response({ versions: [version('1.0.0', { help: { de: { summary: 'Deutsch' } } })] }), '', { language: 'fr' })[0];
    expect(row).toMatchObject({ summaryText: 'Deutsch', helpNoteText: 'This help is not available in your language; it is shown in de.' });
  });
});

describe('compareVersions', () => {
  it('orders numerically, with a pre-release below its release', () => {
    expect(['1.2.0', '1.10.0', '1.2.0-rc.1', '0.9.0'].sort(compareVersions)).toEqual(['0.9.0', '1.2.0-rc.1', '1.2.0', '1.10.0']);
  });
});

describe('pageState', () => {
  it('the setting off raises the banner', () => {
    expect(pageState(response({}, { enabled: false }), '')).toMatchObject({ settingOff: true, canUpload: false });
    expect(pageState(response({}), '')).toMatchObject({ settingOff: false, canUpload: true });
  });
  it('tells status unavailable from not responding', () => {
    expect(pageState(response({}, { gatewayStatus: { available: false, instances: [] } }), '')).toMatchObject({ statusUnavailable: true, notResponding: false });
    expect(pageState(response({}, { gatewayStatus: { available: true, instances: [] } }), '')).toMatchObject({ statusUnavailable: false, notResponding: true });
    expect(pageState(response({}), '')).toMatchObject({ statusUnavailable: false, notResponding: false });
  });
  it('shows why a gateway does not unpack, once per reason', () => {
    const reason = 'Running under ts-node: packages are not unpacked.';
    const gatewayStatus = { available: true, instances: [instance('a', { unpackDisabledReason: reason }), instance('b', { unpackDisabledReason: reason }), instance('c')] };
    expect(pageState(response({}, { gatewayStatus }), '').unpackDisabledReason).toBe(reason);
    expect(pageState(response({}), '').unpackDisabledReason).toBe('');
  });
  it('offers an instance choice only with more than one instance', () => {
    expect(pageState(response({}), '').showInstances).toBe(false);
    const state = pageState(response({}, { gatewayStatus: { available: true, instances: [instance('b'), instance('a')] } }), '');
    expect(state.showInstances).toBe(true);
    expect(state.instanceOptions).toEqual([{ key: '', text: 'All gateways' }, { key: 'a', text: 'a' }, { key: 'b', text: 'b' }]);
  });
  it('an answer without the optional parts is off, not a throw', () => {
    expect(pageState(null, '')).toMatchObject({ settingOff: false, canUpload: false, statusUnavailable: true });
  });
});

describe('builtinRows', () => {
  const gatewayStatus = { available: true, instances: [instance('gw-1', {
    plugins: [{ id: 'shipped-one', version: '1.0.0', kind: 'shipped', state: 'failed', error: 'boom', rules: [] }]
  })] };
  const builtins = [
    { id: 'shipped-one', kind: 'shipped', version: '1.0.0', rules: [{ id: 'b', strategy: 'invoke' }, { id: 'a', strategy: 'invoke' }] },
    { id: 'shipped-two', kind: 'shipped', version: '1.0.0', rules: [] }
  ];

  it('shows each built-in with its rules and no actions', () => {
    const rows = builtinRows(response({}, { builtins, gatewayStatus }), '');
    expect(rows[0]).toMatchObject({ id: 'shipped-one', versionText: '1.0.0', rulesText: 'a, b', errorText: 'boom', statusText: 'Failed' });
    expect(rows[1]).toMatchObject({ id: 'shipped-two', versionText: '1.0.0', rulesText: '', errorText: '', statusText: '' });
    expect(Object.keys(rows[0]).filter((key) => key.startsWith('can'))).toEqual([]);
    expect(rows[0]).not.toHaveProperty('kindText');
  });

  it('an empty list when no gateway reports', () => {
    expect(builtinRows(response({}), '')).toEqual([]);
    expect(builtinRows(null, '')).toEqual([]);
  });
});

describe('selectionActions: the buttons above the table', () => {
  const disabled = (over: Record<string, unknown> = {}) => one({ enabledVersion: null, ...over });
  const enabled = () => one({ versions: [version('1.1.0'), version('1.0.0')] });

  it('nothing selected: every action is off', () => {
    expect(selectionActions([])).toEqual({ canEnable: false, enableText: 'Enable', canDisable: false, canRemove: false, canAddHooks: false });
  });

  it('one disabled plugin can be enabled and removed, not disabled', () => {
    expect(selectionActions([disabled()])).toMatchObject({ canEnable: true, enableText: 'Enable', canDisable: false, canRemove: true, canAddHooks: false });
  });

  it('one enabled plugin on its enabled version can be disabled and given hooks, not enabled or removed', () => {
    expect(selectionActions([enabled()])).toMatchObject({ canEnable: false, canDisable: true, canRemove: false, canAddHooks: true });
  });

  it('another version chosen on an enabled plugin offers the switch', () => {
    const row = withSelectedVersion(enabled(), '1.1.0', true);
    expect(selectionActions([row])).toMatchObject({ canEnable: true, enableText: 'Switch to this version', canRemove: true, canDisable: true });
  });

  it('several rows: an action is on when it fits at least one of them', () => {
    expect(selectionActions([disabled(), disabled()])).toMatchObject({ canEnable: true, canRemove: true, canDisable: false, canAddHooks: false });
    expect(selectionActions([disabled(), enabled()])).toMatchObject({ canEnable: true, canRemove: true, canDisable: true, canAddHooks: true });
  });

  it('the label follows the rows Enable acts on: a plugin already on its version does not count', () => {
    const switching = withSelectedVersion(enabled(), '1.1.0', true);
    expect(selectionActions([disabled(), switching]).enableText).toBe('Enable');
    expect(selectionActions([switching, switching]).enableText).toBe('Switch to this version');
    expect(selectionActions([enabled(), switching]).enableText).toBe('Switch to this version');
    expect(selectionActions([enabled(), disabled()]).enableText).toBe('Enable');
  });

  it('suggested hooks take several rows: they go into one configuration', () => {
    expect(selectionActions([enabled(), enabled()]).canAddHooks).toBe(true);
  });

  it('an incompatible row does not offer Enable on its own, and is left out beside one that fits', () => {
    const incompatible = one({ enabledVersion: null, versions: [version('9.0.0', { compatible: false })] });
    expect(selectionActions([incompatible]).canEnable).toBe(false);
    const { fitting, skipped } = rowsForAction([incompatible, disabled()], 'canEnable');
    expect(fitting.map((row) => row.selectedVersion)).toEqual(['1.0.0']);
    expect(skipped.map((row) => row.selectedVersion)).toEqual(['9.0.0']);
  });

  it('uses the translator it is given', () => {
    expect(selectionActions([], (key) => `[${key}]`).enableText).toBe('[enableAction]');
  });
});
