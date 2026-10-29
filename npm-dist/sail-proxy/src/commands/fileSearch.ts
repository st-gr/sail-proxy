import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import dotenv from 'dotenv';
import { getConfigPath, getGatewayCwd, getMigrateCliPath } from '../utils/paths';
import { buildGatewayEnv } from '../utils/gateway-env';

/**
 * How `sail-proxy file-search rebuild-index` runs the bundled gateway's migration CLI: the same node binary,
 * entry, cwd and environment (the user's .env, so FILE_SEARCH_DATABASE_URL / FILE_SEARCH_MIGRATION_DATABASE_URL
 * come from where `sail-proxy run` reads them) as the gateway, with the user's arguments passed through.
 */
export function rebuildIndexInvocation(
  args: string[], processEnv: NodeJS.ProcessEnv, envConfig: Record<string, string>,
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    args: [getMigrateCliPath(), 'rebuild-index', ...args],
    cwd: getGatewayCwd(),
    env: buildGatewayEnv(processEnv, envConfig, getConfigPath('api_config.json')),
  };
}

export const fileSearchCommand = new Command('file-search')
  .description('Maintain the file search database');

fileSearchCommand.command('rebuild-index')
  .description('Build the approximate-search index without blocking writes (--dry-run first; --help for options)')
  .helpOption(false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action((_options: unknown, command: Command) => {
    const envPath = getConfigPath('.env');
    const envConfig = existsSync(envPath) ? dotenv.parse(readFileSync(envPath, 'utf-8')) : {};
    const run = rebuildIndexInvocation(command.args, process.env, envConfig);
    if (!existsSync(run.args[0])) {
      console.error(chalk.red(`The gateway's migration CLI was not found at ${run.args[0]}.`));
      process.exit(1);
    }
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: 'inherit' });
    // A terminal's Ctrl-C reaches the child too (same process group): it cancels its build and cleans up, and
    // this process waits for that. A SIGTERM sent to this process alone is passed on.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => { child.kill('SIGTERM'); });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  });
