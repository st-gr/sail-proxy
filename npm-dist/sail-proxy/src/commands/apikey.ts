import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { getConfigPath } from '../utils/paths';
import { addApiKey, removeApiKey } from '../utils/apikey-storage';
import ora from 'ora';

export const apiKeyCommand = new Command('apikey')
  .description('Manage API keys');

// Create API key
apiKeyCommand
  .command('create [name]')
  .description('Create a new API key')
  .action(async (name?: string) => {
    const spinner = ora('Creating API key...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      const createdBy = name || 'sail-proxy-cli';
      
      const response = await axios.post(`${baseUrl}/api/admin/api-keys`, {
        createdBy,
        email: ''
      });
      
      spinner.succeed('API key created successfully');
      console.log(chalk.green('\n✓ New API Key:'));
      console.log(chalk.cyan(`  ${response.data.apiKey}`));
      console.log(chalk.gray(`\n  ID: ${response.data.id}`));
      console.log(chalk.gray(`  Name: ${response.data.createdBy}`));
      console.log(chalk.gray(`  Created At: ${response.data.createdAt}`));
      console.log(chalk.yellow('\n⚠️  Save this API key securely. It cannot be retrieved again.'));
      
      // Save the API key to persistent storage
      try {
        addApiKey(createdBy, response.data.apiKey);
        console.log(chalk.green('\n✓ API key saved to persistent storage'));
      } catch (storageError) {
        console.log(chalk.yellow('\n⚠️  Failed to save API key to persistent storage'));
      }
      
    } catch (error) {
      spinner.fail('Failed to create API key');
      handleApiError(error);
    }
  });

// List API keys
apiKeyCommand
  .command('list')
  .description('List all API keys')
  .action(async () => {
    const spinner = ora('Fetching API keys...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      const response = await axios.get(`${baseUrl}/api/admin/api-keys`);
      
      spinner.stop();
      
      if (response.data.length === 0) {
        console.log(chalk.yellow('No API keys found.'));
        console.log(chalk.gray('Create one with: sail-proxy apikey create'));
        return;
      }
      
      console.log(chalk.blue.bold('\nAPI Keys:'));
      console.log(chalk.blue('=========\n'));
      
      response.data.forEach((key: any) => {
        console.log(chalk.cyan(`ID: ${key.id}`));
        console.log(chalk.gray(`  Key: ${key.key.substring(0, 10)}...`));
        console.log(chalk.gray(`  Name: ${key.createdBy}`));
        console.log(chalk.gray(`  Created At: ${key.createdAt}`));
        console.log(chalk.gray(`  Active: ${key.isActive ? chalk.green('Yes') : chalk.red('No')}`));
        console.log('');
      });
      
    } catch (error) {
      spinner.fail('Failed to fetch API keys');
      handleApiError(error);
    }
  });

// Revoke API key
apiKeyCommand
  .command('revoke <key>')
  .description('Revoke an API key')
  .action(async (key: string) => {
    const spinner = ora('Revoking API key...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      await axios.patch(`${baseUrl}/api/admin/api-keys/${key}/revoke`);
      
      spinner.succeed('API key revoked successfully');
      
      // Remove from persistent storage
      try {
        removeApiKey(key);
        console.log(chalk.green('✓ API key removed from persistent storage'));
      } catch (storageError) {
        console.log(chalk.yellow('⚠️  Failed to remove API key from persistent storage'));
      }
      
    } catch (error) {
      spinner.fail('Failed to revoke API key');
      handleApiError(error);
    }
  });

// Set API key value
apiKeyCommand
  .command('set <id> <key>')
  .description('Set a custom API key value')
  .action(async (id: string, key: string) => {
    const spinner = ora('Setting API key...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      await axios.patch(`${baseUrl}/api/admin/api-keys/${id}`, {
        key,
        isActive: true
      });
      
      spinner.succeed('API key updated successfully');
      console.log(chalk.green(`\n✓ API key ${id} has been set to: ${key}`));
      
    } catch (error) {
      spinner.fail('Failed to set API key');
      handleApiError(error);
    }
  });

// Helper functions
export async function getGatewayUrl(): Promise<string> {
  const envPath = getConfigPath('.env');
  if (!existsSync(envPath)) {
    throw new Error('No configuration found. Run "sail-proxy config" first.');
  }
  
  const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
  const port = envConfig.PORT || '3000';
  
  // Check if server is running
  try {
    await axios.get(`http://localhost:${port}/health`, { timeout: 2000 });
  } catch (error) {
    throw new Error('Gateway server is not running. Start it with "sail-proxy run"');
  }
  
  return `http://localhost:${port}`;
}

export function handleApiError(error: any): void {
  if (error.response) {
    console.error(chalk.red(`\nError: ${error.response.data.message || error.response.statusText}`));
  } else if (error.request) {
    console.error(chalk.red('\nError: No response from server'));
  } else {
    console.error(chalk.red(`\nError: ${error.message}`));
  }
  process.exit(1);
}