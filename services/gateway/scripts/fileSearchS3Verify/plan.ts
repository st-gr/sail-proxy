/**
 * What a verification run creates and sends, computed without any I/O so --plan and --execute agree:
 * the test content is derived from the run id alone (random-looking, but reproducible), the keys are
 * content-addressed exactly as the S3 backend derives them (`<runFolder>/<sha[0:2]>/<sha>`), and the
 * steps list every request the run sends, per operation. The reachability probe (S3Backend.probe)
 * writes one more key, the fixed probe object, which the run leaves in place like the product does.
 */
import * as crypto from 'crypto';

export type S3Op = 'PutObject' | 'GetObject' | 'DeleteObject' | 'HeadObject';
export const OPS: S3Op[] = ['PutObject', 'GetObject', 'DeleteObject', 'HeadObject'];

/**
 * The bytes of the backend's probe object (S3_PROBE_CONTENT in src/fileSearch/blob/s3Backend.ts; a
 * test holds the two equal). Repeated here because --plan must load no S3 code.
 */
export const PROBE_CONTENT = Buffer.from('sail-proxy file_search connection probe v1\n', 'utf8');

export interface TestFile {
  index: number;
  content: Buffer;
  sha256: string;
  key: string;
}

export interface PlanStep {
  name: string;
  requests: Partial<Record<S3Op, number>>;
}

export interface Plan {
  runFolder: string;
  files: TestFile[];
  /** The probe object's key: written by the probe, never deleted. */
  probeKey: string;
  steps: PlanStep[];
  totals: Record<S3Op, number>;
  /** Keys the run creates (PutObject) and deletes again at the end, by exact key. */
  cleanup: string[];
}

const CONTENT_BYTES = 1024;

/** Deterministic, random-looking content for file `index` of run `runId` (an HMAC stream). */
export function testContent(runId: string, index: number): Buffer {
  const header = Buffer.from(`sail-proxy file_search S3 verification ${runId} file ${index}\n`, 'utf8');
  const blocks: Buffer[] = [header];
  let length = header.length;
  for (let block = 0; length < CONTENT_BYTES; block++) {
    const chunk = crypto.createHmac('sha256', runId).update(`${index}:${block}`).digest();
    blocks.push(chunk);
    length += chunk.length;
  }
  return Buffer.concat(blocks).subarray(0, CONTENT_BYTES);
}

export function keyFor(runFolder: string, sha256: string): string {
  return `${runFolder}/${sha256.slice(0, 2)}/${sha256}`;
}

export function testFiles(runId: string, runFolder: string, count: number): TestFile[] {
  return Array.from({ length: count }, (_, index) => {
    const content = testContent(runId, index);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    return { index, content, sha256, key: keyFor(runFolder, sha256) };
  });
}

/** The steps of --execute, in order, with the requests each one sends for `n` files. */
export function planSteps(n: number): PlanStep[] {
  return [
    { name: 'preflight: probe (PUT and GET of the fixed probe object)', requests: { PutObject: 1, GetObject: 1 } },
    { name: 'upload: retain each file with backend s3 (PUT)', requests: { PutObject: n } },
    { name: 'read back from s3', requests: { GetObject: n } },
    { name: 'switch blob_storage.backend to db; read back (still from s3)', requests: { GetObject: n } },
    { name: 'migrate s3 -> db (migration job): read each source object', requests: { GetObject: n } },
    { name: 'garbage pass (source copies made due): delete each by exact key', requests: { DeleteObject: n } },
    { name: 'check the source copies are gone (exact-key HEAD)', requests: { HeadObject: n } },
    { name: 'migrate db -> s3 (migration job): probe, PUT, verify GET under the lock',
      requests: { PutObject: n + 1, GetObject: n + 1 } },
    { name: 'read back from s3 (backend still db)', requests: { GetObject: n } },
    { name: 'delete the files (release, grace 0) and run the sweeper', requests: { DeleteObject: n } },
    { name: 'check every created key is gone (exact-key HEAD)', requests: { HeadObject: n } },
    { name: 'cleanup: delete every recorded key by exact key (idempotent)', requests: { DeleteObject: n } },
  ];
}

export function totalsOf(steps: PlanStep[]): Record<S3Op, number> {
  const totals = Object.fromEntries(OPS.map((op) => [op, 0])) as Record<S3Op, number>;
  for (const step of steps) {
    for (const op of OPS) totals[op] += step.requests[op] ?? 0;
  }
  return totals;
}

/**
 * A short fingerprint of everything the maintainer approves: the bucket and region (hashed in, never
 * printed), the run folder, every key (the probe's included), and the requests per step. --execute
 * recomputes it and refuses a different one.
 */
export function planFingerprint(plan: Plan, target: { bucket: string; region: string }): string {
  const material = JSON.stringify({
    bucket: target.bucket,
    region: target.region,
    runFolder: plan.runFolder,
    keys: plan.files.map((f) => f.key),
    probeKey: plan.probeKey,
    steps: plan.steps.map((s) => OPS.map((op) => s.requests[op] ?? 0)),
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function buildPlan(runId: string, runFolder: string, count: number): Plan {
  const files = testFiles(runId, runFolder, count);
  const steps = planSteps(count);
  const probeKey = keyFor(runFolder, crypto.createHash('sha256').update(PROBE_CONTENT).digest('hex'));
  return { runFolder, files, probeKey, steps, totals: totalsOf(steps), cleanup: files.map((f) => f.key) };
}

/** The plan as printed by --plan. Mentions "the bucket", never its name. */
export function formatPlan(plan: Plan, commands: { execute: string; fingerprint: string }): string {
  const lines: string[] = [];
  lines.push('file_search S3 verification - PLAN (nothing has been sent)');
  lines.push('');
  lines.push(`Plan fingerprint: ${commands.fingerprint} (binds the bucket, region, run folder, keys and requests)`);
  lines.push(`Run folder in the bucket: ${plan.runFolder}/`);
  lines.push(`Test files: ${plan.files.length} x ${plan.files[0]?.content.length ?? 0} bytes, content derived from the run id`);
  lines.push('');
  lines.push('Keys the run creates (content-addressed; with the probe key, the only keys any request may touch):');
  for (const f of plan.files) lines.push(`  ${f.key}`);
  lines.push(`Left in place: 1 probe object (${plan.probeKey})`);
  lines.push('');
  lines.push('Steps and requests:');
  plan.steps.forEach((step, i) => {
    const req = OPS.filter((op) => step.requests[op]).map((op) => `${op} ${step.requests[op]}`).join(', ');
    lines.push(`  ${String(i + 1).padStart(2)}. ${step.name}: ${req}`);
  });
  lines.push('');
  const total = OPS.reduce((sum, op) => sum + plan.totals[op], 0);
  lines.push(`Requests per operation: ${OPS.map((op) => `${op} ${plan.totals[op]}`).join(', ')} (total ${total})`);
  lines.push('No other request is possible: a guard refuses, before sending, anything but these keys and the probe');
  lines.push('key. No request on the bucket itself: no HeadBucket, no list, no bucket-wide operation.');
  lines.push('');
  lines.push('Cleanup list (DELETE by exact key, never a listing):');
  for (const key of plan.cleanup) lines.push(`  ${key}`);
  lines.push('');
  lines.push(`To run exactly this plan: ${commands.execute}`);
  return lines.join('\n');
}
