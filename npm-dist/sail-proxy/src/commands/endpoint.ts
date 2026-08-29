import { Command } from 'commander';
import chalk from 'chalk';
import { parseSetArgs, setEndpoint, showEndpoint } from '../launcher/endpoints';

export const endpointCommand = new Command('endpoint').description('Manage the active gateway endpoint');

endpointCommand.command('set <target>')
  .description('Set the active endpoint (target = "local" or a gateway root URL)')
  .option('--key-env <VAR>', 'name of an env var holding the gateway API key (preferred)')
  .option('--key <value>', 'gateway API key stored in the config dir (less secret-safe)')
  .action((target: string, opts: { keyEnv?: string; key?: string }) => {
    const spec = parseSetArgs(target, opts);
    setEndpoint(spec);
    console.log(chalk.green(`Active endpoint set: ${spec.target}${spec.builtin ? ' (bundled gateway)' : ' → ' + spec.rootUrl}`));
  });

endpointCommand.command('show').description('Show the active endpoint')
  .action(() => {
    const s = showEndpoint();
    if (!s) { console.log(chalk.gray('No endpoint set; launches default to "local".')); return; }
    const key = s.builtin ? 'local apikey' : s.keyEnv ? `env:${s.keyEnv}` : 'stored';
    console.log(`${s.target}${s.rootUrl ? '  ' + s.rootUrl : '  (bundled gateway)'}   key: ${key}`);
  });
