/**
 * Utility functions for handling different LLM model providers
 */
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface OpenAIParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

interface ModelParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

type Provider = 'anthropic' | 'openai' | 'ibm' | 'cohere' | 'meta' | string;

/**
 * Maps OpenAI-style parameters to provider-specific parameters
 * @param openAIParams - Parameters in OpenAI format
 * @param provider - The provider name
 * @returns Provider-specific parameters
 */
export const mapModelParameters = (openAIParams: OpenAIParams, provider: Provider): ModelParams => {
  // Default parameters that work with most models
  const commonParams: ModelParams = {};
  
  if (openAIParams.max_tokens !== undefined) {
    commonParams.max_tokens = openAIParams.max_tokens;
  }
  
  if (openAIParams.temperature !== undefined) {
    commonParams.temperature = openAIParams.temperature;
  }
  
  // Add top_p if provided (works with most models)
  if (openAIParams.top_p !== undefined) {
    commonParams.top_p = openAIParams.top_p;
  }
  
  // IMPORTANT: Do NOT add stream parameter to model.params
  // According to SAP AI Core V2 orchestration, streaming must be set at config.stream
  // (the V2 GlobalStreamOptions object: { enabled, chunk_size, delimiters? }) — NOT in model.params.
  
  // Provider-specific parameter mapping
  switch (provider) {
    case 'anthropic':
      // Anthropic doesn't support frequency_penalty or presence_penalty
      // But may support other specific parameters
      if (openAIParams.top_k !== undefined) {
        commonParams.top_k = openAIParams.top_k;
      }
      break;
      
    case 'openai':
    case 'ibm':
      // These providers support the standard OpenAI parameters
      commonParams.frequency_penalty = openAIParams.frequency_penalty || 0;
      commonParams.presence_penalty = openAIParams.presence_penalty || 0;
      break;
      
    case 'cohere':
      // Cohere has some different parameter names
      if (openAIParams.frequency_penalty !== undefined) {
        commonParams.frequency_penalty = openAIParams.frequency_penalty;
      }
      // Map other Cohere-specific parameters as needed
      break;
      
    case 'meta':
      // Meta/Llama parameters
      if (openAIParams.frequency_penalty !== undefined) {
        commonParams.frequency_penalty = openAIParams.frequency_penalty;
      }
      if (openAIParams.presence_penalty !== undefined) {
        commonParams.presence_penalty = openAIParams.presence_penalty;
      }
      // Map other Meta-specific parameters as needed
      break;
      
    default:
      // For unknown providers, include all parameters and let the API handle validation
      if (openAIParams.frequency_penalty !== undefined) {
        commonParams.frequency_penalty = openAIParams.frequency_penalty;
      }
      if (openAIParams.presence_penalty !== undefined) {
        commonParams.presence_penalty = openAIParams.presence_penalty;
      }
  }
  
  logger.debug('ModelUtils', `Mapped model parameters: ${JSON.stringify(commonParams)}`);
  return commonParams;
};

/**
 * Gets default parameters for a specific model provider
 * @param provider - The provider name
 * @returns Default parameters for the provider
 */
export const getDefaultParameters = (provider: Provider): ModelParams => {
  switch (provider) {
    case 'anthropic':
      return {
        max_tokens: 300,
        temperature: 0.7,
        top_p: 0.95
      };
      
    case 'openai':
    case 'ibm':
      return {
        max_tokens: 300,
        temperature: 0.7,
        frequency_penalty: 0,
        presence_penalty: 0,
        top_p: 1
      };
      
    case 'cohere':
      return {
        max_tokens: 300,
        temperature: 0.7,
        top_p: 0.95
      };
      
    case 'meta':
      return {
        max_tokens: 300,
        temperature: 0.7,
        top_p: 0.95
      };
      
    default:
      return {
        max_tokens: 300,
        temperature: 0.7
      };
  }
};