/**
 * Docker Manifest Sync Test
 *
 * The gateway Docker image is built from a hand-maintained slim manifest
 * (package.docker.json) that replaces package.json inside the image (see
 * docker/gateway.Dockerfile). The production stage runs `pnpm install --prod`
 * against that file only, so any runtime dependency added to package.json but
 * not to package.docker.json is silently absent from the deployed container
 * (this is how wink-nlp went missing in the Kyma deployment while local dev
 * kept working).
 *
 * This test freezes the intentional differences in explicit allowlists and
 * fails CI on any new drift. services/admin has a mirrored test.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Dependencies present in package.json but intentionally excluded from the
 * Docker image. Every entry needs a reason.
 */
const DOCKER_EXCLUDED: Record<string, string> = {
  // CVE pin only (transitives patched via root pnpm.overrides);
  // never imported by gateway src, so it must not ship in the image.
  'cross-spawn': 'CVE pin, not a runtime import',
};

/**
 * Dependencies present only in package.docker.json. Every entry needs a
 * reason; do not add entries to paper over drift.
 */
const DOCKER_ONLY: Record<string, string> = {};

/**
 * Dependencies whose semver range deliberately differs between the two
 * manifests. Every entry needs a reason; do not add entries to paper over
 * drift.
 */
const VERSION_MISMATCH_ALLOWED: Record<string, string> = {};

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
