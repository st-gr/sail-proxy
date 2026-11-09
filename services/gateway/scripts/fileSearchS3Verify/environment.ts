/**
 * The process environment the gateway modules see during --execute, prepared by bootstrap.ts before
 * any of them loads: standalone mode; the Valkey, admin, database and config URLs blanked (every
 * consumer reads '' as unset, and a module's dotenv.config() never overwrites a key that exists), so
 * the run never reaches a live gateway's infrastructure or the dev database; the product S3 keys from
 * the env file; and a generated api_config.json in a fresh temporary directory whose blob_storage
 * points at the run folder. Pure apart from the temporary file; never prints a value.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Options, VerifySettings } from './options';

const CLEARED = ['VALKEY_URL', 'ADMIN_SERVICE_URL', 'FILE_SEARCH_DATABASE_URL', 'FILE_SEARCH_MIGRATION_DATABASE_URL',
  'POSTGRES_URL', 'CONFIG_FILE_PATH', 'UNIFIED_TOKEN_SYSTEM_ENABLED'];

export function blobStorageConfig(settings: VerifySettings, backend: 'db' | 's3'): Record<string, unknown> {
  return {
    backend,
    s3: { bucket: settings.bucket, prefix: settings.runFolder, endpoint: '', region: settings.region },
  };
}

export function apiConfigFor(settings: VerifySettings, backend: 'db' | 's3'): unknown {
  return { api_config: { capabilities: { file_search: { blob_storage: blobStorageConfig(settings, backend) } } } };
}

/** The command line that runs exactly the plan just printed. */
export function executeCommand(opts: Pick<Options, 'runId' | 'files' | 'env'>, fingerprint: string): string {
  return 'cd services/gateway && npx ts-node -r tsconfig-paths/register --transpile-only '
    + `scripts/file-search-s3-verify.ts --execute --run-id ${opts.runId} --plan-fingerprint ${fingerprint} `
    + `--files ${opts.files} --env ${opts.env}`;
}

export function prepareEnvironment(
  settings: VerifySettings, env: NodeJS.ProcessEnv = process.env, tmpRoot: string = os.tmpdir(),
): { configFile: string; configDir: string } {
  for (const key of CLEARED) env[key] = '';
  env.FILE_SEARCH_S3_ACCESS_KEY_ID = settings.accessKeyId;
  env.FILE_SEARCH_S3_SECRET_ACCESS_KEY = settings.secretAccessKey;
  env.GATEWAY_STANDALONE = 'true';
  env.DISABLE_FILE_LOGGING = 'true';
  env.LOG_LEVEL = 'warn';
  const configDir = fs.mkdtempSync(path.join(tmpRoot, 'fs-s3verify-'));
  const configFile = path.join(configDir, 'api_config.json');
  fs.writeFileSync(configFile, JSON.stringify(apiConfigFor(settings, 's3'), null, 2), { mode: 0o600 });
  env.CONFIG_FILE_PATH = configFile;
  return { configFile, configDir };
}
