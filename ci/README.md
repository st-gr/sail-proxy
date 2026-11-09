# CI Configuration and Scripts

This directory contains all CI/CD related files and configurations for the SAP LLM Gateway project.

## 📁 Directory Structure

```
ci/
├── ci-pipeline.js          # Main CI pipeline script
├── CI_PIPELINE.md          # Detailed pipeline documentation
├── README.md               # This file
├── scripts/                # Additional CI scripts
│   ├── health-check.js     # Service health checking
│   ├── test-runner.js      # Test execution utilities
│   └── docker-utils.js     # Docker helper functions
└── config/                 # CI configuration files
    ├── jest.config.js      # Jest configuration for CI
    └── test-env.json       # Test environment settings
```

## 🚀 Quick Start

```bash
# Run the full CI pipeline
pnpm run ci

# Run individual CI components
node ci/ci-pipeline.js
```

## 📋 Available Scripts

| Script | Description |
|--------|-------------|
| `ci-pipeline.js` | Complete CI/CD pipeline |
| `scripts/health-check.js` | Service health verification |
| `scripts/test-runner.js` | Test execution with reporting |
| `scripts/docker-utils.js` | Docker container management |

## 🔧 Configuration

### Environment Variables
- `SAP_AI_CORE_SERVICE_KEY` - SAP AI Core service credentials (JSON)
- `CI` - Set to `true` in CI environments
- `NODE_ENV` - Environment mode (`test`, `development`, `production`)

### Test Configuration
- Jest configuration optimized for CI execution
- Test timeouts increased for CI environments
- Parallel test execution settings

## 📊 Pipeline Monitoring

The CI pipeline provides:
- ✅ Real-time progress logging with colors
- 📈 Performance metrics and timing
- 🔍 Health checks for all services
- 🧹 Automatic resource cleanup
- 📊 Test result reporting

## 🛠️ Development

When adding new CI functionality:

1. Place scripts in the appropriate subfolder
2. Update this README with documentation
3. Add relevant npm scripts to root `package.json`
4. Test locally before committing

## 🐳 Docker Integration

The CI system includes:
- Container orchestration for services
- Health checks and service discovery
- Automatic cleanup of test containers
- Docker security scanning

## 🔍 Troubleshooting

See `CI_PIPELINE.md` for detailed troubleshooting information.