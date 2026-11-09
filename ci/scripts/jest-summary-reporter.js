/**
 * Jest reporter for CI: writes the run's results to JEST_SUMMARY_RAW for ci/scripts/jest-summary.js.
 * It replaces jest's --json: with --json, a jest worker running the structure chunker thread suite
 * beside others was killed by SIGTERM on every full run (2026-11-05), while the same run without
 * --json passed. A reporter runs in jest's main process and leaves the workers as they are.
 */
const fs = require('fs');

class JestSummaryReporter {
  onRunComplete(_contexts, results) {
    const file = process.env.JEST_SUMMARY_RAW;
    if (!file) return;
    // The fields jest-summary.js reads, in the shape of jest's --json output.
    const testResults = results.testResults.map((r) => ({
      name: r.testFilePath,
      status: r.testExecError || r.numFailingTests > 0 ? 'failed' : 'passed',
      assertionResults: (r.testResults || []).map((a) => ({ status: a.status })),
    }));
    fs.writeFileSync(file, JSON.stringify({ success: results.success, testResults }));
  }
}

module.exports = JestSummaryReporter;
