import { dirname, join } from 'path';

/**
 * The standalone CLI runs the lite gateway: heavy-weight features stay off here, whatever the
 * host has installed. FILE_SEARCH_OCR=off keeps file_search from running OCR (tesseract) on
 * PDF pages without a text layer; those pages stay empty, as without OCR. FILE_SEARCH_VISION=off
 * keeps it from sending PDF page images to a vision model, even for a store that opted in; those
 * pages keep their text. FILE_SEARCH_DOC=off keeps it from converting legacy Word .doc files
 * (antiword); such files fail as not supported on this deployment. GATEWAY_LOG_SHIPPING=off keeps
 * the log out of Valkey (there is no admin service to store it).
 */
export const LITE_GATEWAY_ENV: Readonly<Record<string, string>> = Object.freeze({
  FILE_SEARCH_OCR: 'off',
  FILE_SEARCH_VISION: 'off',
  FILE_SEARCH_DOC: 'off',
  GATEWAY_LOG_SHIPPING: 'off',
});

/**
 * Defaults the user's own value overrides (shell or .env): the CLI does not delete payload log
 * files unless you set a limit (PAYLOAD_LOG_RETENTION_HOURS, PAYLOAD_LOG_MAX_MB), as before. Only a
 * non-negative number counts: the gateway reads an empty value or a typo as its own defaults
 * (48 hours, 1,024 MB), which would start deleting.
 */
export const LITE_GATEWAY_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  PAYLOAD_LOG_RETENTION_HOURS: '0',
  PAYLOAD_LOG_MAX_MB: '0',
});

/**
 * dotenv's own options, read from the environment by the gateway's `import 'dotenv/config'`.
 * DOTENV_CONFIG_OVERRIDE (any non-empty value counts as true) with DOTENV_CONFIG_PATH would let a
 * .env file overwrite LITE_GATEWAY_ENV inside the gateway, so none of them reaches the child.
 */
const DOTENV_OPTION_PREFIX = 'DOTENV_CONFIG_';

const isNonNegativeNumber = (value: string | undefined): boolean =>
  value !== undefined && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;

/**
 * The environment the CLI spawns the gateway with: LITE_GATEWAY_DEFAULTS, then the shell's, then the
 * user's .env, then the CLI's own settings. LITE_GATEWAY_ENV comes last, so neither the shell nor the .env can
 * override it, and dotenv's option variables are removed so the gateway cannot reload over it.
 */
export function buildGatewayEnv(
  processEnv: NodeJS.ProcessEnv,
  envConfig: Record<string, string>,
  configFilePath: string
): NodeJS.ProcessEnv {
  // Payload files (PAYLOAD_LOGGING_ENABLED) go next to logs/gateway.log in the data folder, which
  // upgrades keep; the gateway's own fallback would be a folder inside the installed package.
  const payloadDir = join(dirname(configFilePath), 'logs', 'payloads');
  const env: NodeJS.ProcessEnv = {
    PAYLOAD_LOG_DIR: payloadDir,
    ...LITE_GATEWAY_DEFAULTS,
    ...processEnv,
    ...envConfig,
    CONFIG_FILE_PATH: configFilePath,
    CONNECTIONS_FILE_PATH: join(dirname(configFilePath), 'connections.json'),
    PLUGINS_SOURCE_DIR: join(dirname(configFilePath), 'plugins'),
    NODE_ENV: 'production',
    ...LITE_GATEWAY_ENV,
  };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith(DOTENV_OPTION_PREFIX)) delete env[name];
  }
  for (const [name, fallback] of Object.entries(LITE_GATEWAY_DEFAULTS)) {
    if (!isNonNegativeNumber(env[name])) env[name] = fallback;
  }
  if (!env.PAYLOAD_LOG_DIR?.trim()) env.PAYLOAD_LOG_DIR = payloadDir;
  return env;
}
