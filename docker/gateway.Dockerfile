# Multi-stage Dockerfile for Gateway Service
FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy package files and workspace config
COPY package.json pnpm-workspace.yaml ./
COPY services/gateway/package.docker.json ./services/gateway/package.json
COPY libs/ ./libs/

# Install dependencies
# Disable isolated linker for Docker compatibility  
RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --no-frozen-lockfile

# Build stage
FROM node:20-alpine AS build

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy package files and source
COPY package.json pnpm-workspace.yaml ./
COPY services/gateway/package.docker.json ./services/gateway/package.json
COPY services/gateway/tsconfig.json ./services/gateway/
COPY libs/ ./libs/
COPY services/gateway/src/ ./services/gateway/src/
COPY services/gateway/config/ ./services/gateway/config/

# Install all dependencies for build
# Disable isolated linker for Docker compatibility
RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --no-frozen-lockfile

# Build TypeScript (this should install iovalkey and other dependencies)
RUN pnpm build:gateway

# Production stage
FROM node:20-alpine AS production

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Install production dependencies only (excludes devDependencies like typescript, types)
COPY package.json pnpm-workspace.yaml ./
COPY services/gateway/package.docker.json ./services/gateway/package.json
COPY libs/ ./libs/
RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --prod --no-frozen-lockfile

# Create non-root user and remove global npm to eliminate bundled vulnerabilities
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Create logs directory
RUN mkdir -p /app/logs
COPY --chown=nodejs:nodejs --from=build /app/services/gateway/dist ./services/gateway/dist
COPY --chown=nodejs:nodejs --from=build /app/libs ./libs
COPY --chown=nodejs:nodejs --from=build /app/services/gateway/config ./services/gateway/config

# Create plugins directory structure to match expected path
# The plugin loader expects ./src/plugins but plugins should remain in their compiled location
RUN mkdir -p /app/src && \
    chown -R nodejs:nodejs /app/src && \
    ln -s /app/services/gateway/dist/services/gateway/src/plugins /app/src/plugins

# Create symlinks for module resolution and @libs path mapping to work at runtime
RUN mkdir -p node_modules && ln -sf /app/services/gateway/dist/libs node_modules/@libs

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV DEPLOY_TARGET=docker

CMD ["node", "services/gateway/dist/services/gateway/src/index.js"]