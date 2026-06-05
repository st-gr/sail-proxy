import { Command } from 'commander';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';
import ora from 'ora';

const execAsync = promisify(exec);

export const updateCommand = new Command('update')
  .description('Check for and install updates')
  .action(async () => {
    await checkAndUpdate();
  });

async function checkAndUpdate(): Promise<void> {
  const spinner = ora('Checking for updates...').start();

  // Read package.json
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')
  );

  try {
    // Check for updates using npm registry
    const response = await axios.get(`https://registry.npmjs.org/${packageJson.name}/latest`);
    const latestVersion = response.data.version;
    const currentVersion = packageJson.version;

    if (latestVersion === currentVersion) {
      spinner.succeed('You are using the latest version');
      console.log(chalk.gray(`Current version: ${currentVersion}`));
      return;
    }

    spinner.stop();

    // Show update information
    console.log(chalk.blue.bold('\nUpdate available!'));
    console.log(chalk.gray('Current version: ') + currentVersion);
    console.log(chalk.green('Latest version: ') + latestVersion);
    console.log('');

    // Ask for confirmation
    const inquirer = await import('inquirer');
    const { confirmUpdate } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirmUpdate',
        message: 'Do you want to update now?',
        default: true
      }
    ]);

    if (!confirmUpdate) {
      console.log(chalk.yellow('\nUpdate cancelled.'));
      return;
    }

    // Perform update
    const updateSpinner = ora('Installing update...').start();

    try {
      const { stdout, stderr } = await execAsync(`npm install -g ${packageJson.name}@latest`);

      if (stderr && !stderr.includes('npm notice')) {
        throw new Error(stderr);
      }

      updateSpinner.succeed('Update installed successfully!');
      console.log(chalk.green(`\n✓ Updated to version ${latestVersion}`));
      console.log(chalk.gray('\nRestart any running services to use the new version.'));

    } catch (error) {
      updateSpinner.fail('Failed to install update');
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      console.log(chalk.gray('\nYou can manually update with:'));
      console.log(chalk.cyan(`  npm install -g ${packageJson.name}@latest`));
      process.exit(1);
    }

  } catch (error) {
    spinner.fail('Failed to check for updates');
    console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
    console.log(chalk.gray('\nYou can manually check for updates with:'));
    console.log(chalk.cyan(`  npm view ${packageJson.name} version`));
    process.exit(1);
  }
}