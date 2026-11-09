---
title: Docker images and build
description: How the gateway, admin and ollama images are built, tagged, pushed and debugged.
---

# Docker Images and Build

The repository builds four images: the gateway, the admin service, the Ollama adapter and the nginx edge. Each is named `<DOCKER_REGISTRY>/<DOCKER_ORGANIZATION>/sail-proxy-<service>:<tag>`; the registry defaults to `ghcr.io`, the organization to `st-gr` and the tag to the version in the root `package.json`. This page is about building, tagging, pushing and debugging the images. Running them is described in [Docker Compose](/deploy/docker) and [SAP BTP Kyma](/deploy/kyma).

## The Images

| Image | Dockerfile | Build context | Port |
|-------|------------|---------------|------|
| `sail-proxy-gateway` | `docker/gateway.Dockerfile` | repository root | 3000 |
| `sail-proxy-admin` | `docker/admin.Dockerfile` | repository root | 4004 |
| `sail-proxy-ollama` | `docker/ollama.Dockerfile` | repository root | 11434 |
| `sail-proxy-nginx` | `docker/nginx/Dockerfile` | `docker/` | 8080, 443 |

The build contexts are those of the `build:` sections in `docker/docker-compose.yml`; the multi-architecture script uses the same. All images are based on Alpine (`node:24-alpine`, `nginx:alpine`) and are built for `linux/amd64` and `linux/arm64`. The Node images run Node.js 24 LTS with OpenSSL 3.5 or later, both the one bundled in Node and the Alpine system `libssl3`/`libcrypto3`.

**No secrets in images.** `.dockerignore` excludes every `.env*` file except `.env.example`, and no Dockerfile copies an `.env` file. `docker/setup-docker.js` is therefore **not** needed to build images; it configures a deployment target and runs there, before `docker compose up`.

### Gateway image

`docker/gateway.Dockerfile` has three stages:

- **`base`** and **`build`** enable pnpm 10.12.4 through corepack, copy `services/gateway/package.docker.json` as the gateway's `package.json`, install with `node-linker=hoisted` and run `pnpm build:gateway`.
- **`production`** uses `docker/package.json` as the workspace-root manifest, the same file the admin image uses: it declares only the runtime dependencies and none of the developer tooling of the real root `package.json`. It runs `pnpm install --prod` and then removes pnpm, corepack, its download cache and the global npm in the same layer. It installs the binaries the hosted `file_search` tool needs (`pandoc`, `poppler-utils`, `tesseract-ocr` with English data, `antiword`) and `netcat-openbsd` for the `gateway-migrate` service's wait loop, and upgrades `libssl3`/`libcrypto3`.
- The image runs as the non-root user `nodejs` (uid 1001) with `NODE_ENV=production` and `DEPLOY_TARGET=docker`, starting `node services/gateway/dist/services/gateway/src/index.js`.

Two symlinks complete the layout: `node_modules/@libs` points at the compiled `services/gateway/dist/libs`, so `@libs/*` imports resolve with plain Node.js resolution; `/app/src/plugins` points at the compiled plugins directory, a leftover from the time the plugin loader resolved its directory from the working directory (it now resolves it from its own module, see [Plugin system](/developer/plugins)). Additional OCR languages are described in [The hosted file_search tool](/developer/file-search-tool#ocr-languages).

### Admin image

`docker/admin.Dockerfile` (built from the repository root) has five stages:

- **`base`** and **`build`** install the whole workspace with dev dependencies (the CAP build tools,
  every UI5 app's `ui5` CLI and tooling) and run `cds build`. `services/admin/package.docker.json`
  replaces `package.json` inside the image. The build stage copies the admin folders one by one
  (`src/`, `_i18n/`, `app/`, the `.cdsrc` files), so a new top-level folder under `services/admin/`
  needs its own `COPY` line.
- **`ui5`** builds the cockpit apps. Their output is plain JS, CSS, JSON and properties files, the same
  for every target architecture, so this stage runs once per build on the build host's own
  architecture (`--platform=$BUILDPLATFORM`) and every platform's image copies its result; a
  multi-arch build no longer runs the UI5 builds under emulation. It installs the same workspace as
  the build stage without the admin sources (a TypeScript change leaves it cached) and builds every
  folder under `app/` that has a `ui5.yaml` with its `build:docker` script,
  one app after the other (see [UI5 application development](/developer/ui5-apps)). After the UI5 build it
  rewrites each app's `index.html` and `manifest.json` to the `/admin/` paths nginx serves, and
  `docker/scripts/consolidate-ui5-resources.js` replaces the per-app copies of the UI5 runtime with
  links. The build fails when an app (a folder with a `ui5.yaml`) has no `dist/index.html` loading
  `/admin/resources/sap-ui-core.js`, or when the consolidated `app/resources` is missing.
- **`runtime-deps`** runs a production-only install (`pnpm install --prod`) of just the image's
  workspace root (`docker/package.json`), the admin service (`package.docker.json`) and `libs`,
  with `node-linker=hoisted` and `auto-install-peers=false`. The latter keeps pnpm from adding
  `@cap-js/postgres`'s optional peer `@sap/cds-dk`, which would bring eslint and
  `@sap/hdi-deploy > micromatch > braces` back. `cds-deploy` is `@sap/cds`'s own bin and needs no
  cds-dk.
- **`production`** copies `node_modules` from `runtime-deps` (pnpm is never installed in this stage)
  the built `dist/`, `libs/` and CDS files from `build`, and the built `app/` tree from `ui5`. Two checks fail the build:
  `node_modules/.bin/cds-deploy` must exist, and a **tooling guard** searches every `node_modules`
  under `/app` (hoisted, nested inside another package, or brought along by the `app/` and `libs/`
  copies) for `@sap/cds-dk`, `@sap/hdi-deploy`, `@ui5/cli`, `ui5-tooling-modules`,
  `ui5-tooling-transpile`, `jest`, `cpy`, `cpy-cli`, `typescript`, `eslint`, `braces` and
  `micromatch`. A new runtime dependency belongs in `package.docker.json`
  (`services/admin/test/docker-manifest-sync.test.ts` holds the two manifests together); a build
  tool must stay out of it. The stage also links each `@libs/<name>` to `libs/dist/<name>` and fails
  when one does not resolve, and links the compiled service and SIEM modules into the paths
  `admin-service.js` requires.

The image runs on **PostgreSQL only** (`NODE_CONFIG_ENV=postgres`): `@cap-js/sqlite` is not a
dependency of the image, so a SQLite override does not boot. The start command, in
`docker/docker-compose.yml` and `kyma/templates/manifests/core/admin.yaml`, waits for Postgres, runs
`cds-deploy --profile pg` and then starts the service; the Dockerfile's own `CMD` only waits and
starts. `LOG_LEVEL` defaults to `info` in the image (see
[Log level resolution](/developer/debugging#log-level-resolution)).

### Ollama and nginx images

- **Ollama** (`docker/ollama.Dockerfile`): `pnpm deploy --filter=ollama --prod` produces a self-contained copy of the service, which the final stage runs as the non-root user `ollama` on port 11434, with a health check on `/health`.
- **nginx** (`docker/nginx/Dockerfile`): `nginx:alpine`. The image carries only a template (`nginx.conf.tmpl`); the entrypoint renders it from environment variables at container start, so one nginx image serves every environment. Kyma renders the same template. Modes, variables and how sign-in is decided are described in [The nginx image](/developer/nginx).

### `package.docker.json`

The gateway and the admin service each have a `package.docker.json` next to their `package.json`. The Dockerfiles install from it instead of `package.json`, so it lists what the image needs at runtime (and, for the build stages, at build time) without the development-only scripts and dependencies. The two files must agree on every dependency they share: `services/gateway/test/docker-manifest-sync.test.ts` and `services/admin/test/docker-manifest-sync.test.ts` fail when they drift. `pnpm run version:sync` keeps their versions in line with the root version (see [Release procedure](/developer/release)).

## Building Images

### Single-architecture builds

```bash
pnpm docker:build                          # all four images
pnpm docker:build -- --service gateway     # one image (gateway, admin, ollama, nginx)
pnpm docker:build:no-cache                 # without the layer cache
```

`docker/scripts/build-and-tag.js` runs `docker-compose build <service>` in `docker/` with `DOCKER_REGISTRY`, `DOCKER_ORGANIZATION` and `DOCKER_TAG` set, then tags each image with `latest` as well. `DOCKER_TAG` defaults to the root `package.json` version (`docker/scripts/get-version.js`). The images are built for the platform of the build host.

The admin image takes the longest: it runs the CAP build and the UI5 build of every cockpit app. Use `--no-cache` sparingly; it costs build time and disk space.

### Multi-architecture builds

```bash
pnpm docker:buildx                          # build and push all four images
pnpm docker:buildx -- --service gateway     # one image
pnpm docker:buildx -- --build-only          # build without pushing (single platform only)
pnpm docker:buildx -- --no-cache
```

`docker/scripts/build-and-tag-multiarch.js` builds with `docker buildx build --platform <platforms>` on a builder named `sail-proxy-builder`, tags the version and `latest`, and **pushes by default**: a multi-platform image cannot be loaded into the local image store, so log in to the registry first. `DOCKER_PLATFORMS` overrides the default `linux/amd64,linux/arm64`; `--build-only` loads the result instead of pushing, which works only for a single platform.

When the builder does not exist, the script offers to create it. It creates it with `docker/buildkitd.toml`, which bounds BuildKit's cache garbage collection; a builder created without that file is reported, and before a build the script prunes the builder cache down to 20 GB. To set the builder up by hand:

```bash
# Check that the builder exists and lists linux/amd64 and linux/arm64
docker buildx inspect sail-proxy-builder

# If ARM64 or AMD64 support is missing, install the QEMU binaries
docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64

# Recreate the builder with the bounded cache policy
docker buildx rm sail-proxy-builder
docker buildx create --name sail-proxy-builder --driver docker-container \
  --buildkitd-config docker/buildkitd.toml --use --bootstrap
```

### Troubleshooting multi-architecture builds

**`ENOSPC: no space left on device`**: the builder container ran out of space; the host may still have plenty, because the builder uses its own storage.

```bash
docker buildx prune --builder sail-proxy-builder --all
docker buildx du --builder sail-proxy-builder     # watch the usage
```

**`SIGSEGV` in esbuild during cross-compilation**: the emulated platform (AMD64 on Apple Silicon or ARM64 on Intel) crashed under QEMU. Update the QEMU binaries and recreate the builder (commands above), then build again without `--no-cache` so the cached layers are reused. Building one service at a time with `--service` also helps when the builder is short of resources.

Multi-architecture builds take considerably longer than single-architecture builds, because one of the two platforms runs emulated.

## Pushing and Pulling

```bash
docker login ghcr.io                       # or your registry
pnpm docker:push                           # version tag and latest, all images
pnpm docker:push -- --service admin        # one image
pnpm docker:push -- --tag-only             # version tag only
pnpm docker:pull                           # the root package.json version
```

`docker/scripts/push-images.js` pushes images built by `build-and-tag.js`; `docker/scripts/pull-images.js` takes `--version <version>` or `--latest` and `--service`. Both read `DOCKER_REGISTRY`, `DOCKER_ORGANIZATION` and `DOCKER_TAG`. A multi-architecture build has already pushed its images. To check the platforms of a pushed image:

```bash
docker buildx imagetools inspect ghcr.io/st-gr/sail-proxy-gateway:latest
```

Whether Compose builds locally or pulls from the registry is switched with `pnpm docker:use-local` (writes `docker/docker-compose.override.yml`) and `pnpm docker:use-registry` (removes it); `docker/docker-compose.registry.yml` drops the `build:` sections altogether. Both modes are described in [Docker Compose](/deploy/docker#images). A Kyma installation pulls the gateway, admin and nginx images from the registry, organization and tag given to its setup ([SAP BTP Kyma](/deploy/kyma#images)); the cluster access the deploy needs is described in [Kyma prerequisites](/deploy/kyma-prerequisites).

## Images in CI

The local CI pipeline (`pnpm run ci`) builds the images in Phase 7 with the tag `ci-test`, starts the admin container on Postgres in Phase 8 and scans every image with Trivy in Phase 9 (see [Testing strategy](/developer/testing-strategy)). Two environment variables steer it:

- `FORCE_DOCKER_BUILD=1` (or `true`) always builds.
- `SKIP_DOCKER_BUILD=true` (or `1`) skips Phases 7 to 9 without looking at the changes. `FORCE_DOCKER_BUILD` wins when both are set.

Without either, a local run builds only when an image-relevant file changed since the last local image build it recorded (`ci-logs/last-local-docker-build`), counting uncommitted and untracked files too. It records a build only when the run started with a clean tree and Phase 8 passed. The GitHub workflow (`.github/workflows/ci.yml`) sets `SKIP_DOCKER_BUILD` for pushes and pull requests; a manual run with the `build_images` input ticked builds and scans the images there. The decision logic is `ci/scripts/docker-build-decision.js`.

Phase 7 builds the four images one after the other and prints milestones instead of the build output: each Dockerfile step that took 10 seconds or more, each UI5 app of the admin build as it starts, a failed step with its error, and every minute the step that has run longest. The full output of each build is in `ci-logs/docker-build-<service>.log`; when a build fails, its last lines are printed with that path. The milestones are read from BuildKit's plain progress output by `ci/scripts/docker-build-progress.js`.

## Development and Docker Module Resolution

The services run from TypeScript sources in development and from compiled JavaScript in the images, and both resolve the shared `@libs/*` packages:

| | Development | Docker image |
|---|---|---|
| Gateway | `nodemon` + `ts-node -r tsconfig-paths/register src/index.ts`; `tsconfig.json` maps `@libs/*` to `libs/*` (`baseUrl: "../.."`) | compiled to `services/gateway/dist/`; `node_modules/@libs` links to `dist/libs` |
| Admin | `cds watch` (`pnpm dev`, `dev:mock`) or `ts-node` (`dev:ts`, `dev:ts:mock`) | compiled to `services/admin/dist/`; `node_modules/@libs/<name>` links to `libs/dist/<name>` |

`services/admin/server.js` loads the auth middleware from `src/` when `NODE_ENV` or `DEPLOY_TARGET` is `development` and the TypeScript source exists, and from `dist/` otherwise. The images set `NODE_ENV=production` and `DEPLOY_TARGET=docker`.

Typical failures:

- **Gateway: `Cannot find module '@libs/logger'`** in development: the dev command must load `tsconfig-paths/register`.
- **Admin image build fails at `@libs/<name> does not resolve`**: the libs build produced no `libs/dist/<name>`; build `libs` locally (`pnpm --filter @sap-llm-gateway/libs build` or `pnpm build`) to see the error.
- **Admin image build fails at the tooling guard**: a build or test tool reached the runtime dependencies; remove it from `package.docker.json` or find the package that pulls it in.

## Debugging Running Containers

```bash
cd docker
docker compose ps                                   # state and health
docker compose logs -f gateway admin                # logs
docker compose exec gateway sh                      # shell (Alpine: sh, not bash)
docker compose exec nginx nginx -t                  # validate the rendered nginx configuration
docker compose exec nginx wget -qO- http://gateway:3000/health
docker compose exec nginx wget -qO- http://admin:4004/api/health
```

A `502 Bad Gateway` from nginx usually means the gateway or admin container is not (yet) healthy: check `docker compose ps` and the service's log. More symptoms and fixes are in the Troubleshooting section of [Docker Compose](/deploy/docker#troubleshooting).
