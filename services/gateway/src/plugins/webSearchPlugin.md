# Web Search Plugin

## Overview

The `webSearchPlugin` intercepts Anthropic API requests containing the `web_search` server tool, executes searches via Perplexity's sonar-pro model through SAP AI Core, and returns results in Anthropic's expected format.

## Problem Statement

Anthropic's `web_search` tool (`web_search_20250305`, `web_search_20260209`) is a **server-side tool** that Anthropic's API executes automatically on their infrastructure. When a client sends a request with this tool type, Anthropic's servers handle the web search execution transparently.

However, SAP AI Core:
1. Does not recognize the `web_search_*` server tool type
2. Cannot execute server-side tools
3. Rejects requests containing unknown tool types

This means Claude Code and other clients using the web search feature would fail when routed through the SAP AI Core gateway.

## Solution

The plugin implements a two-phase interception strategy:

### Phase 1: Before Handler (Request Transformation)

1. **Detect** requests containing `web_search` tools (by type starting with `web_search_` or name `web_search`)
2. **Transform** the server tool definition into a regular tool schema that SAP AI Core accepts:
   ```json
   {
     "name": "web_search",
     "description": "Search the web for current information...",
     "input_schema": {
       "type": "object",
       "properties": {
         "query": { "type": "string", "description": "The search query..." }
       },
       "required": ["query"]
     }
   }
   ```
3. **Check** for pending search executions from previous conversation turns (tool_use without corresponding tool_result)
4. If pending, **execute** the search and inject the result into the messages

### Phase 2: After Handler (Response Transformation)

1. **Detect** if Claude's response contains a `tool_use` block for `web_search`
2. **Execute** the search query via Perplexity sonar-pro through SAP AI Core orchestration
3. **Transform** the response to match Anthropic's expected format:
   - Replace `tool_use` with `server_tool_use`
   - Add `web_search_tool_result` block with search results
   - Add text block with citations

## Request Flow

```
Client Request (with web_search server tool)
         │
         ▼
┌─────────────────────────────────────────┐
│  BEFORE HANDLER                         │
│  • Transform server tool → regular tool │
│  • Handle pending searches from history │
└─────────────────────────────────────────┘
         │
         ▼
    SAP AI Core
  (Claude processes request)
         │
         ▼
┌─────────────────────────────────────────┐
│  AFTER HANDLER                          │
│  • Detect tool_use for web_search       │
│  • Execute search via Perplexity        │
│  • Transform to Anthropic format        │
└─────────────────────────────────────────┘
         │
         ▼
   Client receives response
   (with web_search_tool_result)
```

## Files

| File | Purpose |
|------|---------|
| `webSearchPlugin.ts` | Main plugin implementation |
| `webSearchPlugin.system-prompt.txt` | System prompt for Perplexity sonar-pro (editable without code changes) |
| `webSearchPlugin.md` | This documentation |

## Configuration

### Hook Definition (api_config.json)

```json
{
  "hookDefinitions": {
    "tools:hasWebSearch": {
      "desc": "Match requests containing web_search tool",
      "type": "json-path-regex",
      "path": "$.tools",
      "regex": "web_search",
      "flags": "i"
    }
  }
}
```

### Model Hooks

The plugin is attached to Claude 4.5+ models for both `invoke` and `invoke-with-response-stream` subpaths:

```json
{
  "hooks": {
    "invoke": [
      {
        "request": {
          "callback": { "id": "webSearchPlugin" },
          "match": ["tools:hasWebSearch"]
        }
      }
    ]
  }
}
```

## Perplexity Integration

The plugin calls Perplexity's `sonar-pro` model using two strategies, in priority order:

### 1. Direct Deployment (preferred)

If a `foundation-models` deployment for `sonar-pro` is discovered via auto-discovery, the plugin calls it directly at `/v2/inference/deployments/{id}/chat/completions`. This preserves Perplexity's native `citations` and `search_results` response fields, providing **validated URLs** from Perplexity's search index.

```typescript
const payload = {
  model: 'sonar-pro',
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Search query: ${query}` }
  ],
  temperature: 0.1
};
```

The deployment is auto-discovered by matching `details.resources.backendDetails.model.name === 'sonar-pro'` among running `foundation-models` deployments.

### 2. Orchestration Fallback

If no direct deployment is found, the plugin falls back to SAP AI Core orchestration (`/v2/inference/deployments/{id}/completion`). **Note**: The orchestration wrapper strips Perplexity's `citations` and `search_results` fields from the response (see [SAP incident report](../../../docs/sap-incident-orchestration-strips-perplexity-fields.md)). In this mode, URLs in search results are LLM-generated and may be hallucinated.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEBSEARCH_FORCE_ORCHESTRATION` | `false` | Set to `true` to bypass direct deployment discovery and force the orchestration path. Useful for debugging or comparing response formats. |

The system prompt instructs sonar-pro to return structured JSON with:
- `summary`: Brief answer to the query
- `results`: Array of search results with title, url, snippet, content, date
- `citations_used`: References used

## Response Format

The plugin transforms responses to match Anthropic's web search format:

```json
{
  "content": [
    { "type": "text", "text": "Let me search for that..." },
    {
      "type": "server_tool_use",
      "id": "toolu_xxx",
      "name": "web_search",
      "input": { "query": "..." }
    },
    {
      "type": "web_search_tool_result",
      "tool_use_id": "toolu_xxx",
      "content": [
        {
          "type": "web_search_result",
          "url": "https://...",
          "title": "...",
          "encrypted_content": "base64...",
          "page_age": "April 2025"
        }
      ]
    },
    {
      "type": "text",
      "text": "Based on web search results...",
      "citations": [...]
    }
  ],
  "stop_reason": "end_turn"
}
```

## Error Handling

1. **Search execution failure**: Returns empty results so Claude can respond gracefully
2. **Perplexity timeout**: 30-second timeout, falls back to empty results
3. **Invalid response format**: Logs warning, attempts fallback text parsing
4. **SAP AI Core unavailable**: Passes through original request without search

## Performance Considerations

- System prompt is cached after first load
- Hook matching uses optimized array iteration with early exit
- Individual tool objects are stringified (not entire arrays) for regex matching

## Testing

```bash
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "tools": [{"type": "web_search_20250305", "name": "web_search"}],
    "messages": [{"role": "user", "content": "What is the current weather in Berlin?"}]
  }'
```

## Limitations

1. **Streaming**: The plugin works with streaming responses but sonar-pro itself doesn't support streaming, so search execution is synchronous
2. **Token accounting**: Token usage from Perplexity calls is not currently merged with Claude's usage stats
3. **Rate limits**: Subject to both Claude and Perplexity rate limits through SAP AI Core

## Related Documentation

- [Plugin System](../../../docs/chapter-13-plugin-system.md)
- [SAP AI Core Orchestration](../../../docs/sap-ai-core.md)
- [Anthropic Web Search Tool](https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool)
