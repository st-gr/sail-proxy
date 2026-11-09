// A read-only zip reader for OOXML packages, from the central directory. Nothing is written to
// disk: entry names are normalised lookup keys only (no path is ever built from them). Parts are
// inflated on demand in Node's thread pool (zlib.inflateRaw, async) with an output cap of the
// entry's declared size, so a part that inflates past what it declares stops there; parts over
// the single-entry cap, over the compression-ratio cap, or past the total cap of the read are
// refused before inflating. ZIP64, multi-disk archives and encrypted entries are refused (an
// Office file under the upload limit never needs ZIP64).

import * as zlib from 'zlib';
import { OoxmlFault, OoxmlLimits, ReadContext } from './limits';

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const OLE_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** OPC part names are case-insensitive; a leading "/" and backslashes are tolerated. */
export function partKey(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export interface ZipFile {
  has(name: string): boolean;
  /** The part's bytes; counts them against the read's total. */
  read(name: string, ctx: ReadContext): Promise<Buffer>;
}

const notZip = (): OoxmlFault => new OoxmlFault('it is not a valid zip archive');

function findEndOfCentralDirectory(bytes: Buffer): number {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIG && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) return i;
  }
  return -1;
}

export function openZip(bytes: Buffer, limits: OoxmlLimits): ZipFile {
  if (bytes.length >= OLE_SIG.length && bytes.subarray(0, OLE_SIG.length).equals(OLE_SIG)) {
    throw new OoxmlFault('it is an encrypted (password-protected) or legacy Office file, not an Office Open XML zip');
  }
  if (bytes.length < 22) throw notZip();
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw notZip();
  const disk = bytes.readUInt16LE(eocd + 4);
  const cdDisk = bytes.readUInt16LE(eocd + 6);
  const countHere = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new OoxmlFault('ZIP64 archives are not supported');
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new OoxmlFault('multi-part zip archives are not supported');
  if (count > limits.maxEntries) throw new OoxmlFault(`the archive has more than ${limits.maxEntries} entries`);
  if (cdOffset + cdSize > eocd) throw notZip();

  const entries = new Map<string, Entry>();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || bytes.readUInt32LE(p) !== CENTRAL_SIG) throw notZip();
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const size = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localOffset = bytes.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw notZip();
    const key = partKey(bytes.toString('utf8', p + 46, p + 46 + nameLen));
    p = end;
    if (key === '' || key.endsWith('/')) continue; // a directory entry
    if (entries.has(key)) throw new OoxmlFault('the archive holds a duplicate part name');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new OoxmlFault('ZIP64 archives are not supported');
    }
    if (flags & 0x1) throw new OoxmlFault('it holds an encrypted entry');
    entries.set(key, { method, compressedSize, size, localOffset });
  }

  return {
    has: (name) => entries.has(partKey(name)),
    read: async (name, ctx) => {
      const entry = entries.get(partKey(name));
      if (!entry) throw new OoxmlFault('a part is missing');
      return inflateEntry(bytes, entry, ctx);
    },
  };
}

async function inflateEntry(bytes: Buffer, entry: Entry, ctx: ReadContext): Promise<Buffer> {
  const { limits } = ctx;
  if (entry.size > limits.maxEntryBytes) throw new OoxmlFault(`it holds an entry larger than ${limits.maxEntryBytes} bytes`);
  if (entry.size > limits.ratioMinBytes && entry.size > limits.maxRatio * Math.max(1, entry.compressedSize)) {
    throw new OoxmlFault(`an entry's compression ratio is over ${limits.maxRatio} (a zip bomb)`);
  }
  if (ctx.inflatedBytes + entry.size > limits.maxTotalBytes) {
    throw new OoxmlFault(`the parts to read inflate to more than ${limits.maxTotalBytes} bytes in all`);
  }
  const lh = entry.localOffset;
  if (lh + 30 > bytes.length || bytes.readUInt32LE(lh) !== LOCAL_SIG) throw new OoxmlFault('the archive is corrupt');
  const start = lh + 30 + bytes.readUInt16LE(lh + 26) + bytes.readUInt16LE(lh + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new OoxmlFault('the archive is corrupt');
  const data = bytes.subarray(start, end);

  let out: Buffer;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new OoxmlFault('the archive is corrupt');
    out = data;
  } else if (entry.method === 8) {
    out = await new Promise<Buffer>((resolve, reject) => {
      // The cap is the declared size: a part never inflates past what it declares.
      zlib.inflateRaw(data, { maxOutputLength: Math.max(1, entry.size) }, (error, result) => {
        if (!error) return resolve(result);
        reject(new OoxmlFault((error as any).code === 'ERR_BUFFER_TOO_LARGE'
          ? 'an entry inflates larger than it declares (a zip bomb or a corrupt archive)'
          : 'the archive is corrupt (an entry does not inflate)'));
      });
    });
    if (out.length !== entry.size) throw new OoxmlFault('the archive is corrupt (an entry\'s size does not match)');
  } else {
    throw new OoxmlFault(`an entry uses an unsupported compression method (${entry.method})`);
  }
  ctx.inflatedBytes += out.length;
  return out;
}
