/**
 * Ollama Adapter Service
 * 
 * Core service that transforms between Ollama and OpenAI formats
 * and communicates with the main proxy server.
 */

const axios = require('axios');
const crypto = require('crypto');
const shared = require('./shared');

const MAIN_PROXY_URL = process.env.MAIN_PROXY_URL || 'http://localhost:3000';

/**
 * Generate SHA256 digest for a model name
 */
function generateModelDigest(modelName) {
  const hash = crypto.createHash('sha256');
  hash.update(modelName);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Transform Ollama chat request to OpenAI format
 */
function transformChatRequest(ollamaRequest) {
  const { model, messages, stream, options = {}, format, tools, think } = ollamaRequest;
  
  // Base OpenAI request
  const openaiRequest = {
    model: model || 'gpt-3.5-turbo',
    messages: messages || [],
    stream: stream !== false // Default to streaming
  };
  
  // Map Ollama options to OpenAI parameters
  if (options.temperature !== undefined) {
    openaiRequest.temperature = options.temperature;
  }
  if (options.top_p !== undefined) {
    openaiRequest.top_p = options.top_p;
  }
  if (options.top_k !== undefined) {
    // OpenAI doesn't have top_k, but we can note it in metadata
    openaiRequest.top_k = options.top_k;
  }
  if (options.num_predict !== undefined) {
    openaiRequest.max_tokens = options.num_predict;
  }
  if (options.stop) {
    openaiRequest.stop = Array.isArray(options.stop) ? options.stop : [options.stop];
  }
  if (options.presence_penalty !== undefined) {
    openaiRequest.presence_penalty = options.presence_penalty;
  }
  if (options.frequency_penalty !== undefined) {
    openaiRequest.frequency_penalty = options.frequency_penalty;
  }
  if (options.seed !== undefined) {
    openaiRequest.seed = options.seed;
  }
  
  // Handle JSON format mode
  if (format === 'json' || (typeof format === 'object' && format.type)) {
    if (format === 'json') {
      openaiRequest.response_format = { type: 'json_object' };
    } else {
      // Structured output with schema
      openaiRequest.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: format
        }
      };
    }
  }
  
  // Handle tools
  if (tools && Array.isArray(tools)) {
    openaiRequest.tools = tools;
  }
  
  // Handle stream options for streaming
  if (stream && options.stream_options) {
    openaiRequest.stream_options = options.stream_options;
  }
  
  return openaiRequest;
}

/**
 * Transform Ollama generate request to OpenAI format
 */
function transformGenerateRequest(ollamaRequest) {
  const { model, prompt, stream, options = {}, format, system, suffix, images, raw } = ollamaRequest;
  
  // Convert generate request to chat format
  const messages = [];
  
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  
  // Handle images in the user message
  let userContent;
  if (images && images.length > 0) {
    userContent = [
      { type: 'text', text: prompt || '' }
    ];
    
    // Add images
    images.forEach(image => {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${image}`
        }
      });
    });
  } else {
    userContent = prompt || '';
  }
  
  messages.push({ role: 'user', content: userContent });
  
  // If suffix is provided, we need to handle it specially
  // This is more complex in OpenAI format, so we'll add it as context
  if (suffix) {
    messages.push({ 
      role: 'system', 
      content: `Please complete the following, ensuring your response fits before this suffix: "${suffix}"` 
    });
  }
  
  // Transform to chat request and then to OpenAI
  const chatRequest = {
    model,
    messages,
    stream,
    options,
    format
  };
  
  return transformChatRequest(chatRequest);
}

/**
 * Transform OpenAI streaming response to Ollama format
 */
function transformStreamingChatResponse(openaiChunk, model, isFirst = false, isDone = false) {
  const timestamp = new Date().toISOString();
  
  if (isDone) {
    // Final chunk with done: true
    return {
      model: model,
      created_at: timestamp,
      message: {
        role: 'assistant',
        content: ''
      },
      done: true,
      total_duration: 0, // We don't have this info from OpenAI
      load_duration: 0,
      prompt_eval_count: 0,
      prompt_eval_duration: 0,
      eval_count: 0,
      eval_duration: 0
    };
  }
  
  // Parse the OpenAI chunk
  let content = '';
  let role = 'assistant';
  let toolCalls = null;
  
  if (openaiChunk.choices && openaiChunk.choices[0]) {
    const delta = openaiChunk.choices[0].delta;
    if (delta.content) {
      content = delta.content;
    }
    if (delta.role) {
      role = delta.role;
    }
    if (delta.tool_calls) {
      toolCalls = delta.tool_calls;
    }
  }
  
  const ollamaChunk = {
    model: model,
    created_at: timestamp,
    message: {
      role: role,
      content: content
    },
    done: false
  };
  
  // Add tool calls if present
  if (toolCalls) {
    ollamaChunk.message.tool_calls = toolCalls;
  }
  
  return ollamaChunk;
}

/**
 * Transform OpenAI streaming response to Ollama generate format
 */
function transformStreamingGenerateResponse(openaiChunk, model, isFirst = false, isDone = false) {
  const timestamp = new Date().toISOString();
  
  if (isDone) {
    return {
      model: model,
      created_at: timestamp,
      response: '',
      done: true,
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: 0,
      prompt_eval_duration: 0,
      eval_count: 0,
      eval_duration: 0,
      context: [] // We don't have context from OpenAI
    };
  }
  
  let content = '';
  if (openaiChunk.choices && openaiChunk.choices[0] && openaiChunk.choices[0].delta) {
    content = openaiChunk.choices[0].delta.content || '';
  }
  
  return {
    model: model,
    created_at: timestamp,
    response: content,
    done: false
  };
}

/**
 * Transform OpenAI non-streaming response to Ollama chat format
 */
function transformNonStreamingChatResponse(openaiResponse, model) {
  const timestamp = new Date().toISOString();
  const choice = openaiResponse.choices && openaiResponse.choices[0];
  
  if (!choice) {
    throw new Error('Invalid response from OpenAI API');
  }
  
  const message = choice.message || {};
  
  return {
    model: model,
    created_at: timestamp,
    message: {
      role: message.role || 'assistant',
      content: message.content || '',
      tool_calls: message.tool_calls || null
    },
    done_reason: choice.finish_reason || 'stop',
    done: true,
    total_duration: 0, // We don't have timing info from OpenAI
    load_duration: 0,
    prompt_eval_count: openaiResponse.usage?.prompt_tokens || 0,
    prompt_eval_duration: 0,
    eval_count: openaiResponse.usage?.completion_tokens || 0,
    eval_duration: 0
  };
}

/**
 * Transform OpenAI non-streaming response to Ollama generate format
 */
function transformNonStreamingGenerateResponse(openaiResponse, model) {
  const timestamp = new Date().toISOString();
  const choice = openaiResponse.choices && openaiResponse.choices[0];
  
  if (!choice) {
    throw new Error('Invalid response from OpenAI API');
  }
  
  const message = choice.message || {};
  
  return {
    model: model,
    created_at: timestamp,
    response: message.content || '',
    done_reason: choice.finish_reason || 'stop',
    done: true,
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: openaiResponse.usage?.prompt_tokens || 0,
    prompt_eval_duration: 0,
    eval_count: openaiResponse.usage?.completion_tokens || 0,
    eval_duration: 0,
    context: [] // We don't have context from OpenAI
  };
}

/**
 * Map OpenAI proxy capabilities to Ollama capabilities
 */
function mapCapabilitiesToOllama(openaiCapabilities, inputTypes) {
  const ollamaCapabilities = [];
  
  // Always include completion for text generation
  if (openaiCapabilities && openaiCapabilities.includes('text-generation')) {
    ollamaCapabilities.push('completion');
  } else {
    // Default to completion if no specific text generation capability found
    ollamaCapabilities.push('completion');
  }
  
  // Map vision capabilities
  if (openaiCapabilities && (
    openaiCapabilities.includes('image-recognition') ||
    openaiCapabilities.includes('image-understanding') ||
    openaiCapabilities.includes('vision')
  )) {
    ollamaCapabilities.push('vision');
  }
  
  // Check input types for vision support as fallback
  if (inputTypes && inputTypes.includes('image') && !ollamaCapabilities.includes('vision')) {
    ollamaCapabilities.push('vision');
  }
  
  // Note: Ollama doesn't have direct equivalent for 'speech-to-text' or 'reasoning'
  // These are handled implicitly as part of completion
  
  return ollamaCapabilities;
}

/**
 * Fetch model metadata from OpenAI proxy models endpoint
 */
async function fetchModelMetadata(modelName) {
  try {
    // Load environment variables if not already loaded
    require('dotenv').config();
      const headers = {
      'Content-Type': 'application/json'
    };
    
    const apiKey = process.env.MAIN_PROXY_API_KEY;
    
    if (!apiKey) {
      console.log('[fetchModelMetadata] No API key found in environment variable MAIN_PROXY_API_KEY');
      return null;
    }
    
    // Use the same header format as shared.js for consistency
    headers['x-api-key'] = apiKey;
    console.log(`[fetchModelMetadata] Making request to ${MAIN_PROXY_URL}/v1/models with API key`);
    
    const response = await axios.get(`${MAIN_PROXY_URL}/v1/models`, { headers });
    const modelsData = response.data;
    
    if (modelsData && modelsData.data) {
      // Find the specific model
      const modelData = modelsData.data.find(m => 
        m.id === modelName || 
        m.model === modelName ||
        m.displayName === modelName
      );
      
      if (modelData && modelData.versions && modelData.versions.length > 0) {
        // Get the latest version's capabilities
        const latestVersion = modelData.versions.find(v => v.isLatest) || modelData.versions[0];
        return {
          capabilities: latestVersion.capabilities || [],
          inputTypes: latestVersion.inputTypes || [],
          contextLength: latestVersion.contextLength || 4096,
          provider: modelData.provider || 'Unknown',
          description: modelData.description || '',
          displayName: modelData.displayName || modelName
        };
      }
    }
  } catch (error) {
    console.log(`Could not fetch metadata for model ${modelName}:`, error.message);
  }
  
  return null;
}

/**
 * Handle streaming chat completion
 */
exports.handleStreamingChat = async (ollamaRequest, res) => {
  const openaiRequest = transformChatRequest(ollamaRequest);
  const model = ollamaRequest.model || 'gpt-3.5-turbo';
  
  try {
    const response = await shared.callMainProxyStreaming('/openai/v1/chat/completions', openaiRequest);
    
    let isFirst = true;
    
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          
          if (data === '[DONE]') {
            // Send final chunk
            const finalChunk = transformStreamingChatResponse(null, model, false, true);
            res.write(JSON.stringify(finalChunk) + '\n');
            res.end();
            return;
          }
          
          try {
            const openaiChunk = JSON.parse(data);
            const ollamaChunk = transformStreamingChatResponse(openaiChunk, model, isFirst);
            res.write(JSON.stringify(ollamaChunk) + '\n');
            isFirst = false;
          } catch (parseError) {
            console.error('Error parsing OpenAI chunk:', parseError);
          }
        }
      }
    });
    
    response.data.on('end', () => {
      if (!res.writableEnded) {
        const finalChunk = transformStreamingChatResponse(null, model, false, true);
        res.write(JSON.stringify(finalChunk) + '\n');
        res.end();
      }
    });
    
    response.data.on('error', (error) => {
      console.error('Streaming error:', error);
      if (!res.writableEnded) {
        res.status(500).end();
      }
    });
    
  } catch (error) {
    console.error('Error in streaming chat:', error);
    if (!res.writableEnded) {
      res.status(500).json({
        error: {
          message: error.message,
          type: 'api_error',
          code: 'streaming_error'
        }
      });
    }
  }
};

/**
 * Handle non-streaming chat completion
 */
exports.handleNonStreamingChat = async (ollamaRequest) => {
  const openaiRequest = transformChatRequest(ollamaRequest);
  openaiRequest.stream = false;
  const model = ollamaRequest.model || 'gpt-3.5-turbo';
  
  const openaiResponse = await shared.callMainProxy('/openai/v1/chat/completions', openaiRequest);
  return transformNonStreamingChatResponse(openaiResponse, model);
};

/**
 * Handle streaming text generation
 */
exports.handleStreamingGenerate = async (ollamaRequest, res) => {
  const openaiRequest = transformGenerateRequest(ollamaRequest);
  const model = ollamaRequest.model || 'gpt-3.5-turbo';
  
  try {
    const response = await shared.callMainProxyStreaming('/openai/v1/chat/completions', openaiRequest);
    
    let isFirst = true;
    
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          
          if (data === '[DONE]') {
            const finalChunk = transformStreamingGenerateResponse(null, model, false, true);
            res.write(JSON.stringify(finalChunk) + '\n');
            res.end();
            return;
          }
          
          try {
            const openaiChunk = JSON.parse(data);
            const ollamaChunk = transformStreamingGenerateResponse(openaiChunk, model, isFirst);
            res.write(JSON.stringify(ollamaChunk) + '\n');
            isFirst = false;
          } catch (parseError) {
            console.error('Error parsing OpenAI chunk:', parseError);
          }
        }
      }
    });
    
    response.data.on('end', () => {
      if (!res.writableEnded) {
        const finalChunk = transformStreamingGenerateResponse(null, model, false, true);
        res.write(JSON.stringify(finalChunk) + '\n');
        res.end();
      }
    });
    
    response.data.on('error', (error) => {
      console.error('Streaming error:', error);
      if (!res.writableEnded) {
        res.status(500).end();
      }
    });
    
  } catch (error) {
    console.error('Error in streaming generate:', error);
    if (!res.writableEnded) {
      res.status(500).json({
        error: {
          message: error.message,
          type: 'api_error',
          code: 'streaming_error'
        }
      });
    }
  }
};

/**
 * Handle non-streaming text generation
 */
exports.handleNonStreamingGenerate = async (ollamaRequest) => {
  const openaiRequest = transformGenerateRequest(ollamaRequest);
  openaiRequest.stream = false;
  const model = ollamaRequest.model || 'gpt-3.5-turbo';
  
  const openaiResponse = await shared.callMainProxy('/openai/v1/chat/completions', openaiRequest);
  return transformNonStreamingGenerateResponse(openaiResponse, model);
};

/**
 * Handle embeddings request
 */
exports.handleEmbeddings = async (ollamaRequest) => {
  const { model, input } = ollamaRequest;
  
  // Transform to OpenAI embeddings format
  const openaiRequest = {
    model: model || 'text-embedding-ada-002',
    input: input
  };
  
  try {
    // Check if main proxy has embeddings endpoint
    const openaiResponse = await shared.callMainProxy('/openai/v1/embeddings', openaiRequest);
    
    // Transform response to Ollama format
    const embeddings = openaiResponse.data ? openaiResponse.data.map(item => item.embedding) : [];
    
    return {
      model: model,
      embeddings: embeddings,
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: openaiResponse.usage?.prompt_tokens || 0
    };
  } catch (error) {
    // If embeddings endpoint doesn't exist, return a polite error
    throw new Error('Embeddings endpoint not available in the main proxy');
  }
};

/**
 * List available models
 */
exports.listModels = async () => {
  try {
    console.log('[Ollama Adapter] Calling main proxy for models list...');
    const response = await shared.callMainProxy('/v1/models', {}, 'GET');
    
    console.log('[Ollama Adapter] Raw main proxy response:', JSON.stringify(response, null, 2));
    
    // Transform OpenAI models response to Ollama format
    const models = response.data || [];
    console.log('[Ollama Adapter] Extracted models array:', JSON.stringify(models, null, 2));
    
    if (!Array.isArray(models)) {
      console.error('[Ollama Adapter] ERROR: models is not an array:', typeof models, models);
      throw new Error('Models response is not an array');
    }
      const transformedModels = models
      .filter((model, index) => {
        // Filter out any invalid models
        if (!model || typeof model !== 'object') {
          console.error(`[Ollama Adapter] ERROR: Filtering out invalid model at index ${index}:`, model);
          return false;
        }
        
        const modelId = model.id || model.name;
        if (!modelId || typeof modelId !== 'string' || modelId.trim() === '') {
          console.error(`[Ollama Adapter] ERROR: Filtering out model with invalid ID at index ${index}:`, model);
          return false;
        }
        
        return true;
      })
      .map((model, index) => {
        console.log(`[Ollama Adapter] Transforming model ${index}:`, JSON.stringify(model, null, 2));
        
        const modelId = (model.id || model.name || `unknown-${index}`).trim();
        console.log(`[Ollama Adapter] Using model ID: "${modelId}"`);
          // Ensure all required fields are strings and not undefined/null
        const transformedModel = {
          name: String(modelId), // Ollama requires both name and model fields
          model: String(modelId),
          modified_at: new Date().toISOString(),
          size: 0,
          digest: generateModelDigest(modelId),
          details: {
            parent_model: String(model.parent_model || ''),
            format: String(model.format || 'gguf'), // Default to gguf format like real Ollama
            family: String(model.family || 'llama'), // Default to llama family
            families: Array.isArray(model.families) ? model.families : [String(model.family || 'llama')],
            parameter_size: String(model.parameter_size || 'unknown'),
            quantization_level: String(model.quantization_level || 'Q4_0') // Default quantization
          }
        };
          // Validate that all fields are properly set
        if (!transformedModel.model || transformedModel.model === 'undefined') {
          console.error(`[Ollama Adapter] ERROR: Model name is invalid after transformation:`, transformedModel);
          transformedModel.model = `model-${index}`;
          transformedModel.name = `model-${index}`; // Keep name and model in sync
        }
        
        return transformedModel;
      });    // Sort models alphabetically to ensure consistent ordering
    transformedModels.sort((a, b) => {
      if (!a.model || !b.model) return 0;
      try {
        return a.model.localeCompare(b.model);
      } catch (error) {
        console.error('[Ollama Adapter] Error sorting models:', error);
        return 0;
      }
    });
    
    const result = {
      models: transformedModels
    };
      // Final validation - ensure all models have valid string names
    result.models.forEach((model, index) => {
      if (!model.model || typeof model.model !== 'string' || model.model.trim() === '') {
        console.error(`[Ollama Adapter] CRITICAL ERROR: Model ${index} has invalid name after all transformations:`, model);
        model.model = `fallback-model-${index}`;
        model.name = `fallback-model-${index}`; // Keep name and model in sync
      }
      
      // Ensure name field exists and matches model field
      if (!model.name || model.name !== model.model) {
        model.name = model.model;
      }
      
      // Extra validation for GitHub Copilot compatibility
      if (typeof model.model.localeCompare !== 'function') {
        console.error(`[Ollama Adapter] ERROR: Model name doesn't support localeCompare:`, model.model, typeof model.model);
        model.model = String(model.model);
        model.name = String(model.name);
      }
      
      // Ensure no undefined values in the model object
      Object.keys(model).forEach(key => {
        if (model[key] === undefined) {
          console.error(`[Ollama Adapter] WARNING: Model ${index} has undefined value for key ${key}, setting to default`);
          if (key === 'details') {
            model[key] = {
              parent_model: '',
              format: 'gguf',
              family: 'llama',
              families: ['llama'],
              parameter_size: 'unknown',
              quantization_level: 'Q4_0'
            };
          } else {
            model[key] = key === 'size' ? 0 : 'unknown';
          }
        }
      });
    });
      console.log('[Ollama Adapter] Final transformed response:', JSON.stringify(result, null, 2));
    console.log(`[Ollama Adapter] Final validation: ${result.models.length} models, all with valid names:`, result.models.map(m => m.model));
    
    // Additional validation specifically for GitHub Copilot compatibility
    console.log('[Ollama Adapter] Testing localeCompare compatibility on all model names...');
    result.models.forEach((model, index) => {
      try {
        const testResult = model.model.localeCompare('test');
        console.log(`[Ollama Adapter] Model ${index} "${model.model}": localeCompare test passed (${testResult})`);
      } catch (error) {
        console.error(`[Ollama Adapter] Model ${index} "${model.model}": localeCompare test FAILED:`, error);
      }
    });
    
    return result;
    
  } catch (error) {
    console.error('[Ollama Adapter] Error listing models:', error);
    console.error('[Ollama Adapter] Error stack:', error.stack);
      // Return a default model list if the main proxy is not available
    const fallbackResult = {
      models: [
        {
          name: 'gpt-3.5-turbo:latest',
          model: 'gpt-3.5-turbo:latest',
          modified_at: new Date().toISOString(),
          size: 0,
          digest: 'unknown',
          details: {
            parent_model: '',
            format: 'gguf',
            family: 'gpt',
            families: ['gpt'],
            parameter_size: '175B',
            quantization_level: 'Q4_0'
          }
        }
      ]
    };
    
    console.log('[Ollama Adapter] Returning fallback response:', JSON.stringify(fallbackResult, null, 2));
    return fallbackResult;
  }
};

/**
 * List running models (simulated)
 */
exports.listRunningModels = async () => {
  return {
    models: [] // We don't actually manage model lifecycle
  };
};

/**
 * Show model information
 */
exports.showModel = async (request) => {
  const { model } = request;
  
  // Validate that model is a string
  if (!model || typeof model !== 'string') {
    throw new Error('Model name is required and must be a string');
  }
  
  // Try to fetch model metadata from OpenAI proxy
  const metadata = await fetchModelMetadata(model);
  
  // Determine architecture based on model name (case-insensitive)
  const modelLower = model.toLowerCase();
  let architecture = 'llama';
  
  if (modelLower.includes('gpt')) {
    architecture = 'gpt';
  } else if (modelLower.includes('claude')) {
    architecture = 'claude';
  } else if (modelLower.includes('gemini')) {
    architecture = 'gemini';
  } else if (modelLower.includes('mistral')) {
    architecture = 'mistral';
  } else if (modelLower.includes('titan')) {
    architecture = 'titan';
  } else if (modelLower.includes('nova')) {
    architecture = 'nova';
  } else if (modelLower.includes('granite')) {
    architecture = 'granite';
  }
    // Determine capabilities from metadata or fallback to model name analysis
  let capabilities;
  if (metadata && metadata.capabilities) {
    capabilities = mapCapabilitiesToOllama(metadata.capabilities, metadata.inputTypes);
  } else {
    // Fallback: determine capabilities based on model name
    capabilities = ['completion'];
    if (modelLower.includes('vision') || 
        modelLower.includes('gpt-4') || 
        modelLower.includes('gemini') ||
        modelLower.includes('claude-3') ||
        modelLower.includes('claude-3.5') ||
        modelLower.includes('claude-3.7') ||
        modelLower.includes('mistral-small') ||
        modelLower.includes('o1') ||
        modelLower.includes('o3') ||
        modelLower.includes('o4')) {
      capabilities.push('vision');
    }
  }
  
  // Use metadata for enhanced model information
  const contextLength = metadata ? metadata.contextLength : 4096;
  const displayName = metadata ? metadata.displayName : model;
  const description = metadata ? metadata.description : `${model} language model`;
  
  // Generate parameters string with context length
  const parameters = `temperature                    1\ntop_k                          40\ntop_p                          0.9\nnum_ctx                        ${contextLength}`;
  
  // Generate modelfile with more details
  const modelfile = `# Modelfile generated by SAP AI Core Proxy
# Model: ${displayName}
# Architecture: ${architecture}
# Capabilities: ${capabilities.join(', ')}
FROM ${model}
PARAMETER temperature 1
PARAMETER top_p 0.9
PARAMETER num_ctx ${contextLength}`;
  
  return {
    capabilities: capabilities,
    license: metadata && metadata.provider === 'OpenAI' ? 'OpenAI Terms of Service' : '',
    parameters: parameters,
    template: '<|start_header_id|>system<|end_header_id|>\n\n{{ if .System }}{{ .System }}\n{{ end }}<|eot_id|>\n{{ range .Messages }}\n<|start_header_id|>{{ .Role }}<|end_header_id|>\n\n{{ .Content }}<|eot_id|>\n{{ end }}<|start_header_id|>assistant<|end_header_id|>\n\n',
    modelfile: modelfile,
    system: '',
    details: {
      parent_model: '',
      format: 'gguf',
      family: architecture,
      families: [architecture],
      parameter_size: 'unknown',
      quantization_level: 'Q4_0'
    },
    model_info: {
      'general.architecture': architecture,
      'general.basename': model,
      'general.file_type': 15,
      'general.parameter_count': 1000000000,
      'general.quantization_version': 2,
      'general.type': 'model',
      'general.description': description
    },
    modified_at: new Date().toISOString()
  };
};

/**
 * Get version information
 */
exports.getVersion = async () => {
  return {
    version: '1.0.0-proxy',
    build: 'proxy-adapter',
    built_at: new Date().toISOString()
  };
};
