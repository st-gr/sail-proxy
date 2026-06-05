import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import { getGatewayUrl, handleApiError } from './apikey';
import ora from 'ora';
import { existsSync, readFileSync } from 'fs';
import { getConfigPath } from '../utils/paths';
import dotenv from 'dotenv';
import { addAwsCredential, removeAwsCredential } from '../utils/aws-credentials-storage';

export const awsCredCommand = new Command('awscred')
  .description('Manage AWS credentials for Bedrock emulation');

// Create AWS credentials
awsCredCommand
  .command('create <userId>')
  .description('Create AWS credentials for Bedrock emulation')
  .action(async (userId: string) => {
    const spinner = ora('Creating AWS credentials...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      const response = await axios.post(`${baseUrl}/aws/api-keys`, {
        userId
      });
      
      spinner.succeed('AWS credentials created successfully');
      console.log(chalk.green('\n✓ New AWS Credentials:'));
      console.log(chalk.cyan(`  AWS_ACCESS_KEY_ID: ${response.data.AWS_ACCESS_KEY_ID}`));
      console.log(chalk.cyan(`  AWS_SECRET_ACCESS_KEY: ${response.data.AWS_SECRET_ACCESS_KEY}`));
      console.log(chalk.gray(`\n  User ID: ${userId}`));
      console.log(chalk.yellow('\n⚠️  Save these credentials securely. The secret key cannot be retrieved again.'));
      console.log(chalk.gray('\nUsage example:'));
      console.log(chalk.gray('  export AWS_ACCESS_KEY_ID=' + response.data.AWS_ACCESS_KEY_ID));
      console.log(chalk.gray('  export AWS_SECRET_ACCESS_KEY=' + response.data.AWS_SECRET_ACCESS_KEY));
      const port = await getPort();
      console.log(chalk.gray('  export ANTHROPIC_BEDROCK_BASE_URL=http://localhost:' + port + '/aws-bedrock'));

      // Save credentials to storage for automatic restoration
      try {
        addAwsCredential(
          userId,  // Use userId as name
          response.data.AWS_ACCESS_KEY_ID,
          response.data.AWS_SECRET_ACCESS_KEY,
          {
            userId,
            region: response.data.AWS_REGION,
            createdAt: new Date().toISOString()
          }
        );
        console.log(chalk.green('\n✓ Credentials saved for automatic restoration'));
        console.log(chalk.gray('  Location: ~/.sail-proxy/aws-credentials.json'));
      } catch (storageError) {
        console.log(chalk.yellow('\n⚠️  Warning: Failed to save credentials to storage'));
        // Don't fail the command, just warn
      }

    } catch (error) {
      spinner.fail('Failed to create AWS credentials');
      handleApiError(error);
    }
  });

// List AWS credentials
awsCredCommand
  .command('list')
  .description('List all AWS access keys')
  .action(async () => {
    const spinner = ora('Fetching AWS credentials...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      const response = await axios.get(`${baseUrl}/aws/api-keys`);
      
      spinner.stop();
      
      const credentials = response.data.credentials || [];
      
      if (credentials.length === 0) {
        console.log(chalk.yellow('No AWS credentials found.'));
        console.log(chalk.gray('Create one with: sail-proxy awscred create <userId>'));
        return;
      }
      
      console.log(chalk.blue.bold('\nAWS Credentials:'));
      console.log(chalk.blue('================\n'));
      
      // Also show the AWS region info if available
      if (response.data.aws_region) {
        console.log(chalk.gray(`Default AWS Region: ${response.data.aws_region}`));
        console.log(chalk.gray(`SAP AI Region: ${response.data.sap_ai_region}`));
        console.log('');
      }
      
      credentials.forEach((cred: any) => {
        console.log(chalk.cyan(`Access Key ID: ${cred.accessKeyId}`));
        console.log(chalk.gray(`  User ID: ${cred.userId}`));
        console.log(chalk.gray(`  Created At: ${cred.createdAt}`));
        console.log(chalk.gray(`  Active: ${cred.isActive ? chalk.green('Yes') : chalk.red('No')}`));
        console.log('');
      });
      
    } catch (error) {
      spinner.fail('Failed to fetch AWS credentials');
      handleApiError(error);
    }
  });

// Revoke AWS credentials
awsCredCommand
  .command('revoke <accessKeyId>')
  .description('Revoke AWS credentials')
  .action(async (accessKeyId: string) => {
    const spinner = ora('Revoking AWS credentials...').start();

    try {
      const baseUrl = await getGatewayUrl();
      await axios.delete(`${baseUrl}/aws/api-keys/${accessKeyId}`);

      spinner.succeed('AWS credentials revoked successfully');

      // Remove from storage
      try {
        removeAwsCredential(accessKeyId);
        console.log(chalk.green('✓ Credentials removed from storage'));
      } catch (storageError) {
        console.log(chalk.yellow('⚠️  Warning: Failed to remove credentials from storage'));
      }

    } catch (error) {
      spinner.fail('Failed to revoke AWS credentials');
      handleApiError(error);
    }
  });

// Helper function to get configured port
async function getPort(): Promise<string> {
  const envPath = getConfigPath('.env');
  if (existsSync(envPath)) {
    const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
    return envConfig.PORT || '3000';
  }
  return '3000';
}

// Re-export helper functions for use in other commands
export { getGatewayUrl, handleApiError };