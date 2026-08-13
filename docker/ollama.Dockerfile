# ---- build stage: resolve ONLY ollama's dependencies -------------------------
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

WORKDIR /usr/src/app

# The workspace files pnpm needs to honour the lockfile, plus the service source
# (`pnpm deploy` copies the package's own files, so they must be present here).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/ollama/ ./services/ollama/

# `pnpm deploy` rather than `pnpm install`, and it is the whole point of this
# stage. A plain `pnpm install --prod` runs against the WORKSPACE ROOT, whose
# own package.json declares 13 production dependencies (@sap-ux/fiori-mcp-server
# and @ui5/mcp-server among them). Their transitives landed in this image too:
# 599 packages / 578 MB for a service that needs SIX (axios, cors, dotenv,
# express, helmet, morgan) -- carrying 3 CRITICAL and 32 HIGH findings for code
# ollama never loads. `--filter ollama` does NOT fix that: the root project is
# itself part of the workspace and is installed regardless.
#
# `pnpm deploy` emits a self-contained directory -- the package's own files and
# only its own resolved dependencies -- still driven by the frozen lockfile, so
# nothing is tampered with and nothing else comes along. The production stage
# copies that directory wholesale, which also means index.js and node_modules
# arrive as siblings and resolve normally.
#
# NO node-linker=hoisted here, deliberately: hoisting flattens every workspace
# dependency into one tree and `deploy` then copies that tree verbatim, which
# silently undid the pruning (@babel, @lancedb, @sapui5 … all still shipped).
#
# --legacy: pnpm 10 otherwise refuses with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE
# unless the workspace sets inject-workspace-packages=true. This workspace does
# not, and changing that global setting to satisfy one Dockerfile would affect
# every package; the flag is the narrower lever pnpm's own error suggests.
# inject-workspace-packages=true is written into THIS STAGE's .npmrc, not into
# the repo's pnpm-workspace.yaml: it is what `pnpm deploy` requires in pnpm 10
# (without it the command aborts with ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE),
# and scoping it here keeps every other package's resolution untouched.
#
# The `--legacy` escape hatch was tried first and is NOT equivalent: legacy
# deploy copies the workspace's whole virtual store, so the pruning silently did
# nothing — @sap-ux, @ui5 and their transitives still shipped, 405 MB of them.
# Measured, so the shape of this is not arbitrary:
#   `pnpm install --prod --filter ollama` still installs the workspace ROOT's 13
#   dependencies (@sap-ux/fiori-mcp-server, @ui5/mcp-server and friends, 394.9 MB)
#   because the root project belongs to the workspace and is installed whatever
#   the filter says. services/ollama/node_modules meanwhile holds exactly the six
#   this service declares. So the pruning has to come from `deploy`, not `filter`.
#
# inject-workspace-packages is written into THIS STAGE's .npmrc rather than the
# repo's pnpm-workspace.yaml — pnpm 10 refuses `deploy` without it
# (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE), and scoping it here leaves every other
# package's resolution untouched. It changes nothing for ollama in practice: all
# six of its dependencies are external, so there is no workspace package to inject.
#
# --frozen-lockfile is dropped ONLY here, and only because it cannot coexist with
# that setting: the lockfile records injectWorkspacePackages=false and pnpm aborts
# with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. The lockfile is still copied above and
# still drives resolution; what is lost is the assertion that it does not change,
# inside a throwaway build stage whose output is a pruned directory we then copy.
#
# `--legacy` was the other way round this and is NOT equivalent: it copies the
# workspace's entire virtual store, so the prune silently did nothing.
RUN echo "inject-workspace-packages=true" >> .npmrc && \
    pnpm install --prod --filter ollama && \
    pnpm deploy --filter=ollama --prod /prod/ollama

# ---- production stage --------------------------------------------------------
FROM node:20-alpine

# OCI provenance labels — connect the published image to its source repo on ghcr
LABEL org.opencontainers.image.source="https://github.com/st-gr/sail-proxy" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.description="SAIL-Proxy Ollama adapter — local model integration service"

WORKDIR /usr/src/app

# The whole deployed directory: the service's files and its pruned node_modules,
# as siblings. No pnpm, no corepack and no download cache reach this image — the
# build tooling stays in the stage above rather than being installed here and
# deleted afterwards.
COPY --from=build /prod/ollama ./

# npm ships in node:20-alpine and nothing here uses it (the entrypoint is
# `node`). Its own bundled tar@6.2.1 is a CRITICAL finding on its own, so remove
# it for the same reason gateway.Dockerfile and admin.Dockerfile already do.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S ollama -u 1001

# Change ownership of the app directory
RUN chown -R ollama:nodejs /usr/src/app
USER ollama

# Expose port
EXPOSE 11434

# Bind to all interfaces INSIDE the container.
#
# The app defaults to OLLAMA_HOST=localhost (services/ollama/index.js:24), which
# is right for a dev host and wrong here: it bound ::1 only, so the published
# port reached nothing — `docker run -p 11435:11434 …` answered no connection
# while the app was demonstrably serving inside. Compose's env_file takes
# precedence over this ENV, so docker-compose.yml sets it explicitly too.
ENV OLLAMA_HOST=0.0.0.0

# Health check.
#
# wget, not curl: curl is NOT installed in node:20-alpine and this Dockerfile
# never added it, so the previous `CMD curl -f …` could only ever fail — the
# container sat in "starting" until it went unhealthy, regardless of the app.
# busybox wget ships in the base image, so this needs no extra package (and no
# extra CVE surface).
#
# 127.0.0.1, NOT localhost: inside this image `localhost` resolves to ::1, and
# the app binds 0.0.0.0 (IPv4) per the ENV above — so a localhost check gets
# "Connection refused" against an IPv6 address nothing listens on, while the
# published port works fine. The two bugs masked each other: before, the app
# bound ::1 and the internal check passed while the host port was dead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:11434/health || exit 1

# Start the application.
#
# `node index.js` directly, NOT `pnpm start`. The start script in
# services/ollama/package.json is exactly `node index.js`, so this runs the same
# process with one fewer layer — and, unlike `pnpm start`, it does not make the
# package manager a RUNTIME dependency, which is what allows the production
# stage to contain no pnpm at all.
#
# `pnpm start` was also broken here in its own right: corepack's cache is
# root-owned, the container runs as the non-root `ollama` user, so corepack
# could not read it, fell back, and crashed before reaching the app.
CMD ["node", "index.js"]