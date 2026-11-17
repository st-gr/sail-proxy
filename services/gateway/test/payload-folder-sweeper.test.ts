import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sweepPayloadFolder,
  payloadSweepLimits,
  startPayloadFolderSweeper,
  stopPayloadFolderSweeper,
} from '../src/utils/payloadFolderSweeper';

const HOUR = 3600 * 1000;
const NOW = new Date('2026-11-11T12:00:00Z');

let root: string;
let dir: string;

function put(name: string, ageHours: number, bytes = 100, base: string = dir): string {
  const file = path.join(base, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(bytes));
  const t = new Date(NOW.getTime() - ageHours * HOUR);
  fs.utimesSync(file, t, t);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-sweep-'));
  dir = path.join(root, 'payloads');
  fs.mkdirSync(dir);
});

afterEach(() => {
  stopPayloadFolderSweeper();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sweepPayloadFolder', () => {
  it('deletes files older than the retention and keeps younger ones', async () => {
    const old = put('a_old.json', 49);
    const young = put('b_young.json', 47);
    const result = await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 0 }, NOW);
    expect(result).toEqual({ byAge: 1, bySize: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
  });

  it('deletes the oldest files first while the folder is over the size limit', async () => {
    const files = [5, 4, 3, 2, 1].map((h, i) => put(`f${i}.json`, h));
    const result = await sweepPayloadFolder(dir, { retentionHours: 0, maxBytes: 300 }, NOW);
    expect(result).toEqual({ byAge: 0, bySize: 2 });
    expect(files.map((f) => fs.existsSync(f))).toEqual([false, false, true, true, true]);
  });

  it('retentionHours 0 deletes nothing by age', async () => {
    const ancient = put('ancient.json', 100000);
    const result = await sweepPayloadFolder(dir, { retentionHours: 0, maxBytes: 0 }, NOW);
    expect(result).toEqual({ byAge: 0, bySize: 0 });
    expect(fs.existsSync(ancient)).toBe(true);
  });

  it('maxBytes 0 deletes nothing by size', async () => {
    const files = [1, 2, 3].map((h, i) => put(`g${i}.json`, h, 1000));
    const result = await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 0 }, NOW);
    expect(result).toEqual({ byAge: 0, bySize: 0 });
    expect(files.every((f) => fs.existsSync(f))).toBe(true);
  });

  it('leaves files that are not *.json alone, however old and large', async () => {
    const other = put('notes.txt', 1000, 5000);
    const gateway = put('gateway.log', 1000, 5000);
    const json = put('p.json', 1000);
    await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 1 }, NOW);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(gateway)).toBe(true);
    expect(fs.existsSync(json)).toBe(false);
  });

  it('also removes the Anthropic stream dumps by age and by size, and no other text file', async () => {
    const oldDump = put('2026-11-08T10-00-00-000Z_gateway-1-a_04_client_native_stream_response.txt', 72);
    const youngDump = put('2026-11-11T11-00-00-000Z_gateway-2-b_04_client_native_stream_response.txt', 1, 5000);
    const notes = put('notes.txt', 1000, 5000);
    await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 1000 }, NOW);
    expect(fs.existsSync(oldDump)).toBe(false);   // by age
    expect(fs.existsSync(youngDump)).toBe(false); // by size
    expect(fs.existsSync(notes)).toBe(true);
  });

  it('is no error when the folder does not exist', async () => {
    await expect(
      sweepPayloadFolder(path.join(root, 'missing'), { retentionHours: 48, maxBytes: 100 }, NOW),
    ).resolves.toEqual({ byAge: 0, bySize: 0 });
  });

  it('runs by age before by size: only the two old files go', async () => {
    const o1 = put('o1.json', 60);
    const o2 = put('o2.json', 50);
    const y = [3, 2, 1].map((h, i) => put(`y${i}.json`, h));
    const result = await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 300 }, NOW);
    expect(result).toEqual({ byAge: 2, bySize: 0 });
    expect(fs.existsSync(o1)).toBe(false);
    expect(fs.existsSync(o2)).toBe(false);
    expect(y.every((f) => fs.existsSync(f))).toBe(true);
  });

  it('sweeps files in subfolders, removes an emptied subfolder, keeps the payload folder', async () => {
    const emptied = put('2026-11-01/old.json', 100);
    const mixed = put('2026-11-10/old.json', 100);
    const kept = put('2026-11-10/new.json', 1);
    await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 0 }, NOW);
    expect(fs.existsSync(emptied)).toBe(false);
    expect(fs.existsSync(path.dirname(emptied))).toBe(false);
    expect(fs.existsSync(mixed)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('keeps the payload folder when it is emptied', async () => {
    put('only.json', 100);
    await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 0 }, NOW);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never follows a symbolic link: the link stays and its target outside is untouched', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const target = put('victim.json', 1000, 100, outside);
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(target, link);
    const dirLink = path.join(dir, 'linked-folder');
    fs.symlinkSync(outside, dirLink);
    const result = await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 1 }, NOW);
    expect(result).toEqual({ byAge: 0, bySize: 0 });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('refuses a filesystem root', async () => {
    await expect(
      sweepPayloadFolder(path.parse(process.cwd()).root, { retentionHours: 1, maxBytes: 1 }, NOW),
    ).resolves.toEqual({ byAge: 0, bySize: 0 });
  });

  it('two overlapping sweeps delete every file once and do not throw', async () => {
    for (let i = 0; i < 50; i++) put(`f${i}.json`, 100);
    const limits = { retentionHours: 48, maxBytes: 0 };
    const [a, b] = await Promise.all([
      sweepPayloadFolder(dir, limits, NOW),
      sweepPayloadFolder(dir, limits, NOW),
    ]);
    expect(a.byAge + b.byAge).toBe(50);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a file that vanishes between listing and deleting is no error', async () => {
    const victim = put('vanish.json', 100);
    const other = put('other.json', 100);
    const realUnlink = fs.promises.unlink;
    const spy = jest.spyOn(fs.promises, 'unlink').mockImplementation(async (p: fs.PathLike) => {
      if (String(p) === victim) await realUnlink(p); // someone else deleted it first
      return realUnlink(p);
    });
    await expect(sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 0 }, NOW)).resolves.toEqual({
      byAge: 1,
      bySize: 0,
    });
    spy.mockRestore();
    expect(fs.existsSync(other)).toBe(false);
  });

  it('a file that cannot be deleted does not stop the sweep', async () => {
    const stuck = put('a_stuck.json', 100);
    const other = put('b_other.json', 100);
    const realUnlink = fs.promises.unlink;
    const spy = jest.spyOn(fs.promises, 'unlink').mockImplementation(async (p: fs.PathLike) => {
      if (String(p) === stuck) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realUnlink(p);
    });
    const result = await sweepPayloadFolder(dir, { retentionHours: 48, maxBytes: 0 }, NOW);
    spy.mockRestore();
    expect(result).toEqual({ byAge: 1, bySize: 0 });
    expect(fs.existsSync(stuck)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
  });
});

describe('payloadSweepLimits', () => {
  it('gives the defaults when nothing is set', () => {
    expect(payloadSweepLimits({})).toEqual({ retentionHours: 48, maxBytes: 1024 * 1024 * 1024, everyMinutes: 15 });
  });

  it('reads valid values', () => {
    expect(
      payloadSweepLimits({
        PAYLOAD_LOG_RETENTION_HOURS: '6',
        PAYLOAD_LOG_MAX_MB: '10',
        PAYLOAD_LOG_SWEEP_MINUTES: '2',
      }),
    ).toEqual({ retentionHours: 6, maxBytes: 10 * 1024 * 1024, everyMinutes: 2 });
  });

  it('gives the default for non-numeric, negative and non-finite values', () => {
    for (const bad of ['abc', '', '  ', '-1', 'Infinity', 'NaN']) {
      expect(
        payloadSweepLimits({
          PAYLOAD_LOG_RETENTION_HOURS: bad,
          PAYLOAD_LOG_MAX_MB: bad,
          PAYLOAD_LOG_SWEEP_MINUTES: bad,
        }),
      ).toEqual({ retentionHours: 48, maxBytes: 1024 * 1024 * 1024, everyMinutes: 15 });
    }
  });

  it('0 switches a limit off, but a sweep interval below 1 gives the default', () => {
    expect(
      payloadSweepLimits({
        PAYLOAD_LOG_RETENTION_HOURS: '0',
        PAYLOAD_LOG_MAX_MB: '0',
        PAYLOAD_LOG_SWEEP_MINUTES: '0',
      }),
    ).toEqual({ retentionHours: 0, maxBytes: 0, everyMinutes: 15 });
    expect(payloadSweepLimits({ PAYLOAD_LOG_SWEEP_MINUTES: '0.5' }).everyMinutes).toBe(15);
  });

  it('the lite gateway environment gives both limits as 0', () => {
    const lite = payloadSweepLimits({ PAYLOAD_LOG_RETENTION_HOURS: '0', PAYLOAD_LOG_MAX_MB: '0' });
    expect(lite.retentionHours).toBe(0);
    expect(lite.maxBytes).toBe(0);
  });
});

describe('startPayloadFolderSweeper', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('with both limits 0 it starts no timer', () => {
    process.env.PAYLOAD_LOG_RETENTION_HOURS = '0';
    process.env.PAYLOAD_LOG_MAX_MB = '0';
    const spy = jest.spyOn(global, 'setInterval');
    expect(startPayloadFolderSweeper()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('with a limit set it starts, once, and stop ends it', () => {
    delete process.env.PAYLOAD_LOG_RETENTION_HOURS;
    delete process.env.PAYLOAD_LOG_MAX_MB;
    expect(startPayloadFolderSweeper()).toBe(true);
    expect(startPayloadFolderSweeper()).toBe(true);
    stopPayloadFolderSweeper();
    process.env.PAYLOAD_LOG_RETENTION_HOURS = '0';
    process.env.PAYLOAD_LOG_MAX_MB = '0';
    expect(startPayloadFolderSweeper()).toBe(false);
  });
});
