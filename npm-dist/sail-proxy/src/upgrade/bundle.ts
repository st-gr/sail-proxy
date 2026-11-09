// Framing choice: manifest.json is the LAST entry of the plaintext stream, because the
// per-entry size and sha256 are only known once the entries have been streamed. openBundle
// therefore extracts every entry, then locates manifest.json, then verifies each entry's
// sha256 (after the GCM tag, in mode E) before returning anything to the caller.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'fs';
import { chmod, mkdir, open, rename, rm, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getConfigDir } from '../utils/paths';

export const MIN_PASSPHRASE = 12;
const MAGIC = 'SPBK';
const VERSION = '1';
const HEADER_LEN = 7; // SPBK1 + mode + \n
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const MANIFEST = 'manifest.json';
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_NAME = 4096;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Only authentication, format and integrity failures use BAD_PASSPHRASE_OR_DAMAGED; system I/O errors
// (EACCES, ENOSPC, ...) propagate as the original Node error.
export type BundleErrorCode = 'BAD_PASSPHRASE_OR_DAMAGED' | 'NOT_A_BUNDLE' | 'UNSUPPORTED_FORMAT' | 'PASSPHRASE_REQUIRED';

export class BundleError extends Error {
  code: BundleErrorCode;
  constructor(code: BundleErrorCode, message?: string) {
    super(message ?? ({
      BAD_PASSPHRASE_OR_DAMAGED: 'wrong passphrase or damaged file',
      NOT_A_BUNDLE: 'not a sail-proxy backup file',
      UNSUPPORTED_FORMAT: 'unsupported backup format',
      PASSPHRASE_REQUIRED: 'this backup is encrypted, a passphrase is required',
    })[code]);
    this.name = 'BundleError';
    this.code = code;
  }
}

export interface BundleEntryInfo { name: string; size: number; sha256: string }
export interface BundleManifest {
  format: 1;
  kind: 'kyma' | 'docker';
  fromVersion: string;
  toVersion: string;
  createdAt: string;
  entries: BundleEntryInfo[];
}
export type PromptFn = (questions: object[]) => Promise<Record<string, string>>;

export async function resolvePassphrase(opts: {
  encrypt: boolean; confirm: boolean; env?: NodeJS.ProcessEnv; prompt: PromptFn;
}): Promise<string | null> {
  if (!opts.encrypt) return null;
  const env = opts.env ?? process.env;
  const tooShort = `The passphrase must be at least ${MIN_PASSPHRASE} characters.`;
  const fromEnv = env.SAIL_PROXY_BACKUP_PASSPHRASE;
  if (fromEnv) {
    if (fromEnv.length < MIN_PASSPHRASE) throw new Error(`SAIL_PROXY_BACKUP_PASSPHRASE: ${tooShort}`);
    return fromEnv;
  }
  const ask = async (message: string): Promise<string> => {
    const a = await opts.prompt([{ type: 'password', name: 'passphrase', message, mask: '*' }]);
    return a.passphrase ?? '';
  };
  const first = await ask('Backup passphrase:');
  if (first.length < MIN_PASSPHRASE) throw new Error(tooShort);
  if (opts.confirm) {
    const second = await ask('Repeat the passphrase:');
    if (second !== first) throw new Error('The passphrases do not match.');
  }
  return first;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

export function backupFileName(label: string, fromVersion: string, now: Date): string {
  const ts = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  return `${safe(label)}-${safe(fromVersion)}-${ts}.spbk`;
}

export function defaultBackupDir(): string {
  return join(getConfigDir(), 'backups');
}

function validName(name: string): boolean {
  if (!name || name.length > MAX_NAME || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const deriveKey = (pass: string, salt: Buffer): Promise<Buffer> =>
  new Promise((res, rej) => scrypt(pass, salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));

async function chmodQuiet(p: string): Promise<void> {
  try { await chmod(p, 0o600); } catch { /* best effort (Windows) */ }
}

export async function writeBundle(
  file: string,
  passphrase: string | null,
  manifest: Omit<BundleManifest, 'entries'>,
  entries: AsyncIterable<{ name: string; source: string }>,
): Promise<BundleManifest> {
  const partial = `${file}.partial`;
  const infos: BundleEntryInfo[] = [];
  const frame = (name: string, size: number): Buffer => {
    const nb = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(4 + nb.length + 8);
    h.writeUInt32BE(nb.length, 0);
    nb.copy(h, 4);
    h.writeBigUInt64BE(BigInt(size), 4 + nb.length);
    return h;
  };
  async function* plaintext(): AsyncGenerator<Buffer> {
    const seen = new Set<string>([MANIFEST]);
    for await (const e of entries) {
      if (!validName(e.name) || seen.has(e.name)) throw new Error(`invalid or duplicate bundle entry name: ${e.name}`);
      seen.add(e.name);
      const size = (await stat(e.source)).size;
      yield frame(e.name, size);
      const hash = createHash('sha256');
      let count = 0;
      for await (const chunk of createReadStream(e.source) as AsyncIterable<Buffer>) {
        count += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (count !== size) throw new Error(`source changed while writing: ${e.name}`);
      infos.push({ name: e.name, size, sha256: hash.digest('hex') });
    }
    const full: BundleManifest = { ...manifest, entries: infos };
    const body = Buffer.from(JSON.stringify(full, null, 2), 'utf8');
    yield frame(MANIFEST, body.length);
    yield body;
  }
  try {
    await mkdir(dirname(file), { recursive: true });
    const out = createWriteStream(partial, { flags: 'w', mode: 0o600 });
    const header = Buffer.from(`${MAGIC}${VERSION}${passphrase === null ? 'P' : 'E'}\n`, 'latin1');
    try {
      if (passphrase === null) {
        await pipeline(
          async function* () { yield header; yield* plaintext(); },
          out,
        );
      } else {
        const salt = randomBytes(SALT_LEN);
        const iv = randomBytes(IV_LEN);
        const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
        await pipeline(
          Readable.from(plaintext()),
          cipher,
          async function* (src: AsyncIterable<Buffer>) {
            yield Buffer.concat([header, salt, iv]);
            yield* src;
            yield cipher.getAuthTag();
          },
          out,
        );
      }
    } finally {
      await closedStream(out);
    }
    await chmodQuiet(partial);
    await rename(partial, file);
  } catch (e) {
    await quietRm(partial);
    throw e;
  }
  return { ...manifest, entries: infos };
}

class ByteReader {
  private it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  constructor(stream: Readable) { this.it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>; }
  private async fill(): Promise<boolean> {
    const r = await this.it.next();
    if (r.done) return false;
    this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    return true;
  }
  async atEnd(): Promise<boolean> {
    return this.buf.length === 0 && !(await this.fill());
  }
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) if (!(await this.fill())) throw new Error('truncated');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill())) throw new Error('truncated');
      const k = Math.min(left, this.buf.length);
      yield this.buf.subarray(0, k);
      this.buf = this.buf.subarray(k);
      left -= k;
    }
  }
}

const damaged = (): BundleError => new BundleError('BAD_PASSPHRASE_OR_DAMAGED');

// System I/O errors (EACCES, ENOSPC, EMFILE, ...) carry a syscall. They are never reported as
// BAD_PASSPHRASE_OR_DAMAGED: they propagate unchanged. Only auth/format/integrity failures map to it.
const isIoError = (e: unknown): boolean => typeof (e as NodeJS.ErrnoException | undefined)?.syscall === 'string';
const quietRm = async (p: string): Promise<void> => { try { await rm(p, { force: true }); } catch { /* cleanup must not mask the original error */ } };
/** Resolves once the stream's file is closed: an open file cannot be removed on Windows. */
const closedStream = (s: WriteStream): Promise<void> =>
  new Promise((done) => { if (s.closed) done(); else { s.once('close', done); s.destroy(); } });

// Reads the framed entries from `plain`, writes each (except manifest.json) under workDir,
// then verifies the manifest. Removes everything it wrote on any failure.
async function extract(plain: Readable, workDir: string): Promise<BundleManifest> {
  const reader = new ByteReader(plain);
  const written: string[] = [];
  const got = new Map<string, BundleEntryInfo>();
  let manifestBody: Buffer | null = null;
  try {
    while (!(await reader.atEnd())) {
      if (manifestBody) throw new Error('data after manifest');
      const nameLen = (await reader.read(4)).readUInt32BE(0);
      if (nameLen === 0 || nameLen > MAX_NAME) throw new Error('bad name length');
      const name = (await reader.read(nameLen)).toString('utf8');
      const sizeBig = (await reader.read(8)).readBigUInt64BE(0);
      if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('bad size');
      const size = Number(sizeBig);
      if (name === MANIFEST) {
        if (size > MAX_MANIFEST) throw new Error('manifest too large');
        const parts: Buffer[] = [];
        for await (const c of reader.take(size)) parts.push(Buffer.from(c));
        manifestBody = Buffer.concat(parts);
        continue;
      }
      if (!validName(name) || got.has(name)) throw new Error('bad entry name');
      const target = join(workDir, ...name.split('/'));
      await mkdir(dirname(target), { recursive: true });
      written.push(target);
      const hash = createHash('sha256');
      const out = createWriteStream(target, { flags: 'w', mode: 0o600 });
      try {
        await pipeline(
          Readable.from(reader.take(size)),
          async function* (src: AsyncIterable<Buffer>) { for await (const c of src) { hash.update(c); yield c; } },
          out,
        );
      } finally {
        await closedStream(out);
      }
      await chmodQuiet(target);
      got.set(name, { name, size, sha256: hash.digest('hex') });
    }
    if (!manifestBody) throw new Error('manifest missing');
    const m = JSON.parse(manifestBody.toString('utf8')) as BundleManifest;
    if (m.format !== 1 || !Array.isArray(m.entries) || m.entries.length !== got.size) throw new Error('manifest mismatch');
    for (const e of m.entries) {
      const g = got.get(e.name);
      if (!g || g.size !== e.size || g.sha256 !== e.sha256) throw new Error('entry mismatch');
    }
    return m;
  } catch (e) {
    plain.destroy();
    for (const p of written) await quietRm(p);
    throw isIoError(e) ? e : damaged();
  } finally {
    plain.destroy();
  }
}

export async function openBundle(
  file: string,
  passphrase: string | null,
  workDir: string,
): Promise<{ manifest: BundleManifest; path(name: string): string }> {
  const size = (await stat(file)).size;
  const fh = await open(file, 'r');
  let head = Buffer.alloc(HEADER_LEN);
  try {
    const { bytesRead } = await fh.read(head, 0, HEADER_LEN, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (head.length < HEADER_LEN || head.subarray(0, 4).toString('latin1') !== MAGIC || head[6] !== 0x0a) {
    throw new BundleError('NOT_A_BUNDLE');
  }
  if (head.subarray(4, 5).toString('latin1') !== VERSION) throw new BundleError('UNSUPPORTED_FORMAT');
  const mode = head.subarray(5, 6).toString('latin1');
  if (mode !== 'E' && mode !== 'P') throw new BundleError('NOT_A_BUNDLE');
  await mkdir(workDir, { recursive: true });
  const api = (manifest: BundleManifest) => ({
    manifest,
    path: (name: string): string => {
      if (!validName(name) || !manifest.entries.some((e) => e.name === name)) throw new Error(`no such bundle entry: ${name}`);
      return join(workDir, ...name.split('/'));
    },
  });

  if (mode === 'P') {
    return api(await extract(createReadStream(file, { start: HEADER_LEN }), workDir));
  }
  if (passphrase === null) throw new BundleError('PASSPHRASE_REQUIRED');
  if (size < HEADER_LEN + SALT_LEN + IV_LEN + TAG_LEN) throw damaged();
  const meta = Buffer.alloc(SALT_LEN + IV_LEN + TAG_LEN);
  const mh = await open(file, 'r');
  let tag: Buffer;
  try {
    await mh.read(meta, 0, SALT_LEN + IV_LEN, HEADER_LEN);
    const t = Buffer.alloc(TAG_LEN);
    await mh.read(t, 0, TAG_LEN, size - TAG_LEN);
    tag = t;
  } finally {
    await mh.close();
  }
  const salt = meta.subarray(0, SALT_LEN);
  const iv = meta.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const tmp = join(workDir, `.bundle-${randomBytes(6).toString('hex')}.plain.tmp`);
  try {
    const start = HEADER_LEN + SALT_LEN + IV_LEN;
    const end = size - TAG_LEN - 1;
    const ct = end >= start ? createReadStream(file, { start, end }) : Readable.from([]);
    // The tag is verified when the decipher finishes, before any entry is parsed.
    const out = createWriteStream(tmp, { flags: 'w', mode: 0o600 });
    try {
      await pipeline(ct, decipher, out);
    } finally {
      await closedStream(out);
    }
    await chmodQuiet(tmp);
  } catch (e) {
    await quietRm(tmp);
    throw isIoError(e) ? e : damaged();
  }
  try {
    return api(await extract(createReadStream(tmp), workDir));
  } finally {
    await quietRm(tmp);
  }
}
