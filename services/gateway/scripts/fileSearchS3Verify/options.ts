/**
 * Command line and settings of the file_search S3 verification. No gateway imports: bootstrap.ts
 * reads these before any gateway module is loaded.
 *
 * The bucket, region and prefix come from FILE_SEARCH_S3_VERIFY_BUCKET / _REGION / _PREFIX, the keys
 * from the product variables FILE_SEARCH_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY, all read from the env
 * file (the gitignored gateway .env), never from the process environment. None of them is ever
 * printed; the bucket is "the bucket" in every message.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/** The only prefix the verification may write under (the maintainer's bucket is shared). */
export const ALLOWED_PREFIX_ROOT = 'grounding-test';
export const DEFAULT_FILES = 3;
export const MAX_FILES = 10;
const RUN_ID_RE = /^w7-\d{8}T\d{6}Z$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

export interface Options {
  mode: 'plan' | 'execute';
  runId: string;
  /** Whether --run-id was given (a plan without it generates one). */
  runIdGiven: boolean;
  /** --plan-fingerprint: what the approved plan printed; --execute refuses a different plan. */
  planFingerprint: string | null;
  files: number;
  env: string;
}

export interface VerifySettings {
  bucket: string;
  region: string;
  /** The configured verification prefix (grounding-test or below). */
  prefix: string;
  /** `<prefix>/<runId>`: the backend prefix of this run; every key lies under it. */
  runFolder: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const USAGE = `Usage: ts-node scripts/file-search-s3-verify.ts [--plan | --execute] [--run-id w7-YYYYMMDDTHHMMSSZ]
                                               [--files N] [--env <gateway .env>]

  --plan      (default) print the run folder, every key, the requests per operation and the cleanup
              list. Sends nothing.
  --execute   run the verification against the bucket. Requires the --run-id and the
              --plan-fingerprint that the approved plan printed.
  --run-id    the run's folder name under the prefix (default for --plan: w7-<UTC now>).
  --files N   number of test files (default ${DEFAULT_FILES}, at most ${MAX_FILES}).
  --env       env file with FILE_SEARCH_S3_VERIFY_BUCKET/_REGION/_PREFIX and the product keys
              FILE_SEARCH_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY (default: services/gateway/.env).`;

export function runIdFor(now: Date): string {
  return `w7-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

export function parseArgs(argv: string[], now: Date = new Date(), cwd: string = process.cwd()): Options {
  let mode: Options['mode'] | null = null;
  let runId: string | null = null;
  let planFingerprint: string | null = null;
  let files = DEFAULT_FILES;
  let env = path.resolve(__dirname, '..', '..', '.env');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--plan':
      case '--execute': {
        const m = arg === '--plan' ? 'plan' : 'execute';
        if (mode && mode !== m) throw new Error('--plan and --execute exclude each other');
        mode = m;
        break;
      }
      case '--run-id': runId = value(); break;
      case '--plan-fingerprint': planFingerprint = value(); break;
      case '--files': {
        const v = value();
        files = /^\d+$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(files) || files < 1 || files > MAX_FILES) throw new Error(`--files must be 1..${MAX_FILES}`);
        break;
      }
      case '--env': env = path.resolve(cwd, value()); break;
      default: throw new Error(`unknown argument ${arg}`);
    }
  }
  const resolvedMode = mode ?? 'plan';
  if (runId !== null && !RUN_ID_RE.test(runId)) throw new Error('--run-id must look like w7-YYYYMMDDTHHMMSSZ');
  if (resolvedMode === 'execute' && runId === null) {
    throw new Error('--execute needs the --run-id of the approved plan (run --plan first)');
  }
  if (planFingerprint !== null && !/^[0-9a-f]{16}$/.test(planFingerprint)) throw new Error('--plan-fingerprint must be 16 hex digits');
  if (resolvedMode === 'execute' && planFingerprint === null) {
    throw new Error('--execute needs the --plan-fingerprint the approved plan printed (run --plan first)');
  }
  return { mode: resolvedMode, runId: runId ?? runIdFor(now), runIdGiven: runId !== null, planFingerprint, files, env };
}

/**
 * Refuses any prefix that is not `grounding-test` or below it, and any segment the backend would
 * refuse or that could climb out of it. Trailing slashes are dropped (the backend does the same).
 */
export function checkPrefix(raw: string | undefined): string {
  const prefix = (raw ?? '').replace(/\/+$/, '');
  if (prefix !== ALLOWED_PREFIX_ROOT && !prefix.startsWith(`${ALLOWED_PREFIX_ROOT}/`)) {
    throw new Error(`FILE_SEARCH_S3_VERIFY_PREFIX must be "${ALLOWED_PREFIX_ROOT}" or start with "${ALLOWED_PREFIX_ROOT}/"`);
  }
  for (const segment of prefix.split('/')) {
    if (!SEGMENT_RE.test(segment) || segment === '.' || segment === '..') {
      throw new Error('FILE_SEARCH_S3_VERIFY_PREFIX must be path segments of letters, digits, ".", "_" or "-"');
    }
  }
  return prefix;
}

/** The settings from the env file's values. Names what is missing, never a value. */
export function settingsFrom(values: Record<string, string | undefined>, runId: string): VerifySettings {
  const required = ['FILE_SEARCH_S3_VERIFY_BUCKET', 'FILE_SEARCH_S3_VERIFY_REGION', 'FILE_SEARCH_S3_VERIFY_PREFIX',
    'FILE_SEARCH_S3_ACCESS_KEY_ID', 'FILE_SEARCH_S3_SECRET_ACCESS_KEY'];
  const missing = required.filter((k) => !values[k]);
  if (missing.length > 0) throw new Error(`the env file does not set ${missing.join(', ')}`);
  if (!RUN_ID_RE.test(runId)) throw new Error('invalid run id');
  const prefix = checkPrefix(values.FILE_SEARCH_S3_VERIFY_PREFIX);
  return {
    bucket: values.FILE_SEARCH_S3_VERIFY_BUCKET!,
    region: values.FILE_SEARCH_S3_VERIFY_REGION!,
    prefix,
    runFolder: `${prefix}/${runId}`,
    accessKeyId: values.FILE_SEARCH_S3_ACCESS_KEY_ID!,
    secretAccessKey: values.FILE_SEARCH_S3_SECRET_ACCESS_KEY!,
  };
}

export function readSettings(envFile: string, runId: string): VerifySettings {
  if (!fs.existsSync(envFile)) throw new Error(`env file not found: ${envFile}`);
  return settingsFrom(dotenv.parse(fs.readFileSync(envFile)), runId);
}
