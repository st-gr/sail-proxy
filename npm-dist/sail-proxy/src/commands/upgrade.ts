import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { UpgradeResult, exitCodeOf, runUpgrade } from '../upgrade/kyma';
import { runRestore } from '../upgrade/kymaRestore';
import { runDockerUpgrade } from '../upgrade/docker';
import { runDockerRestore } from '../upgrade/dockerRestore';

const packageVersion = (): string =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')).version;

/** One question at a time through inquirer (the shape the setup's prompt session asks in). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prompt = async (question: any) => (await inquirer.prompt([{ ...question, name: 'answer' }])).answer;

const upgradeKyma = new Command('kyma')
  .description('Upgrade a Kyma installation to this release, all or nothing (rolls back on any failure)')
  .requiredOption('-n, --namespace <namespace>', 'Kubernetes namespace of the installation')
  .option('--backup-dir <dir>', 'Where the encrypted backup is written (default: <config dir>/backups)')
  .option('--no-encrypt', 'Write the backup unencrypted (it holds API keys in plain text)')
  .option('--registry <registry>', 'Test mode: image registry (with --organization and --tag)')
  .option('--organization <organization>', 'Test mode: image organization')
  .option('--tag <tag>', 'Test mode: image tag (an rc tag is allowed)')
  .option('-y, --yes', 'Do not ask before starting the outage', false)
  .action(async (options) => {
    const images = testImages(options);
    const result = await runUpgrade({
      namespace: options.namespace,
      packageVersion: packageVersion(),
      prompt,
      backupDir: options.backupDir,
      encrypt: options.encrypt,
      yes: options.yes,
      testImages: images,
    });
    report(result);
  });

/** Test mode needs all three image coordinates; exits otherwise. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function testImages(options: any) {
  const test = [options.registry, options.organization, options.tag];
  if (test.some(Boolean) && !test.every(Boolean)) {
    console.error(chalk.red('Test mode needs --registry, --organization and --tag together.'));
    process.exit(1);
  }
  return options.tag ? { registry: options.registry, organization: options.organization, tag: options.tag } : undefined;
}

function report(result: UpgradeResult): never {
  if (result.ok) console.log(chalk.green(`\n✓ ${result.from} → ${result.to}. Backup: ${result.backup}`));
  else if (exitCodeOf(result) === 1) console.error(chalk.red(`\nNot upgraded: ${result.error}`));
  else if (result.rolledBack) {
    console.error(chalk.yellow(`\nUpgrade failed at ${result.failedAt} and was rolled back to ${result.from}.`));
  } else {
    console.error(chalk.red(`\nUpgrade failed at ${result.failedAt} and the rollback failed: ${result.error}`));
    if (result.restoreCommand) console.error(chalk.red(`Restore by hand: ${result.restoreCommand}`));
  }
  process.exit(exitCodeOf(result));
}

const upgradeDocker = new Command('docker')
  .description('Upgrade a Docker installation (the directory setup-docker.js ran in) to this release, all or nothing')
  .option('-d, --dir <dir>', 'The install directory (default: the current directory)')
  .option('--backup-dir <dir>', 'Where the encrypted backup is written (default: <config dir>/backups)')
  .option('--no-encrypt', 'Write the backup unencrypted (it holds API keys in plain text)')
  .option('--registry <registry>', 'Test mode: image registry (with --organization and --tag)')
  .option('--organization <organization>', 'Test mode: image organization')
  .option('--tag <tag>', 'Test mode: image tag (an rc tag is allowed)')
  .option('-y, --yes', 'Do not ask before starting the outage', false)
  .action(async (options) => {
    const images = testImages(options);
    report(await runDockerUpgrade({
      dir: options.dir,
      packageVersion: packageVersion(),
      prompt,
      backupDir: options.backupDir,
      encrypt: options.encrypt,
      yes: options.yes,
      testImages: images,
    }));
  });

export const upgradeCommand = new Command('upgrade')
  .description('Upgrade an installation (Kyma or Docker) to the release this package belongs to')
  .addCommand(upgradeKyma)
  .addCommand(upgradeDocker);

const restoreKyma = new Command('kyma')
  .description('Restore a Kyma installation from a backup written by `upgrade kyma`')
  .requiredOption('-n, --namespace <namespace>', 'Kubernetes namespace of the installation')
  .requiredOption('-i, --input <file>', 'The .spbk backup file')
  .option('--manifests', 'Also put back the previous version\'s Kubernetes objects', false)
  .option('-y, --yes', 'Do not ask before replacing the database', false)
  .action(async (options) => {
    const result = await runRestore({
      namespace: options.namespace, input: options.input, manifests: options.manifests, yes: options.yes, prompt,
    });
    process.exit(result.ok ? 0 : 1);
  });

const restoreDocker = new Command('docker')
  .description('Restore a Docker installation from a backup written by `upgrade docker`')
  .requiredOption('-d, --dir <dir>', 'The install directory')
  .requiredOption('-i, --input <file>', 'The .spbk backup file')
  .option('-y, --yes', 'Do not ask before replacing the database and files', false)
  .action(async (options) => {
    const result = await runDockerRestore({ dir: options.dir, input: options.input, yes: options.yes, prompt });
    process.exit(result.ok ? 0 : 1);
  });

export const restoreCommand = new Command('restore')
  .description('Restore an installation from a backup written by `upgrade`')
  .addCommand(restoreKyma)
  .addCommand(restoreDocker);
