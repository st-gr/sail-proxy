/**
 * file_search scale bench: synthetic stores in a throwaway pgvector database, no SAP calls. Measures the
 * exact vector arm against the ANN path per HNSW index configuration (vector or halfvec,
 * ef_construction, serial or parallel build): latency, tie-aware recall@limit, under-returned answers,
 * build time, index size and the insert cost with and without the index; with --lexical, the full-text
 * OR arm today, without table-statistics common lexemes, and under ranked-set ceilings. See
 * ci/file-search-eval/README.md ("Scale bench") for how to run it and read the numbers.
 */
import { options } from './fileSearchScale/bootstrap';
import * as fs from 'fs';
import { Client } from 'pg';
import { getPool, runMigration, __resetForTests } from '../src/fileSearch/db';
import {
  installSignalCleanup, prepareDatabase, removeContainer, schemaDsn, startContainer,
} from './fileSearchScale/database';
import { measureLexical } from './fileSearchScale/lexical';
import { benchStores, clearInserted, ensureLoaded, measureInsert } from './fileSearchScale/load';
import { annTable, buildTable, ConfigResult, configName, exactTable, lexicalTable } from './fileSearchScale/report';
import { buildIndex, exactFromTruth, measureAnn, measureExact, OWNER } from './fileSearchScale/vectors';

const started = Date.now();
const log = (m: string) => console.log(`[file-search-scale ${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`);

async function migrate(): Promise<boolean> {
  try {
    return await runMigration();
  } finally {
    await getPool()?.end();
    __resetForTests();
  }
}

async function bench(baseDsn: string): Promise<void> {
  await prepareDatabase(baseDsn);
  const dsn = schemaDsn(baseDsn);
  process.env.FILE_SEARCH_DATABASE_URL = dsn;
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const load = await ensureLoaded(client, options, migrate, log);
    const stores = benchStores(options.stores, options.tenants);
    const exact = (load.reused ? await exactFromTruth(client, stores, options.queries) : null)
      ?? await measureExact(client, stores, options.limit, log);

    let lexical = null;
    if (options.lexical) {
      const largest = stores.reduce((a, b) => (b.size > a.size ? b : a));
      log(`full-text arm on ${largest.id} (${largest.size} chunks)`);
      lexical = { store: largest, ...await measureLexical(client, { storeId: largest.id, owner: OWNER,
        limit: options.limit, words: options.words, thetas: options.thetas, ceilings: options.ceilings }, log) };
    }

    let baselineInsert = null;
    if (options.insert > 0) {
      await client.query('DROP INDEX IF EXISTS idx_chunks_hnsw');
      baselineInsert = await measureInsert(client, options);
      await clearInserted(client);
      log(`insert without an HNSW index: ${baselineInsert.msPer1000.toFixed(0)} ms per 1000 chunks`);
    }

    const configs: ConfigResult[] = [];
    for (const config of options.indexes) {
      /* eslint-disable no-await-in-loop */
      log(`building ${configName(config)}`);
      const built = await buildIndex(client, config, options.dims, options.maintenanceWorkMem);
      log(`built ${configName(config)} in ${(built.buildMs / 1000).toFixed(1)} s, ${(built.indexBytes / 2 ** 20).toFixed(0)} MiB`);
      const ann = await measureAnn(client, stores, config, options.dims, options.limit, log);
      const insert = options.insert > 0 ? await measureInsert(client, options) : null;
      if (insert) log(`insert with ${configName(config)}: ${insert.msPer1000.toFixed(0)} ms per 1000 chunks`);
      await clearInserted(client);
      configs.push({ config, ...built, insert, ann });
      /* eslint-enable no-await-in-loop */
    }

    console.log(`\n## ${options.dims} dims, ${options.vectors} vectors, ${load.chunks} chunks, ${options.tenants} tenant stores `
      + `(Postgres ${load.postgres}, pgvector ${load.pgvector}, maintenance_work_mem ${options.maintenanceWorkMem})\n`);
    console.log(`${exactTable(exact)}\n`);
    console.log(`${buildTable(configs, baselineInsert)}\n`);
    if (configs.length > 0) console.log(`${annTable(configs)}\n`);
    if (lexical) {
      console.log(`Full-text arm on ${lexical.store.size} chunks; lexemes above theta in pg_stats: `
        + `${JSON.stringify(lexical.statsCommon)}\n`);
      console.log(`${lexicalTable(lexical.results)}\n`);
    }
    if (options.out) {
      fs.writeFileSync(options.out, JSON.stringify({ options: { ...options, dsn: undefined }, load, exact, lexical,
        baselineInsert, configs }, null, 2));
      log(`results written to ${options.out}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function main(): Promise<number> {
  try {
    if (options.dsn) {
      await bench(options.dsn);
    } else {
      installSignalCleanup({ keepDb: options.keepDb, remove: () => removeContainer(log) });
      try {
        await bench(await startContainer(log, options.keepDb));
      } finally {
        if (!options.keepDb) removeContainer(log);
      }
    }
    return 0;
  } catch (error: any) {
    // The driver's message can quote SQL, never credentials; the DSN is not printed.
    console.error(`[file-search-scale] failed: ${error?.code ?? ''} ${String(error?.message ?? error).split('\n')[0]}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
