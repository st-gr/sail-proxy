import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';

// Import commands
import { configCommand } from './commands/config';
import { serverCommand, stopCommand, statusCommand } from './commands/server';
import { apiKeyCommand } from './commands/apikey';
import { awsCredCommand } from './commands/awscred';
import { modelsCommand } from './commands/models';
import { ollamaCommand } from './commands/ollama';
import { updateCommand } from './commands/update';
import { logsCommand } from './commands/logs';

// Utils
import { getConfigDir, ensureConfigDir, isFirstRun } from './utils/paths';
import { runInteractiveConfig } from './utils/interactive-config';

// Read package.json for version
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

// Create the main program
const program = new Command();

program
  .name('sail-proxy')
  .description('SAP AI Core Local LLM Proxy - A command-line tool to run a local proxy for SAP AI Core Foundation Models')
  .version(packageJson.version);

// Add subcommands
program.addCommand(configCommand);
program.addCommand(serverCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);
program.addCommand(apiKeyCommand);
program.addCommand(awsCredCommand);
program.addCommand(modelsCommand);
program.addCommand(ollamaCommand);
program.addCommand(updateCommand);
program.addCommand(logsCommand);

// Default action when no command is specified
program.action(async () => {
  try {
    ensureConfigDir();
    
    if (isFirstRun()) {
      console.log(chalk.blue.bold('\nWelcome to SAP AI Core Local LLM Proxy!'));
      console.log(chalk.gray('No configuration found. Let\'s set up your proxy.\n'));
      
      await runInteractiveConfig();
      
      console.log(chalk.green('\n✓ Configuration complete!'));
      console.log(chalk.gray('\nQuick start:'));
      console.log(chalk.gray('  - Start the proxy: ') + chalk.cyan('sail-proxy run'));
      console.log(chalk.gray('  - Create an API key: ') + chalk.cyan('sail-proxy apikey create "my-app"'));
      console.log(chalk.gray('  - List models: ') + chalk.cyan('sail-proxy models list'));
      console.log(chalk.gray('  - View help: ') + chalk.cyan('sail-proxy --help'));
    } else {
      // If already configured, start the server
      console.log(chalk.blue('Starting SAP AI Core Local LLM Proxy...'));
      const { runServer } = await import('./commands/server');
      await runServer();
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});

// Parse command line arguments
program.parse(process.argv);