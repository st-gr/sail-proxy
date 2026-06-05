# Multi-stage Dockerfile for Admin Service
# Note: Uses package.docker.json to exclude SQLite dependencies that require Python/build tools
# Docker deployment uses PostgreSQL only, SQLite is for local development
FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy package files and workspace config - use Docker-optimized package.json (NO MCP SERVERS!)
COPY docker/package.json ./package.json
COPY pnpm-workspace.yaml ./
# Use Docker-optimized package.json (no SQLite dependencies)
COPY services/admin/package.docker.json ./services/admin/package.json
COPY libs/ ./libs/

# Install dependencies for workspace (include dev deps for CAP build tools)
# Disable isolated linker for Docker compatibility
# Note: Using --no-frozen-lockfile since we use package.docker.json with different deps
RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --no-frozen-lockfile

# Build stage
FROM node:20-alpine AS build

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

# Copy package files and source - use Docker-optimized package.json (NO MCP SERVERS!)
COPY docker/package.json ./package.json
COPY pnpm-workspace.yaml ./
# Use Docker-optimized package.json (no SQLite dependencies)
COPY services/admin/package.docker.json ./services/admin/package.json
COPY services/admin/tsconfig.json ./services/admin/
COPY services/admin/.cdsrc.json ./services/admin/
COPY services/admin/.cdsrc.docker.json ./services/admin/
COPY libs/ ./libs/
COPY services/admin/src/ ./services/admin/src/
# Copy UI5 applications for Docker deployment
COPY services/admin/app/ ./services/admin/app/
# Note: gen/ directory will be created by cds build command

# Install all dependencies for build
# Disable isolated linker for Docker compatibility
# Note: Using --no-frozen-lockfile since we use package.docker.json with different deps
RUN echo "node-linker=hoisted" >> .npmrc && pnpm install --no-frozen-lockfile

# Build libs first
WORKDIR /app/libs
RUN pnpm build && \
    echo "=== Verifying libs build output ===" && \
    ls -la dist/ && \
    ls -la dist/logger/

# Build TypeScript from admin service directory
WORKDIR /app/services/admin
RUN pnpm build

# Build UI5 applications with preload mode (fast builds) and cache SAPUI5 framework
# Using BuildKit cache mount to avoid re-downloading SAPUI5 framework each build
RUN --mount=type=cache,target=/root/.ui5/framework,sharing=locked \
    echo "=== Building UI5 Applications with framework cache ===" && \
    cd app/shell && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../api-keys-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../aws-credentials-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../config-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../security-notifications-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../usage-analytics-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    echo "✅ UI5 applications built successfully with cached SAPUI5 framework"

# Update index.html and manifest.json files for Docker deployment
RUN echo "=== Updating files for Docker deployment ===" && \
    for app in shell api-keys-app aws-credentials-app config-app security-notifications-app usage-analytics-app; do \
        # Update index.html to use absolute path with /admin prefix
        if [ -f "app/$app/dist/index.html" ]; then \
            # Handle both relative (resources/) and absolute (/resources/) paths
            sed -i 's|src="/\?resources/sap-ui-core\.js"|src="/admin/resources/sap-ui-core.js"|g' "app/$app/dist/index.html" && \
            echo "✅ Updated $app index.html to use /admin/resources path for nginx routing" && \
            echo "   Verifying update:" && \
            grep "sap-ui-core.js" "app/$app/dist/index.html" || echo "   WARNING: sap-ui-core.js not found in index.html"; \
        fi; \
        # Update manifest.json to fix OData service URI
        if [ -f "app/$app/dist/manifest.json" ]; then \
            sed -i 's|"uri": "/odata/v4/admin/"|"uri": "/admin/odata/v4/admin/"|g' "app/$app/dist/manifest.json" && \
            echo "✅ Updated $app manifest.json to use /admin/odata/v4/admin/ path" && \
            grep '"uri":' "app/$app/dist/manifest.json" || echo "   WARNING: URI not found in manifest.json"; \
        fi; \
    done

# Copy UI5 optimization script and run it in build stage
COPY docker/scripts/consolidate-ui5-resources.js /tmp/consolidate-ui5-resources.js

# Optimize UI5 resources in build stage
RUN echo "=== Optimizing UI5 Resources in Build Stage ===" && \
    export ADMIN_ROOT=/app/services/admin && \
    node /tmp/consolidate-ui5-resources.js && \
    rm /tmp/consolidate-ui5-resources.js && \
    echo "✅ UI5 resources optimized - symlinks created in build stage"

# Webcomponents are now loaded via SAPUI5 wrapper libraries, no manual fixes needed

# Verify build output and structure
RUN echo "=== BUILD OUTPUT STRUCTURE ===" && \
    find dist -type f -name "*.js" | head -20 && \
    echo "=== CHECKING FOR SERVICE IMPLEMENTATIONS ===" && \
    find dist -name "*service*.js" -type f && \
    echo "=== CHECKING FOR PROCESSORS ===" && \
    find dist -name "*processor*.js" -type f && \
    echo "=== DIST DIRECTORY STRUCTURE ===" && \
    ls -la dist/ 2>/dev/null || echo "dist/ not found" && \
    echo "=== CHECKING FOR CSN AND EDMX FILES ===" && \
    ls -la dist/srv/csn.json 2>/dev/null || echo "WARNING: csn.json not found!" && \
    ls -la dist/srv/odata/v4/*.xml 2>/dev/null || echo "WARNING: EDMX files not found!" && \
    echo "=== CHECKING UI5 BUILD OUTPUT ===" && \
    ls -la app/shell/dist/ 2>/dev/null || echo "shell/dist/ not found" && \
    find app/shell/dist -name "Component.js" -type f 2>/dev/null || echo "No Component.js in shell" && \
    echo "✅ Build structure verification complete"


# Production stage
FROM node:20-alpine AS production

# Install pnpm and netcat for database health checks
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate && \
    apk add --no-cache netcat-openbsd

WORKDIR /app

# Copy node_modules from build, then prune dev dependencies
# (pnpm prune --prod is more reliable than --prod during install in workspace mode)
# Copy node_modules and strip dev-only packages in a single layer to avoid bloat
# (@sap/cds-dk pulls in jsdoc, handlebars, rollup, eslint, etc.)
RUN --mount=type=bind,from=build,source=/app/node_modules,target=/tmp/build-modules \
    cp -a /tmp/build-modules ./node_modules && \
    rm -rf node_modules/@sap/cds-dk \
           node_modules/@sap/eslint-plugin-cds \
           node_modules/@sap/ux-ui5-tooling \
           node_modules/eslint node_modules/@eslint node_modules/@eslint-community \
           node_modules/jsdoc node_modules/js2xmlparser node_modules/requizzle node_modules/catharsis \
           node_modules/handlebars node_modules/neo-async \
           node_modules/rollup node_modules/@rollup \
           node_modules/underscore \
           node_modules/flatted \
           node_modules/serialize-javascript \
           node_modules/terser \
           node_modules/@jridgewell \
           node_modules/prettier

# Create non-root user and remove global npm to eliminate bundled vulnerabilities
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Create directories and symlinks for writable paths
# /tmp is writable even in read-only containers
RUN mkdir -p /app/services/admin /app/services/admin/app && \
    ln -s /tmp /app/logs && \
    ln -s /tmp /app/config && \
    mkdir -p /tmp/admin-config && \
    ln -s /tmp/admin-config /app/services/admin/config

# Copy built application and all CDS-related files
# The build creates nested dist structure, so copy from the correct nested path
COPY --chown=nodejs:nodejs --from=build /app/services/admin/dist ./services/admin/dist
# Note: gen directory is not needed at runtime, it's only used during build
# Copy the Docker-optimized package.json
COPY --chown=nodejs:nodejs --from=build /app/services/admin/package.json ./services/admin/package.json
COPY --chown=nodejs:nodejs --from=build /app/services/admin/tsconfig.json ./services/admin/tsconfig.json
COPY --chown=nodejs:nodejs --from=build /app/services/admin/src ./services/admin/src
# Copy UI5 applications preserving symlinks using tar
RUN --mount=type=bind,from=build,source=/app/services/admin/app,target=/tmp/source-app \
    cd /tmp/source-app && \
    tar -cf - . | tar -xf - -C /app/services/admin/app && \
    chown -R nodejs:nodejs /app/services/admin/app
# Copy CDS configuration file for database credentials
COPY --chown=nodejs:nodejs --from=build /app/services/admin/.cdsrc.json ./services/admin/.cdsrc.json
COPY --chown=nodejs:nodejs --from=build /app/libs ./libs

# UI5 optimization completed in build stage, symlinks preserved via tar copy

# Create symlinks for module resolution and @libs path mapping to work at runtime
# The service implementations expect to find modules via relative imports like ../services/usageEventProcessor
# When admin-service.js is in dist/srv/, it looks for ../services/ which should resolve to dist/services/
RUN mkdir -p node_modules/@libs && \
    ln -sf /app/libs/dist/logger node_modules/@libs/logger && \
    ln -sf /app/libs/dist/types node_modules/@libs/types && \
    ln -sf /app/libs/dist/config node_modules/@libs/config && \
    ln -sf /app/libs/dist/service-auth node_modules/@libs/service-auth && \
    ln -sf /app/libs/dist/cache-invalidation node_modules/@libs/cache-invalidation && \
    ln -sf /app/libs/dist/aws-token-validation node_modules/@libs/aws-token-validation && \
    echo "=== Verifying @libs symlinks ===" && \
    ls -la node_modules/@libs/ && \
    cd /app/services/admin/dist && \
    echo "=== Creating dynamic symlinks for all service files ===" && \
    mkdir -p services && \
    echo "Working from directory: $(pwd)" && \
    echo "Scanning for service files to symlink..." && \
    if [ -d "services/admin/src/services" ]; then \
        echo "Creating symlinks for all .js files in services/admin/src/services/:" && \
        for file in services/admin/src/services/*.js; do \
            if [ -f "$file" ]; then \
                basename_file=$(basename "$file") && \
                echo "  Symlinking: services/$basename_file -> ../$file" && \
                ln -sf "../$file" "services/$basename_file"; \
            fi; \
        done && \
        echo "Symlink creation completed successfully"; \
    else \
        echo "ERROR: services/admin/src/services/ directory not found"; \
        echo "Available directories:"; \
        find . -type d -name services; \
    fi && \
    echo "=== Verifying dynamic symlinks ===" && \
    ls -la services/ && \
    echo "=== Final verification ===" && \
    echo "Total .js files symlinked: $(ls -1 services/*.js 2>/dev/null | wc -l)"

USER nodejs

# Set working directory to admin service
WORKDIR /app/services/admin

EXPOSE 4004

ENV NODE_ENV=production
ENV DEPLOY_TARGET=docker
ENV CDS_ENV=docker
# Set NODE_CONFIG_ENV for PostgreSQL
ENV NODE_CONFIG_ENV=postgres
# Enable debug logging by default in Docker (can be overridden)
ENV LOG_LEVEL=debug
ENV CDS_LOG_LEVELS_CDS=debug
ENV DEBUG=cds:*

# Start the Admin service with proper CAP schema deployment
CMD ["sh", "-c", "echo 'Admin service starting...' && echo 'Environment: CDS_ENV='$CDS_ENV' NODE_ENV='$NODE_ENV' LOG_LEVEL='$LOG_LEVEL && echo 'Waiting for PostgreSQL...' && while ! nc -z postgres 5432; do sleep 1; done && echo 'PostgreSQL ready, starting CAP service...' && node dist/services/admin/src/index.js"]