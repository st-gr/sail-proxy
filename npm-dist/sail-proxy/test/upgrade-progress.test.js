// The progress lines of a long upgrade or rollback phase: a heartbeat while it runs, its duration at the end.
const assert = require('assert');
const { runPhase } = require('../dist/upgrade/steps');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // A phase that outlasts the interval says it is still running, then how long it took
  const lines = [];
  const value = await runPhase((m) => lines.push(m), 'Restoring the database from the backup', async () => { await sleep(120); return 42; }, { intervalMs: 25 });
  assert.strictEqual(value, 42, 'the work\'s result is returned');
  assert.strictEqual(lines[0], 'Restoring the database from the backup...');
  const still = lines.filter((l) => l.startsWith('  still restoring the database from the backup ('));
  assert.ok(still.length >= 2, `heartbeats: ${JSON.stringify(lines)}`);
  assert.match(still[0], /\(\d+ s\)$/);
  assert.match(lines[lines.length - 1], /^ {2}done in \d+ s$/);

  // A quick phase: no heartbeat, only the duration
  const quick = [];
  await runPhase((m) => quick.push(m), 'Stopping the new components', async () => {}, { intervalMs: 1000 });
  assert.deepStrictEqual(quick.map((l) => l.replace(/\d+/, 'N')), ['Stopping the new components...', '  done in N s']);

  // A failing phase stops its heartbeat and passes the error on, without a "done"
  const failing = [];
  await assert.rejects(runPhase((m) => failing.push(m), 'Starting the previous version', async () => { await sleep(60); throw new Error('boom'); }, { intervalMs: 20 }), /boom/);
  const count = failing.length;
  await sleep(60);
  assert.strictEqual(failing.length, count, 'no heartbeat after the phase ended');
  assert.ok(!failing.some((l) => /done in/.test(l)));
  console.log('ok - runPhase: heartbeat while running, duration at the end, silent after a failure');
}

main().then(() => process.exit(0), (error) => { console.log(`not ok - runPhase\n${error.stack}`); process.exit(1); });
