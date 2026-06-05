#!/usr/bin/env node

/**
 * Ollama API Compatibility Server
 * 
 * This server provides Ollama API compatibility by transforming requests
 * to OpenAI format and proxying them to the main SAP AI Core proxy server.
 * 
 * Port: 11434 (standard Ollama port)
 * Dependencies: Express, helmet, morgan, axios
 */

// Load environment variables first
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const ollamaRoutes = require('./routes/ollamaRoutes');

const app = express();
const PORT = process.env.OLLAMA_PORT || 11434;
const HOST = process.env.OLLAMA_HOST || 'localhost';

// Main proxy base URL (where our main proxy is running)
const MAIN_PROXY_URL = process.env.MAIN_PROXY_URL || 'http://localhost:3000';

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false, // Allow embedding for some Ollama clients
}));

// CORS - Allow all origins for Ollama compatibility
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Request logging
app.use(morgan('combined'));

// Body parsing middleware
app.use(express.json({ limit: '50mb' })); // Ollama supports large image payloads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'ollama-compatibility-server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    mainProxy: MAIN_PROXY_URL
  });
});

// Root endpoint with API information
app.get('/', (req, res) => {
  res.json({
    message: 'Ollama API Compatibility Server',
    version: '1.0.0',
    mainProxy: MAIN_PROXY_URL,
    endpoints: {
      chat: 'POST /api/chat',
      generate: 'POST /api/generate',
      embeddings: 'POST /api/embed',
      models: 'GET /api/tags',
      version: 'GET /api/version',
      health: 'GET /health'
    },
    documentation: 'https://github.com/ollama/ollama/blob/main/docs/api.md'
  });
});

// Mount Ollama API routes
app.use('/api', ollamaRoutes);

// Mount OpenAI compatible routes at /v1
try {
  const openaiRoutes = require('./routes/openaiRoutes');
  app.use('/v1', openaiRoutes);
  console.log('✅ OpenAI compatible routes loaded at /v1');
} catch (error) {
  console.error('❌ Failed to load OpenAI routes:', error.message);
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Ollama Server Error:', err.stack);
  
  // Ollama-style error response
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      type: 'api_error',
      code: err.code || 'internal_error'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint not found: ${req.method} ${req.path}`,
      type: 'not_found',
      code: 'endpoint_not_found'
    }
  });
});

// Start the server
app.listen(PORT, HOST, () => {
  console.log('🦙 Ollama Compatibility Server Started');
  console.log(`📡 Server running at: http://${HOST}:${PORT}`);
  console.log(`🔗 Main proxy URL: ${MAIN_PROXY_URL}`);
  console.log('📝 Available endpoints:');
  console.log(`   - Chat: POST http://${HOST}:${PORT}/api/chat`);
  console.log(`   - Generate: POST http://${HOST}:${PORT}/api/generate`);
  console.log(`   - Embeddings: POST http://${HOST}:${PORT}/api/embed`);
  console.log(`   - Models: GET http://${HOST}:${PORT}/api/tags`);
  console.log(`   - Version: GET http://${HOST}:${PORT}/api/version`);
  console.log(`   - Health: GET http://${HOST}:${PORT}/health`);
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down Ollama Compatibility Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down Ollama Compatibility Server...');
  process.exit(0);
});

module.exports = app;
