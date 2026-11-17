# CI

The pipeline that builds, tests and scans the project, locally and on GitHub, and the scripts it uses. [CI_PIPELINE.md](CI_PIPELINE.md) describes the phases, what a local run needs and how to read a failure.

## Running

From the repository root:

```bash
pnpm run ci               # node ci/preflight.js && node ci/ci-pipeline.js
pnpm run security:check   # node ci/security-scanner.js
pnpm run security:quick   # the same scanner with --quick
```

A local run needs Docker, free ports for the gateway, the admin service, PostgreSQL and Valkey, and `SAP_AI_CORE_SERVICE_KEY` in the shell that starts it. Stop your development services first. CI_PIPELINE.md has the details.

`.github/workflows/ci.yml` runs the same pipeline on GitHub.

## What is here

| Path | Content |
|---|---|
| `ci-pipeline.js` | The pipeline: ten phases, from environment setup to cleanup |
| `preflight.js` | Checks before the pipeline starts |
| `audit-gate.js`, `audit-allowlist.json`, `audit-gate.test.js` | The dependency gate: fails on an advisory that is not allowlisted with a reason and a review date. The pipeline runs the test before the gate |
| `security-scanner.js` | Secret detection and supply-chain checks. The pipeline's security phase uses it; `pnpm run security:check` runs it on its own |
| `local-security-check.js` | A quick security check for developers: secrets, dependency audit and, when Trivy is installed, an image scan |
| `verify-docker-vulnerabilities.js` | Runs Trivy on the images and prints the findings |
| `scripts/` | Helpers of the pipeline, see below |
| `config/` | A Jest configuration and its setup file. Nothing in the pipeline refers to them; the services bring their own |
| `sap-relay/` | The relay through which the private CI reaches SAP AI Core, with its own README |
| `file-search-eval/` | The corpus and tooling for measuring file search retrieval, with its own README |
| `reports/` | Logs and results of local runs; not tracked |

### `scripts/`

| Script | Purpose |
|---|---|
| `health-check.js` | Health checks of the services, with timeouts and retries. Nothing calls it at present |
| `security-scan.js` | An older security scanner. Nothing calls it at present |
| `sqlite-checkpoint.js` | Folds the admin database's write-ahead log into the file before the backup |
| `backed-up-volumes.js` | Which Docker volumes a run may remove: the ones it backed up |
| `docker-build-decision.js` | Whether a run builds the images, from the files that changed |
| `docker-build-progress.js` | Progress output for the image builds |
| `file-search-test-db.js`, `file-search-test-s3.js` | A PostgreSQL with pgvector and an S3-compatible store for the file search suites |
| `jest-summary.js`, `jest-summary-reporter.js` | The per-suite record of a Jest run |
| `sap-relay-env.js` | The SAP settings of the CI gateway when the run goes through the relay |
| `i18n-literals.js`, `i18n-literals.allowlist.json` | Fails on hard-coded cockpit text that is not allowlisted |
| `ui5-typecheck.js`, `ui5-typecheck.gated.json` | Type check of the cockpit apps |
| `schema-texts.js` | Keeps the configuration schema's texts in the cockpit's translation bundles |
| `ui-journeys/` | Seeds the admin service and runs the cockpit's OPA5 journeys |

The `*.test.js` files beside the scripts are their tests; run one with `node <file>`.

## Environment

- `SAP_AI_CORE_SERVICE_KEY`: the SAP AI Core service key as JSON. Export it in the shell; the pipeline clears the services' `.env` files while it runs and restores them at the end.
- `FORCE_DOCKER_BUILD=1` builds the images even when no image-relevant file changed. `SKIP_DOCKER_BUILD=true` skips the image phases. The first wins when both are set.

## Adding to the pipeline

Put a helper into `scripts/` with its test beside it, call it from `ci-pipeline.js`, and describe the step in CI_PIPELINE.md.
