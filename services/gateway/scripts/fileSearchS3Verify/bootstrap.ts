/**
 * The first import of file-search-s3-verify.ts. Parses the command line, reads and checks the
 * settings (the prefix refusal happens here), then:
 * - --plan: prints the plan and exits before any gateway module is loaded, so nothing is sent;
 * - --execute: prepares the environment the gateway modules read at load time (environment.ts).
 * Values are never printed; the bucket is "the bucket".
 */
import { Options, parseArgs, readSettings, USAGE, VerifySettings } from './options';
import { buildPlan, formatPlan, Plan, planFingerprint } from './plan';
import { executeCommand, prepareEnvironment } from './environment';

function fail(message: string, code: number): never {
  console.error(`[file-search-s3-verify] ${message}`);
  process.exit(code);
}

let options: Options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error: any) {
  fail(`${error.message}\n\n${USAGE}`, 2);
}

let settings: VerifySettings;
try {
  settings = readSettings(options.env, options.runId);
} catch (error: any) {
  fail(`refused: ${error.message}`, 2);
}

const plan: Plan = buildPlan(options.runId, settings.runFolder, options.files);
const fingerprint = planFingerprint(plan, settings);

if (options.mode === 'plan') {
  console.log(formatPlan(plan, { execute: executeCommand(options, fingerprint), fingerprint }));
  process.exit(0);
}

if (options.planFingerprint !== fingerprint) {
  fail('refused: --plan-fingerprint does not match the plan this run would execute (another bucket, region, '
    + 'run id, file count or prefix?); run --plan again and review it', 2);
}

const prepared = prepareEnvironment(settings);

export { options, settings, plan, prepared };
