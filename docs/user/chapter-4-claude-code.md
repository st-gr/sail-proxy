---
title: SAIL-PROXY User Guide - Chapter 4
author: st-gr
date: 2025-01-28
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY User Guide
*Multi-provider AI Gateway for SAP AI Core*
**Author:** *st-gr*

[<< Previous Chapter](chapter-3-installation.md) | [Content Table](README.md) | [Next Chapter >>](chapter-5-github-copilot.md)

---

## Using with Claude Code

Claude Code is Anthropic's official CLI tool that provides AI assistance for software development. By configuring Claude Code to use SAIL-PROXY, you can leverage SAP AI Core's enterprise-managed Claude models with full governance and monitoring.

### Prerequisites

- **SAIL-PROXY installed and running** (see [Installation](chapter-3-installation.md))
- **Valid API key** created through SAIL-PROXY
- **Claude Code installed**: Follow Anthropic's installation guide

### Configuration Method 1: Environment Variables

The simplest way to configure Claude Code is through environment variables:

**For Docker Deployments**:
```bash
# Set the API key
export ANTHROPIC_API_KEY="your-sail-proxy-api-key"

# Set the base URL to point to SAIL-PROXY
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"

# Prevent 'calling home' endpoints which are not implemented
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

**For Kyma Deployments**:
```bash
# Set the API key
export ANTHROPIC_API_KEY="your-sail-proxy-api-key"

# Set the base URL to your Kyma deployment
export ANTHROPIC_BASE_URL="https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/anthropic"

# Prevent 'calling home' endpoints which are not implemented
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

**⚠️ Important for Kyma**: Replace `your-subdomain.your-cluster-id.kyma.ondemand.com` with your actual Kyma domain from the deployment.

**For persistent configuration**, add these to your shell profile:

**Docker**:
```bash
# Add to ~/.bashrc, ~/.zshrc, or ~/.profile
echo 'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1' >> ~/.bashrc
echo 'export ANTHROPIC_API_KEY="your-sail-proxy-api-key"' >> ~/.bashrc
echo 'export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"' >> ~/.bashrc
source ~/.bashrc
```

**Kyma**:
```bash
# Add to ~/.bashrc, ~/.zshrc, or ~/.profile
echo 'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1' >> ~/.bashrc
echo 'export ANTHROPIC_API_KEY="your-sail-proxy-api-key"' >> ~/.bashrc
echo 'export ANTHROPIC_BASE_URL="https://your-subdomain.your-cluster-id.kyma.ondemand.com/gateway/anthropic"' >> ~/.bashrc
source ~/.bashrc
```

### Configuration Method 2: Claude Code Config

Claude Code also supports configuration files:

```bash
# Create or edit Claude Code config
nano ~/.claude/config.json
```
Edit or insert `"primaryApiKey": "your key"`.

### Model Selection

When using Claude Code with SAIL-PROXY, you can use familiar model names:

```bash
# Use Claude 4.5 Sonnet (most popular)
claude-code --model claude-sonnet-4-5-20250929

# Use Claude 4 Opus (for complex tasks)
claude-code --model claude-opus-4-20250514

# Claude 3 Haiku 
Is used in older claude code versions (e. g. 1.0.41) to summarize chat sessions for UX.
```



**Available Models (SAP)** (check current availability with `sail-proxy models list`):
- `claude-sonnet-4-5-20250929` - Latest Sonnet with improved coding capabilities
- `claude-sonnet-4-20250514` - Previous Sonnet model
- `claude-opus-4-20250514` - Most capable model for complex reasoning
- `claude-3-5-haiku-20241022` - Fastest model for simple tasks internally mapped into `anthropic--claude-3-haiku` as SAP does not offer model Claude 3.5 Haiku, nor the now needed 4.5 Haiku model or Opus 4.1 (Nov 2025).

### Usage Examples

#### Basic Code Generation

```bash
# Generate a Python function
claude -p "Create a Python function to validate email addresses using regex"

# Explain existing code
claude -p "explain app.py"

# Debug code issues
claude
Text UI:
debug file buggy_script.py "This function is throwing a TypeError"
```

#### Interactive Development Session

```bash
# Start an interactive session
claude

# In the chat session:
# > I'm building a REST API with Express.js. Can you help me set up authentication?
# > [Claude provides detailed Express.js auth implementation]
# > Can you also add rate limiting to prevent abuse?
# > [Claude adds rate limiting middleware]
```

#### File Analysis and Modification

```bash
# Analyze a specific file
claude -p "analyze src/components/UserProfile.tsx"

# Request specific changes
claude -p "Add TypeScript types to the utils.js file"

# Code review
claude
Text UI:
review --file src/api/users.py "Check for security issues and performance improvements"
```

### Advanced Configuration

#### Custom Prompts and Context

```bash
# Use custom system prompt
claude --system "You are a senior DevOps engineer. Focus on security and best practices." \
  "Help me containerize this Node.js application"

# Include additional context files
claude --include package.json,tsconfig.json,README.md \
  "Set up CI/CD pipeline for this TypeScript project"
```

#### Working with Large Codebases

```bash
# Analyze project structure
claude "Analyze this project structure and suggest improvements" --recursive src/

# Generate documentation
claude "Create comprehensive API documentation" --include "src/api/*.js"

# Refactoring assistance
claude "Suggest refactoring opportunities in this codebase" --include "src/**/*.ts"
```

### Integration Patterns

#### Development Workflow Integration

**Git Hooks Integration**:
```bash
# Pre-commit hook for code review
#!/bin/bash
# .git/hooks/pre-commit
changed_files=$(git diff --cached --name-only --diff-filter=ACM | grep '\\.js$\|\\.ts$')
if [ ! -z "$changed_files" ]; then
    claude review --files $changed_files "Quick security and style review"
fi
```

**IDE Integration**:
Many editors can be configured to use Claude Code as an external tool:
```bash
# VS Code task configuration example
{
  "label": "Claude Code Review",
  "type": "shell",
  "command": "claude",
  "args": ["review", "--file", "${file}", "Review this code for improvements"]
}
```

#### Collaborative Development

**Code Review Assistance**:
```bash
# Review pull request changes
git diff main..feature-branch > changes.diff
claude "Review these changes for potential issues" --file changes.diff

# Generate PR description
claude "Create a pull request description based on these changes" --file changes.diff
```

### Monitoring and Usage Tracking

When using Claude Code through SAIL-PROXY, all interactions are tracked:

#### View Logs (CLI users)
```bash
# Check your API usage
sail-proxy logs --tail 100 | grep "claude-sonnet-4-20250514"

# Monitor token usage
sail-proxy logs --follow | grep "token"
```

#### Admin Cockpit Monitoring (Docker users)
![Usage Dashboard](/docs/assets/usage-dashboard-claude-code.png)

1. **Access Admin Cockpit**: Navigate to your SAIL-PROXY admin interface
2. **Usage Analytics**: View detailed usage by model, time period, and user
3. **Security Events**: Monitor for unusual patterns or access attempts
4. **Cost Tracking**: Track usage costs and set budget alerts

### Troubleshooting

#### Common Issues

**Invalid Beta Flag Errors**:

When using newer versions of Claude Code (2.1.30+), you may encounter:
```json
{
  "error": {
    "message": "undefined: invalid beta flag",
    "type": "api_error"
  }
}
```

**Cause**: Claude Code sends new beta feature flags (like `prompt-caching-scope-2026-01-05`) that SAP AI Core doesn't yet support.

**Solution**: SAIL-PROXY filters these automatically via the `excluded_beta_headers` configuration in `api_config.json`. If you encounter this error:

1. Verify your `api_config.json` includes the `excluded_beta_headers` setting:
```json
{
  "api_config": {
    "anthropic": {
      "excluded_beta_headers": [
        "prompt-caching-scope-2026-01-05"
      ]
    }
  }
}
```

2. Restart the gateway service to apply configuration changes
3. Check logs for: `Filtered X unsupported beta feature(s)` to confirm filtering is working

**Authentication Errors**:
```bash
# Verify API key is valid
curl -H "x-api-key: your-api-key" http://localhost:3000/v1/models

# Check environment variables
echo $ANTHROPIC_API_KEY
echo $ANTHROPIC_BASE_URL
```

**Connection Issues**:
```bash
# Test SAIL-PROXY connectivity
curl -X GET http://localhost:3000/anthropic/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01"

# Check if SAIL-PROXY is running
sail-proxy status
```

**Model Availability**:
```bash
# List available models
sail-proxy models list

# Test specific model
curl -X POST http://localhost:3000/anthropic/v1/messages \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'
```

#### Performance Optimization

**Reduce Latency**:
- Use Claude 3 Haiku for simple tasks
- Enable response caching in SAIL-PROXY configuration
- Consider running SAIL-PROXY closer to your development environment

**Manage Costs**:
- Set token limits per API key in Admin Cockpit
- Use appropriate models for task complexity
- Monitor usage patterns and optimize accordingly

### Best Practices

#### Security
- **Never commit API keys** to version control
- **Use environment variables** for API key configuration
- **Rotate API keys regularly** (recommended every 90 days)
- **Monitor usage** for unusual patterns or unauthorized access

#### Development Efficiency
- **Use specific prompts** for better results
- **Provide context files** when working with existing codebases
- **Leverage model strengths**: Sonnet for coding, Opus for complex reasoning, Haiku for speed
- **Save common prompts** as shell aliases or scripts

#### Integration Tips
- **Test configuration** with simple queries before complex tasks
- **Monitor token usage** to understand costs and optimize usage
- **Use appropriate timeouts** for long-running code generation tasks
- **Implement fallback strategies** for network or service interruptions

---

*Next: Learn how to [integrate with GitHub Copilot](chapter-5-github-copilot.md) for enhanced development workflows.*
