/**
 * Whether a CI run builds the Docker images (Phases 7-9), from the files changed.
 *
 * GitHub Actions compares against the PR base or the push's `before` commit, a generic CI=true
 * run against HEAD~1. A local run compares against the commit of the last LOCAL image build,
 * recorded in a gitignored marker after Phase 8 validated a build that started from a clean tree,
 * plus the uncommitted and untracked changes: diffing
 * only HEAD~1 skipped the build after a multi-commit merge whose last commit touched docs only.
 * A missing, unreadable or non-ancestor marker builds (fail-safe). A local decision also reports
 * `cleanTree`: whether the run started with no uncommitted or untracked change to an image path.
 * Only such a run may record the marker, since otherwise the images hold edits HEAD does not.
 *
 * `exec` is promisified child_process.exec (rejects on a non-zero exit); the caller injects it,
 * the environment, the logger and the marker reader so the decision can be tested without git.
 */
const path = require('path');

/** Gitignored (`ci-logs/`), relative to the repository root. */
const LOCAL_BUILD_MARKER = 'ci-logs/last-local-docker-build';

const DOCKER_RELEVANT_PATHS = [
  'docker/',
  'services/',
  'libs/',
  'ci/',
  '.github/',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.dockerignore'
];

const SHA = /^[0-9a-f]{40}$/;

const lines = (stdout) => stdout.trim().split('\n').filter(f => f.length > 0);
const failSafe = (reason) => ({ required: true, reason: `${reason} (fail-safe)`, files: [] });
const short = (sha) => sha.slice(0, 8);

/** True for a local run: neither GitHub Actions nor a generic CI=true runner. */
function isLocalRun(env) {
  return env.GITHUB_ACTIONS !== 'true' && env.CI !== 'true';
}

/**
 * Local mode: the files changed since the last local image build, committed or not.
 * Returns `{ files, base, cleanTree }`, or `{ decision, cleanTree }` when it must build
 * (fail-safe) or the tree is exactly the one last built.
 */
async function localChanges({ exec, readMarker, logger }) {
  logger.info('Local mode: comparing against the last local image build plus uncommitted changes...');
  let uncommitted;
  try {
    uncommitted = await uncommittedFiles(exec);
  } catch (error) {
    return { decision: { ...failSafe(`Git diff failed: ${error.message}`), cleanTree: false } };
  }
  if (uncommitted.length > 0) logger.info(`Found ${uncommitted.length} uncommitted change(s)`);
  const cleanTree = isCleanStart(uncommitted);
  const local = await changesSinceMarker({ exec, readMarker, logger, uncommitted });
  return { ...local, cleanTree };
}

/** Whether a path is part of what the images are built from. */
const isDockerRelevant = (file) => DOCKER_RELEVANT_PATHS.some(p => (p.endsWith('/') ? file.startsWith(p) : file === p));

/** A clean start for the marker: nothing uncommitted or untracked that goes into the images. */
const isCleanStart = (uncommitted) => !uncommitted.some(isDockerRelevant);

/** The uncommitted changes, tracked or untracked (a new file reaches the image build context too). */
async function uncommittedFiles(exec) {
  const tracked = lines((await exec('git diff --name-only HEAD')).stdout);
  const untracked = lines((await exec('git ls-files --others --exclude-standard')).stdout);
  return [...new Set([...tracked, ...untracked])];
}

/** The committed changes since the marker, merged with `uncommitted`; or a finished decision. */
async function changesSinceMarker({ exec, readMarker, logger, uncommitted }) {
  let marker;
  try {
    marker = String(await readMarker()).trim();
  } catch (error) {
    const why = error && error.code === 'ENOENT' ? 'no local image build recorded' : `the marker is unreadable: ${error.message}`;
    return { decision: failSafe(`Comparison base: none, ${why} (${LOCAL_BUILD_MARKER})`) };
  }
  if (!SHA.test(marker)) {
    return { decision: failSafe(`Comparison base: none, ${LOCAL_BUILD_MARKER} does not hold a commit id`) };
  }
  try {
    await exec(`git merge-base --is-ancestor ${marker} HEAD`);
  } catch {
    return { decision: failSafe(`Comparison base: none, the last local image build ${short(marker)} is not an ancestor of HEAD`) };
  }

  let committed;
  try {
    committed = lines((await exec(`git diff --name-only ${marker} HEAD`)).stdout);
  } catch (error) {
    return { decision: failSafe(`Git diff failed: ${error.message}`) };
  }
  const files = [...new Set([...committed, ...uncommitted])];
  const base = `last local image build ${short(marker)}`;
  logger.info(`Comparing against the ${base}: ${committed.length} committed and ${uncommitted.length} uncommitted file(s) changed`);
  if (files.length === 0) {
    return { decision: { required: false, reason: `No changes since the ${base}`, files: [] } };
  }
  return { files, base };
}

/**
 * @returns {Promise<{required: boolean, reason: string, files: string[], cleanTree?: boolean}>}
 */
async function decideDockerBuild({ exec, env, logger, readMarker }) {
  try {
    if (env.FORCE_DOCKER_BUILD === 'true' || env.FORCE_DOCKER_BUILD === '1') {
      logger.info('FORCE_DOCKER_BUILD environment variable is set');
      const forced = { required: true, reason: 'Forced via FORCE_DOCKER_BUILD environment variable', files: [] };
      if (!isLocalRun(env)) return forced;
      let cleanTree = false;
      try { cleanTree = isCleanStart(await uncommittedFiles(exec)); } catch { /* not clean: never record */ }
      return { ...forced, cleanTree };
    }

    // SKIP_DOCKER_BUILD turns Phases 7-9 off (they skip when no image was built), e.g. to save
    // GitHub Actions minutes; FORCE_DOCKER_BUILD above still wins.
    if (env.SKIP_DOCKER_BUILD === 'true' || env.SKIP_DOCKER_BUILD === '1') {
      logger.warning('SKIP_DOCKER_BUILD environment variable is set');
      return { required: false, reason: 'Skipped via SKIP_DOCKER_BUILD environment variable', files: [] };
    }

    try {
      await exec('git rev-parse --is-inside-work-tree');
    } catch {
      logger.warning('Not in a git repository - running full Docker build');
      return { required: true, reason: 'Not a git repository (fail-safe)', files: [] };
    }

    let changedFiles = [];
    let base = null;
    let cleanTree; // local runs only
    const withClean = (d) => (cleanTree === undefined ? d : { ...d, cleanTree });

    if (env.GITHUB_ACTIONS === 'true') {
      // For PRs, use the base ref; for pushes, use the before/after commits or HEAD~1
      let baseBranch;
      if (env.GITHUB_BASE_REF) {
        baseBranch = `origin/${env.GITHUB_BASE_REF}`;
        logger.info(`GitHub Actions PR mode: comparing against ${baseBranch}`);
      } else if (env.GITHUB_EVENT_BEFORE && env.GITHUB_EVENT_BEFORE !== '0000000000000000000000000000000000000000') {
        baseBranch = env.GITHUB_EVENT_BEFORE;
        logger.info(`GitHub Actions push mode: comparing ${baseBranch}...${env.GITHUB_SHA}`);
      } else {
        // Fallback to HEAD~1 (requires fetch-depth >= 2)
        baseBranch = 'HEAD~1';
        logger.info(`GitHub Actions mode: comparing against ${baseBranch}`);
      }
      try {
        changedFiles = lines((await exec(`git diff --name-only ${baseBranch}...HEAD`)).stdout);
      } catch (error) {
        logger.warning(`Failed to detect changed files: ${error.message}`);
        logger.warning('Tip: Ensure GitHub Actions workflow uses checkout with fetch-depth: 2 or greater');
        return failSafe(`Git diff failed: ${error.message}`);
      }
    } else if (env.CI === 'true') {
      logger.info('Generic CI mode: comparing HEAD~1...HEAD');
      try {
        changedFiles = lines((await exec('git diff --name-only HEAD~1 HEAD')).stdout);
      } catch (error) {
        logger.warning(`Failed to detect changed files: ${error.message}`);
        return failSafe(`Git diff failed: ${error.message}`);
      }
    } else {
      const local = await localChanges({ exec, readMarker, logger });
      if (local.decision) {
        if (local.decision.required) logger.warning(local.decision.reason);
        return { ...local.decision, cleanTree: local.cleanTree === true };
      }
      changedFiles = local.files;
      base = local.base;
      cleanTree = local.cleanTree;
    }

    if (changedFiles.length === 0) {
      logger.warning('No changed files detected - running full Docker build (fail-safe)');
      return withClean(failSafe('No changed files detected'));
    }

    const since = base ? ` since the ${base}` : '';
    const dockerRelevantFiles = changedFiles.filter(isDockerRelevant);
    if (dockerRelevantFiles.length > 0) {
      return withClean({ required: true, reason: `Docker-related files changed${since} (${dockerRelevantFiles.length} files)`, files: dockerRelevantFiles });
    }
    return withClean({ required: false, reason: `No Docker-related files changed${since} (${changedFiles.length} files checked)`, files: changedFiles });
  } catch (error) {
    logger.error(`Unexpected error in shouldRunDockerBuild: ${error.message}`);
    return { required: true, reason: `Unexpected error: ${error.message} (fail-safe)`, files: [] };
  }
}

/** The commit HEAD points at, or null when git cannot tell. */
async function headCommit(exec) {
  try {
    const sha = (await exec('git rev-parse HEAD')).stdout.trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The marker's absolute path under `repoRoot`. */
function markerPath(repoRoot) {
  return path.join(repoRoot, LOCAL_BUILD_MARKER);
}

module.exports = { decideDockerBuild, headCommit, isLocalRun, markerPath, LOCAL_BUILD_MARKER, DOCKER_RELEVANT_PATHS };
