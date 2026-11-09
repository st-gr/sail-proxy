import { Command } from 'commander';
import chalk from 'chalk';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'fs';
import { getPidPath, getOllamaPath, getLogPath, ensureLogDir, getConfigPath } from '../utils/paths';
import { createLogStream, formatLogLine, rotateLogsIfNeeded } from '../utils/log-manager';
import { ensureOllamaApiKey } from '../utils/api-key-manager';
import axios from 'axios';
import ora from 'ora';

let ollamaProcess: ChildProcess | null = null;

export const ollamaCommand = new Command('ollama')
  .description('Manage Ollama service');

// Start Ollama
ollamaCommand
  .command('start')
  .description('Start the Ollama service')
  .action(async () => {
    await startOllama();
  });

// Stop Ollama
ollamaCommand
  .command('stop')
  .description('Stop the Ollama service')
  .action(async () => {
    await stopOllama();
  });

// Ollama status
ollamaCommand
  .command('status')
  .description('Show Ollama service status')
  .action(async () => {
    await checkOllamaStatus();
  });

// Export functions for auto-start/stop
export async function startOllama(): Promise<void> {
  const spinner = ora('Starting Ollama service...').start();
  
  try {
    // Check if already running
    const pid = getStoredPid('ollama');
    if (pid && isProcessRunning(pid)) {
      spinner.fail('Ollama service is already running');
      console.log(chalk.gray(`PID: ${pid}`));
      return;
    }
    
    // Load environment configuration
    const envPath = getConfigPath('.env');
    let port = '3000';
    if (existsSync(envPath)) {
      const dotenv = require('dotenv');
      const envConfig = dotenv.parse(readFileSync(envPath, 'utf-8'));
      port = envConfig.PORT || '3000';
    }
    
    // Start the Ollama process
    const ollamaPath = getOllamaPath();
    const ollamaDir = require('path').dirname(ollamaPath);
    
    // Configure stdio based on debug mode
    let stdio: any;
    if (process.env.DEBUG === 'true') {
      stdio = 'inherit';
    } else {
      // For background mode, redirect output to log files
      ensureLogDir();
      rotateLogsIfNeeded('ollama');
      const logFile = openSync(getLogPath('ollama.log'), 'a');
      const errFile = logFile; // Use same file for both stdout and stderr
      stdio = ['ignore', logFile, errFile];
    }
    
    // Ensure Ollama has a valid API key before starting
    try {
      await ensureOllamaApiKey(spinner);
    } catch (error) {
      // Non-fatal error - warn but continue
      console.log(chalk.yellow(`\n⚠️  Warning: Could not configure API key for Ollama`));
      console.log(chalk.gray(`   ${error instanceof Error ? error.message : String(error)}`));
      console.log(chalk.gray(`   Ollama may not be able to access the gateway's secured endpoints`));
    }
    
    // Load ollama.env if it exists
    const ollamaEnvPath = getConfigPath('ollama.env');
    let ollamaEnv = {
      ...process.env,
      OLLAMA_PORT: '11434',
      OLLAMA_HOST: 'localhost',
      MAIN_PROXY_URL: `http://localhost:${port}`
    };
    
    if (existsSync(ollamaEnvPath)) {
      const dotenv = require('dotenv');
      const ollamaConfig = dotenv.parse(readFileSync(ollamaEnvPath, 'utf-8'));
      ollamaEnv = {
        ...process.env,
        ...ollamaConfig,
        MAIN_PROXY_URL: `http://localhost:${port}` // Always override with current port
      };
    }
    
    ollamaProcess = spawn('node', ['index.js'], {
      cwd: ollamaDir,
      env: ollamaEnv,
      detached: true,
      stdio: stdio
    });
    
    // Store PID
    if (ollamaProcess.pid) {
      storePid('ollama', ollamaProcess.pid);
      ollamaProcess.unref();
    }
    
    // Wait for service to be ready
    await waitForOllama();
    
    spinner.succeed('Ollama service started on http://localhost:11434');
    console.log(chalk.gray(`PID: ${ollamaProcess.pid}`));
    
    if (process.env.DEBUG !== 'true') {
      console.log(chalk.gray('Logs: ') + 'Use "sail-proxy logs ollama" to view logs');
    }
    
  } catch (error) {
    spinner.fail(`Failed to start Ollama service: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export async function stopOllama(): Promise<void> {
  const spinner = ora('Stopping Ollama service...').start();
  
  try {
    const pid = getStoredPid('ollama');
    if (!pid) {
      spinner.info('Ollama service is not running');
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
      removePid('ollama');
      
      spinner.succeed('Ollama service stopped');
    } catch (error) {
      if ((error as any).code === 'ESRCH') {
        // Process not found
        removePid('ollama');
        spinner.info('Ollama service was not running (stale PID)');
      } else {
        throw error;
      }
    }
  } catch (error) {
    spinner.fail(`Failed to stop Ollama service: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function checkOllamaStatus(): Promise<void> {
  console.log(chalk.blue.bold('\nOllama Service Status'));
  console.log(chalk.blue('=====================\n'));
  
  const pid = getStoredPid('ollama');
  const running = pid && isProcessRunning(pid);
  
  if (running) {
    console.log(chalk.green('Status: ') + 'Running');
    console.log(chalk.gray('PID: ') + pid);
    console.log(chalk.gray('URL: ') + 'http://localhost:11434');
    
    // Try to get version info
    try {
      const response = await axios.get('http://localhost:11434/api/version', { timeout: 5000 });
      console.log(chalk.gray('Version: ') + response.data.version);
    } catch (error) {
      console.log(chalk.gray('Version: ') + chalk.yellow('Unable to fetch version'));
    }
    
    // Try to get models
    try {
      const response = await axios.get('http://localhost:11434/api/tags', { timeout: 5000 });
      const models = response.data.models || [];
      console.log(chalk.gray('Models: ') + `${models.length} available`);
    } catch (error) {
      console.log(chalk.gray('Models: ') + chalk.yellow('Unable to fetch models'));
    }
  } else {
    console.log(chalk.red('Status: ') + 'Stopped');
  }
  
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

async function waitForOllama(maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await axios.get('http://localhost:11434/api/version', { timeout: 1000 });
      return;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Ollama service failed to start within timeout period');
}