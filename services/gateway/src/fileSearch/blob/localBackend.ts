import * as fs from 'fs/promises';
import * as path from 'path';
import { BlobBackend } from './blobStore';

const SHA_RE = /^[0-9a-f]{64}$/;
function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid sha256 key: ${sha}`);
}
const pathFor = (root: string, sha: string) => {
  assertSha(sha);
  return path.join(root, sha.slice(0, 2), sha);
};

export function createLocalBackend(root: string): BlobBackend {
  return {
    async put(sha, bytes) {
      const p = pathFor(root, sha);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, bytes);
      return { location: p };
    },
    async get(sha) {
      try { return await fs.readFile(pathFor(root, sha)); }
      catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async delete(sha) {
      try { await fs.unlink(pathFor(root, sha)); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    },
    async exists(sha) {
      try { await fs.stat(pathFor(root, sha)); return true; }
      catch { return false; }
    },
  };
}
