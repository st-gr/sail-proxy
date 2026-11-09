/**
 * A checksum of the Secrets a workload's pods read, for its pod template.
 *
 * Pods read Secrets once, at start (env vars; a mounted Secret updates only eventually), so a
 * Secret changed by a deploy leaves pods whose own manifest is unchanged on the old value
 * (sail-proxy-test 2026-11-06: oauth2-proxy kept a client secret Dex no longer accepted).
 * deploy-kyma.js applies each workload with this checksum in its pod template: a changed Secret
 * changes the template and rolls the pods, unchanged Secrets leave it as it is.
 *
 * Works on the rendered text (deploy-kyma.js has no YAML parser): the Deployment and StatefulSet
 * documents of a manifest, the Secrets their pods reference by secretKeyRef, secretRef or a secret
 * volume, and the files setup-kyma.js rendered for them. Jobs are left alone: their pod template
 * cannot be changed once created.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRETS_CHECKSUM_ANNOTATION = 'sail-proxy/secrets-checksum';

const indentOf = (line) => line.length - line.trimStart().length;

/** The Secret names a workload document's pods read, sorted and without duplicates. */
function secretsReferencedBy(doc) {
  const names = new Set();
  const lines = doc.split('\n');
  lines.forEach((line, i) => {
    const kind = line.trim();
    if (kind !== 'secretKeyRef:' && kind !== 'secretRef:' && kind !== '- secretRef:' && kind !== 'secret:') return;
    const key = kind === 'secret:' ? 'secretName' : 'name';
    // The reference's own keys follow, one level deeper than the reference key.
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === '') continue;
      if (indentOf(next) <= indentOf(line)) break;
      const match = new RegExp(`^${key}:\\s*["']?([a-z0-9.-]+)["']?\\s*$`).exec(next.trim());
      if (match) names.add(match[1]);
    }
  });
  return [...names].sort();
}

/** sha256 over each named Secret's rendered file (or its absence), in name order. */
function checksumOf(names, secretsDir) {
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    const file = path.join(secretsDir, `${name}.yaml`);
    hash.update(`${name}\n${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(not rendered)'}\n`);
  }
  return hash.digest('hex');
}

/** The document with the annotation in its pod template metadata (one annotations block). */
function annotatePodTemplate(doc, value) {
  const lines = doc.split('\n');
  const template = lines.findIndex((l, i) => /^\s+template:\s*$/.test(l) && lines[i + 1] && lines[i + 1].trim() === 'metadata:');
  if (template === -1) return doc;
  const metadata = template + 1;
  const base = indentOf(lines[metadata]);
  let end = metadata + 1;
  while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > base)) end++;
  const annotations = lines.slice(metadata + 1, end).findIndex((l) => indentOf(l) === base + 2 && l.trim() === 'annotations:');
  const entry = `${' '.repeat(base + 4)}${SECRETS_CHECKSUM_ANNOTATION}: "${value}"`;
  if (annotations === -1) {
    lines.splice(metadata + 1, 0, `${' '.repeat(base + 2)}annotations:`, entry);
  } else {
    lines.splice(metadata + 2 + annotations, 0, entry);
  }
  return lines.join('\n');
}

/**
 * The manifest with a checksum of the Secrets in each Deployment's and StatefulSet's pod template;
 * documents that read no Secret, and other kinds, stay as they are.
 */
function withSecretsChecksum(manifest, secretsDir) {
  return manifest
    .split(/^(?=---\s*$)/m)
    .map((doc) => {
      if (!/^kind:\s*(Deployment|StatefulSet)\s*$/m.test(doc)) return doc;
      const names = secretsReferencedBy(doc);
      return names.length === 0 ? doc : annotatePodTemplate(doc, checksumOf(names, secretsDir));
    })
    .join('');
}

module.exports = { SECRETS_CHECKSUM_ANNOTATION, secretsReferencedBy, withSecretsChecksum };
