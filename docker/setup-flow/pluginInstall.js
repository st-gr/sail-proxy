'use strict';
/**
 * The question whether admins may install gateway plugins, for the setup scripts, and the admin
 * env line it produces.
 *
 * The admin reads INSTALLED_PLUGINS_ENABLED (unset or anything but false means on). An uploaded
 * plugin runs as code inside the gateway, so an operator can switch the feature off here.
 */

const INSTALL_KEY = 'INSTALLED_PLUGINS_ENABLED';
const PLUGIN_INSTALL_MESSAGE =
  'Allow admins to install plugins? An uploaded plugin runs as code inside the gateway, which holds your provider keys.';

/** The stored answer of an env (parsed .env / Secret data): { INSTALLED_PLUGINS_ENABLED: boolean } or {}. */
function pluginInstallFromEnv(env) {
  const raw = env && typeof env[INSTALL_KEY] === 'string' ? env[INSTALL_KEY].trim().toLowerCase() : '';
  if (raw === 'true') return { [INSTALL_KEY]: true };
  if (raw === 'false') return { [INSTALL_KEY]: false };
  return {};
}

/**
 * @param {object} session  the PromptSession
 * @param {object} [current]  current values by question id (INSTALLED_PLUGINS_ENABLED: boolean)
 * @returns {Promise<boolean>}
 */
async function askPluginInstall(session, current = {}) {
  const answer = await session.ask({
    type: 'confirm',
    name: INSTALL_KEY,
    message: PLUGIN_INSTALL_MESSAGE,
    reviewLabel: 'Admins may install plugins',
    default: current[INSTALL_KEY] !== false
  });
  return answer[INSTALL_KEY];
}

/**
 * What an interactive run writes: the answer, except that yes with nothing stored changes
 * nothing (null), since unset already means on.
 */
function pluginInstallToWrite(enabled, current = {}) {
  if (typeof enabled !== 'boolean') return null;
  if (enabled && current[INSTALL_KEY] === undefined) return null;
  return enabled;
}

/** Sets the key in the text of an env file: replaces its active or commented sample line, or appends it. */
function applyPluginInstallToEnvText(text, enabled) {
  const lines = text.split('\n');
  const active = new RegExp(`^\\s*${INSTALL_KEY}\\s*=`);
  const sample = new RegExp(`^\\s*#\\s*${INSTALL_KEY}\\s*=`);
  let index = lines.findIndex((line) => active.test(line));
  if (index < 0) index = lines.findIndex((line) => sample.test(line));
  const line = `${INSTALL_KEY}=${enabled}`;
  if (index >= 0) {
    lines[index] = line;
  } else {
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push(line, '');
  }
  return lines.join('\n');
}

module.exports = {
  INSTALL_KEY,
  PLUGIN_INSTALL_MESSAGE,
  pluginInstallFromEnv,
  askPluginInstall,
  pluginInstallToWrite,
  applyPluginInstallToEnvText
};
