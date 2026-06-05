import { Command } from 'commander';
import chalk from 'chalk';
import axios from 'axios';
import { getGatewayUrl, handleApiError } from './apikey';
import ora from 'ora';

export const modelsCommand = new Command('models')
  .description('Manage models');

// List models
modelsCommand
  .command('list')
  .description('List available models')
  .option('-j, --json', 'Output in JSON format')
  .action(async (options) => {
    const spinner = ora('Fetching models...').start();
    
    try {
      const baseUrl = await getGatewayUrl();
      const response = await axios.get(`${baseUrl}/openrouter/api/v1/models`);
      
      spinner.stop();
      
      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      
      const models = response.data.data || [];
      
      if (models.length === 0) {
        console.log(chalk.yellow('No models found.'));
        return;
      }
      
      console.log(chalk.blue.bold('\nAvailable Models:'));
      console.log(chalk.blue('=================\n'));
      
      // Group models by provider (extracted from OpenRouter format)
      const modelsByProvider: { [key: string]: any[] } = {};
      models.forEach((model: any) => {
        // Extract provider from OpenRouter format (e.g., "anthropic/claude-3-haiku" -> "anthropic")
        const provider = model.id.split('/')[0] || 'unknown';
        if (!modelsByProvider[provider]) {
          modelsByProvider[provider] = [];
        }
        modelsByProvider[provider].push(model);
      });
      
      // Display models grouped by provider
      Object.keys(modelsByProvider).sort().forEach(provider => {
        console.log(chalk.cyan(`${provider}:`));
        
        modelsByProvider[provider].forEach((model: any) => {
          console.log(chalk.gray(`  - ${model.id}`));
          
          // Show additional details from OpenRouter format
          if (model.name) {
            console.log(chalk.gray(`    Name: ${model.name}`));
          }
          if (model.context_length) {
            console.log(chalk.gray(`    Context: ${model.context_length.toLocaleString()} tokens`));
          }
          if (model.architecture && model.architecture.modality) {
            console.log(chalk.gray(`    Modality: ${model.architecture.modality}`));
          }
          if (model.pricing) {
            const promptCost = parseFloat(model.pricing.prompt);
            const completionCost = parseFloat(model.pricing.completion);
            if (promptCost > 0 || completionCost > 0) {
              console.log(chalk.gray(`    Pricing: $${promptCost.toFixed(6)}/prompt, $${completionCost.toFixed(6)}/completion`));
            }
          }
        });
        console.log('');
      });
      
      console.log(chalk.gray(`Total models: ${models.length}`));
      
    } catch (error) {
      spinner.fail('Failed to fetch models');
      handleApiError(error);
    }
  });