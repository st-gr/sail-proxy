# Ollama API Compatibility Server

A self-contained Express server that provides Ollama API compatibility by transforming requests to OpenAI format and proxying them to the main SAP AI Core proxy server.

## Overview

This server acts as an adapter layer between Ollama clients and the main proxy server, enabling seamless integration with existing Ollama workflows while leveraging the powerful SAP AI Core infrastructure.

## Features

- **🦙 Full Ollama API Compatibility**: Supports all major Ollama endpoints
- **🔄 Request/Response Transformation**: Converts between Ollama and OpenAI formats
- **📡 Streaming Support**: Handles both streaming and non-streaming requests
- **🚀 Self-Contained**: Runs independently on port 11434 (standard Ollama port)
- **🧪 Comprehensive Testing**: Includes unit tests for all functionality
- **📊 Multiple Endpoints**: Chat, generate, embeddings, models, and more

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Ollama        │    │   Ollama        │    │   Main SAP AI   │
│   Client        │───▶│   Adapter       │───▶│   Core Proxy    │
│                 │    │   (Port 11434)  │    │   (Port 3000)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Format         │
                    │  Transformations│
                    │  • Ollama→OpenAI│
                    │  • OpenAI→Ollama│
                    └─────────────────┘
```

## Supported Endpoints

### Core Functionality
- `POST /api/chat` - Chat completions (Ollama's main interface)
- `POST /api/generate` - Text generation/completion
- `POST /api/embed` - Generate embeddings
- `GET /api/tags` - List available models

### OpenAI Compatible Endpoints
- `POST /v1/chat/completions` - OpenAI chat completions format
- `GET /v1/models` - OpenAI models list format  
- `POST /v1/embeddings` - OpenAI embeddings format

### Model Management (Read-Only)
- `GET /api/ps` - List running models
- `POST /api/show` - Show model information
- `GET /api/version` - Get version information

### System
- `GET /health` - Health check
- `GET /` - API information

### Unsupported (Returns 501)
- `POST /api/create` - Create model
- `POST /api/pull` - Pull model
- `POST /api/push` - Push model
- `DELETE /api/delete` - Delete model
- `POST /api/copy` - Copy model
- Blob operations

## Installation & Setup

### Prerequisites
- Node.js 14+ 
- Main SAP AI Core proxy running on port 3000
- Valid API key for the main proxy

### Environment Variables

Create a `.env` file in the `ollama-server` directory:

```bash
# Ollama server configuration
OLLAMA_PORT=11434
OLLAMA_HOST=localhost

# Main proxy configuration
MAIN_PROXY_URL=http://localhost:3000
MAIN_PROXY_API_KEY=your_api_key_here

# Alternative: Use OpenAI API key directly
OPENAI_API_KEY=your_api_key_here
```

### Installation

```bash
# Navigate to the ollama-server directory
cd ollama-server

# Install dependencies
npm install express helmet morgan cors axios

# Start the server
npm start
```

### Development Mode

```bash
# Install dev dependencies
npm install --save-dev nodemon

# Run in development mode with auto-restart
npm run dev
```

## Usage Examples

### Chat Completion (Streaming)

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "llama3.2",
  "messages": [
    {
      "role": "user",
      "content": "Why is the sky blue?"
    }
  ]
}'
```

### Chat Completion (Non-Streaming)

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gpt-4",
  "messages": [
    {
      "role": "user", 
      "content": "Explain quantum computing"
    }
  ],
  "stream": false
}'
```

### Text Generation

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "gpt-3.5-turbo",
  "prompt": "Complete this story: Once upon a time",
  "stream": false
}'
```

### Generate with JSON Format

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "gpt-4",
  "prompt": "List 3 colors in JSON format",
  "format": "json",
  "stream": false
}'
```

### Structured Output

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "Give me a person with age and name"}],
  "format": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "integer"}
    },
    "required": ["name", "age"]
  },
  "stream": false
}'
```

### Embeddings

```bash
curl http://localhost:11434/api/embed -d '{
  "model": "text-embedding-ada-002",
  "input": "The quick brown fox jumps over the lazy dog"
}'
```

### List Models

```bash
curl http://localhost:11434/api/tags
```

### Multimodal (Images)

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "gpt-4-vision-preview",
  "messages": [
    {
      "role": "user",
      "content": "What is in this image?",
      "images": ["base64_encoded_image_data_here"]
    }
  ]
}'
```

## API Request/Response Formats

### Chat Request Format (Ollama)

```json
{
  "model": "llama3.2",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "stream": true,
  "options": {
    "temperature": 0.7,
    "top_p": 0.9,
    "top_k": 20,
    "num_predict": 100,
    "stop": ["stop_word"],
    "seed": 42
  },
  "format": "json",
  "tools": [...],
  "keep_alive": "5m"
}
```

### Chat Response Format (Ollama)

```json
{
  "model": "llama3.2",
  "created_at": "2023-08-04T19:22:45.499127Z",
  "message": {
    "role": "assistant",
    "content": "Hello! How can I help you today?"
  },
  "done": true,
  "total_duration": 5191566416,
  "load_duration": 2154458,
  "prompt_eval_count": 26,
  "prompt_eval_duration": 383809000,
  "eval_count": 298,
  "eval_duration": 4799921000
}
```

## Format Transformations

### Ollama → OpenAI Transformations

| Ollama Parameter | OpenAI Equivalent | Notes |
|------------------|-------------------|-------|
| `options.temperature` | `temperature` | Direct mapping |
| `options.top_p` | `top_p` | Direct mapping |
| `options.num_predict` | `max_tokens` | Direct mapping |
| `options.stop` | `stop` | Direct mapping |
| `options.seed` | `seed` | Direct mapping |
| `format: "json"` | `response_format: {type: "json_object"}` | JSON mode |
| `format: {schema}` | `response_format: {type: "json_schema"}` | Structured output |
| `messages[].images` | `messages[].content[].image_url` | Multimodal |

### OpenAI → Ollama Transformations

| OpenAI Field | Ollama Equivalent | Notes |
|--------------|-------------------|-------|
| `choices[0].message` | `message` | Direct mapping |
| `choices[0].finish_reason` | `done_reason` | Direct mapping |
| `usage.prompt_tokens` | `prompt_eval_count` | Token counts |
| `usage.completion_tokens` | `eval_count` | Token counts |
| Stream chunks | JSON objects with `\n` | Format conversion |

## Testing

Run the comprehensive test suite:

```bash
# Run all tests
node tests/ollamaAdapter.test.js

# Or if you have npm test configured
npm test
```

Test coverage includes:
- ✅ Request transformations
- ✅ Non-streaming chat
- ✅ Non-streaming generate
- ✅ Streaming responses
- ✅ Embeddings
- ✅ Models list
- ✅ Version info
- ✅ Error handling

## Configuration

### Main Proxy Integration

The adapter automatically discovers the main proxy configuration and available models. Ensure:

1. Main proxy is running on configured URL (default: `http://localhost:3000`)
2. Valid API key is provided
3. Main proxy has OpenAI-compatible endpoints enabled

### Model Mapping

Models are automatically mapped from the main proxy's model list. Custom model mappings can be configured by modifying the `listModels()` function in `services/ollamaAdapter.js`.

## Error Handling

The server provides Ollama-compatible error responses:

```json
{
  "error": {
    "message": "Error description",
    "type": "api_error",
    "code": "specific_error_code"
  }
}
```

Common error scenarios:
- Main proxy connection failure
- Invalid API key
- Model not found
- Invalid request format
- Streaming interruption

## Logging

The server provides detailed logging for:
- Request/response transformations
- Main proxy communication
- Error conditions
- Performance metrics

Logs are output to the console with structured formatting.

## Performance Considerations

- **Streaming**: Maintains connection efficiency for real-time responses
- **Timeout Handling**: Configurable timeouts for different request types
- **Memory Usage**: Efficient handling of large payloads (images, long texts)
- **Connection Pooling**: Reuses connections to the main proxy

## Limitations

1. **Model Management**: Read-only access (no model creation/modification)
2. **Blob Operations**: Not supported in proxy mode
3. **Context Memory**: Limited to OpenAI's context handling capabilities
4. **Custom Model Files**: Cannot handle local model files

## Troubleshooting

### Common Issues

**Connection Refused**
```
Error: Cannot connect to main proxy at http://localhost:3000
```
- Ensure main proxy is running
- Check MAIN_PROXY_URL configuration
- Verify network connectivity

**Authentication Failed**
```
Error: Main proxy error: 401 Unauthorized
```
- Check API key configuration
- Verify key has required permissions
- Test key with main proxy directly

**Model Not Found**
```
Error: Model 'invalid-model' not found
```
- Check available models with `GET /api/tags`
- Verify model name spelling
- Ensure model is available in main proxy

### Debug Mode

Enable detailed logging:

```bash
DEBUG=true node index.js
```

### Health Check

Check server health:

```bash
curl http://localhost:11434/health
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

This project follows the same license as the main SAP AI Core proxy project.

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review the test suite for examples
3. Examine logs for error details
4. Open an issue with reproduction steps

## 🔗 OpenAI API Compatibility

As of the latest update, this server now supports **official OpenAI-compatible endpoints** as specified in [Ollama's OpenAI compatibility blog post](https://ollama.com/blog/openai-compatibility):

### OpenAI Compatible Endpoints
- `POST /v1/chat/completions` - OpenAI chat completions format
- `GET /v1/models` - OpenAI models list format
- `POST /v1/embeddings` - OpenAI embeddings format

### Usage with OpenAI SDKs

#### Python
```python
from openai import OpenAI

client = OpenAI(
    base_url='http://localhost:11434/v1',
    api_key='ollama'  # required but unused
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

#### JavaScript
```javascript
import OpenAI from 'openai'

const openai = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama', // required but unused
})

const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
})
```

#### cURL
```bash
curl http://localhost:11434/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hello!"}]
    }'
```
