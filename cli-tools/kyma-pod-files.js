/**
 * Moves database dumps between this machine and the namespace's postgres pod, verified by sha256.
 *
 * `kubectl exec` can lose the tail of a large stream and still exit 0: on 2026-10-29 (kubectl 1.36,
 * over WebSockets and over SPDY alike) a 113 MB pg_dump arrived as 74-107 MB, and the backup reported
 * success with ten tables missing. Streaming a restore through stdin has the same weakness, and psql
 * treats the end of its input as the end of a COPY, so a cut upload could commit a partial table.
 *
 * So dumps never cross kubectl as a bare stream: they are written to a file in the pod, both sides
 * compare the file's sha256, and a transfer that arrives short is repeated.
 */

const crypto = require('crypto');
const { execSync } = require('child_process');

const DUMP_TRAILER = '-- PostgreSQL database dump complete';
const MAX_BUFFER = 2 * 1024 * 1024 * 1024;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** A fresh /tmp path in the pod for one backup or restore; never reused between runs. */
function podTempPath(kind) {
  const nonce = crypto.randomBytes(4).toString('hex');
  return `/tmp/sail-${kind}-${Date.now().toString(36)}-${process.pid}-${nonce}`;
}

/** The sha256 and size of a file in the pod, as the pod computes them. */
function podChecksum(namespace, podPath, exec) {
  const out = exec(`kubectl -n ${namespace} exec postgres-0 -- sh -c "sha256sum ${podPath} && wc -c < ${podPath}"`,
    { stdio: 'pipe', maxBuffer: 1024 * 1024 }).toString();
  const [first, second] = out.trim().split('\n');
  return { sha256: first.split(/\s+/)[0], bytes: parseInt(second, 10) };
}

/** Reads a pod file, repeating the transfer until its sha256 matches the pod's. */
function readPodFileVerified(namespace, podPath, { exec = execSync, log = console.warn, attempts = 5 } = {}) {
  const expected = podChecksum(namespace, podPath, exec);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const data = exec(`kubectl -n ${namespace} exec postgres-0 -- cat ${podPath}`,
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
    if (data.length === expected.bytes && sha256(data) === expected.sha256) return data;
    log(`Transfer from the pod arrived incomplete (${data.length} of ${expected.bytes} bytes, attempt ${attempt} of ${attempts}); repeating it`);
  }
  throw new Error(`Transfer of ${podPath} from the pod stayed incomplete after ${attempts} attempts`);
}

/** Writes data to a pod file, repeating the upload until the pod's sha256 matches. */
function writePodFileVerified(namespace, podPath, data, { exec = execSync, log = console.warn, attempts = 5 } = {}) {
  const expected = sha256(data);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    exec(`kubectl -n ${namespace} exec -i postgres-0 -- sh -c "cat > ${podPath}"`,
      { input: data, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const got = podChecksum(namespace, podPath, exec);
    if (got.bytes === data.length && got.sha256 === expected) return;
    log(`Upload to the pod arrived incomplete (${got.bytes} of ${data.length} bytes, attempt ${attempt} of ${attempts}); repeating it`);
  }
  throw new Error(`Upload of ${podPath} to the pod stayed incomplete after ${attempts} attempts`);
}

/** Removes the pod's temporary files; best effort, a leftover in /tmp goes with the pod. */
function removePodFiles(namespace, podPaths, exec = execSync) {
  try {
    exec(`kubectl -n ${namespace} exec postgres-0 -- rm -f ${podPaths.join(' ')}`, { stdio: 'pipe' });
  } catch {
    // The paths are in the pod's /tmp; nothing else depends on them.
  }
}

/** Throws unless the text is a dump pg_dump finished (its last comment block). */
function assertCompleteDump(text) {
  if (!text.includes(DUMP_TRAILER)) {
    throw new Error(`The dump did not finish: it lacks pg_dump's "${DUMP_TRAILER}" line`);
  }
}

module.exports = {
  DUMP_TRAILER, podTempPath, podChecksum, readPodFileVerified, writePodFileVerified, removePodFiles, assertCompleteDump,
};
