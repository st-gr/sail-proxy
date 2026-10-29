/**
 * Docker Manifest Sync Test
 *
 * The admin Docker image is built from a hand-maintained slim manifest
 * (package.docker.json) that replaces package.json inside the image (see
 * docker/admin.Dockerfile). The runtime-deps stage runs `pnpm install --prod`
 * against that file only and the production stage copies its node_modules, so any runtime dependency added to package.json but
 * not to package.docker.json is silently absent from the deployed container
 * (this is how wink-nlp went missing from the gateway image in the Kyma
 * deployment while local dev kept working).
 *
 * This test freezes the intentional differences in explicit allowlists and
 * fails CI on any new drift. services/gateway has a mirrored test.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Dependencies present in package.json but intentionally excluded from the
 * Docker image. Every entry needs a reason.
 */
const DOCKER_EXCLUDED: Record<string, string> = {
  // Docker/Kyma deployments run against PostgreSQL; SQLite is local/dev only.
  '@cap-js/sqlite': 'local dev database only',
  sqlite3: 'local dev database only',
  // Not imported by admin src (session handling is done by approuter/CAP middleware).
  'cookie-parser': 'not a runtime import',
  'express-session': 'not a runtime import',
};

/**
 * Dependencies present only in package.docker.json. Every entry needs a
 * reason; do not add entries to paper over drift.
 */
const DOCKER_ONLY: Record<string, string> = {
  // Legacy entry, not imported by admin src (express 4 bundles body
  // parsing). Kept until the admin image is next rebuilt and re-verified.
  'body-parser': 'stale, pending removal',
};

/**
 * Dependencies whose semver range deliberately differs between the two
 * manifests. Every entry needs a reason; do not add entries to paper over
 * drift.
 */
const VERSION_MISMATCH_ALLOWED: Record<string, string> = {
  // docker pins a stricter floor (^4.19.2) than main (^4); same major,
  // and the effective version is governed by the pnpm.overrides block of docker/package.json (the image workspace root; kept equal to the root block by the last test below).
  express: 'stricter floor in docker, superseded by root overrides',
};

function readDependencies(file: string): Record<string, string> {
  const manifestPath = path.resolve(__dirname, '..', file);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.dependencies ?? {};
}

describe('package.docker.json stays in sync with package.json', () => {
  const mainDeps = readDependencies('package.json');
  const dockerDeps = readDependencies('package.docker.json');

  it('declares every runtime dependency from package.json (except documented exclusions)', () => {
    const missing = Object.keys(mainDeps).filter(
      (dep) => !(dep in dockerDeps) && !(dep in DOCKER_EXCLUDED)
    );
    expect(missing).toEqual([]);
  });

  it('pins the same semver range as package.json for shared dependencies', () => {
    const mismatched = Object.keys(dockerDeps)
      .filter(
        (dep) =>
          dep in mainDeps &&
          dockerDeps[dep] !== mainDeps[dep] &&
          !(dep in VERSION_MISMATCH_ALLOWED)
      )
      .map((dep) => `${dep}: docker=${dockerDeps[dep]} main=${mainDeps[dep]}`);
    expect(mismatched).toEqual([]);
  });

  it('declares no dependencies unknown to package.json (except documented docker-only entries)', () => {
    const unknown = Object.keys(dockerDeps).filter(
      (dep) => !(dep in mainDeps) && !(dep in DOCKER_ONLY)
    );
    expect(unknown).toEqual([]);
  });

  it('only allowlists dependencies that still exist in package.json', () => {
    const stale = Object.keys(DOCKER_EXCLUDED).filter((dep) => !(dep in mainDeps));
    expect(stale).toEqual([]);
  });
});

describe('docker/package.json pnpm.overrides mirror the root package.json', () => {
  // The Dockerfiles copy docker/package.json in as the pnpm workspace root, so the
  // root package.json's overrides never apply inside the images: this block is the
  // only one that governs the shipped dependency closure.
  const readOverrides = (file: string): Record<string, string> =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', file), 'utf8')).pnpm?.overrides ?? {};

  it('carries exactly the root overrides, so a CVE pin cannot be missed in the images', () => {
    expect(readOverrides('docker/package.json')).toEqual(readOverrides('package.json'));
  });
});
