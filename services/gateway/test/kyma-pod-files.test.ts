// Tests for cli-tools/kyma-pod-files.js: moving dumps between this machine and the postgres pod.
//
// `kubectl exec` can lose the tail of a large stream and still exit 0 (seen 2026-10-29 with kubectl
// 1.36, over WebSockets and over SPDY: a 113 MB dump arrived as 74-107 MB). A backup then reported
// success with half the tables missing, and a restore streamed through stdin could commit a partial
// COPY. These tests drive the transfer with a fake exec that drops bytes, the way the real one did.

import * as crypto from 'crypto';
import * as zlib from 'zlib';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const podFiles = require('../../../cli-tools/kyma-pod-files.js');
const { readPodFileVerified, writePodFileVerified, assertCompleteDump, podTempPath, DUMP_TRAILER } = podFiles;

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

// A fake pod: one file system, and a `kubectl exec` whose output loses its tail for the first
// `truncatedTransfers` cat/upload calls.
function fakePod(truncatedTransfers: number) {
  const files = new Map<string, Buffer>();
  let failuresLeft = truncatedTransfers;
  const calls: string[] = [];
  const exec = (cmd: string, opts: { input?: Buffer } = {}) => {
    calls.push(cmd);
    let m = /sha256sum (\S+) && wc -c < \S+"?$/.exec(cmd);
    if (m) {
      const f = files.get(m[1]);
      if (!f) throw new Error('No such file');
      return Buffer.from(`${sha(f)}  ${m[1]}\n${f.length}\n`);
    }
    m = /cat > (\S+)"$/.exec(cmd);
    if (m) {
      let data = opts.input as Buffer;
      if (failuresLeft > 0) { failuresLeft--; data = data.subarray(0, Math.floor(data.length / 2)); }
      files.set(m[1], data);
      return Buffer.alloc(0);
    }
    m = / cat (\S+)$/.exec(cmd);
    if (m) {
      const f = files.get(m[1]) as Buffer;
      if (failuresLeft > 0) { failuresLeft--; return f.subarray(0, Math.floor(f.length / 3)); }
      return f;
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { files, exec, calls };
}

const quiet = () => undefined;

describe('readPodFileVerified', () => {
  it('returns the file when the first transfer is complete', () => {
    const pod = fakePod(0);
    pod.files.set('/tmp/a.gz', Buffer.from('x'.repeat(1000)));
    const got = readPodFileVerified('ns', '/tmp/a.gz', { exec: pod.exec, log: quiet });
    expect(got.equals(pod.files.get('/tmp/a.gz') as Buffer)).toBe(true);
  });

  it('retries a transfer that lost its tail until the checksum matches', () => {
    const pod = fakePod(2);
    pod.files.set('/tmp/a.gz', Buffer.from('y'.repeat(5000)));
    const warnings: string[] = [];
    const got = readPodFileVerified('ns', '/tmp/a.gz', { exec: pod.exec, log: (m: string) => warnings.push(m) });
    expect(got.length).toBe(5000);
    expect(warnings).toHaveLength(2);
  });

  it('fails instead of returning a short file when every attempt is cut', () => {
    const pod = fakePod(99);
    pod.files.set('/tmp/a.gz', Buffer.from('z'.repeat(5000)));
    expect(() => readPodFileVerified('ns', '/tmp/a.gz', { exec: pod.exec, log: quiet, attempts: 3 }))
      .toThrow(/incomplete after 3 attempts/);
  });

  it('reads from the given namespace\'s postgres pod', () => {
    const pod = fakePod(0);
    pod.files.set('/tmp/a.gz', Buffer.from('q'));
    readPodFileVerified('prod-ns', '/tmp/a.gz', { exec: pod.exec, log: quiet });
    expect(pod.calls.every((c) => c.startsWith('kubectl -n prod-ns exec'))).toBe(true);
    expect(pod.calls.every((c) => c.includes(' postgres-0 '))).toBe(true);
  });
});

describe('writePodFileVerified', () => {
  it('re-uploads until the pod holds the exact bytes', () => {
    const pod = fakePod(1);
    const data = Buffer.from('restore input '.repeat(400));
    const warnings: string[] = [];
    writePodFileVerified('ns', '/tmp/r.gz', data, { exec: pod.exec, log: (m: string) => warnings.push(m) });
    expect((pod.files.get('/tmp/r.gz') as Buffer).equals(data)).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('fails when the upload never arrives whole', () => {
    const pod = fakePod(99);
    expect(() => writePodFileVerified('ns', '/tmp/r.gz', Buffer.from('abc'.repeat(100)), { exec: pod.exec, log: quiet, attempts: 2 }))
      .toThrow(/incomplete after 2 attempts/);
  });
});

describe('assertCompleteDump', () => {
  it('accepts a dump that ends with pg_dump\'s completion line', () => {
    expect(() => assertCompleteDump(`SET x;\n--\n${DUMP_TRAILER}\n--\n\n`)).not.toThrow();
  });

  it('refuses a dump that pg_dump did not finish', () => {
    expect(() => assertCompleteDump('COPY public.t (a) FROM stdin;\n1\n2\n')).toThrow(/did not finish/);
  });

  it('round-trips through gzip, the format the pod file uses', () => {
    const dump = `SET x;\n${DUMP_TRAILER}\n`;
    expect(() => assertCompleteDump(zlib.gunzipSync(zlib.gzipSync(dump)).toString('utf8'))).not.toThrow();
  });
});

describe('podTempPath', () => {
  it('is a unique /tmp path per call, never shared between runs', () => {
    const a = podTempPath('backup');
    const b = podTempPath('backup');
    expect(a).toMatch(/^\/tmp\/sail-backup-[0-9a-z-]+$/);
    expect(a).not.toBe(b);
  });
});
