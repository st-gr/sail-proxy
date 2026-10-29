import { dirname, join } from 'path';

/**
 * The standalone CLI runs the lite gateway: heavy-weight features stay off here, whatever the
 * host has installed. FILE_SEARCH_OCR=off keeps file_search from running OCR (tesseract) on
 * PDF pages without a text layer; those pages stay empty, as without OCR. FILE_SEARCH_VISION=off
 * keeps it from sending PDF page images to a vision model, even for a store that opted in; those
 * pages keep their text. FILE_SEARCH_DOC=off keeps it from converting legacy Word .doc files
 * (antiword); such files fail as not supported on this deployment.
 */
export const LITE_GATEWAY_ENV: Readonly<Record<string, string>> = Object.freeze({
  FILE_SEARCH_OCR: 'off',
  FILE_SEARCH_VISION: 'off',
  FILE_SEARCH_DOC: 'off',
});

/**
 * dotenv's own options, read from the environment by the gateway's `import 'dotenv/config'`.
 * DOTENV_CONFIG_OVERRIDE (any non-empty value counts as true) with DOTENV_CONFIG_PATH would let a
 * .env file overwrite LITE_GATEWAY_ENV inside the gateway, so none of them reaches the child.
 */
const DOTENV_OPTION_PREFIX = 'DOTENV_CONFIG_';

/**
 * The environment the CLI spawns the gateway with: the shell's, then the user's .env, then the
 * CLI's own settings. LITE_GATEWAY_ENV comes last, so neither the shell nor the .env can
 * override it, and dotenv's option variables are removed so the gateway cannot reload over it.
 */
export function buildGatewayEnv(
  processEnv: NodeJS.ProcessEnv,
  envConfig: Record<string, string>,
  configFilePath: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...processEnv,
    ...envConfig,
    CONFIG_FILE_PATH: configFilePath,
    CONNECTIONS_FILE_PATH: join(dirname(configFilePath), 'connections.json'),
    NODE_ENV: 'production',
    ...LITE_GATEWAY_ENV,
  };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith(DOTENV_OPTION_PREFIX)) delete env[name];
  }
  return env;
}
