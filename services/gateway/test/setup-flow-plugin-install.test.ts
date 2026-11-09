import fs from 'fs';
import path from 'path';
import { scripted, Step } from './helpers/scriptedPrompter';

/* eslint-disable @typescript-eslint/no-var-requires */
const { PromptSession, REVIEW } = require('../../../docker/setup-flow/session');
const {
  INSTALL_KEY,
  PLUGIN_INSTALL_MESSAGE,
  askPluginInstall,
  pluginInstallFromEnv,
  pluginInstallToWrite,
  applyPluginInstallToEnvText
} = require('../../../docker/setup-flow/pluginInstall');
/* eslint-enable @typescript-eslint/no-var-requires */

async function run(steps: Step[], current: Record<string, unknown> = {}) {
  const script = scripted(steps);
  const session = new PromptSession({ inquirer: {}, promptFn: script.promptFn, current });
  const result = await session.run((s: any) => askPluginInstall(s, current));
  script.assertDone();
  return { result, script };
}

describe('askPluginInstall', () => {
  test('uses the agreed copy and defaults to yes', async () => {
    const { result, script } = await run([[INSTALL_KEY, true], [REVIEW, 'WRITE']]);
    expect(result).toBe(true);
    expect(PLUGIN_INSTALL_MESSAGE).toBe(
      'Allow admins to install plugins? An uploaded plugin runs as code inside the gateway, which holds your provider keys.'
    );
    expect(script.shown[0].question.message).toBe(PLUGIN_INSTALL_MESSAGE);
    expect(script.shown[0].default).toBe(true);
  });

  test('a no is returned', async () => {
    const { result } = await run([[INSTALL_KEY, false], [REVIEW, 'WRITE']]);
    expect(result).toBe(false);
  });

  test('an earlier no is the default of a re-run', async () => {
    const { script } = await run([[INSTALL_KEY, false], [REVIEW, 'WRITE']], { [INSTALL_KEY]: false });
    expect(script.shown[0].default).toBe(false);
  });
});

describe('pluginInstallFromEnv', () => {
  test('reads true and false, ignores anything else', () => {
    expect(pluginInstallFromEnv({ [INSTALL_KEY]: 'false' })).toEqual({ [INSTALL_KEY]: false });
    expect(pluginInstallFromEnv({ [INSTALL_KEY]: ' TRUE ' })).toEqual({ [INSTALL_KEY]: true });
    expect(pluginInstallFromEnv({ [INSTALL_KEY]: 'maybe' })).toEqual({});
    expect(pluginInstallFromEnv({})).toEqual({});
    expect(pluginInstallFromEnv(null)).toEqual({});
  });
});

describe('pluginInstallToWrite', () => {
  test('yes with nothing stored changes nothing', () => {
    expect(pluginInstallToWrite(true, {})).toBeNull();
  });
  test('yes over a stored no writes true, no always writes false', () => {
    expect(pluginInstallToWrite(true, { [INSTALL_KEY]: false })).toBe(true);
    expect(pluginInstallToWrite(false, {})).toBe(false);
  });
});

describe('applyPluginInstallToEnvText', () => {
  const sample = '# a\n# INSTALLED_PLUGINS_ENABLED=true\nOTHER=1\n';
  test('replaces the commented sample line', () => {
    expect(applyPluginInstallToEnvText(sample, false)).toBe('# a\nINSTALLED_PLUGINS_ENABLED=false\nOTHER=1\n');
  });
  test('replaces an active line', () => {
    expect(applyPluginInstallToEnvText('INSTALLED_PLUGINS_ENABLED=false\n', true)).toBe('INSTALLED_PLUGINS_ENABLED=true\n');
  });
  test('appends when absent', () => {
    expect(applyPluginInstallToEnvText('OTHER=1\n', false)).toBe('OTHER=1\nINSTALLED_PLUGINS_ENABLED=false\n');
  });
});

describe('docker-compose.yml', () => {
  const compose = fs.readFileSync(path.join(__dirname, '../../../docker/docker-compose.yml'), 'utf8');
  const block = (service: string) => {
    const match = new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9_-]+:\\n|$)`).exec(compose);
    return match ? match[1] : '';
  };

  test('admin reads its settings from services/admin/.env, which carries the plugin setting', () => {
    expect(block('admin')).toMatch(/- \.\.\/services\/admin\/\.env/);
  });

  test('the gateway does not read the admin env file', () => {
    expect(block('gateway')).not.toMatch(/services\/admin\/\.env/);
    expect(block('gateway')).not.toMatch(/INSTALLED_PLUGINS_ENABLED/);
  });
});
