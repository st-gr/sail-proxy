import { Command } from 'commander';
import chalk from 'chalk';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'fs';
import { getPidPath, getConfigPath, getGatewayPath, getGatewayCwd, getLogPath, ensureLogDir } from '../utils/paths';
import { createLogStream, formatLogLine, rotateLogsIfNeeded } from '../utils/log-manager';
import { getStoredApiKeys } from '../utils/apikey-storage';
import { getStoredAwsCredentials } from '../utils/aws-credentials-storage';
import axios from 'axios';
import ora from 'ora';
import dotenv from 'dotenv';

let gatewayProcess: ChildProcess | null = null;

export const serverCommand = new Command('run')
  .description('Start the gateway server')
  .action(async () => {
    await runServer();
  });

// Add aliases for better UX
const stopCommand = new Command('stop')
  .description('Stop the gateway server')
  .action(async () => {
    await stopServer();
  });

const statusCommand = new Command('status')
  .description('Show server status')
  .action(async () => {
    await checkStatus();
  });

// Export function for use in index.ts
export async function runServer(): Promise<void> {
  const spinner = ora('Starting gateway server...').start();
  
  try {
    // Check if already running
    const pid = getStoredPid('gateway');
    if (pid && isProcessRunning(pid)) {
      spinner.fail('Gateway server is already running');
      console.log(chalk.gray(`PID: ${pid}`));
      console.log(chalk.gray('Use "sail-proxy stop" to stop the server'));
      return;
    }
    
    // Load environment variables
    const envPath = getConfigPath('.env');
    if (!existsSync(envPath)) {
      spinner.fail('No configuration found. Run "sail-proxy config" first.');
      return;
    }
    
    const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
    const port = envConfig.PORT || '3000';
    
    // Resolve gateway entry/cwd against the actual layout (bundled or dev).
    const gatewayPath = getGatewayPath();
    const gatewayCwd = getGatewayCwd();
    
    // Configure stdio based on debug mode
    let stdio: any;
    if (envConfig.DEBUG === 'true') {
      stdio = 'inherit';
    } else {
      // For background mode, redirect output to log files
      ensureLogDir();
      rotateLogsIfNeeded('gateway');
      const logFile = openSync(getLogPath('gateway.log'), 'a');
      const errFile = logFile; // Use same file for both stdout and stderr
      stdio = ['ignore', logFile, errFile];
    }
    
    gatewayProcess = spawn('node', [gatewayPath], {
      cwd: gatewayCwd,
      env: {
        ...process.env,
        ...envConfig,
        CONFIG_FILE_PATH: getConfigPath('api_config.json'),
        NODE_ENV: 'production',
      },
      detached: true,
      stdio: stdio
    });
    
    // Store PID
    if (gatewayProcess.pid) {
      storePid('gateway', gatewayProcess.pid);
      gatewayProcess.unref();
    }
    
    // Wait for server to be ready
    await waitForServer(port);
    
    spinner.succeed(`Gateway server started on http://localhost:${port}`);
    console.log(chalk.gray(`PID: ${gatewayProcess.pid}`));
    
    if (envConfig.DEBUG !== 'true') {
      console.log(chalk.gray('Logs: ') + 'Use "sail-proxy logs gateway" to view logs');
    }
    
    // Display API routes
    displayApiRoutes(port);
    
    // Restore saved API keys
    await restoreApiKeys(port);

    // Restore saved AWS credentials
    await restoreAwsCredentials(port);

    // Check if Ollama should autostart
    if (envConfig.OLLAMA_AUTOSTART === 'true') {
      console.log(chalk.blue('\nAuto-starting Ollama service...'));
      const { startOllama } = await import('./ollama');
      await startOllama();
    }
    
    // If not in debug mode, exit the parent process to return to shell
    if (envConfig.DEBUG !== 'true') {
      console.log(chalk.gray('\nUse "sail-proxy stop" to stop the server'));
      process.exit(0);
    }
    
  } catch (error) {
    spinner.fail(`Failed to start gateway server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function stopServer(): Promise<void> {
  const spinner = ora('Stopping gateway server...').start();
  
  try {
    // Check if Ollama was auto-started and stop it first
    const envPath = getConfigPath('.env');
    if (existsSync(envPath)) {
      const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
      const ollamaPid = getStoredPid('ollama');
      
      if (envConfig.OLLAMA_AUTOSTART === 'true' && ollamaPid && isProcessRunning(ollamaPid)) {
        spinner.text = 'Stopping Ollama service...';
        const { stopOllama } = await import('./ollama');
        await stopOllama();
      }
    }
    
    spinner.text = 'Stopping gateway server...';
    const pid = getStoredPid('gateway');
    if (!pid) {
      spinner.info('Gateway server is not running');
      return;
    }
    
    // Try to kill the process
    try {
      process.kill(pid, 'SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if still running and force kill if needed
      if (isProcessRunning(pid)) {
        process.kill(pid, 'SIGKILL');
      }
      
      // Remove PID file
      removePid('gateway');
      
      spinner.succeed('Gateway server stopped');
    } catch (error) {
      if ((error as any).code === 'ESRCH') {
        // Process not found
        removePid('gateway');
        spinner.info('Gateway server was not running (stale PID)');
      } else {
        throw error;
      }
    }
  } catch (error) {
    spinner.fail(`Failed to stop gateway server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function checkStatus(): Promise<void> {
  console.log(chalk.blue.bold('\nSAP AI Core Local LLM Proxy Status'));
  console.log(chalk.blue('==================================\n'));
  
  // Check gateway status
  const gatewayPid = getStoredPid('gateway');
  const gatewayRunning = gatewayPid && isProcessRunning(gatewayPid);
  
  console.log(chalk.gray('Gateway Server:'));
  if (gatewayRunning) {
    console.log(chalk.green('  Status: ') + 'Running');
    console.log(chalk.gray('  PID: ') + gatewayPid);
    
    // Try to get health status
    try {
      const envPath = getConfigPath('.env');
      const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
      const port = envConfig.PORT || '3000';
      
      const response = await axios.get(`http://localhost:${port}/health`, { timeout: 5000 });
      console.log(chalk.gray('  Health: ') + chalk.green('Healthy'));
      console.log(chalk.gray('  URL: ') + `http://localhost:${port}`);
      
      if (response.data.message) {
        console.log(chalk.gray('  Message: ') + response.data.message);
      }
      
      // Display API routes when gateway is running
      displayApiRoutes(port);
    } catch (error) {
      console.log(chalk.gray('  Health: ') + chalk.yellow('Unable to reach health endpoint'));
    }
  } else {
    console.log(chalk.red('  Status: ') + 'Stopped');
  }
  
  // Check Ollama status
  const ollamaPid = getStoredPid('ollama');
  const ollamaRunning = ollamaPid && isProcessRunning(ollamaPid);
  
  console.log(chalk.gray('\nOllama Service:'));
  if (ollamaRunning) {
    console.log(chalk.green('  Status: ') + 'Running');
    console.log(chalk.gray('  PID: ') + ollamaPid);
    console.log(chalk.gray('  URL: ') + 'http://localhost:11434');
  } else {
    console.log(chalk.red('  Status: ') + 'Stopped');
  }
  
  // Show configuration status
  console.log(chalk.gray('\nConfiguration:'));
  const envExists = existsSync(getConfigPath('.env'));
  const configExists = existsSync(getConfigPath('api_config.json'));
  
  console.log(chalk.gray('  .env: ') + (envExists ? chalk.green('Found') : chalk.red('Missing')));
  console.log(chalk.gray('  api_config.json: ') + (configExists ? chalk.green('Found') : chalk.red('Missing')));
  console.log(chalk.gray('  Config Directory: ') + getConfigPath(''));
  
  console.log('');
}

// Helper functions
function getStoredPid(service: 'gateway' | 'ollama'): number | null {
  const pidPath = getPidPath(service);
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
    return isNaN(pid) ? null : pid;
  }
  return null;
}

function storePid(service: 'gateway' | 'ollama', pid: number): void {
  writeFileSync(getPidPath(service), pid.toString());
}

function removePid(service: 'gateway' | 'ollama'): void {
  const pidPath = getPidPath(service);
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForServer(port: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await axios.get(`http://localhost:${port}/health`, { timeout: 1000 });
      return;
    } catch (error) {
      // Check if the process is still running
      if (gatewayProcess && gatewayProcess.pid && !isProcessRunning(gatewayProcess.pid)) {
        throw new Error('Gateway process exited unexpectedly. Try running with DEBUG=true for more details.');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Server failed to start within timeout period');
}

// Helper function to display API routes
function displayApiRoutes(port: string): void {
  console.log(chalk.gray('\nAPI Routes:'));
  console.log(chalk.gray('───────────'));
  
  console.log(chalk.cyan('\nChat Completions:'));
  console.log(chalk.gray('  • OpenAI: ') + `http://localhost:${port}/openai/api/v1/chat/completions`);
  console.log(chalk.gray('  • OpenAI: ') + `http://localhost:${port}/openai/v1/chat/completions`);
  console.log(chalk.gray('  • Anthropic: ') + `http://localhost:${port}/anthropic/v1/messages`);
  console.log(chalk.gray('  • OpenRouter: ') + `http://localhost:${port}/openrouter/api/v1/chat/completions`);

  console.log(chalk.cyan('\nEmbeddings:'));
  console.log(chalk.gray('  • OpenAI: ') + `http://localhost:${port}/openai/api/v1/embeddings`);
  console.log(chalk.gray('  • OpenAI: ') + `http://localhost:${port}/openai/v1/embeddings`);

  console.log(chalk.cyan('\nAWS Bedrock:'));
  console.log(chalk.gray('  • Invoke: ') + `http://localhost:${port}/aws-bedrock/model/{modelId}/invoke`);
  console.log(chalk.gray('  • Stream: ') + `http://localhost:${port}/aws-bedrock/model/{modelId}/invoke-with-response-stream`);
  console.log(chalk.gray('  • Converse: ') + `http://localhost:${port}/aws-bedrock/model/{modelId}/converse`);
  console.log(chalk.gray('  • Converse Stream: ') + `http://localhost:${port}/aws-bedrock/model/{modelId}/converse-stream`);
  
  console.log(chalk.cyan('\nManagement:'));
  console.log(chalk.gray('  • Models: ') + `http://localhost:${port}/v1/models`);
  console.log(chalk.gray('  • API Keys: ') + `http://localhost:${port}/api/admin/api-keys`);
  console.log(chalk.gray('  • AWS Credentials: ') + `http://localhost:${port}/aws/api-keys`);
  console.log(chalk.gray('  • Configuration: ') + `http://localhost:${port}/api/admin/api-config`);
  
  console.log(chalk.cyan('\nAuthentication:'));
  console.log(chalk.gray('  • OpenAI/Anthropic/OpenRouter: ') + 'Bearer token or x-api-key header');
  console.log(chalk.gray('  • AWS Bedrock: ') + 'AWS SigV4 or x-api-key header');
  console.log('');
}

// Restore saved API keys
async function restoreApiKeys(port: string): Promise<void> {
  const savedKeys = getStoredApiKeys();
  
  if (savedKeys.length === 0) {
    return;
  }
  
  console.log(chalk.blue('\nRestoring saved API keys...'));
  
  let restoredCount = 0;
  let failedCount = 0;
  
  for (const savedKey of savedKeys) {
    try {
      // Step 1: Create a new API key with the saved name
      const createResponse = await axios.post(`http://localhost:${port}/api/admin/api-keys`, {
        createdBy: savedKey.name,
        email: ''
      }, {
        timeout: 5000
      });
      
      const newKeyId = createResponse.data.id;
      
      // Step 2: Update the newly created key with the saved value
      await axios.patch(`http://localhost:${port}/api/admin/api-keys/${newKeyId}`, {
        key: savedKey.key,
        isActive: true
      }, {
        timeout: 5000
      });
      
      restoredCount++;
    } catch (error) {
      failedCount++;
      console.log(chalk.yellow(`  Failed to restore key "${savedKey.name}": ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  
  if (restoredCount > 0) {
    console.log(chalk.green(`✓ Restored ${restoredCount} API key${restoredCount > 1 ? 's' : ''}`));
  }
  
  if (failedCount > 0) {
    console.log(chalk.yellow(`⚠️  Failed to restore ${failedCount} API key${failedCount > 1 ? 's' : ''}`));
  }
}

// Helper function to get credential ID by userId (fallback)
async function getCredentialIdByUserId(port: string, userId: string): Promise<string | null> {
  try {
    const response = await axios.get(`http://localhost:${port}/aws/api-keys`, { timeout: 5000 });
    const credentials = response.data.credentials || [];
    const found = credentials.find((c: any) => c.userId === userId);
    return found ? found.id : null;
  } catch (error) {
    return null;
  }
}

// Restore saved AWS credentials
async function restoreAwsCredentials(port: string): Promise<void> {
  const savedCredentials = getStoredAwsCredentials();

  if (savedCredentials.length === 0) {
    return;
  }

  console.log(chalk.blue('\nRestoring saved AWS credentials...'));

  let restoredCount = 0;
  let failedCount = 0;

  for (const savedCred of savedCredentials) {
    try {
      // Step 1: Create with random keys
      const createResponse = await axios.post(
        `http://localhost:${port}/aws/api-keys`,
        { userId: savedCred.userId },
        { timeout: 5000 }
      );

      // Extract credential ID from response, with fallback
      let credentialId = createResponse.data.id;
      if (!credentialId) {
        credentialId = await getCredentialIdByUserId(port, savedCred.userId);
        if (!credentialId) {
          throw new Error('Could not retrieve credential ID');
        }
      }

      // Step 2: Update with saved keys
      await axios.patch(
        `http://localhost:${port}/aws/api-keys/set-keys`,
        {
          credentialId,
          accessKeyId: savedCred.accessKeyId,
          secretAccessKey: savedCred.secretAccessKey
        },
        { timeout: 5000 }
      );

      restoredCount++;
    } catch (error) {
      failedCount++;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(chalk.yellow(`  Failed to restore "${savedCred.name}": ${errorMsg}`));
    }
  }

  if (restoredCount > 0) {
    console.log(chalk.green(`✓ Restored ${restoredCount} AWS credential${restoredCount > 1 ? 's' : ''}`));
  }

  if (failedCount > 0) {
    console.log(chalk.yellow(`⚠️  Failed to restore ${failedCount} AWS credential${failedCount > 1 ? 's' : ''}`));
  }
}

// Export all commands
export { stopCommand, statusCommand };