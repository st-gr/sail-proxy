/** Command line of the file_search scale bench (file-search-scale.ts). */
import { OR_ARM_RANKED_SET_CEILING } from '../../src/fileSearch/lexicalBound';

export interface IndexConfig {
  kind: 'vector' | 'halfvec';
  efConstruction: number;
  /** false: max_parallel_maintenance_workers = 0 (no dynamic shared memory); true: the server default of 2. */
  parallel: boolean;
}

export interface Options {
  dims: number;
  /** One store per entry, of that many chunks; they share one table. */
  stores: number[];
  /** clustered: mixtures of a few centroids (recall); random: independent Gaussian vectors (worst case). */
  vectors: 'clustered' | 'random';
  words: number;
  indexes: IndexConfig[];
  queries: number;
  limit: number;
  lexical: boolean;
  thetas: number[];
  /** Ranked-set ceilings of the OR arm to measure (the shipped one by default). */
  ceilings: number[];
  insert: number;
  maintenanceWorkMem: string;
  keepDb: boolean;
  dsn: string | null;
  out: string | null;
  /** Filler stores of TENANT_CHUNKS chunks besides the measured ones, so the table's store statistics look like
   *  a many-store install's (with a handful of stores the planner scans the whole table for a small one). */
  tenants: number;
}

/** pgvector's HNSW limits: 2,000 dimensions for vector, 4,000 for halfvec. */
const MAX_DIMS = { vector: 2000, halfvec: 4000 } as const;

export const USAGE = `Usage (from services/gateway):
  pnpm run bench:file-search-scale -- [--dims 1536] [--stores 1000,2000,...,200000] [--vectors clustered|random]
      [--words 120] [--index halfvec:200:serial,vector:64:parallel,...|none] [--queries 20] [--limit 50]
      [--lexical] [--theta 0.02,0.05,0.1] [--ceiling 2000,5000] [--insert 2000] [--maintenance-work-mem 1GB]
      [--tenants 200] [--keep-db] [--dsn postgresql://...] [--out results.json]`;

export function parseIndexConfigs(text: string): IndexConfig[] {
  if (text.trim() === 'none') return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const [kind, ef, mode, ...rest] = item.split(':');
    const efConstruction = Number(ef);
    if (rest.length > 0 || (kind !== 'vector' && kind !== 'halfvec') || !Number.isInteger(efConstruction)
      || efConstruction < 4 || efConstruction > 1000 || (mode !== 'serial' && mode !== 'parallel')) {
      throw new Error(`--index entries are kind:ef_construction:mode (vector|halfvec, 4..1000, serial|parallel), got ${item}`);
    }
    return { kind, efConstruction, parallel: mode === 'parallel' };
  });
}

/** The bench's HNSW index (m 16, pgvector's default): on the vector column, or on its halfvec cast. */
export function indexDdl(config: IndexConfig, dims: number): string {
  const column = config.kind === 'halfvec'
    ? `(embedding::halfvec(${dims})) halfvec_cosine_ops` : 'embedding vector_cosine_ops';
  return `CREATE INDEX idx_chunks_hnsw ON vector_store_chunks USING hnsw (${column}) `
    + `WITH (m = 16, ef_construction = ${config.efConstruction})`;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dims: 1536,
    stores: [1000, 2000, 5000, 10000, 20000, 50000, 200000],
    vectors: 'clustered',
    words: 120,
    indexes: [{ kind: 'halfvec', efConstruction: 200, parallel: false }],
    queries: 20,
    limit: 50,
    lexical: false,
    thetas: [0.02, 0.05, 0.1],
    ceilings: [OR_ARM_RANKED_SET_CEILING],
    insert: 2000,
    maintenanceWorkMem: '1GB',
    keepDb: false,
    dsn: null,
    out: null,
    tenants: 200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    const int = (value: string, min: number, max: number): number => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${arg} must be an integer in ${min}..${max}, got ${value}`);
      return n;
    };
    switch (arg) {
      case '--dims': opts.dims = int(next(), 1, MAX_DIMS.halfvec); break;
      case '--stores': {
        const list = next().split(',').map((s) => s.trim());
        if (list.length === 0 || list.some((s) => s === '')) throw new Error('--stores needs a list of sizes');
        opts.stores = list.map((s) => int(s, 1, 10_000_000));
        break;
      }
      case '--vectors': {
        const v = next();
        if (v !== 'clustered' && v !== 'random') throw new Error(`--vectors must be clustered or random, got ${v}`);
        opts.vectors = v;
        break;
      }
      case '--words': opts.words = int(next(), 1, 2000); break;
      case '--index': opts.indexes = parseIndexConfigs(next()); break;
      case '--queries': opts.queries = int(next(), 1, 1000); break;
      case '--limit': opts.limit = int(next(), 1, 1000); break;
      case '--lexical': opts.lexical = true; break;
      case '--theta': {
        opts.thetas = next().split(',').map((s) => {
          const t = Number(s);
          if (!(t > 0 && t < 1)) throw new Error(`--theta values must be in (0, 1), got ${s}`);
          return t;
        });
        break;
      }
      case '--ceiling': {
        const list = next().split(',').map((s) => s.trim());
        if (list.some((s) => s === '')) throw new Error('--ceiling needs a list of sizes');
        opts.ceilings = list.map((s) => int(s, 1, 10_000_000));
        break;
      }
      case '--insert': opts.insert = int(next(), 0, 1_000_000); break;
      case '--maintenance-work-mem': {
        const v = next();
        if (!/^\d+(kB|MB|GB)$/.test(v)) throw new Error(`--maintenance-work-mem must look like 1GB or 512MB, got ${v}`);
        opts.maintenanceWorkMem = v;
        break;
      }
      case '--keep-db': opts.keepDb = true; break;
      case '--dsn': opts.dsn = next(); break;
      case '--out': opts.out = next(); break;
      case '--tenants': opts.tenants = int(next(), 0, 100_000); break;
      case '--': break; // pnpm run forwards it
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const c of opts.indexes) {
    if (opts.dims > MAX_DIMS[c.kind]) {
      throw new Error(`a ${c.kind} HNSW index takes at most ${MAX_DIMS[c.kind]} dimensions, --dims is ${opts.dims}`);
    }
  }
  return opts;
}
