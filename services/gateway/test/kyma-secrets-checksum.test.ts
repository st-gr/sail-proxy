/**
 * deploy-kyma.js rolls a workload whose Secrets changed.
 *
 * Pods read their Secrets once, at start (env vars; a mounted Secret updates
 * only eventually). deploy-kyma.js applied changed Secrets but left a workload
 * whose own manifest was unchanged running on the old values: on
 * sail-proxy-test (2026-11-06) the oauth2-proxy pods kept a client secret the
 * Secret no longer held, and the first Dex restart (its config had become a
 * Secret) made every login fail with "invalid client_secret". The deploy now
 * puts a checksum of the Secret files a pod template reads into that template,
 * so a changed value changes the template and rolls the pods; unchanged values
 * leave it as it is. The manifests are the golden renders; nothing is applied.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const { withSecretsChecksum, SECRETS_CHECKSUM_ANNOTATION } = require('../../../kyma/scripts/secrets-checksum.js');
/* eslint-enable @typescript-eslint/no-var-requires */

const GOLDEN = path.join(__dirname, 'fixtures', 'kyma-golden', 'sail-proxy', 'manifests');
const golden = (rel: string) => fs.readFileSync(path.join(GOLDEN, rel), 'utf8');

/** Every Secret the golden workloads read, as files in setup's format. */
const SECRET_FILES = ['admin-env', 'gateway-env', 'gateway-migration-env', 'oauth2-proxy-secrets', 'postgres-env', 'dex-config'];

function writeSecret(dir: string, name: string, value: string) {
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${name}\ntype: Opaque\nstringData:\n  VALUE: "${value}"\n`
  );
}

/**
 * The pod template metadata block of the workload document: its lines, from `metadata:` under
 * `template:` up to (not including) the first line indented no deeper than that `metadata:`.
 */
function podTemplateMetadata(manifest: string): string[] {
  const lines = manifest.split('\n');
  const t = lines.findIndex((l) => /^\s+template:\s*$/.test(l));
  expect(t).toBeGreaterThan(-1);
  const indent = (l: string) => l.length - l.trimStart().length;
  expect(lines[t + 1].trim()).toBe('metadata:');
  const base = indent(lines[t + 1]);
  const block = [lines[t + 1]];
  for (const l of lines.slice(t + 2)) {
    if (l.trim() !== '' && indent(l) <= base) break;
    block.push(l);
  }
  return block;
}

describe('deploy-kyma.js puts a checksum of the Secrets a pod reads into its template', () => {
  let secretsDir: string;

  beforeEach(() => {
    secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyma-secrets-checksum-'));
    for (const name of SECRET_FILES) writeSecret(secretsDir, name, `${name}-1`);
  });

  afterEach(() => {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });

  const annotationOf = (manifest: string) => {
    const block = podTemplateMetadata(manifest);
    const hits = block.filter((l) => l.trim().startsWith(`${SECRETS_CHECKSUM_ANNOTATION}:`));
    return hits.length === 1 ? /"([0-9a-f]{64})"/.exec(hits[0])![1] : hits.length === 0 ? null : 'duplicated';
  };

  it.each(['core/admin.yaml', 'core/gateway.yaml', 'core/postgres.yaml', 'auth/dex.yaml', 'auth/oauth2-proxy.yaml'])(
    'adds exactly one checksum to the pod template of %s, in one annotations block, Service untouched',
    (rel) => {
      const before = golden(rel);
      const after: string = withSecretsChecksum(before, secretsDir);
      expect(annotationOf(after)).toMatch(/^[0-9a-f]{64}$/);
      const block = podTemplateMetadata(after);
      const base = block[0].length - block[0].trimStart().length;
      const annotationKeys = block.filter((l) => l.trim() === 'annotations:' && l.length - l.trimStart().length === base + 2);
      expect(annotationKeys).toHaveLength(1);
      // The checksum line sits one level below that annotations key.
      const line = block.find((l) => l.trim().startsWith(`${SECRETS_CHECKSUM_ANNOTATION}:`))!;
      expect(line.length - line.trimStart().length).toBe(base + 4);
      // The document before the workload (the Service) is not touched.
      expect(after.split(/^---$/m)[0]).toBe(before.split(/^---$/m)[0]);
      // Nothing else changes: removing the added lines gives the input back.
      const added = after.split('\n').filter((l) => !before.split('\n').includes(l));
      expect(added.every((l) => l.trim() === 'annotations:' || l.trim().startsWith(`${SECRETS_CHECKSUM_ANNOTATION}:`))).toBe(true);
    }
  );

  it('keeps the pod annotations a template already has', () => {
    const block = podTemplateMetadata(withSecretsChecksum(golden('auth/oauth2-proxy.yaml'), secretsDir));
    expect(block.some((l) => l.trim() === 'sidecar.istio.io/inject: "true"')).toBe(true);
  });

  it.each(['core/valkey.yaml', 'core/nginx.yaml', 'core/namespace.yaml', 'auth/dex-rbac.yaml'])(
    'leaves %s, which reads no Secret, unchanged',
    (rel) => {
      expect(withSecretsChecksum(golden(rel), secretsDir)).toBe(golden(rel));
    }
  );

  it('changes the checksum when a Secret the workload reads changes, and only then', () => {
    const gateway = golden('core/gateway.yaml');
    const first = annotationOf(withSecretsChecksum(gateway, secretsDir));
    expect(annotationOf(withSecretsChecksum(gateway, secretsDir))).toBe(first);

    writeSecret(secretsDir, 'admin-env', 'admin-env-2'); // read by admin, not by the gateway
    expect(annotationOf(withSecretsChecksum(gateway, secretsDir))).toBe(first);

    writeSecret(secretsDir, 'gateway-env', 'gateway-env-2');
    expect(annotationOf(withSecretsChecksum(gateway, secretsDir))).not.toBe(first);
  });

  it('tells an optional Secret that is rendered from one that is not', () => {
    const gateway = golden('core/gateway.yaml');
    const without = annotationOf(withSecretsChecksum(gateway, secretsDir));
    writeSecret(secretsDir, 'gateway-s3-env', 's3-1');
    expect(annotationOf(withSecretsChecksum(gateway, secretsDir))).not.toBe(without);
  });

  it('is a hash of the files, which never shows a value', () => {
    const after = withSecretsChecksum(golden('auth/oauth2-proxy.yaml'), secretsDir);
    expect(after).not.toContain('oauth2-proxy-secrets-1');
    const expected = crypto
      .createHash('sha256')
      .update(`oauth2-proxy-secrets\n${fs.readFileSync(path.join(secretsDir, 'oauth2-proxy-secrets.yaml'), 'utf8')}\n`)
      .digest('hex');
    expect(annotationOf(after)).toBe(expected);
  });
});
