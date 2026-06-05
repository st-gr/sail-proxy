/**
 * OpenRouter Service
 * Handles OpenRouter-specific functionality
 */
import modelService from './modelService';
// import configService from './configService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Type definitions
interface ModelVersion {
  isLatest?: boolean;
  contextLength?: number;
  capabilities?: string[];
  inputTypes?: string[];
  streamingSupported?: boolean;
  name?: string;
}

interface SAPModel {
  id: string;
  created?: number;
  owned_by?: string;
  displayName?: string;
  description?: string;
  versions?: ModelVersion[];
  capabilities?: string[];
  streamingSupported?: boolean;
  contextLength?: number;
  [key: string]: any;
}

interface SAPModelsResponse {
  data: SAPModel[];
}

interface OpenRouterModel {
  id: string;
  canonical_slug: string;
  hugging_face_id: string;
  name: string;
  created: number;
  description: string;
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
    instruct_type: null;
  };
  pricing: {
    prompt: string;
    completion: string;
    request: string;
    image: string;
  };
  top_provider: {
    context_length: number;
    max_completion_tokens: number;
    is_moderated: boolean;
  };
  per_request_limits: null;
  supported_parameters: string[];
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

interface OpenRouterEndpoint {
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    request: string;
    image: string;
    web_search: string;
    internal_reasoning: string;
    input_cache_read: string;
    input_cache_write: string;
    discount: number;
  };
  provider_name: string;
  tag: string;
  quantization: null;
  max_completion_tokens: number;
  max_prompt_tokens: null;
  supported_parameters: string[];
  status: number;
}

interface OpenRouterEndpointsResponse {
  data: {
    id: string;
    name: string;
    created: number;
    description: string;
    architecture: {
      tokenizer: string;
      instruct_type: null;
      modality: string;
      input_modalities: string[];
      output_modalities: string[];
    };
    endpoints: OpenRouterEndpoint[];
  };
}

/**
 * Transform models from SAP AI Core format to OpenRouter format
 * @returns OpenRouter models response
 */
export async function getModels(): Promise<OpenRouterModelsResponse> {
  try {
    // Get models from the model service
    const sapModels = await modelService.getModels();
    
    // Transform to OpenRouter format
    const transformedModels = transformModelsToOpenRouterFormat(sapModels);
    
    return {
      data: transformedModels
    };
  } catch (error: any) {
    logger.error('OpenRouterService', `Error getting models: ${error.message}`);
    throw error;
  }
}

/**
 * Get model endpoints for a specific model
 * @param author - The model author/provider
 * @param slug - The model slug/name
 * @returns OpenRouter model endpoints response
 */
export async function getModelEndpoints(author: string, slug: string): Promise<OpenRouterEndpointsResponse> {
  try {
    // Form the canonical slug
    const canonicalSlug = `${author}/${slug}`;
    logger.info('OpenRouterService', `Getting endpoints for model ${canonicalSlug}`);
    
    // Get a specific model with that slug if available
    const sapModels = await modelService.getModels();
    const modelData = findModelByCanonicalSlug(sapModels, canonicalSlug);
    
    if (!modelData) {
      logger.warn('OpenRouterService', `Model not found for canonical slug: ${canonicalSlug}`);
      const error = new Error(`Model not found: ${canonicalSlug}`) as any;
      error.status = 404;
      throw error;
    }
    
    // Transform to OpenRouter model endpoints format
    return transformModelToEndpointsFormat(modelData);
  } catch (error: any) {
    logger.error('OpenRouterService', `Error getting model endpoints: ${error.message}`);
    throw error;
  }
}

/**
 * Transform SAP models into OpenRouter models format  
 * @param sapModels - SAP AI Core models response
 * @returns Array of OpenRouter model objects
 */
function transformModelsToOpenRouterFormat(sapModels: SAPModelsResponse): OpenRouterModel[] {
  if (!sapModels || !sapModels.data || !Array.isArray(sapModels.data)) {
    return [];
  }
  
  return sapModels.data.map(model => {
    // Map SAP AI Core model to OpenRouter model format
    const created = model.created || Math.floor(Date.now() / 1000);
    const provider = model.owned_by || 'SAP AI Core';
    
    // Create a canonical slug that follows the pattern provider/model-id
    const canonicalSlug = `${provider.toLowerCase().replace(/\\s+/g, '')}/${model.id}`;
    
    // Determine the model's context length
    const contextLength = getModelContextLength(model);
    
    // Get supported parameters
    const supportedParameters = getModelSupportedParameters(model);
    
    return {
      id: `${provider.toLowerCase().replace(/\\s+/g, '')}/${model.id}`, // Format: provider/model-id
      canonical_slug: canonicalSlug,
      hugging_face_id: '',
      name: `${provider}: ${model.displayName || model.id}`,
      created: created,
      description: model.description || `${provider} model ${model.id}`,
      context_length: contextLength,
      architecture: {
        modality: getModelModality(model),
        input_modalities: getModelInputModalities(model),
        output_modalities: ["text"],
        tokenizer: getModelTokenizer(provider),
        instruct_type: null
      },
      pricing: {
        prompt: "0.000001",
        completion: "0.000005",
        request: "0",
        image: model.capabilities?.includes("image-recognition") ? "0.001" : "0"
      },
      top_provider: {
        context_length: contextLength,
        max_completion_tokens: Math.floor(contextLength / 2),
        is_moderated: false
      },
      per_request_limits: null,
      supported_parameters: supportedParameters
    };
  });
}

/**
 * Find a model by its canonical slug
 * @param sapModels - SAP AI Core models response
 * @param canonicalSlug - The canonical slug to search for
 * @returns Model data or null if not found
 */
function findModelByCanonicalSlug(sapModels: SAPModelsResponse, canonicalSlug: string): SAPModel | null {
  if (!sapModels || !sapModels.data || !Array.isArray(sapModels.data)) {
    return null;
  }
  
  // First try direct canonical slug match
  const [author, slug] = canonicalSlug.split('/');
  
  for (const model of sapModels.data) {
    const provider = model.owned_by || 'SAP AI Core';
    const providerId = provider.toLowerCase().replace(/\\s+/g, '-');
    
    if (providerId === author && model.id === slug) {
      return model;
    }
  }
  
  // If not found, try more flexible matching
  for (const model of sapModels.data) {
    const provider = model.owned_by || 'SAP AI Core';
    const providerId = provider.toLowerCase().replace(/\\s+/g, '-');
    
    if (providerId === author && (
      model.id === slug || 
      model.id.includes(slug || '') || 
      (model.displayName && slug && model.displayName.toLowerCase().includes(slug.toLowerCase()))
    )) {
      return model;
    }
  }
  
  return null;
}

/**
 * TODO: There must be a better way to do this, e. g. poll OpenRouter API endpoints
 * Transform a single model to the OpenRouter endpoints format
 * @param model - The model data
 * @returns OpenRouter endpoints response
 */
function transformModelToEndpointsFormat(model: SAPModel): OpenRouterEndpointsResponse {
  if (!model) {
    return { 
      data: { 
        id: '',
        name: '',
        created: 0,
        description: '',
        architecture: {
          tokenizer: '',
          instruct_type: null,
          modality: '',
          input_modalities: [],
          output_modalities: []
        },
        endpoints: [] 
      } 
    };
  }
  
  const provider = model.owned_by || 'SAP AI Core';
  const providerId = provider.toLowerCase().replace(/\\s+/g, '-');
  // const canonicalSlug = `${providerId}/${model.id}`;
  const contextLength = getModelContextLength(model);
  const supportedParameters = getModelSupportedParameters(model);
  
  // Create a single endpoint for the model
  const endpoint: OpenRouterEndpoint = {
    name: `${provider} | ${model.id}`,
    context_length: contextLength,
    pricing: {
      prompt: "0.000001",
      completion: "0.000005",
      request: "0",
      image: model.capabilities?.includes("image-recognition") ? "0.001" : "0",
      web_search: "0",
      internal_reasoning: "0",
      input_cache_read: "0.0000001",
      input_cache_write: "0.0000005",
      discount: 0
    },
    provider_name: provider,
    tag: providerId,
    quantization: null,
    max_completion_tokens: Math.floor(contextLength / 2),
    max_prompt_tokens: null,
    supported_parameters: supportedParameters,
    status: 0
  };
  
  return {
    data: {
      id: `${providerId}/${model.id}`,
      name: `${provider}: ${model.displayName || model.id}`,
      created: model.created || Math.floor(Date.now() / 1000),
      description: model.description || `${provider} model ${model.id}`,
      architecture: {
        tokenizer: getModelTokenizer(provider),
        instruct_type: null,
        modality: getModelModality(model),
        input_modalities: getModelInputModalities(model),
        output_modalities: ["text"]
      },
      endpoints: [endpoint]
    }
  };
}

/**
 * Get the context length for a model
 * @param model - The model data 
 * @returns Context length
 */
function getModelContextLength(model: SAPModel): number {
  // Try to get context length from versions
  if (model.versions && Array.isArray(model.versions) && model.versions.length > 0) {
    const latestVersion = model.versions.find(v => v.isLatest === true) || model.versions[0];
    if (latestVersion && latestVersion.contextLength) {
      return latestVersion.contextLength;
    }
  }
  
  // Check for explicit contextLength from model_list_changes config
  if (model.contextLength) {
    return model.contextLength;
  }

  // Provide defaults based on model family
  const id = model.id.toLowerCase();
  
  if (id.includes('claude-3')) return 200000;
  if (id.includes('gpt-4')) return 128000;
  if (id.includes('mistral')) return 32000;
  if (id.includes('gemini')) return 1000000;
  
  // Default fallback
  return 16000;
}

/**
 * TODO: There must be a better way to do this, e. g. poll OpenRouter API models and then merge with SAP AI Core model list
 * Get supported parameters for a model
 * @param model - The model data
 * @returns Supported parameters
 */
function getModelSupportedParameters(model: SAPModel): string[] {
  const baseParams = [
    "max_tokens",
    "temperature",
    "top_p",
    "stop"
  ];
  
  // Add common optional parameters
  const optionalParams: string[] = [];
  
  // Add model-specific parameters
  if (model.owned_by && model.owned_by.toLowerCase().includes('openai')) {
    optionalParams.push(
      "frequency_penalty", 
      "presence_penalty",
      "logit_bias",
      "seed"
    );
  }
  
  // Add advanced features if model supports them
  if (model.streamingSupported === true) {
    optionalParams.push("stream");
  }
  
  // Add tool calling support for newer models
  const id = model.id.toLowerCase();
  if (
    id.includes('gpt-4') || 
    id.includes('claude-3') || 
    id.includes('gemini')
  ) {
    optionalParams.push(
      "tools",
      "tool_choice"
    );
  }
  
  // Add response format for OpenAI models
  if (model.owned_by && model.owned_by.toLowerCase().includes('openai')) {
    optionalParams.push("response_format", "structured_outputs");
  }
  
  // Add reasoning for Anthropic Claude models
  if (model.owned_by && model.owned_by.toLowerCase().includes('anthropic') && id.includes('claude-3')) {
    optionalParams.push("reasoning", "include_reasoning");
  }
  
  return [...baseParams, ...optionalParams];
}

/**
 * Get the tokenizer for a model
 * @param provider - The model provider
 * @returns Tokenizer name
 */
function getModelTokenizer(provider: string): string {
  const providerLower = provider.toLowerCase();
  
  if (providerLower.includes('openai')) return 'GPT';
  if (providerLower.includes('anthropic')) return 'Claude';
  if (providerLower.includes('google')) return 'Gemini';
  if (providerLower.includes('mistral')) return 'Mistral';
  if (providerLower.includes('meta') || providerLower.includes('llama')) return 'Llama';
  
  return 'Other';
}

/**
 * Get the modality for a model
 * @param model - The model data
 * @returns Modality description
 */
function getModelModality(model: SAPModel): string {
  // Check if model has image recognition capability
  const hasImageCapability = model.versions && 
    Array.isArray(model.versions) && 
    model.versions.some(v => 
      v.capabilities && 
      Array.isArray(v.capabilities) && 
      v.capabilities.includes('image-recognition')
    );
  
  return hasImageCapability ? "text+image->text" : "text->text";
}

/**
 * Get the input modalities for a model
 * @param model - The model data
 * @returns Input modalities
 */
function getModelInputModalities(model: SAPModel): string[] {
  const modalities = ["text"];
  
  // Check if model has image recognition capability
  const hasImageCapability = model.versions && 
    Array.isArray(model.versions) && 
    model.versions.some(v => 
      v.capabilities && 
      Array.isArray(v.capabilities) && 
      v.capabilities.includes('image-recognition')
    );
  
  // Check if model has audio capability
  const hasAudioCapability = model.versions && 
    Array.isArray(model.versions) && 
    model.versions.some(v => 
      v.inputTypes && 
      Array.isArray(v.inputTypes) && 
      v.inputTypes.includes('audio')
    );
  
  if (hasImageCapability) {
    modalities.push("image");
  }
  
  if (hasAudioCapability) {
    modalities.push("audio");
  }
  
  return modalities;
}

class OpenRouterService {
  async getModels(): Promise<OpenRouterModelsResponse> {
    return getModels();
  }

  async getModelEndpoints(author: string, slug: string): Promise<OpenRouterEndpointsResponse> {
    return getModelEndpoints(author, slug);
  }
}

export default new OpenRouterService();