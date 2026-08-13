// Hermetic (no database) tests for the teacher-label logger: fire-and-forget
// semantics, the never-throws swallow, the drop-not-queue semaphore, the
// self-disable on structural errors, and the text-storage gate. The write
// itself is exercised against a mocked pg pool/client — a real database is
// Task 5's job (test/fileSearch/integration).
let teacherConfig: {
  enabled: boolean;
  storeChunkText: boolean;
  sampleRate: number;
  source: string;
  maxConcurrentWrites: number;
};

const DEFAULT_CONFIG = {
  enabled: false,
  storeChunkText: false,
  sampleRate: 1.0,
  source: 'production',
  maxConcurrentWrites: 2,
};

function mockConfig(overrides: Partial<typeof DEFAULT_CONFIG>): void {
  teacherConfig = { ...DEFAULT_CONFIG, ...overrides };
}

jest.mock('../../src/services/configService', () => ({
  __esModule: true,
  getTeacherLoggingConfig: () => teacherConfig,
}));

type MockClient = { query: jest.Mock; release: jest.Mock };
type MockPool = { connect: jest.Mock } | null;

let mockPool: MockPool = null;

jest.mock('../../src/fileSearch/db', () => ({
  __esModule: true,
  getPool: () => mockPool,
}));

import * as teacherLogger from '../../src/fileSearch/teacherLogger';
import { candidateId, CandidateChunk } from '../../src/fileSearch/repository';

function makeClient(queryImpl?: (text: string, values?: any[]) => Promise<any>): MockClient {
  return {
    query: jest.fn(queryImpl ?? (async () => ({ rows: [], rowCount: 0 }))),
    release: jest.fn(),
  };
}

function setPoolClient(client: MockClient): void {
  mockPool = { connect: jest.fn(async () => client) };
}

function mockPoolConnectRejects(err: Error): void {
  mockPool = { connect: jest.fn(async () => { throw err; }) };
}

// Holds the semaphore slot open indefinitely: connect() succeeds but the
// first query (BEGIN) never resolves, so inFlight is never decremented.
function blockNextWrite(): void {
  setPoolClient(makeClient(() => new Promise(() => {})));
}

// Records every query issued against the mocked client and reconstructs the
// candidate-label rows from the multi-row INSERT by reading the column list
// straight out of the SQL text (rather than hardcoding it a second time
// here), so this stays correct if teacherLogger.ts's column order changes.
function captureInsertParams() {
  const calls: { text: string; values: any[] }[] = [];
  setPoolClient(makeClient(async (text: string, values: any[] = []) => {
    calls.push({ text, values });
    return { rows: [], rowCount: 0 };
  }));
  return {
    get calls() {
      return calls;
    },
    get labelRows(): Array<Record<string, any>> {
      const call = calls.find((c) => /INSERT INTO reranker_candidate_labels/.test(c.text));
      if (!call) return [];
      const colsMatch = call.text.match(/\(([^)]+)\)\s*VALUES/i);
      if (!colsMatch) return [];
      const cols = colsMatch[1].split(',').map((s) => s.trim());
      const rows: Array<Record<string, any>> = [];
      for (let i = 0; i < call.values.length; i += cols.length) {
        const row: Record<string, any> = {};
        cols.forEach((col, j) => { row[col] = call.values[i + j]; });
        rows.push(row);
      }
      return rows;
    },
    // Same technique as labelRows: read the column list out of the SQL text
    // itself, rather than a second hardcoded copy of the column order, so a
    // reordered INSERT can't silently move an assertion onto the wrong column.
    get eventRow(): Record<string, any> | null {
      const call = calls.find((c) => /INSERT INTO reranker_search_events/.test(c.text));
      if (!call) return null;
      const colsMatch = call.text.match(/\(([^)]+)\)\s*VALUES/i);
      if (!colsMatch) return null;
      const cols = colsMatch[1].split(',').map((s) => s.trim());
      const row: Record<string, any> = {};
      cols.forEach((col, j) => { row[col] = call.values[j]; });
      return row;
    },
  };
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

function candidate(overrides: Partial<CandidateChunk> & { fileId: string; ord: number }): CandidateChunk {
  return {
    storeId: 'vs_1',
    filename: `${overrides.fileId}.md`,
    text: `text for ${overrides.fileId}#${overrides.ord}`,
    attributes: {},
    score: 0.5,
    ...overrides,
  };
}

const baseInput = (): teacherLogger.TeacherLogInput => {
  const candidates: CandidateChunk[] = [
    candidate({ fileId: 'file-1', ord: 0, score: 0.9, vectorRank: 1, vectorScore: 0.1, lexicalRank: 2, lexicalScore: 0.3 }),
    candidate({ fileId: 'file-2', ord: 0, score: 0.8, vectorRank: 2, vectorScore: 0.2 }),
    candidate({ fileId: 'file-3', ord: 1, score: 0.7, attributes: { tag: 'x' } }),
  ];
  return {
    queryText: 'what is the refund policy',
    rewriteUsed: false,
    storeIds: ['vs_1'],
    ownerEmail: 'owner@example.com',
    candidates,
    teacher: [
      { index: 0, relevanceScore: 0.95 },
      { index: 2, relevanceScore: 0.4 },
    ],
    selectedIds: new Set([candidateId('vs_1', 'file-1', 0)]),
    embeddingModel: 'text-embedding-3-large',
    embeddingDim: 1536,
    candidatesRequested: 50,
    rrfK: 60,
    lexicalEnabled: true,
  };
};

beforeEach(() => {
  teacherLogger.__resetForTests();
  mockConfig({});
  setPoolClient(makeClient());
});

describe('teacherLogger.record', () => {
  it('returns void synchronously, not a promise', () => {
    mockConfig({ enabled: true });
    const result = teacherLogger.record(baseInput());
    expect(result).toBeUndefined();
  });

  it('does nothing at all when disabled', () => {
    mockConfig({ enabled: false });
    const client = makeClient();
    setPoolClient(client);

    teacherLogger.record(baseInput());

    expect(mockPool!.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('never throws when the write rejects', async () => {
    mockConfig({ enabled: true });
    mockPoolConnectRejects(new Error('connection refused'));

    expect(() => teacherLogger.record(baseInput())).not.toThrow();
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().written).toBe(0);
  });

  it('drops rather than queues when the semaphore is saturated', () => {
    mockConfig({ enabled: true, maxConcurrentWrites: 1 });
    blockNextWrite(); // hold one slot open

    teacherLogger.record(baseInput()); // takes the slot
    teacherLogger.record(baseInput()); // must be dropped, not queued

    expect(teacherLogger.__statsForTests().dropped).toBe(1);
  });

  it('samples deterministically with an injected RNG', () => {
    mockConfig({ enabled: true, sampleRate: 0.5 });

    teacherLogger.__setRngForTests(() => 0.9); // above the rate -> skip
    teacherLogger.record(baseInput());
    expect(teacherLogger.__statsForTests().written).toBe(0);

    teacherLogger.__setRngForTests(() => 0.1); // below -> write
    expect(() => teacherLogger.record(baseInput())).not.toThrow();
  });

  it('omits chunk_text when store_chunk_text is false but still stores chunk_hash', async () => {
    mockConfig({ enabled: true, storeChunkText: false });
    const captured = captureInsertParams();

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(captured.labelRows.length).toBe(3);
    expect(captured.labelRows.every((r) => r.chunk_text === null)).toBe(true);
    expect(captured.labelRows.every((r) => typeof r.chunk_hash === 'string' && r.chunk_hash.length > 0)).toBe(true);
  });

  it('stores chunk_text when store_chunk_text is true', async () => {
    mockConfig({ enabled: true, storeChunkText: true });
    const captured = captureInsertParams();

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(captured.labelRows.every((r) => typeof r.chunk_text === 'string')).toBe(true);
  });

  it('disables itself after a permission error rather than warning per search', async () => {
    mockConfig({ enabled: true });
    mockPoolConnectRejects(Object.assign(new Error('permission denied'), { code: '42501' }));

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().disabled).toBe(true);

    const before = teacherLogger.__statsForTests().dropped;
    const connectSpy = mockPool!.connect;
    connectSpy.mockClear();
    teacherLogger.record(baseInput());

    expect(teacherLogger.__statsForTests().dropped).toBe(before); // not even attempted
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('disables itself after an undefined-table error (42P01)', async () => {
    mockConfig({ enabled: true });
    mockPoolConnectRejects(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().disabled).toBe(true);
  });

  it('does not self-disable on an ordinary (non-structural) error', async () => {
    mockConfig({ enabled: true });
    mockPoolConnectRejects(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().disabled).toBe(false);
  });

  it('counts a failed write in `failed`, without disabling the logger', async () => {
    // `failed` exists so a test can wait on "a write failed" directly. The
    // alternative — waiting on `disabled` — only works for errors on the
    // 42501/42P01 self-disable list, so it silently stops observing the failure
    // path for every other error, and stops observing it entirely if that list
    // is ever changed.
    mockConfig({ enabled: true });
    mockPoolConnectRejects(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().failed).toBe(1);
    expect(teacherLogger.__statsForTests().disabled).toBe(false);
    expect(teacherLogger.__statsForTests().written).toBe(0);
  });

  it('counts a structural failure in `failed` as well as disabling', async () => {
    mockConfig({ enabled: true });
    mockPoolConnectRejects(Object.assign(new Error('permission denied'), { code: '42501' }));

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().failed).toBe(1);
    expect(teacherLogger.__statsForTests().disabled).toBe(true);
  });

  it('records candidate_index and retrieval_rank as the identity that holds today', async () => {
    mockConfig({ enabled: true });
    const captured = captureInsertParams();

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(captured.labelRows.length).toBeGreaterThan(0);
    for (const r of captured.labelRows) {
      expect(r.retrieval_rank).toBe(r.candidate_index + 1);
    }
  });

  it('records a null teacher and reranker_available=false for rrf_only searches', async () => {
    mockConfig({ enabled: true });
    const captured = captureInsertParams();

    const input = baseInput();
    input.teacher = null;
    teacherLogger.record(input);
    await flushMicrotasks();

    const eventRow = captured.eventRow;
    expect(eventRow).not.toBeNull();
    expect(eventRow!.reranker_available).toBe(false);
    expect(eventRow!.retrieval_mode).toBe('rrf_only');

    expect(captured.labelRows.every((r) => r.teacher_rank === null)).toBe(true);
    expect(captured.labelRows.every((r) => r.teacher_score === null)).toBe(true);
  });

  it('pins teacher_rank/teacher_score to the teacher array position, not the retrieval index', async () => {
    // The only fixture shape that can distinguish "teacher rank/score" from
    // "retrieval rank/score" is one where the teacher's ordering actually
    // differs from retrieval order — reversed here, plus one candidate
    // (index 3) the teacher never scored at all.
    mockConfig({ enabled: true });
    const captured = captureInsertParams();

    const input = baseInput();
    input.candidates = [
      candidate({ fileId: 'file-1', ord: 0 }),
      candidate({ fileId: 'file-2', ord: 0 }),
      candidate({ fileId: 'file-3', ord: 0 }),
      candidate({ fileId: 'file-4', ord: 0 }),
    ];
    input.teacher = [
      { index: 2, relevanceScore: 0.99 }, // teacher's #1 pick is retrieval candidate 2
      { index: 1, relevanceScore: 0.50 }, // teacher's #2 pick is retrieval candidate 1
      { index: 0, relevanceScore: 0.01 }, // teacher's #3 pick is retrieval candidate 0
      // candidate 3 (retrieval index 3) was never returned by the teacher at all.
    ];
    input.selectedIds = new Set();

    teacherLogger.record(input);
    await flushMicrotasks();

    const byIndex = (i: number) => captured.labelRows.find((r) => r.candidate_index === i)!;

    expect(byIndex(0).teacher_rank).toBe(3);
    expect(byIndex(0).teacher_score).toBe(0.01);
    expect(byIndex(1).teacher_rank).toBe(2);
    expect(byIndex(1).teacher_score).toBe(0.50);
    expect(byIndex(2).teacher_rank).toBe(1);
    expect(byIndex(2).teacher_score).toBe(0.99);
    expect(byIndex(3).teacher_rank).toBeNull();
    expect(byIndex(3).teacher_score).toBeNull();
  });

  it('writes all candidate labels in a single multi-row INSERT, not one per candidate', async () => {
    mockConfig({ enabled: true });
    const captured = captureInsertParams();

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    const labelInserts = captured.calls.filter((c) => /INSERT INTO reranker_candidate_labels/.test(c.text));
    expect(labelInserts.length).toBe(1);
    expect(captured.labelRows.length).toBe(3);
  });

  it('commits only after both inserts succeed, and rolls back on a mid-transaction failure', async () => {
    mockConfig({ enabled: true });
    const queries: string[] = [];
    let callCount = 0;
    setPoolClient(makeClient(async (text: string) => {
      queries.push(text);
      callCount++;
      // Fail the candidate-labels insert specifically.
      if (/INSERT INTO reranker_candidate_labels/.test(text)) {
        throw Object.assign(new Error('constraint violation'), { code: '23505' });
      }
      return { rows: [], rowCount: 0 };
    }));

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    expect(queries.some((q) => q === 'COMMIT')).toBe(false);
    expect(queries.some((q) => q === 'ROLLBACK')).toBe(true);
    expect(teacherLogger.__statsForTests().written).toBe(0);
    expect(teacherLogger.__statsForTests().disabled).toBe(false); // not a structural error
  });

  it('marks selected candidates using the shared candidateId() key format', async () => {
    mockConfig({ enabled: true });
    const captured = captureInsertParams();

    teacherLogger.record(baseInput());
    await flushMicrotasks();

    const selectedRow = captured.labelRows.find((r) => r.file_id === 'file-1' && r.ord === 0);
    const unselectedRow = captured.labelRows.find((r) => r.file_id === 'file-2' && r.ord === 0);
    expect(selectedRow!.selected).toBe(true);
    expect(unselectedRow!.selected).toBe(false);
  });

  it('is a no-op with no thrown error when no database is configured', async () => {
    mockConfig({ enabled: true });
    mockPool = null;

    expect(() => teacherLogger.record(baseInput())).not.toThrow();
    await flushMicrotasks();

    expect(teacherLogger.__statsForTests().written).toBe(0);
  });

  it('returns the semaphore slot after a write completes, so a later call is not dropped forever', async () => {
    mockConfig({ enabled: true, maxConcurrentWrites: 1 });
    setPoolClient(makeClient()); // resolves cleanly

    teacherLogger.record(baseInput());
    await flushMicrotasks();
    expect(teacherLogger.__statsForTests().written).toBe(1); // the write actually completed...

    teacherLogger.record(baseInput()); // ...so the slot must be free again, not leaked forever
    expect(teacherLogger.__statsForTests().dropped).toBe(0);
  });

  it('never throws even when reading the configuration itself throws', () => {
    mockConfig({ enabled: true });
    const configService = require('../../src/services/configService');
    const original = configService.getTeacherLoggingConfig;
    configService.getTeacherLoggingConfig = () => { throw new Error('config boom'); };
    try {
      expect(() => teacherLogger.record(baseInput())).not.toThrow();
    } finally {
      configService.getTeacherLoggingConfig = original;
    }
  });
});
