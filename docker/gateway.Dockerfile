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

# OCI provenance labels — connect the published image to its source repo on ghcr
LABEL org.opencontainers.image.source="https://github.com/st-gr/sail-proxy" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.description="SAIL-Proxy gateway — OpenAI/Anthropic/Bedrock-compatible proxy for SAP AI Core Foundation Models"

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Install file_search extractor binaries: pandoc (.docx/.odt/.epub/.rst/.html/.tex)
# and pdftotext from poppler-utils (.pdf). Without these, those upload types fail.
# netcat-openbsd: the gateway-migrate compose service's own "wait for
# postgres" loop (same pattern admin.Dockerfile already uses for cds-deploy).
RUN apk add --no-cache pandoc poppler-utils netcat-openbsd

# Install production dependencies only (excludes devDependencies like typescript, types)
# docker/package.json AS the workspace-root package.json — the SAME file
# admin.Dockerfile already uses for the same reason (see its lines 12 and 32).
# It declares only the 13 runtime-safe root dependencies and deliberately omits
# the developer tooling the real root package.json carries (@sap-ux/fiori-mcp-server,
# @ui5/mcp-server …).
#
# pnpm installs the workspace ROOT project alongside any filtered package,
# because the root belongs to the workspace — so with the real manifest those
# tooling transitives shipped in this image: 403 packages / 423 MB, of which
# @sap-ux and @ui5 alone are code the gateway never loads.
#
# ONLY in this stage. The build stages above run root scripts (pnpm
# build:gateway) that docker/package.json does not carry, and nothing they
# install reaches the final image anyway.
COPY docker/package.json ./package.json
COPY pnpm-workspace.yaml ./
COPY services/gateway/package.docker.json ./services/gateway/package.json
COPY libs/ ./libs/
# The `rm -rf` is in THIS RUN, not a later one, on purpose: a separate layer
# would hide the files from a scanner while still shipping their bytes.
#
# corepack downloads pnpm into /root/.cache and neither it nor the corepack
# install dir is used again — nothing below this line runs pnpm, and the
# entrypoint is `node` (see CMD). Left in place they were 60.4 MB of dead weight
# AND the image's single worst finding: corepack's vendored tar@7.4.3
# (CVE-2026-59873, fixed in 7.5.19) plus 26 HIGHs — while the application's own
# tar is 7.5.22, already above the fix. Same reasoning as the npm removal
# immediately below, which this completes.
RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --prod --no-frozen-lockfile && \
    rm -rf /root/.cache /usr/local/lib/node_modules/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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