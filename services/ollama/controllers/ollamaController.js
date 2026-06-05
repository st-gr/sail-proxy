/**
 * Ollama Controller
 * 
 * Thin controller layer that handles Ollama API requests and delegates
 * to the appropriate adapter services for format transformation.
 */

const ollamaAdapter = require('../services/ollamaAdapter');

/**
 * Handle Ollama chat completion requests
 * POST /api/chat
 */
exports.handleChat = async (req, res) => {
  try {
    console.log(`[Ollama Chat] Request: ${JSON.stringify(req.body, null, 2)}`);
    
    const { stream = true } = req.body;
    
    if (stream) {
      // Set up streaming response
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      await ollamaAdapter.handleStreamingChat(req.body, res);
    } else {
      const result = await ollamaAdapter.handleNonStreamingChat(req.body);
      res.json(result);
    }
  } catch (error) {
    console.error('[Ollama Chat] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to process chat request',
        type: 'api_error',
        code: 'chat_error'
      }
    });
  }
};

/**
 * Handle Ollama text generation requests
 * POST /api/generate
 */
exports.handleGenerate = async (req, res) => {
  try {
    console.log(`[Ollama Generate] Request: ${JSON.stringify(req.body, null, 2)}`);
    
    const { stream = true } = req.body;
    
    if (stream) {
      // Set up streaming response
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      await ollamaAdapter.handleStreamingGenerate(req.body, res);
    } else {
      const result = await ollamaAdapter.handleNonStreamingGenerate(req.body);
      res.json(result);
    }
  } catch (error) {
    console.error('[Ollama Generate] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to process generate request',
        type: 'api_error',
        code: 'generate_error'
      }
    });
  }
};

/**
 * Handle Ollama embeddings requests
 * POST /api/embed
 */
exports.handleEmbed = async (req, res) => {
  try {
    console.log(`[Ollama Embed] Request: ${JSON.stringify(req.body, null, 2)}`);
    
    const result = await ollamaAdapter.handleEmbeddings(req.body);
    res.json(result);
  } catch (error) {
    console.error('[Ollama Embed] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to process embeddings request',
        type: 'api_error',
        code: 'embeddings_error'
      }
    });
  }
};

/**
 * List available models
 * GET /api/tags
 */
exports.listModels = async (req, res) => {
  try {
    console.log('[Ollama Models] Listing available models - START');
    
    const result = await ollamaAdapter.listModels();
    
    console.log('[Ollama Models] Result from adapter:', JSON.stringify(result, null, 2));
    
    // Validate the result structure
    if (!result || !result.models || !Array.isArray(result.models)) {
      console.error('[Ollama Models] ERROR: Invalid result structure:', result);
      throw new Error('Invalid models response structure');
    }    // Validate each model has required fields
    for (let i = 0; i < result.models.length; i++) {
      const model = result.models[i];
      if (!model.model || typeof model.model !== 'string') {
        console.error(`[Ollama Models] ERROR: Model ${i} has invalid name:`, model);
        throw new Error(`Model ${i} has invalid name field`);
      }
      if (model.model.trim() === '') {
        console.error(`[Ollama Models] ERROR: Model ${i} has empty name:`, model);
        throw new Error(`Model ${i} has empty name field`);
      }
      if (!model.name || typeof model.name !== 'string') {
        console.error(`[Ollama Models] ERROR: Model ${i} has invalid name field:`, model);
        throw new Error(`Model ${i} has invalid name field`);
      }
    }    // Return the full Ollama models structure (not just names)
    console.log(`[Ollama Models] Sending full Ollama models response with ${result.models.length} models`);
    console.log(`[Ollama Models] Sample model:`, JSON.stringify(result.models[0], null, 2));
    
    res.json(result);
  } catch (error) {
    console.error('[Ollama Models] Error:', error);
    console.error('[Ollama Models] Error stack:', error.stack);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to list models',
        type: 'api_error',
        code: 'models_error'
      }
    });
  }
};

/**
 * List running models
 * GET /api/ps
 */
exports.listRunningModels = async (req, res) => {
  try {
    console.log('[Ollama Running Models] Listing running models');
    
    const result = await ollamaAdapter.listRunningModels();
    res.json(result);
  } catch (error) {
    console.error('[Ollama Running Models] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to list running models',
        type: 'api_error',
        code: 'running_models_error'
      }
    });
  }
};

/**
 * Get version information
 * GET /api/version
 */
exports.getVersion = async (req, res) => {
  try {
    const result = await ollamaAdapter.getVersion();
    res.json(result);
  } catch (error) {
    console.error('[Ollama Version] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to get version',
        type: 'api_error',
        code: 'version_error'
      }
    });
  }
};

/**
 * Model management endpoints - These are mostly stubs since we don't actually manage models
 * but return appropriate responses for Ollama client compatibility
 */

exports.createModel = async (req, res) => {
  res.status(501).json({
    error: {
      message: 'Model creation not supported in proxy mode',
      type: 'not_implemented',
      code: 'create_not_supported'
    }
  });
};

exports.pullModel = async (req, res) => {
  res.status(501).json({
    error: {
      message: 'Model pulling not supported in proxy mode',
      type: 'not_implemented',
      code: 'pull_not_supported'
    }
  });
};

exports.pushModel = async (req, res) => {
  res.status(501).json({
    error: {
      message: 'Model pushing not supported in proxy mode',
      type: 'not_implemented',
      code: 'push_not_supported'
    }
  });
};

exports.deleteModel = async (req, res) => {
  res.status(501).json({
    error: {
      message: 'Model deletion not supported in proxy mode',
      type: 'not_implemented',
      code: 'delete_not_supported'
    }
  });
};

exports.copyModel = async (req, res) => {
  res.status(501).json({
    error: {
      message: 'Model copying not supported in proxy mode',
      type: 'not_implemented',
      code: 'copy_not_supported'
    }
  });
};

exports.showModel = async (req, res) => {
  try {
    console.log('[Ollama Show Model] Request body:', JSON.stringify(req.body, null, 2));
    
    // Validate request body
    if (!req.body || !req.body.model) {
      return res.status(400).json({
        error: {
          message: 'Model name is required in request body',
          type: 'invalid_request',
          code: 'missing_model'
        }
      });
    }
    
    const result = await ollamaAdapter.showModel(req.body);
    res.json(result);
  } catch (error) {
    console.error('[Ollama Show Model] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to show model information',
        type: 'api_error',
        code: 'show_model_error'
      }
    });
  }
};

exports.checkBlob = async (req, res) => {
  res.status(404).end(); // Blobs not supported in proxy mode
};

exports.pushBlob = async (req, res) => {
  res.status(501).json({
    error: {
      message: 'Blob operations not supported in proxy mode',
      type: 'not_implemented',
      code: 'blob_not_supported'
    }
  });
};

/**
 * Handle OpenAI compatible chat completions
 * POST /v1/chat/completions
 */
exports.handleOpenAIChat = async (req, res) => {
  try {
    console.log('[OpenAI Chat] Received OpenAI-compatible chat request');
    
    // Convert OpenAI request to Ollama format
    const openaiRequest = req.body;
    const ollamaRequest = {
      model: openaiRequest.model,
      messages: openaiRequest.messages,
      stream: openaiRequest.stream !== false, // Default to streaming
      options: {}
    };
    
    // Map OpenAI parameters to Ollama options
    if (openaiRequest.temperature !== undefined) {
      ollamaRequest.options.temperature = openaiRequest.temperature;
    }
    if (openaiRequest.top_p !== undefined) {
      ollamaRequest.options.top_p = openaiRequest.top_p;
    }
    if (openaiRequest.max_tokens !== undefined) {
      ollamaRequest.options.num_predict = openaiRequest.max_tokens;
    }
    if (openaiRequest.stop) {
      ollamaRequest.options.stop = openaiRequest.stop;
    }
    if (openaiRequest.presence_penalty !== undefined) {
      ollamaRequest.options.presence_penalty = openaiRequest.presence_penalty;
    }
    if (openaiRequest.frequency_penalty !== undefined) {
      ollamaRequest.options.frequency_penalty = openaiRequest.frequency_penalty;
    }
    if (openaiRequest.seed !== undefined) {
      ollamaRequest.options.seed = openaiRequest.seed;
    }
    
    // Handle response format
    if (openaiRequest.response_format) {
      if (openaiRequest.response_format.type === 'json_object') {
        ollamaRequest.format = 'json';
      } else if (openaiRequest.response_format.type === 'json_schema') {
        ollamaRequest.format = openaiRequest.response_format.json_schema.schema;
      }
    }
    
    // Handle tools
    if (openaiRequest.tools) {
      ollamaRequest.tools = openaiRequest.tools;
    }
    
    if (ollamaRequest.stream) {
      // Streaming response - convert Ollama stream to OpenAI format
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      await ollamaAdapter.handleStreamingChat(ollamaRequest, {
        write: (data) => {
          // Convert Ollama chunk to OpenAI format
          const ollamaChunk = JSON.parse(data);
          const openaiChunk = convertOllamaToOpenAIChunk(ollamaChunk);
          res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        },
        end: () => {
          res.write('data: [DONE]\n\n');
          res.end();
        },
        writableEnded: false
      });
    } else {
      // Non-streaming response
      const ollamaResponse = await ollamaAdapter.handleNonStreamingChat(ollamaRequest);
      const openaiResponse = convertOllamaToOpenAIResponse(ollamaResponse);
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('[OpenAI Chat] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to process OpenAI chat request',
        type: 'api_error',
        code: 'openai_chat_error'
      }
    });
  }
};

/**
 * List models in OpenAI format
 * GET /v1/models
 */
exports.listOpenAIModels = async (req, res) => {
  try {
    console.log('[OpenAI Models] Listing models in OpenAI format');
    
    const ollamaModels = await ollamaAdapter.listModels();
    
    // Convert Ollama models format to OpenAI format
    const openaiModels = {
      object: 'list',
      data: ollamaModels.models.map(model => ({
        id: model.model,
        object: 'model',
        created: Math.floor(new Date(model.modified_at).getTime() / 1000),
        owned_by: 'ollama',
        permission: [],
        root: model.model,
        parent: model.details.parent_model || null
      }))
    };
    
    res.json(openaiModels);
    
  } catch (error) {
    console.error('[OpenAI Models] Error listing models:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to list models',
        type: 'api_error',
        code: 'models_error'
      }
    });
  }
};

/**
 * Handle OpenAI compatible embeddings
 * POST /v1/embeddings
 */
exports.handleOpenAIEmbeddings = async (req, res) => {
  try {
    console.log('[OpenAI Embeddings] Received OpenAI-compatible embeddings request');
    
    const openaiRequest = req.body;
    const ollamaRequest = {
      model: openaiRequest.model,
      input: openaiRequest.input
    };
    
    const ollamaResponse = await ollamaAdapter.handleEmbeddings(ollamaRequest);
    
    // Convert Ollama embeddings format to OpenAI format
    const openaiResponse = {
      object: 'list',
      data: ollamaResponse.embeddings.map((embedding, index) => ({
        object: 'embedding',
        embedding: embedding,
        index: index
      })),
      model: ollamaResponse.model,
      usage: {
        prompt_tokens: ollamaResponse.prompt_eval_count || 0,
        total_tokens: ollamaResponse.prompt_eval_count || 0
      }
    };
    
    res.json(openaiResponse);
    
  } catch (error) {
    console.error('[OpenAI Embeddings] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Failed to process embeddings request',
        type: 'api_error',
        code: 'embeddings_error'
      }
    });
  }
};

// Helper functions for format conversion
function convertOllamaToOpenAIChunk(ollamaChunk) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: ollamaChunk.model,
    choices: [{
      index: 0,
      delta: {
        role: ollamaChunk.done ? undefined : (ollamaChunk.message?.role || 'assistant'),
        content: ollamaChunk.done ? undefined : (ollamaChunk.message?.content || ''),
        tool_calls: ollamaChunk.message?.tool_calls || undefined
      },
      finish_reason: ollamaChunk.done ? (ollamaChunk.done_reason || 'stop') : null
    }]
  };
}

function convertOllamaToOpenAIResponse(ollamaResponse) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ollamaResponse.model,
    choices: [{
      index: 0,
      message: {
        role: ollamaResponse.message.role,
        content: ollamaResponse.message.content,
        tool_calls: ollamaResponse.message.tool_calls || undefined
      },
      finish_reason: ollamaResponse.done_reason || 'stop'
    }],
    usage: {
      prompt_tokens: ollamaResponse.prompt_eval_count || 0,
      completion_tokens: ollamaResponse.eval_count || 0,
      total_tokens: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
    }
  };
}
