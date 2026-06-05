import { Command } from 'commander';
import chalk from 'chalk';
import { runInteractiveConfig, loadAndDisplayConfig } from '../utils/interactive-config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getConfigPath } from '../utils/paths';
import dotenv from 'dotenv';

export const configCommand = new Command('config')
  .description('Manage proxy configuration');

// Show current configuration
configCommand
  .command('show')
  .description('Display current configuration')
  .action(async () => {
    await loadAndDisplayConfig();
    
    console.log(chalk.yellow('\n💡 Tip: For advanced gateway configuration'));
    console.log(chalk.gray('Edit: ') + chalk.cyan(`${getConfigPath('api_config.json')}`));
    console.log(chalk.gray('This file contains model substitutions, plugin hooks, rate limiting, and more.'));
  });

// Edit a specific configuration value
configCommand
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action(async (key: string, value: string) => {
    try {
      const envPath = getConfigPath('.env');
      if (!existsSync(envPath)) {
        console.error(chalk.red('No configuration found. Run "sail-proxy" first.'));
        process.exit(1);
      }
      
      // Read current config
      let envContent = readFileSync(envPath, 'utf-8');
      const envConfig = dotenv.parse(envContent);
      
      // Update the value
      if (key in envConfig) {
        // Replace existing value
        const regex = new RegExp(`^${key}=.*$`, 'm');
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        // Add new value at the end
        envContent += `\n${key}=${value}`;
      }
      
      // Save updated config
      writeFileSync(envPath, envContent);
      console.log(chalk.green(`✓ Updated ${key} = ${value}`));
      
      // Special handling for PORT changes
      if (key === 'PORT') {
        // Update ollama.env with new port
        const ollamaEnvPath = getConfigPath('ollama.env');
        if (existsSync(ollamaEnvPath)) {
          let ollamaContent = readFileSync(ollamaEnvPath, 'utf-8');
          ollamaContent = ollamaContent.replace(
            /MAIN_PROXY_URL=http:\/\/localhost:\d+/,
            `MAIN_PROXY_URL=http://localhost:${value}`
          );
          writeFileSync(ollamaEnvPath, ollamaContent);
          console.log(chalk.green(`✓ Updated Ollama proxy URL to use port ${value}`));
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Error updating configuration:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Get a specific configuration value
configCommand
  .command('get <key>')
  .description('Get a configuration value')
  .action(async (key: string) => {
    try {
      const envPath = getConfigPath('.env');
      if (!existsSync(envPath)) {
        console.error(chalk.red('No configuration found. Run "sail-proxy" first.'));
        process.exit(1);
      }
      
      const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
      
      if (key in envConfig) {
        console.log(envConfig[key]);
      } else {
        console.error(chalk.red(`Configuration key '${key}' not found.`));
        process.exit(1);
      }
      
    } catch (error) {
      console.error(chalk.red('Error reading configuration:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Reset/reconfigure from scratch
configCommand
  .command('reset')
  .description('Reset configuration and run setup again')
  .action(async () => {
    console.log(chalk.yellow('\nThis will reset your entire configuration.\n'));
    await runInteractiveConfig();
  });

// Default action - show current config and available commands
configCommand.action(async () => {
  await loadAndDisplayConfig();
  
  console.log(chalk.blue('\nAvailable commands:'));
  console.log(chalk.gray('  sail-proxy config show              - Display current configuration'));
  console.log(chalk.gray('  sail-proxy config get <key>         - Get a specific value'));
  console.log(chalk.gray('  sail-proxy config set <key> <value> - Set a configuration value'));
  console.log(chalk.gray('  sail-proxy config reset             - Reset and reconfigure from scratch'));
  
  console.log(chalk.yellow('\n⚠️  Advanced Gateway Configuration:'));
  console.log(chalk.gray('The above commands manage basic proxy settings (.env file).'));
  console.log(chalk.gray('For advanced gateway features, edit: ') + chalk.cyan(`${getConfigPath('api_config.json')}`));
  
  console.log(chalk.gray('\n📋 Available in api_config.json:'));
  console.log(chalk.gray('  • Model substitutions - Map client model names to SAP AI Core models'));
  console.log(chalk.gray('  • Streaming emulation - Enable streaming for non-streaming models'));
  console.log(chalk.gray('  • Plugin hooks - Intercept and modify requests/responses'));
  console.log(chalk.gray('  • Logging levels - Fine-tune component-specific logging'));
  console.log(chalk.gray('  • AWS Bedrock response caching - Cache large requests'));
  console.log(chalk.gray('  • Request timeouts - Configure default and streaming timeouts'));
  
  console.log(chalk.gray('\nExample model substitutions:'));
  console.log(chalk.gray('  • "claude-3-5-sonnet-20240229" → "anthropic--claude-3.5-sonnet--deployed"'));
  console.log(chalk.gray('  • "GPT-4" → "o1"'));
  console.log(chalk.gray('  • "us.anthropic.claude-3-7-sonnet-20250219-v1:0" → "anthropic--claude-3.7-sonnet--deployed"'));
  
  console.log(chalk.gray('\nRestart the gateway after editing api_config.json for changes to take effect.'));
});