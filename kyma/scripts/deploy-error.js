/**
 * A failed step of a strict deploy or of the migration Jobs. Carries kubectl's stderr only (cut
 * to STDERR_LIMIT), never a manifest: a Secret's contents cannot reach a log through it.
 */
const STDERR_LIMIT = 2000;

class DeployError extends Error {
  constructor({ step, command, stderr }) {
    super(`${step} failed`);
    this.name = 'DeployError';
    this.step = step;
    this.command = command;
    this.stderr = String(stderr || '').slice(0, STDERR_LIMIT);
  }
}

const stderrFrom = (error) => (error && (error.stderr || error.message)) || '';

module.exports = { DeployError, stderrFrom, STDERR_LIMIT };
