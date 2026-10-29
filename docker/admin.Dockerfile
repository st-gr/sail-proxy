# Multi-stage Dockerfile for Admin Service
# Note: Uses package.docker.json to exclude SQLite dependencies that require Python/build tools
# Docker deployment uses PostgreSQL only, SQLite is for local development
FROM node:24-alpine AS base
# No browser ever runs inside an image: keep puppeteer (a root devDependency
# used only by the CI UI journeys) from downloading Chrome for Testing into
# this build stage's layers.
ENV PUPPETEER_SKIP_DOWNLOAD=true

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
FROM node:24-alpine AS build
# No browser ever runs inside an image: keep puppeteer (a root devDependency
# used only by the CI UI journeys) from downloading Chrome for Testing into
# this build stage's layers.
ENV PUPPETEER_SKIP_DOWNLOAD=true

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
# CDS translation bundle for the Fiori Elements annotations; cds build merges it into dist/srv/_i18n/i18n.json
COPY services/admin/_i18n/ ./services/admin/_i18n/
# Copy UI5 applications for Docker deployment
COPY services/admin/app/ ./services/admin/app/
# API reference: pnpm build copies these documents and swagger-ui-dist into dist/api-docs
COPY openapi/ ./openapi/
COPY cli-tools/copy-api-docs.js ./cli-tools/
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
    cd ../api-keys-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../aws-credentials-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../config-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../security-notifications-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../usage-analytics-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../sap-rates-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../model-library-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd ../users-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../teams-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../connections-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../tool-policies-app && pnpm install && pnpm ui5 build --all --exclude-dependency sap.fe.test --exclude-dependency sap.ushell --exclude-dependency themelib_sap_horizon --clean-dest --dest dist && \
    cd ../grounding-app && pnpm install && pnpm ui5 build --all --clean-dest --dest dist && \
    cd .. && rm -rf */dist/test && \
    echo "🧹 Stripped OPA test pages (app/*/dist/test) from the image" && \
    echo "✅ UI5 applications built successfully with cached SAPUI5 framework"

# Update index.html and manifest.json files for Docker deployment
RUN echo "=== Updating files for Docker deployment ===" && \
    for app in shell api-keys-app aws-credentials-app config-app security-notifications-app usage-analytics-app sap-rates-app model-library-app users-app teams-app connections-app tool-policies-app grounding-app; do \
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


# Runtime dependencies stage: a production-only install of the same workspace minus the UI5 apps
# (their packages are build tooling; the image serves only their built dist/). pnpm stays out of
# the production stage, which copies this node_modules.
FROM node:24-alpine AS runtime-deps

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /app

COPY docker/package.json ./package.json
COPY pnpm-workspace.yaml ./
COPY services/admin/package.docker.json ./services/admin/package.json
COPY libs/package.json ./libs/package.json

# auto-install-peers=false: with pnpm's default, the install adds @cap-js/postgres's peer
# @sap/cds-dk (and with it eslint and @sap/hdi-deploy > micromatch > braces) - about 100 more
# packages. cds-deploy is @sap/cds's own bin and needs no cds-dk.
RUN echo "node-linker=hoisted" >> .npmrc && echo "auto-install-peers=false" >> .npmrc && \
    pnpm install --prod --no-frozen-lockfile


# Production stage
FROM node:24-alpine AS production

# OCI provenance labels — connect the published image to its source repo on ghcr
LABEL org.opencontainers.image.source="https://github.com/st-gr/sail-proxy" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.description="SAIL-Proxy admin service — configuration and usage administration (SAP CAP)"

# netcat for the database health check in CMD below.
#
# pnpm is deliberately NOT installed here. This stage never runs it — it copies
# node_modules from the runtime-deps stage, and the
# entrypoint is `node` — but `corepack prepare` still downloaded pnpm into
# /root/.cache, leaving 20.7 MB in the image whose only effect was to carry
# corepack's vendored tar@7.4.3 (CVE-2026-59873, fixed in 7.5.19) plus 26 HIGH
# findings. Not installing it beats installing and deleting it. Same reasoning
# as the npm removal further down.
# libssl3/libcrypto3: node:24-alpine can lag Alpine's OpenSSL security releases (on node:20-alpine,
# 0.10.0 shipped 3.5.6 with CVE-2026-14456 and CVE-2026-45447, both HIGH, fixed in 3.5.8). Upgrading them here
# takes the fix whenever the base image has not caught up yet.
RUN apk upgrade --no-cache libssl3 libcrypto3 && \
    apk add --no-cache netcat-openbsd

WORKDIR /app

# Runtime node_modules come from the runtime-deps stage (production dependencies of the image
# workspace root, the admin service and libs only). The build stage's node_modules is the whole
# workspace INCLUDING every UI5 app's devDependencies and libs' jest peer; copying it and deleting a
# hand-kept list shipped jest, cpy, ui5-tooling-modules and @sap/hdi-deploy (braces via micromatch).
# The tooling guard after the libs copy below fails the build if build or test tooling ever
# reaches this stage again.
RUN --mount=type=bind,from=runtime-deps,source=/app/node_modules,target=/tmp/runtime-modules \
    cp -a /tmp/runtime-modules ./node_modules && \
    test -x node_modules/.bin/cds-deploy

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
# Server message texts (_i18n/messages*.properties, req.reject keys): CAP looks them up at runtime in
# the _i18n folder above the model's sources (dist/srv -> dist -> services/admin); cds build does not
# merge them into dist/srv/_i18n/i18n.json the way it does the annotation texts.
COPY --chown=nodejs:nodejs --from=build /app/services/admin/_i18n ./services/admin/_i18n
# Copy UI5 applications preserving symlinks using tar
RUN --mount=type=bind,from=build,source=/app/services/admin/app,target=/tmp/source-app \
    cd /tmp/source-app && \
    tar -cf - . | tar -xf - -C /app/services/admin/app && \
    chown -R nodejs:nodejs /app/services/admin/app
# Copy CDS configuration file for database credentials
COPY --chown=nodejs:nodejs --from=build /app/services/admin/.cdsrc.json ./services/admin/.cdsrc.json
COPY --chown=nodejs:nodejs --from=build /app/libs ./libs

# Tooling guard: no build or test tooling anywhere in the image - hoisted, nested inside another
# package, or in a node_modules the app/ and libs/ copies above brought along.
RUN for tool in @sap/cds-dk @sap/hdi-deploy @ui5/cli ui5-tooling-modules ui5-tooling-transpile \
                jest cpy cpy-cli typescript eslint braces micromatch; do \
        found="$(find /app -type d -path "*/node_modules/$tool" | head -n 1)"; \
        if [ -n "$found" ]; then echo "ERROR: build/test tooling $tool in the production image: $found"; exit 1; fi; \
    done

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
    ln -sf /app/libs/dist/aws-signing node_modules/@libs/aws-signing && \
    ln -sf /app/libs/dist/service-key-parser node_modules/@libs/service-key-parser && \
    echo "=== Verifying @libs symlinks ===" && \
    ls -la node_modules/@libs/ && \
    for lib in logger types config service-auth cache-invalidation aws-token-validation aws-signing service-key-parser; do \
        if [ ! -e "node_modules/@libs/$lib/" ]; then \
            echo "ERROR: @libs/$lib does not resolve - the build produced no /app/libs/dist/$lib"; \
            exit 1; \
        fi; \
    done && \
    echo "All @libs symlinks resolve" && \
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
    echo "Total .js files symlinked: $(ls -1 services/*.js 2>/dev/null | wc -l)" && \
    echo "=== Creating symlinks for the siem module ===" && \
    mkdir -p siem && \
    if [ -d "services/admin/src/siem" ]; then \
        for file in services/admin/src/siem/*.js; do \
            if [ -f "$file" ]; then \
                basename_file=$(basename "$file") && \
                ln -sf "../$file" "siem/$basename_file"; \
            fi; \
        done && \
        mkdir -p siem/sinks && \
        for file in services/admin/src/siem/sinks/*.js; do \
            if [ -f "$file" ]; then \
                basename_file=$(basename "$file") && \
                ln -sf "../../$file" "siem/sinks/$basename_file"; \
            fi; \
        done && \
        ls -la siem/ && \
        for required in dispatcher dispatcherHandle siemConfigResolver credentialStore secretResolver secretResolverHandle outbox sink siemEvent; do \
            if [ ! -e "siem/$required.js" ]; then \
                echo "ERROR: siem/$required.js did not resolve - admin-service.js requires ../siem/$required"; \
                exit 1; \
            fi; \
        done && \
        echo "All siem symlinks resolve"; \
    else \
        echo "ERROR: services/admin/src/siem/ not found - the SIEM export pipeline cannot start"; \
        exit 1; \
    fi

USER nodejs

# Set working directory to admin service
WORKDIR /app/services/admin

EXPOSE 4004

ENV NODE_ENV=production
ENV DEPLOY_TARGET=docker
ENV CDS_ENV=docker
# Set NODE_CONFIG_ENV for PostgreSQL
ENV NODE_CONFIG_ENV=postgres
# Admin log level default (services/admin/.env or the container env overrides it). It was
# debug while the logger ignored LOG_LEVEL and stock admins logged at INFO; now that
# LOG_LEVEL takes effect, info keeps that behaviour. CDS_LOG_LEVELS_CDS is CAP's own logging.
ENV LOG_LEVEL=info
ENV CDS_LOG_LEVELS_CDS=debug
ENV DEBUG=cds:*

# Start the Admin service with proper CAP schema deployment
CMD ["sh", "-c", "echo 'Admin service starting...' && echo 'Environment: CDS_ENV='$CDS_ENV' NODE_ENV='$NODE_ENV' LOG_LEVEL='$LOG_LEVEL && echo 'Waiting for PostgreSQL...' && while ! nc -z postgres 5432; do sleep 1; done && echo 'PostgreSQL ready, starting CAP service...' && node dist/services/admin/src/index.js"]