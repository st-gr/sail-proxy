/**
 * Request overhead bench: the yardstick for changes to the gateway's logger. Three modes, chosen by the
 * first argument; each prints one JSON line per run. See requestOverheadBench/README.md.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/request-overhead-bench.ts e2e|logger|raw
 */
import { runE2eMode } from './requestOverheadBench/e2e';
import { runLoggerMode } from './requestOverheadBench/logger';
import { runRawMode } from './requestOverheadBench/raw';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'e2e') await runE2eMode();
  else if (mode === 'logger') await runLoggerMode();
  else if (mode === 'raw') await runRawMode();
  else throw new Error('usage: request-overhead-bench.ts e2e|logger|raw');
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
