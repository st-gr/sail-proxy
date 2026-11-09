import { join } from 'path';
import { homedir } from 'os';
import { HarnessAdapter, LaunchContext, LaunchPlan } from './types';
import { resolveBinary } from '../which';

// Any model the gateway lists works on /google: a Gemini model with a deployment is served by it,
// everything else goes through orchestration. gemini-3.5-flash is the default because it is the
// Gemini model most tenants deploy first; pick another with -m.
const MODEL = 'gemini-3.5-flash';

/** True when the caller already chose a model (`-m x`, `--model x`, `--model=x`). */
export function hasModelFlag(argv: string[]): boolean {
  return argv.some(a => a === '-m' || a === '--model' || a.startsWith('--model='));
}

export const geminiAdapter: HarnessAdapter = {
  name: 'gemini',
  async locate() {
    return resolveBinary('gemini', 'Install Gemini CLI: npm i -g @google/gemini-cli (https://geminicli.com).');
  },
  async plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan> {
    // Gemini CLI reads the gateway from GOOGLE_GEMINI_BASE_URL (the @google/genai SDK appends
    // /v1beta/models/<model>:<method>) and the key from GEMINI_API_KEY. The key alone is not
    // enough: without a selected auth type the CLI exits 41 "Invalid auth method selected" even in
    // headless mode (verified with 0.58.0), and no environment variable selects it — so the one
    // setting is written into ~/.gemini/settings.json, backed up first like every launcher edit.
    return {
      fileEdits: [{
        file: join(homedir(), '.gemini', 'settings.json'),
        format: 'json',
        blocks: { 'security.auth.selectedType': JSON.stringify('gemini-api-key') },
      }],
      env: {
        GOOGLE_GEMINI_BASE_URL: `${ctx.rootUrl}/google`,
        GEMINI_API_KEY: ctx.apiKey,
      },
      notes: [
        `Gemini CLI selects the API-key auth type in ~/.gemini/settings.json; switch back in the CLI's /auth dialog if you also use Google login.`,
        `Headless runs (-p) need a trusted folder: pass --skip-trust or trust the directory once in interactive mode.`,
      ],
      argv: hasModelFlag(passthrough) ? [...passthrough] : ['-m', MODEL, ...passthrough],
    };
  },
};
