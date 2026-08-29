import { spawn } from 'child_process';
import axios from 'axios';
import chalk from 'chalk';
import { resolveEndpoint } from '../launcher/endpoints';
import { applyEdit, diffEdit } from '../launcher/config-writer';
import { HarnessAdapter, LaunchContext } from '../launcher/adapters/types';
import { codexAdapter } from '../launcher/adapters/codex';
import { claudeAdapter } from '../launcher/adapters/claude';
import { opencodeAdapter } from '../launcher/adapters/opencode';

export const ADAPTERS: Record<string, HarnessAdapter> = { codex: codexAdapter, claude: claudeAdapter, opencode: opencodeAdapter };

/** For a local endpoint, make sure the bundled gateway answers /health; start it if not. */
async function ensureLocalRunning(rootUrl: string): Promise<void> {
  const health = `${rootUrl}/health`;
  const up = async () => { try { await axios.get(health, { timeout: 1000 }); return true; } catch { return false; } };
  if (await up()) return;                       // reuse an already-running gateway (e.g. a dev instance)
  console.log(chalk.gray('local gateway not responding; starting it…'));
  // Start the gateway via a detached CLI subprocess ("sail-proxy run"), not in-process:
  // runServer() (in server.ts) calls process.exit(0) after spawning the detached gateway,
  // which would kill this launcher process if invoked in-process. Running it as a child
  // means the CHILD is the one that exits after spawning the detached gateway, and the
  // detached gateway survives independently of both the child and this launcher.
  await new Promise<void>((resolve) => {
    const starter = spawn(process.execPath, [process.argv[1], 'run'], { stdio: 'inherit' });
    starter.on('exit', () => resolve());
    starter.on('error', () => resolve());
  });
  for (let i = 0; i < 30; i++) { if (await up()) return; await new Promise(r => setTimeout(r, 500)); }
  throw new Error(`Local gateway did not become ready at ${health}. Start it manually with: sail-proxy run`);
}

export async function runLauncher(harness: string, passthrough: string[],
  opts: { noWebSearch?: boolean; dryRun?: boolean }): Promise<number> {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`Unknown harness "${harness}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  const { rootUrl, resolveKey, isLocal } = resolveEndpoint();
  const ctx: LaunchContext = { rootUrl, apiKey: resolveKey(), webSearch: harness === 'codex' && !opts.noWebSearch, dryRun: !!opts.dryRun };
  const plan = await adapter.plan(ctx, passthrough);

  if (opts.dryRun) {
    // Preview only: never resolves the binary, never touches config, never starts the gateway.
    for (const edit of plan.fileEdits) {
      let d = diffEdit(edit);
      if (ctx.apiKey) d = d.split(ctx.apiKey).join('sk-***REDACTED***');
      console.log(chalk.gray(d));
    }
    plan.notes.forEach(n => console.log(chalk.yellow('note: ') + n));
    console.log(chalk.gray(`would exec: ${adapter.name} ${plan.argv.join(' ')}`));
    return 0;
  }

  // Real launch: resolve the binary FIRST so a missing harness fails before any config is touched.
  const cmd = await adapter.locate();
  for (const edit of plan.fileEdits) {
    const { backupPath } = applyEdit(edit);
    if (backupPath) console.log(chalk.gray(`backed up ${edit.file} → ${backupPath}`));
  }
  plan.notes.forEach(n => console.log(chalk.yellow('note: ') + n));
  if (isLocal) await ensureLocalRunning(rootUrl);
  return await new Promise<number>((resolve) => {
    const child = spawn(cmd, plan.argv, { stdio: 'inherit', env: { ...process.env, ...plan.env } });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (e) => { console.error(chalk.red(`Failed to launch ${cmd}: ${e.message}`)); resolve(127); });
  });
}
