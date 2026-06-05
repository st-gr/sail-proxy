# Development vs Docker Deployment

This document explains the dual-environment approach for running the SAP LLM Gateway services.

## Quick Start

### Local Development (TypeScript)
```bash
# Terminal 1 - Admin Service
cd services/admin
pnpm run dev:ts:mock

# Terminal 2 - Gateway Service  
cd services/gateway
pnpm dev
```

### Docker Deployment
```bash
# From project root
cd docker
docker-compose up --build
```

## Architecture Overview

The project supports two deployment modes:

1. **Local Development**: TypeScript source files with `ts-node` and hot reload
2. **Docker Production**: Compiled JavaScript with optimized module resolution

## Module Resolution Strategy

### Development Environment

**Gateway Service:**
- Uses `tsconfig-paths/register` to resolve `@libs/*` imports
- TypeScript path mapping in `tsconfig.json` maps `@libs/*` to `../../libs/*`
- Hot reload with `nodemon` and `ts-node`

**Admin Service:**
- Uses environment-aware imports in `server.js`
- Automatically detects TypeScript source files vs compiled output
- Falls back to compiled versions if TypeScript sources unavailable

### Docker Environment

**Gateway Service:**
- Compiled JavaScript in `/app/services/gateway/dist/`
- Symlink: `node_modules/@libs -> /app/services/gateway/dist/libs`
- Standard Node.js module resolution

**Admin Service:**
- Compiled JavaScript in `/app/services/admin/dist/`
- Environment detection chooses compiled paths in production

## Environment Detection Logic

### Admin Service (server.js)
```javascript
const isDevelopment = process.env.NODE_ENV === 'development' || process.env.DEPLOY_TARGET === 'development';

function resolveModulePath(devPath, prodPath) {
  if (isDevelopment && fs.existsSync(devPath + '.ts')) {
    try {
      return require(devPath);  // TypeScript source
    } catch (e) {
      return require(prodPath); // Fallback to compiled
    }
  }
  return require(prodPath);     // Production compiled
}
```

## File Structure

### Development Paths
```
services/admin/
├── src/
│   ├── middleware/authMiddleware.ts     ← Development
│   └── auth/cds-auth-adapter.ts         ← Development
└── server.js                           ← Environment-aware

services/gateway/
├── src/                                ← TypeScript sources
└── tsconfig.json                       ← Path mapping for @libs/*
```

### Docker Production Paths
```
services/admin/
├── dist/
│   ├── middleware/authMiddleware.js     ← Production
│   └── auth/cds-auth-adapter.js         ← Production
└── server.js                           ← Environment-aware

services/gateway/
├── dist/
│   ├── libs/logger/                    ← Compiled @libs
│   └── services/gateway/src/           ← Compiled sources
└── node_modules/@libs -> dist/libs     ← Symlink
```

## Configuration Files

### Gateway TypeScript Config
```json
// services/gateway/tsconfig.json
{
  "compilerOptions": {
    "baseUrl": "../..",
    "paths": {
      "@libs/*": ["libs/*"]
    }
  }
}
```

### Package.json Scripts
```json
// Gateway
"dev": "nodemon --exec ts-node -r tsconfig-paths/register src/index.ts"

// Admin  
"dev:ts:mock": "cross-env NODE_ENV=development nodemon --exec ts-node -r tsconfig-paths/register src/index.ts"
```

## Troubleshooting

### Common Issues

1. **Gateway: "Cannot find module '@libs/logger'"**
   - Ensure `tsconfig-paths/register` is in the dev command
   - Check `tsconfig.json` has correct path mapping

2. **Admin: "Cannot find module './dist/middleware/authMiddleware'"**
   - Ensure TypeScript source files exist in `src/`
   - Check `server.js` has environment-aware imports

3. **Docker: Module resolution fails**
   - Verify symlinks are created in Dockerfile
   - Check compiled output structure matches expectations

### Validation Script

Run the development setup validation:
```bash
node scripts/dev-setup-check.js
```

## Environment Variables

| Variable | Development | Docker | Purpose |
|----------|------------|--------|---------|
| `NODE_ENV` | `development` | `production` | Environment detection |
| `DEPLOY_TARGET` | `development` | `docker` | Deployment mode |

## Key Benefits

1. **Fast Development**: TypeScript hot reload with `ts-node`
2. **Production Ready**: Compiled JavaScript for Docker
3. **No Breaking Changes**: Docker deployment unchanged
4. **Automatic Fallback**: Smart module resolution
5. **Environment Awareness**: Detects development vs production

## Testing Both Environments

### Development
```bash
# Check TypeScript compilation
pnpm build

# Run development servers
pnpm dev  # Gateway
pnpm run dev:ts:mock  # Admin
```

### Docker
```bash
# Build and test Docker deployment
docker-compose up --build

# Check logs for successful startup
docker-compose logs gateway
docker-compose logs admin
```

Both environments should work independently without conflicts.