import inquirer from 'inquirer';
import chalk from 'chalk';
import { writeFileSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseServiceKey, formatAsEnvFile, ParsedConfig } from '@sap-llm-gateway/service-key-parser';
import { getConfigPath, getTemplatePath } from './paths';

/**
 * Run the interactive configuration experience
 */
export async function runInteractiveConfig(): Promise<void> {
  console.log(chalk.blue.bold('SAP AI Core Local LLM Proxy Configuration'));
  console.log(chalk.blue('=========================================\n'));
  
  // Step 1: Get service key
  const { serviceKeyJson } = await inquirer.prompt([
    {
      type: 'editor',
      name: 'serviceKeyJson',
      message: 'Please paste your SAP BTP AI Core service key JSON and save:',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Service key cannot be empty';
        }
        try {
          JSON.parse(input);
          return true;
        } catch (error) {
          return 'Invalid JSON format. Please provide a valid service key.';
        }
      }
    }
  ]);
  
  // Parse the service key
  let config: ParsedConfig;
  try {
    config = parseServiceKey(serviceKeyJson);
    console.log(chalk.green('\n✓ Service key parsed successfully\n'));
  } catch (error) {
    console.error(chalk.red(`\nError parsing service key: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
  
  // Step 2: Review and customize configuration
  console.log(chalk.blue('Review and confirm configuration:\n'));
  
  // Display parsed values
  console.log(chalk.gray('SAP AI Core URL: ') + config.SAP_AI_CORE_URL);
  console.log(chalk.gray('Auth URL: ') + config.AUTH_URL);
  console.log(chalk.gray('Client ID: ') + config.CLIENT_ID);
  console.log(chalk.gray('Client Secret: ') + '•'.repeat(40));
  console.log(chalk.gray('SAP AI Region: ') + config.SAP_AI_REGION);
  console.log('');
  
  // Allow customization of certain values
  const customization = await inquirer.prompt([
    {
      type: 'input',
      name: 'resourceGroup',
      message: 'Resource Group:',
      default: config.SAP_AI_RESOURCE_GROUP,
      validate: (input: string) => input.trim() !== '' || 'Resource group cannot be empty'
    },
    {
      type: 'input',
      name: 'port',
      message: 'Server Port:',
      default: config.PORT,
      validate: (input: string) => {
        const port = parseInt(input);
        if (isNaN(port) || port < 1 || port > 65535) {
          return 'Please enter a valid port number (1-65535)';
        }
        return true;
      }
    },
    {
      type: 'confirm',
      name: 'ollamaAutostart',
      message: 'Ollama Auto-start:',
      default: false
    }
  ]);
  
  // Update config with customized values
  config.SAP_AI_RESOURCE_GROUP = customization.resourceGroup;
  config.PORT = customization.port;
  config.OLLAMA_AUTOSTART = customization.ollamaAutostart ? 'true' : 'false';
  
  // Step 3: Confirm and save
  const { confirmSave } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirmSave',
      message: '\nSave configuration?',
      default: true
    }
  ]);
  
  if (!confirmSave) {
    console.log(chalk.yellow('\nConfiguration cancelled.'));
    process.exit(0);
  }
  
  // Save configuration
  try {
    // Save .env file
    const envContent = formatAsEnvFile(config);
    writeFileSync(getConfigPath('.env'), envContent, 'utf-8');
    console.log(chalk.green(`✓ Configuration saved to ${getConfigPath('.env')}`));
    
    // Copy api_config.json template
    copyFileSync(getTemplatePath('api_config.template.json'), getConfigPath('api_config.json'));
    console.log(chalk.green(`✓ API configuration saved to ${getConfigPath('api_config.json')}`));
    
    // Copy ollama .env.sample and update the port
    const ollamaEnvExample = join(__dirname, '..', '..', '..', '..', 'services', 'ollama', '.env.sample');
    let ollamaEnvContent = readFileSync(ollamaEnvExample, 'utf-8');
    
    // Update MAIN_PROXY_URL with the correct port
    ollamaEnvContent = ollamaEnvContent.replace(
      /MAIN_PROXY_URL=http:\/\/localhost:\d+/,
      `MAIN_PROXY_URL=http://localhost:${config.PORT}`
    );
    
    writeFileSync(getConfigPath('ollama.env'), ollamaEnvContent);
    console.log(chalk.green(`✓ Ollama configuration saved to ${getConfigPath('ollama.env')}`));
    
  } catch (error) {
    console.error(chalk.red(`\nError saving configuration: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

/**
 * Load existing configuration for display
 */
export async function loadAndDisplayConfig(): Promise<void> {
  try {
    const envPath = getConfigPath('.env');
    const envContent = require('fs').readFileSync(envPath, 'utf-8');
    
    console.log(chalk.blue.bold('\nCurrent Configuration:'));
    console.log(chalk.blue('=====================\n'));
    
    // Parse and display key values (hiding secrets)
    const lines = envContent.split('\n');
    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) {
        continue;
      }
      
      const [key, value] = line.split('=', 2);
      if (key && value) {
        if (key.includes('SECRET') || key.includes('PASSWORD') || key.includes('KEY')) {
          console.log(chalk.gray(`${key}: `) + '•'.repeat(40));
        } else {
          console.log(chalk.gray(`${key}: `) + value);
        }
      }
    }
    
    console.log('');
  } catch (error) {
    console.log(chalk.yellow('No existing configuration found.'));
  }
}