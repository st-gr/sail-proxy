/**
 * OpenAI Compatible Routes for Ollama
 * 
 * These routes provide OpenAI API compatibility as described in:
 * https://ollama.com/blog/openai-compatibility
 */

const express = require('express');
const router = express.Router();
const ollamaController = require('../controllers/ollamaController');

// OpenAI compatible chat completions endpoint
// POST /v1/chat/completions
router.post('/chat/completions', ollamaController.handleOpenAIChat);

// OpenAI compatible models list endpoint  
// GET /v1/models
router.get('/models', ollamaController.listOpenAIModels);

// OpenAI compatible embeddings endpoint (future)
// POST /v1/embeddings
router.post('/embeddings', ollamaController.handleOpenAIEmbeddings);

module.exports = router;
