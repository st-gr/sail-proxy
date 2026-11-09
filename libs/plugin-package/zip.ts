import { unzipSync } from 'fflate';
import { PluginPackageError, validateManifest, type PluginManifest } from './manifest';

export const PLUGIN_PACKAGE_LIMITS = {
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxFiles: 5000,
  // Lists read every stored manifest, so one must stay small.
  maxManifestBytes: 1024 * 1024,
} as const;

export type PluginPackageFile = { path: string; data: Uint8Array };

type CentralEntry = { name: string; size: number; compressedSize: number; method: number; externalAttrs: number };

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const notAZip = (message: string): PluginPackageError => new PluginPackageError('NOT_A_ZIP', message);

// fflate does not expose externalAttrs, so the central directory is read here: it carries the
// symlink bit, and declared sizes let the limits apply before anything is inflated.
const readCentralDirectory = (bytes: Uint8Array): CentralEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notAZip('not a zip file');
  // fflate unpacks by the this-disk count (+8) while this reader uses the total (+10): they must agree,
  // or entries could be unpacked that were never checked. A zip64 locator is a second route; refuse it.
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) throw notAZip('multi-disk zips are not supported');
  if (view.getUint16(eocd + 8, true) !== view.getUint16(eocd + 10, true)) throw notAZip('damaged end of central directory');
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) throw notAZip('zip64 packages are not supported');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw notAZip('zip64 packages are not supported');
  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw notAZip('damaged central directory');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.length) throw notAZip('damaged central directory');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    // Decode exactly as fflate does (UTF-8 only when the flag is set, Latin-1 otherwise), so the names
    // checked here are the names it unpacks. A non-ASCII name without the flag is refused outright.
    const utf8 = (view.getUint16(offset + 8, true) & 2048) !== 0;
    if (!utf8 && nameBytes.some(byte => byte > 127)) {
      throw new PluginPackageError(
        'NAME_ENCODING',
        'a file name is not plain ASCII and the zip does not mark it as UTF-8; re-create the package with UTF-8 names',
      );
    }
    entries.push({
      name: utf8 ? decoder.decode(nameBytes) : String.fromCharCode(...nameBytes),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      externalAttrs: view.getUint32(offset + 38, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const refusePath = (name: string): void => {
  const unsafe =
    name === '' ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some(segment => segment === '..' || segment === '.') ||
    name.replace(/\/$/, '').split('/').some(segment => segment === '');
  if (unsafe) throw new PluginPackageError('UNSAFE_PATH', `unsafe path in package: ${JSON.stringify(name)}`);
};

const checkEntry = (entry: CentralEntry): void => {
  refusePath(entry.name);
  if (((entry.externalAttrs >>> 16) & S_IFMT) === S_IFLNK) {
    throw new PluginPackageError('SYMLINK_REFUSED', `symlinks are not allowed: ${entry.name}`);
  }
  const segments = entry.name.split('/').filter(Boolean);
  if (segments.includes('node_modules')) {
    throw new PluginPackageError('NODE_MODULES_REFUSED', `node_modules is not allowed: ${entry.name}; bundle dependencies into the plugin`);
  }
  if (segments[0] === '.installed.json') {
    throw new PluginPackageError('RESERVED_NAME', '.installed.json is reserved');
  }
  if (!entry.name.endsWith('/') && entry.name.toLowerCase().endsWith('.ts')) {
    throw new PluginPackageError('TYPESCRIPT_REFUSED', `TypeScript is not allowed: ${entry.name}; ship compiled JavaScript`);
  }
};

export const parsePluginPackage = (bytes: Uint8Array): { manifest: PluginManifest; files: PluginPackageFile[] } => {
  if (bytes.length > PLUGIN_PACKAGE_LIMITS.maxCompressedBytes) {
    throw new PluginPackageError('TOO_LARGE', 'package exceeds 20 MB compressed');
  }
  const entries = readCentralDirectory(bytes);
  const fileEntries = entries.filter(entry => !entry.name.endsWith('/'));
  if (entries.length > PLUGIN_PACKAGE_LIMITS.maxFiles) {
    throw new PluginPackageError('TOO_MANY_FILES', 'package holds more than 5000 files');
  }
  let declared = 0;
  for (const entry of entries) {
    // fflate copies a stored entry by its compressed size and caps a deflated one at its declared size, so
    // with stored sizes equal the declared total bounds what it allocates (at most 100 MB).
    if (entry.method === 0 && entry.compressedSize !== entry.size) {
      throw notAZip(`stored entry has inconsistent sizes: ${entry.name}`);
    }
    declared += entry.size;
    if (declared > PLUGIN_PACKAGE_LIMITS.maxUncompressedBytes) {
      throw new PluginPackageError('TOO_LARGE_UNPACKED', 'package exceeds 100 MB uncompressed');
    }
  }
  entries.forEach(checkEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.name.replace(/\/$/, '');
    if (seen.has(key)) throw new PluginPackageError('DUPLICATE_PATH', `duplicate path in package: ${entry.name}`);
    seen.add(key);
  }

  const names = new Set(fileEntries.map(entry => entry.name));
  if (!names.has('manifest.json')) throw new PluginPackageError('MANIFEST_MISSING', 'manifest.json is missing at the zip root');

  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, { filter: file => !file.name.endsWith('/') });
  } catch (error) {
    throw notAZip(`package cannot be read: ${(error as Error).message}`);
  }

  // Everything below works on what fflate actually returned, not on what was announced.
  const returned = Object.keys(unpacked);
  if (returned.length > PLUGIN_PACKAGE_LIMITS.maxFiles) {
    throw new PluginPackageError('TOO_MANY_FILES', 'package holds more than 5000 files');
  }
  // The returned names must equal the announced file names exactly, in both directions.
  const returnedSet = new Set(returned);
  for (const name of returned) {
    if (!names.has(name)) throw notAZip(`package holds an entry its directory does not list: ${JSON.stringify(name)}`);
  }
  for (const name of names) {
    if (!returnedSet.has(name)) throw notAZip(`package entry could not be unpacked under its listed name: ${JSON.stringify(name)}`);
  }
  let actualBytes = 0;
  for (const name of returned) {
    refusePath(name);
    actualBytes += unpacked[name].length;
    if (actualBytes > PLUGIN_PACKAGE_LIMITS.maxUncompressedBytes) {
      throw new PluginPackageError('TOO_LARGE_UNPACKED', 'package exceeds 100 MB uncompressed');
    }
  }

  if (unpacked['manifest.json'].length > PLUGIN_PACKAGE_LIMITS.maxManifestBytes) {
    throw new PluginPackageError('MANIFEST_INVALID', 'manifest.json is larger than 1 MB');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(unpacked['manifest.json']));
  } catch {
    throw new PluginPackageError('MANIFEST_INVALID', 'manifest.json is not valid JSON');
  }
  const manifest = validateManifest(raw);
  if (!names.has('index.js')) throw new PluginPackageError('ENTRY_MISSING', 'index.js is missing at the zip root');

  const files = Object.entries(unpacked).map(([path, data]) => ({ path, data }));
  return { manifest, files };
};
