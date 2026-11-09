/**
 * Ollama API Routes
 * 
 * Defines all Ollama API endpoints and routes them to appropriate controllers.
 */

const express = require('express');
const router = express.Router();
const ollamaController = require('../controllers/ollamaController');

// Chat completion endpoint - Ollama's main conversational interface
router.post('/chat', ollamaController.handleChat);

// Text generation endpoint - Ollama's completion interface
router.post('/generate', ollamaController.handleGenerate);

// Embeddings endpoint
router.post('/embed', ollamaController.handleEmbed);

// Model management endpoints
router.get('/tags', ollamaController.listModels);
router.get('/ps', ollamaController.listRunningModels);

// Model lifecycle endpoints
router.post('/create', ollamaController.createModel);
router.post('/pull', ollamaController.pullModel);
router.post('/push', ollamaController.pushModel);
router.delete('/delete', ollamaController.deleteModel);
router.post('/copy', ollamaController.copyModel);

// Model information endpoint
router.post('/show', ollamaController.showModel);

// Version endpoint
router.get('/version', ollamaController.getVersion);

// Blob management (for model files)
router.head('/blobs/:digest', ollamaController.checkBlob);
router.post('/blobs/:digest', ollamaController.pushBlob);

module.exports = router;
