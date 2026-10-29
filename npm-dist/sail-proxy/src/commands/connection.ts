import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import inquirer from 'inquirer';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { getGatewayUrl, handleApiError } from './apikey';
import {
  ConnectionEntry, ConnectionsFileError, ConnectionType, SecretValue,
  addConnection, addModel, modelIdOf, readConnections, removeConnection, removeModel, validateConnectionsFile,
} from '../utils/connections-storage';
import { getConfigPath } from '../utils/paths';

/**
 * Connections of the standalone gateway (connections.json). Secrets never come from argv (shell
 * history): `--secret-env NAME` stores an env reference, otherwise a hidden prompt on a TTY or
 * stdin reads the value. Nothing here prints a secret value.
 */
export const connectionCommand = new Command('connection')
  .description('Manage connections to external providers (OpenAI, Azure OpenAI, Anthropic, AWS Bedrock)');

/** CLI flag (commander camelCase) → settings key; which keys a type takes is the storage validator's call. */
const SETTING_FLAGS: Record<string, { key: string; flag: string; help: string }> = {
  baseUrl: { key: 'baseUrl', flag: '--base-url', help: 'openai, anthropic: API base URL' },
  organization: { key: 'organization', flag: '--organization', help: 'openai' },
  project: { key: 'project', flag: '--project', help: 'openai' },
  endpoint: { key: 'endpoint', flag: '--endpoint', help: 'azure-openai: resource endpoint' },
  apiMode: { key: 'apiMode', flag: '--api-mode', help: 'azure-openai: v1 or deployments' },
  apiVersion: { key: 'apiVersion', flag: '--api-version', help: 'azure-openai' },
  authMode: { key: 'authMode', flag: '--auth-mode', help: 'azure-openai: api-key or entra-client-secret; bedrock: access-key or bearer' },
  tenantId: { key: 'tenantId', flag: '--tenant-id', help: 'azure-openai (entra-client-secret)' },
  clientId: { key: 'clientId', flag: '--client-id', help: 'azure-openai (entra-client-secret)' },
  anthropicVersion: { key: 'anthropicVersion', flag: '--anthropic-version', help: 'anthropic' },
  region: { key: 'region', flag: '--region', help: 'bedrock' },
  accessKeyId: { key: 'accessKeyId', flag: '--access-key-id', help: 'bedrock (access-key)' },
  runtimeEndpoint: { key: 'runtimeEndpoint', flag: '--runtime-endpoint', help: 'bedrock: custom runtime endpoint' },
};
const TYPES: ConnectionType[] = ['openai', 'azure-openai', 'anthropic', 'bedrock'];

function fail(message: string): never {
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

/**
 * A storage error as a message. A refusal inside `added` (the entry `connection add` builds) is
 * named by its flag; any other (a hand-edited entry of the file) keeps its path.
 */
function explain(error: unknown, added?: { at: string; type: string }): string {
  if (error instanceof ConnectionsFileError && added && error.path.startsWith(`${added.at}.`)) {
    const rest = error.path.slice(added.at.length + 1);
    const setting = rest.startsWith('settings.') ? rest.slice('settings.'.length) : null;
    const flag = setting && Object.values(SETTING_FLAGS).find((s) => s.key === setting)?.flag;
    if (flag && error.code === 'unknown_setting') return `${flag} does not apply to type ${added.type}`;
    if (flag) return `${flag} ${error.reason}`;
    if (rest === 'sessionToken') return `--session-token-env ${error.reason}`;
    // The refused value is never echoed: it may be a key pasted in place of a variable name.
    const envFlag = rest === 'secret.env' ? '--secret-env' : rest === 'sessionToken.env' ? '--session-token-env' : null;
    if (envFlag) return `${envFlag} must name an environment variable ([A-Za-z_][A-Za-z0-9_]*), not hold the secret`;
    if (rest === 'name') return `name ${error.reason}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readSecret(label: string): Promise<string> {
  if (process.stdin.isTTY) {
    const { value } = await inquirer.prompt([{ type: 'password', name: 'value', message: `${label}:`, mask: '*' }]);
    return String(value ?? '').trim();
  }
  console.error('Reading the secret from standard input…');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** A gateway refusal names its reason code (connection_not_found, no_credential, …). */
function gatewayError(name: string, error: any): never {
  const data = error?.response?.data;
  if (data?.error && typeof data.error === 'string') fail(`${name}: ${data.message ?? data.error}`);
  handleApiError(error);
  process.exit(1);
}

/** Whether the gateway would see NAME: set in this shell or in the config dir's .env. */
function envVarKnown(name: string): boolean {
  if (process.env[name]) return true;
  const envPath = getConfigPath('.env');
  return existsSync(envPath) && !!dotenv.parse(readFileSync(envPath, 'utf-8'))[name];
}

const secretKind = (secret: SecretValue | undefined): string =>
  secret === undefined ? 'none' : typeof secret === 'string' ? 'stored' : `env:${secret.env}`;

/**
 * Tells a running gateway to reread the file; a gateway that is down reads it on start, so that
 * case stays silent. A gateway that answers but does not reload is reported: the change is not live yet.
 */
async function reloadGateway(): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = await getGatewayUrl();
  } catch {
    return; // not running (or no config yet): nothing to reload
  }
  try {
    const { data } = await axios.post(`${baseUrl}/api/admin/connections/reload`, {}, { timeout: 10000 });
    console.log(chalk.gray(`Gateway reloaded: ${data.connections} connection(s), ${data.models} model(s)`));
  } catch (error: any) {
    const why = error?.response ? `status ${error.response.status}` : error?.code === 'ECONNABORTED' ? 'timed out' : 'no answer';
    console.log(chalk.gray(`Gateway did not reload (${why}); it picks the change up within 60 s`));
  }
}

function printModelIds(name: string): void {
  const conn = readConnections().connections.find((c) => c.name === name);
  const ids = (conn?.models ?? []).map((m) => modelIdOf(m.upstreamModel, name));
  if (ids.length === 0) {
    console.log(chalk.gray(`No models yet. Add one with: sail-proxy connection model add ${name} <upstreamModel>`));
    return;
  }
  console.log(chalk.green('Model ids to use:'));
  ids.forEach((id) => console.log(`  ${id}`));
}

const add = connectionCommand
  .command('add <name>')
  .description('Add a connection; the secret comes from --secret-env, a hidden prompt, or stdin')
  .requiredOption('--type <type>', `provider type: ${TYPES.join(', ')}`)
  .option('--secret-env <NAME>', 'read the secret from this environment variable of the gateway')
  .option('--session-token-env <NAME>', 'bedrock (access-key): read a session token from this environment variable')
  .option('--inactive', 'add the connection switched off');
for (const { flag, help } of Object.values(SETTING_FLAGS)) add.option(`${flag} <value>`, help);
add.action(async (name: string, opts: Record<string, any>) => {
  if (!TYPES.includes(opts.type)) fail(`--type must be one of ${TYPES.join(', ')}`);
  const settings: Record<string, string> = {};
  for (const [option, { key }] of Object.entries(SETTING_FLAGS)) {
    if (opts[option] !== undefined) settings[key] = opts[option];
  }
  let added: { at: string; type: string } | undefined;
  try {
    const entry: ConnectionEntry = {
      name, type: opts.type, active: !opts.inactive,
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(opts.secretEnv ? { secret: { env: opts.secretEnv } } : {}),
      ...(opts.sessionTokenEnv ? { sessionToken: { env: opts.sessionTokenEnv } } : {}),
    };
    // Refuse a malformed file, a taken or invalid name and a misplaced flag before asking for a secret.
    const file = readConnections();
    added = { at: `connections[${file.connections.length}]`, type: opts.type };
    if (file.connections.some((c) => c.name === name)) fail(`Connection "${name}" already exists`);
    validateConnectionsFile({ ...file, connections: [...file.connections, entry] });
    const secret: SecretValue = entry.secret ?? await readSecret(`Secret for ${name}`);
    if (!secret) fail('no secret given (use --secret-env NAME, the prompt, or stdin)');
    addConnection({ ...entry, secret });
  } catch (error) {
    fail(explain(error, added));
  }
  console.log(chalk.green(`✓ Connection ${name} added`));
  for (const ref of [opts.secretEnv, opts.sessionTokenEnv]) {
    if (ref && !envVarKnown(ref)) console.log(chalk.gray(`${ref} is not set here or in ${getConfigPath('.env')}; set it, then restart the gateway`));
  }
  printModelIds(name);
  await reloadGateway();
});

connectionCommand
  .command('list')
  .description('List connections, their secret kind and model ids (never a secret value)')
  .action(() => {
    let connections: ConnectionEntry[] = [];
    try { connections = readConnections().connections; } catch (error) { fail(explain(error)); }
    if (connections.length === 0) {
      console.log(chalk.yellow('No connections.'));
      console.log(chalk.gray('Add one with: sail-proxy connection add <name> --type <type>'));
      return;
    }
    for (const c of connections) {
      console.log(chalk.cyan(c.name) + chalk.gray(`  ${c.type}  ${c.active === false ? 'inactive' : 'active'}  secret: ${secretKind(c.secret)}`)
        + (c.sessionToken ? chalk.gray(`  session token: ${secretKind(c.sessionToken)}`) : ''));
      for (const m of c.models ?? []) console.log(`  ${modelIdOf(m.upstreamModel, c.name)}`);
    }
  });

connectionCommand
  .command('remove <name>')
  .description('Remove a connection and its models')
  .action(async (name: string) => {
    let withdrawn: string[] = [];
    try { withdrawn = removeConnection(name); } catch (error) { fail(explain(error)); }
    console.log(chalk.green(`✓ Connection ${name} removed`));
    if (withdrawn.length) {
      console.log(chalk.gray('Model ids withdrawn:'));
      withdrawn.forEach((id) => console.log(`  ${id}`));
    }
    await reloadGateway();
  });

const model = connectionCommand.command('model').description('Manage the models a connection publishes');

model
  .command('add <name> <upstreamModel>')
  .description('Publish an upstream model as <upstreamModel>--<name>')
  .option('--family <family>', 'openai or claude (default: claude for anthropic/bedrock, openai otherwise)')
  .option('--display-name <text>', 'display name')
  .option('--capabilities <list>', 'comma-separated capabilities, e.g. chat,streaming')
  .action(async (name: string, upstreamModel: string, opts: Record<string, string | undefined>) => {
    try {
      addModel(name, {
        upstreamModel,
        ...(opts.family ? { family: opts.family as 'openai' | 'claude' } : {}),
        ...(opts.displayName ? { displayName: opts.displayName } : {}),
        ...(opts.capabilities ? { capabilities: opts.capabilities.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      });
    } catch (error) {
      fail(explain(error));
    }
    console.log(chalk.green(`✓ Model ${upstreamModel} added to ${name}`));
    printModelIds(name);
    await reloadGateway();
  });

model
  .command('remove <name> <upstreamModel>')
  .description('Withdraw an upstream model from a connection')
  .action(async (name: string, upstreamModel: string) => {
    try { removeModel(name, upstreamModel); } catch (error) { fail(explain(error)); }
    console.log(chalk.green(`✓ Model ${upstreamModel} removed from ${name}`));
    printModelIds(name);
    await reloadGateway();
  });

connectionCommand
  .command('test <name>')
  .description('Test a connection through the running gateway')
  .action(async (name: string) => {
    try {
      const baseUrl = await getGatewayUrl();
      const { data } = await axios.post(`${baseUrl}/api/admin/connections/${encodeURIComponent(name)}/test`, {}, { timeout: 60000 });
      if (data.ok) {
        console.log(chalk.green(`✓ ${name}: ok`));
        return;
      }
      fail(`${name}: ${data.error?.reason ?? 'failed'}${data.error?.status ? ` (status ${data.error.status})` : ''}`);
    } catch (error) {
      gatewayError(name, error);
    }
  });

connectionCommand
  .command('models <name>')
  .description('List the models the provider offers on a connection (through the running gateway)')
  .action(async (name: string) => {
    try {
      const baseUrl = await getGatewayUrl();
      const { data } = await axios.get(`${baseUrl}/api/admin/connections/${encodeURIComponent(name)}/models`, { timeout: 60000 });
      const models: string[] = data.models ?? [];
      if (models.length === 0) console.log(chalk.yellow('The provider lists no models.'));
      models.forEach((m) => console.log(m));
    } catch (error) {
      gatewayError(name, error);
    }
  });
