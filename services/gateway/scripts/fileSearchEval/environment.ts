/**
 * The process environment the gateway modules see during an evaluation run. Applied by bootstrap.ts
 * before any gateway module loads, because configService and the logger read it at load time.
 *
 * - Only SAP AI Core credentials are taken from the env file (AUTH_URL, CLIENT_ID, CLIENT_SECRET and
 *   SAP_*). The Valkey, admin service, database and config URLs are set to '' (every consumer reads
 *   '' as unset), so a run never publishes to, or reads from, a live gateway's infrastructure, even
 *   when a gateway module later loads a .env from the working directory. Values are never printed.
 * - Standalone mode with a generated api_config.json holding only the configuration's file_search
 *   section ({} = the shipped defaults; see fileSearchSectionFor) in a fresh temporary directory.
 * - OCR and vision (W3) are switched by the configuration alone: FILE_SEARCH_OCR and
 *   FILE_SEARCH_VISION are `off` unless it asks for them (then `auto`), whatever the shell or a .env
 *   says, so a configuration measures the same reading on every host.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import type { EvalConfig, Options } from './options';

const CREDENTIAL_KEY = /^(AUTH_URL|CLIENT_ID|CLIENT_SECRET|SAP_[A-Z0-9_]+)$/;
const CLEARED = ['VALKEY_URL', 'ADMIN_SERVICE_URL', 'FILE_SEARCH_DATABASE_URL', 'FILE_SEARCH_MIGRATION_DATABASE_URL',
  'POSTGRES_URL', 'CONFIG_FILE_PATH', 'UNIFIED_TOKEN_SYSTEM_ENABLED'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key] as Record<string, unknown>, value) : value;
  }
  return out;
}

/** The configuration's `file_search` section: `fileSearch` plus what its typed fields stand for
 *  (the context model, the candidates per arm, parent sections on the tool surface). */
export function fileSearchSectionFor(config: EvalConfig): Record<string, unknown> {
  let section: Record<string, unknown> = { ...config.fileSearch };
  if (config.contextual) section = merge(section, { contextual: { model: config.contextual.model } });
  if (config.candidates !== undefined) section = merge(section, { hybrid: { candidates: config.candidates } });
  if (config.parentSections) {
    section = merge(section, { parent_sections: { max_tokens: config.parentSections.maxTokens, scope: 'tool' } });
  }
  if (config.ocr) section = merge(section, { parsing: { ocr: { languages: ['eng'] } } });
  if (config.vision) section = merge(section, { parsing: { vision: { model: config.vision.model, default_mode: 'off' } } });
  return section;
}

export function apiConfigFor(config: EvalConfig): unknown {
  return { api_config: { capabilities: { file_search: fileSearchSectionFor(config) } } };
}

export function prepareEnvironment(
  opts: Pick<Options, 'env' | 'verbose'>, config: EvalConfig,
  env: NodeJS.ProcessEnv = process.env, tmpRoot: string = os.tmpdir(),
): { configFile: string } {
  // Blank, not deleted: modelService and sapAIService run dotenv.config() at load, which fills
  // absent keys from a .env in the working directory but never overwrites one that exists.
  for (const key of CLEARED) env[key] = '';
  if (opts.env) {
    const parsed = dotenv.parse(fs.readFileSync(opts.env));
    for (const [key, value] of Object.entries(parsed)) {
      if (CREDENTIAL_KEY.test(key)) env[key] = value;
    }
  }
  env.FILE_SEARCH_OCR = config.ocr ? 'auto' : 'off';
  env.FILE_SEARCH_VISION = config.vision ? 'auto' : 'off';
  env.GATEWAY_STANDALONE = 'true';
  env.DISABLE_FILE_LOGGING = 'true';
  env.LOG_LEVEL = opts.verbose ? 'debug' : 'warn';
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'fseval-'));
  const configFile = path.join(dir, 'api_config.json');
  fs.writeFileSync(configFile, JSON.stringify(apiConfigFor(config), null, 2));
  env.CONFIG_FILE_PATH = configFile;
  return { configFile };
}
