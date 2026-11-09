/**
 * The database migrations of `sail-proxy upgrade kyma`, run as Jobs
 * (kyma/templates/manifests/core/migrate-jobs.yaml, rendered into manifests/upgrade/).
 */
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const { DeployError, stderrFrom, STDERR_LIMIT } = require('./deploy-error');

const execAsync = promisify(exec);

// Job name by short name, in run order; each Job carries the label sail-proxy/migration-job=<short>
const MIGRATION_JOB_NAMES = {
  admin: 'sail-proxy-migrate-admin',
  'file-search': 'sail-proxy-migrate-file-search'
};
const MIGRATION_JOBS = Object.values(MIGRATION_JOB_NAMES);

// Runs the named migration Jobs (default both, admin first) and waits for them: stale Jobs of the
// same names are deleted first, only the selected Jobs of the rendered file applied, then each is
// polled until it completes. A Job that fails (or does not finish within timeoutSeconds) throws a
// DeployError carrying the last 50 lines of its log. manifestsDir is the render's manifests
// directory (it holds upgrade/); kubectl takes a command string and returns {stdout, stderr},
// throwing on failure.
async function runMigrationJobs({
  namespace,
  manifestsDir,
  jobs = ['admin', 'file-search'],
  kubectl = (command) => execAsync(command),
  timeoutSeconds = 600,
  pollIntervalMs = 2000
}) {
  for (const job of jobs) {
    if (!MIGRATION_JOB_NAMES[job]) throw new Error(`Unknown migration job "${job}"`);
  }
  const names = jobs.map(job => MIGRATION_JOB_NAMES[job]);
  const file = path.join(manifestsDir, 'upgrade', 'migrate-jobs.yaml');
  let lastCommand = '';
  const call = async (step, command) => {
    lastCommand = command;
    try {
      return await kubectl(command);
    } catch (error) {
      throw new DeployError({ step, command, stderr: stderrFrom(error) });
    }
  };
  const logsOf = async (name) => {
    try {
      return (await kubectl(`kubectl -n ${namespace} logs job/${name} --tail=50`)).stdout || '';
    } catch (error) {
      return `(no log: ${stderrFrom(error)})`;
    }
  };
  const fail = async (name, why, command) => {
    const logs = await logsOf(name);
    throw new DeployError({
      step: `Migration job ${name}`,
      command,
      stderr: `${why}\n${logs}`.slice(-STDERR_LIMIT)
    });
  };

  await call('Removing earlier migration jobs', `kubectl -n ${namespace} delete job ${names.join(' ')} --ignore-not-found`);
  for (const job of jobs) {
    await call(`Applying the ${job} migration job`, `kubectl apply -f "${file}" -l sail-proxy/migration-job=${job}`);
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  const pending = new Set(names);
  while (pending.size > 0) {
    for (const name of [...pending]) {
      const { stdout } = await call(`Reading migration job ${name}`, `kubectl -n ${namespace} get job ${name} -o json`);
      const conditions = (JSON.parse(stdout).status || {}).conditions || [];
      const isTrue = (type) => conditions.some(c => c.type === type && c.status === 'True');
      if (isTrue('Failed')) await fail(name, 'the Job failed', lastCommand);
      if (isTrue('Complete')) {
        console.log(`Migration job ${name} completed`);
        pending.delete(name);
      }
    }
    if (pending.size === 0) break;
    if (Date.now() >= deadline) {
      await fail([...pending][0], `not complete after ${timeoutSeconds}s`, `kubectl -n ${namespace} get job ${[...pending][0]} -o json`);
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

module.exports = { runMigrationJobs, MIGRATION_JOBS, MIGRATION_JOB_NAMES };
