---
title: SAIL-PROXY Developer Guide - Chapter 14
author: st-gr
date: 2026-07-07
mainfont: Helvetica, Arial, sans-serif
fontsize: 18px
---

# SAIL-PROXY Developer Guide
*Multi-provider AI Gateway for SAP AI Core - Developer Documentation*
**Author:** *st-gr*

# Chapter 14: Release & Deployment

This chapter describes how to cut a release: bumping the version across the workspace, publishing the standalone `@st-gr/sail-proxy` CLI to npm, and building and pushing the Docker images. One orchestrator script runs the whole sequence; the individual steps are documented below for when you need to run (or debug) them separately.

## TL;DR — One-Command Release

```bash
# Prerequisites (once per machine/session):
npm login                     # npm publish auth
docker login ghcr.io          # Docker registry auth

# Verify everything is in order without executing:
pnpm release:dry-run

# Cut the release:
pnpm release:patch            # or release:minor / release:major

# Final manual step (printed by the script):
git push origin <branch> && git push origin v<new-version>
```

`pnpm release:*` runs `cli-tools/release.js`, which executes, in order:

1. **Preflight** — tracked working tree clean, npm authenticated, Docker daemon reachable. Aborts before touching anything if a check fails.
2. **Test gate** — `pnpm test` (gateway suite). Skip with `--skip-tests` (not recommended).
3. **Version bump** — `npm version <type>` on the root package. The root `"version"` lifecycle hook (`cli-tools/sync-version.js --stage`) propagates the new version to `libs/*`, `services/*`, `docker/package.json`, and `npm-dist/sail-proxy`, and stages them so the version commit + git tag include every synced manifest.
4. **npm publish** — `cli-tools/publish-npm.js`, the hardened wrapper (see below). sail-proxy's `prepublishOnly` runs its full build, including `bundle:gateway`, so the published package always contains a freshly compiled gateway — the checked-in `bundled/` directory is never shipped stale.
5. **Docker build + push** — `docker/scripts/build-and-tag.js` (tags each image with both the new version and `latest`), then `docker/scripts/push-images.js`.

The script never pushes git commits or tags — it prints the exact `git push` commands at the end so you stay in control of what reaches the remote.

**Partial releases:** `--skip-npm` (Docker-only release), `--skip-docker` (npm-only release), `--skip-tests`.

## Why the Order Matters

- **Bump before publish/build:** both the npm tarball and the Docker image tags read the version from the (already-bumped) manifests. Publishing before bumping ships the old version number with new code.
- **Test before bump:** `npm version` creates a commit and tag; gating tests first keeps broken states out of tagged history.
- **Publish before announcing:** the git tag exists locally after step 3 — only push it once npm and the registry actually have the artifacts.

## The Individual Steps (Manual / Debugging)

### 1. Version Bump

```bash
pnpm version:bump:patch       # npm version patch + workspace sync + commit + tag
pnpm version:check            # verify all manifests agree
```

`cli-tools/sync-version.js` keeps `libs/*`, `services/{gateway,admin,ollama}`, `docker/package.json`, and `npm-dist/sail-proxy` on the root version. It does **not** touch `workspace:*` dependency protocols — those are rewritten only at pack time (see below).

### 2. Publish sail-proxy to npm

```bash
pnpm publish:npm              # from the repo root — ALWAYS use this, never raw npm publish
```

`cli-tools/publish-npm.js` exists because of a real npm bug: `npm publish` re-reads `package.json` from disk *after* packing and ships that manifest to the registry. A `postpack` hook that restores `workspace:*` therefore poisons the registry metadata (consumers get `EUNSUPPORTEDPROTOCOL`) while the tarball itself looks fine. The wrapper:

- refuses to run if a `postpack` hook exists in `npm-dist/sail-proxy/package.json`,
- pre-rewrites `workspace:*` to concrete versions and verifies the on-disk state before publishing,
- restores `workspace:*` in a `finally` block whether publish succeeded, failed, or was interrupted.

Consequence for manual testing: after a bare `npm pack` in `npm-dist/sail-proxy`, `package.json` is left with concrete versions — restore it yourself with `npm run restore-workspace`. See `npm-dist/sail-proxy/DEVELOPER.md` → Publishing.

### 3. Docker Images

```bash
pnpm docker:build             # builds gateway/admin/ollama/nginx images, tags v<version> + latest
pnpm docker:push              # pushes both tags (docker login required)
```

Registry and organization default to `ghcr.io` / `st-gr`; override with `DOCKER_REGISTRY`, `DOCKER_ORGANIZATION`, `DOCKER_TAG`. `--service NAME` limits either script to one image; `push-images.js --tag-only` skips the `latest` tag.

### 4. Push Commit and Tag

```bash
git push origin <branch>
git push origin v<new-version>
```

CI (`.github/workflows/ci.yml`) runs tests and Trivy scans on push — it does **not** publish to npm or push images. Releases are operator-driven by design.

## What Reaches Users When

| Artifact | Updated by | Users receive it |
|---|---|---|
| npm `@st-gr/sail-proxy` | `pnpm publish:npm` (step 4 of release) | `npm install -g @st-gr/sail-proxy@latest` |
| Docker images (`ghcr.io/st-gr/sail-proxy-*`) | `pnpm docker:push` (step 5) | `pnpm docker:pull` / redeploy |
| Bundled gateway inside the npm package | Rebuilt automatically by `prepublishOnly` → `bundle:gateway` | With the npm package |
| `api_config.json` for **existing** standalone installs | **Never automatically** — the template is copied once at setup | User re-runs setup or hand-merges new keys (e.g. `supported_beta_headers`) |

The last row matters after config-schema releases: existing standalone installs keep their old `api_config.json`. Ship code that degrades gracefully when new keys are absent (the beta-header allowlist and runtime quarantine were designed this way).

## Release Checklist

- [ ] `git status` clean (tracked files), on the intended branch
- [ ] `npm whoami` succeeds; `docker login ghcr.io` done
- [ ] `pnpm release:dry-run` passes preflight
- [ ] `pnpm release:patch|minor|major`
- [ ] Push the version commit and tag
- [ ] Spot-check: `npm view @st-gr/sail-proxy version` and the registry image tags match the new version
