/**
 * Keeps the developer's local configuration intact across setup-kyma.js.
 *
 * setup-kyma.js runs docker/setup-docker.js --config to produce the service
 * .env files it turns into Kyma ConfigMaps. setup-docker.js writes those files
 * into the checkout itself — services/admin/.env switched to Postgres, new
 * database passwords in docker/.env*, a rewritten dex.config.yaml — which breaks
 * local development and the Docker stack. setup-kyma.js therefore snapshots
 * every file setup-docker.js can write or delete before running it and puts
 * them back afterwards: files that existed get their exact bytes and mode back,
 * files that did not exist are removed again.
 *
 * The snapshot is also copied to a private temp directory so the files can be
 * recovered by hand if the process is killed before the restore runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Every path docker/setup-docker.js writes or deletes, relative to the project
// root. Enumerated from its write sites; keep in step with that file.
const DOCKER_SETUP_OUTPUTS = [
  'services/gateway/.env',                // setupGatewayEnv, validation-secret refresh
  'services/admin/.env',                  // setupAdminEnv, ROLE_MAPPING update in copyAndConfigureFiles
  'services/ollama/.env',                 // setupOllamaEnv
  'docker/.env',                          // configureDockerImages, database credentials in copyAndConfigureFiles
  'docker/.env.docker',                   // configureDockerImages
  'docker/.env.postgres',                 // copyAndConfigureFiles (shared files)
  'docker/.env.filesearch-runtime',       // copyAndConfigureFiles (shared files)
  'docker/.env.nginx',                    // copyAndConfigureFiles
  'docker/.env.auth',                     // copyAndConfigureFiles (provider files)
  'docker/dex.config.yaml',               // copyAndConfigureFiles (credentials + provider files)
  'docker/okta-saml-ca.pem',              // copyAndConfigureFiles (Okta certificate / placeholder)
  'docker/docker-compose.yml',            // copyAndConfigureFiles (Okta certificate mount)
  'docker/docker-compose.override.yml'    // configureDockerImages, copyAndConfigureFiles (written or deleted)
];

// setup-docker.js's cleanupTempFiles() deletes files in docker/ whose names
// start with these prefixes (its patterns '.servicekey.tmp.json*', '.*.swp'
// and '.*.tmp' after it strips the first '*').
const DOCKER_SETUP_DELETED_PREFIXES = ['.servicekey.tmp.json', '..swp', '..tmp'];

/** The files setup-docker.js may touch in this project, as relative paths. */
function dockerSetupOutputs(projectRoot) {
  const dockerDir = path.join(projectRoot, 'docker');
  let tempFiles = [];
  try {
    tempFiles = fs.readdirSync(dockerDir)
      .filter(name => DOCKER_SETUP_DELETED_PREFIXES.some(prefix => name.startsWith(prefix)))
      .map(name => `docker/${name}`);
  } catch (error) {
    // No docker/ directory: nothing to delete there.
  }
  return [...DOCKER_SETUP_OUTPUTS, ...tempFiles];
}

/**
 * Record the current state of each file: its bytes and mode, or that it is absent.
 * Existing files are also copied to a fresh private temp directory.
 */
function snapshotFiles(projectRoot, relativePaths) {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-proxy-local-config-'));
  fs.chmodSync(backupDir, 0o700);
  const entries = relativePaths.map(rel => {
    const full = path.join(projectRoot, rel);
    if (!fs.existsSync(full)) {
      return { rel, existed: false };
    }
    const content = fs.readFileSync(full);
    const mode = fs.statSync(full).mode & 0o777;
    const copy = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, content, { mode: 0o600 });
    return { rel, existed: true, content, mode };
  });
  return { projectRoot, backupDir, entries };
}

/**
 * Put every file back as snapshotFiles found it. Returns the relative paths it
 * changed. The temp copy is removed only when every file was restored; on a
 * failure it stays and the error names it.
 */
function restoreFiles(snapshot) {
  const changed = [];
  const failures = [];
  for (const entry of snapshot.entries) {
    const full = path.join(snapshot.projectRoot, entry.rel);
    try {
      if (entry.existed) {
        const current = fs.existsSync(full) ? fs.readFileSync(full) : null;
        const currentMode = current ? fs.statSync(full).mode & 0o777 : null;
        if (!current || !current.equals(entry.content) || currentMode !== entry.mode) {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, entry.content);
          fs.chmodSync(full, entry.mode);
          changed.push(entry.rel);
        }
      } else if (fs.existsSync(full)) {
        fs.rmSync(full, { force: true });
        changed.push(entry.rel);
      }
    } catch (error) {
      failures.push(`${entry.rel}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not restore ${failures.join('; ')}. The original files are in ${snapshot.backupDir}`);
  }
  fs.rmSync(snapshot.backupDir, { recursive: true, force: true });
  return changed;
}

module.exports = {
  DOCKER_SETUP_OUTPUTS,
  DOCKER_SETUP_DELETED_PREFIXES,
  dockerSetupOutputs,
  snapshotFiles,
  restoreFiles
};
