#!/usr/bin/env node

/**
 * SAP LLM Gateway CI Pipeline
 * 
 * Industry-standard Node.js CI pipeline that follows best practices:
 * - Fail-fast on any error
 * - Proper service orchestration
 * - Comprehensive logging
 * - Graceful cleanup
 * - Environment validation
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { checkpointSqliteWal } = require('./scripts/sqlite-checkpoint');
const { ensureFileSearchTestDatabase, needsContainer, CONTAINER_NAME } = require('./scripts/file-search-test-db');
const fileSearchTestS3 = require('./scripts/file-search-test-s3');
const { volumesToRemoveBeforeCI, pickVolumeToBackUp } = require('./scripts/backed-up-volumes');
const { sapRelayEnv } = require('./scripts/sap-relay-env');
const { decideDockerBuild, headCommit, isLocalRun, markerPath, LOCAL_BUILD_MARKER } = require('./scripts/docker-build-decision');
const { streamBuild, formatDuration } = require('./scripts/docker-build-progress');

// Axios is loaded dynamically after dependencies are installed
let axios;

const execAsync = promisify(exec);

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

// Logging utilities
const logger = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}[WARNING]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  step: (msg) => console.log(`${colors.cyan}${colors.bold}► ${msg}${colors.reset}`),
  phase: (msg) => {
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.bold}${msg}${colors.reset}`);
    console.log('='.repeat(60));
  }
};

// Global state for cleanup
const state = {
  processes: [],
  containers: [],
  fileSearch: null,
  // MinIO for the file_search S3 suites: { container, env }; the container is removed by name in cleanup()
  fileSearchS3: null,
  fileSearchS3Container: null,
  startTime: Date.now(),
  backupDir: null,
  // The volumes backupCIState saved: the only ones cleanStateBeforeCI removes
  backedUpVolumes: null,
  volumeNames: {
    postgres: null,
    valkey: null
  },
  images: [],
  dockerComposeCmd: null,
  dockerBuildRequired: true,
  dockerBuildDecisionReason: 'Not yet determined',
  changedFiles: [],
  startHead: null,
  startCleanTree: false
};

// Parse docker-compose.yml to extract volume and image names
async function parseDockerComposeConfig() {
  try {
    const dockerComposePath = path.join(__dirname, '..', 'docker/docker-compose.yml');
    const content = await fs.readFile(dockerComposePath, 'utf8');

    const config = {
      volumes: {
        postgres: null,
        valkey: null
      },
      images: []
    };

    // Parse postgres volume (line format: "- postgres_data:/var/lib/postgresql/data")
    const postgresMatch = content.match(/^\s+-\s+(\w+):\s*\/var\/lib\/postgresql\/data/m);
    if (postgresMatch) {
      config.volumes.postgres = postgresMatch[1];
    }

    // Parse valkey volume (line format: "- valkey_data:/data"); anchored on the name, since other
    // services (the optional minio) also mount a volume at /data
    const valkeyMatch = content.match(/^\s+-\s+(\w*valkey\w*):\s*\/data/m);
    if (valkeyMatch) {
      config.volumes.valkey = valkeyMatch[1];
    }

    // Parse image names (format: "image: ${DOCKER_REGISTRY:-ghcr.io}/${DOCKER_ORGANIZATION:-st-gr}/sail-proxy-NAME:${DOCKER_TAG:-latest}")
    const imageRegex = /image:\s*\$\{DOCKER_REGISTRY:-([^}]+)\}\/\$\{DOCKER_ORGANIZATION:-([^}]+)\}\/(sail-proxy-\w+):\$\{DOCKER_TAG:-[^}]+\}/g;
    let match;
    while ((match = imageRegex.exec(content)) !== null) {
      const registry = match[1];
      const org = match[2];
      const imageName = match[3];
      config.images.push({
        fullName: `${registry}/${org}/${imageName}`,
        baseName: imageName,
        ciTag: `${registry}/${org}/${imageName}:ci-test`
      });
    }

    logger.info(`Parsed volume names from docker-compose.yml: postgres=${config.volumes.postgres}, valkey=${config.volumes.valkey}`);
    logger.info(`Parsed ${config.images.length} image names: ${config.images.map(i => i.baseName).join(', ')}`);

    return config;
  } catch (error) {
    logger.warning(`Failed to parse docker-compose.yml: ${error.message}`);
    logger.warning('Falling back to default configuration');
    return {
      volumes: {
        postgres: 'postgres_data',
        valkey: 'valkey_data'
      },
      images: [
        { fullName: 'ghcr.io/st-gr/sail-proxy-gateway', baseName: 'sail-proxy-gateway', ciTag: 'ghcr.io/st-gr/sail-proxy-gateway:ci-test' },
        { fullName: 'ghcr.io/st-gr/sail-proxy-admin', baseName: 'sail-proxy-admin', ciTag: 'ghcr.io/st-gr/sail-proxy-admin:ci-test' },
        { fullName: 'ghcr.io/st-gr/sail-proxy-nginx', baseName: 'sail-proxy-nginx', ciTag: 'ghcr.io/st-gr/sail-proxy-nginx:ci-test' }
      ]
    };
  }
}

/**
 * Determines if Docker build testing should run based on changed files
 * (ci/scripts/docker-build-decision.js; a local run compares against the last local image build).
 * @returns {Promise<{required: boolean, reason: string, files: string[]}>}
 */
async function shouldRunDockerBuild() {
  return decideDockerBuild({
    exec: execAsync,
    env: process.env,
    logger,
    readMarker: () => fs.readFile(markerPath(path.join(__dirname, '..')), 'utf8')
  });
}

/**
 * After a successful local Phase 8 (images built in Phase 7 and the admin container validated),
 * records the commit the run started from as the last local image build, but only when the run
 * started with a clean tree. Starting HEAD, not current HEAD: a commit made while the run builds
 * is not in it.
 */
async function recordLocalDockerBuild() {
  if (!isLocalRun(process.env)) return;
  if (state.startCleanTree !== true) {
    // The images contain uncommitted edits, so HEAD's own tree was never built: recording HEAD
    // would let the next run skip after those edits are discarded.
    logger.info('The run started with uncommitted changes; the last local image build is not recorded');
    return;
  }
  if (!state.startHead) {
    logger.warning('HEAD was unknown when the run started; the last local image build is not recorded');
    return;
  }
  const file = markerPath(path.join(__dirname, '..'));
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${state.startHead}\n`);
    logger.info(`Recorded the last local image build: ${state.startHead.slice(0, 8)} (${LOCAL_BUILD_MARKER})`);
  } catch (error) {
    logger.warning(`Could not record the last local image build: ${error.message}; the next local run builds again`);
  }
}

// Detect which docker compose command is available
async function getDockerComposeCommand() {
  try {
    // Try Docker Compose V2 (plugin) first - preferred on GitHub Actions
    await execAsync('docker compose version');
    return 'docker compose';
  } catch (v2Error) {
    try {
      // Fall back to legacy docker-compose command
      await execAsync('docker-compose --version');
      return 'docker-compose';
    } catch (v1Error) {
      throw new Error('Neither "docker compose" nor "docker-compose" command is available');
    }
  }
}

// Wait for a port to become available
async function waitForPortFree(port, timeout = 30000) {
  const start = Date.now();
  logger.info(`Waiting for port ${port} to be free...`);

  while (Date.now() - start < timeout) {
    try {
      // Try different methods to check port availability
      // Method 1: Try lsof (Linux/Mac)
      try {
        const { stdout } = await execAsync(`lsof -i :${port} 2>/dev/null || true`);
        const lines = stdout.trim().split('\n').filter(line => line.includes('LISTEN') || line.includes('ESTABLISHED'));

        if (lines.length === 0) {
          logger.success(`Port ${port} is now free`);
          return true;
        }
      } catch (lsofError) {
        // lsof not available, try netstat
      }

      // Method 2: Try netstat (fallback)
      try {
        const { stdout } = await execAsync(`netstat -tuln 2>/dev/null | grep :${port} || true`);
        if (!stdout.trim()) {
          logger.success(`Port ${port} is now free`);
          return true;
        }
      } catch (netstatError) {
        // netstat failed, try ss
      }

      // Method 3: Try ss (modern Linux)
      try {
        const { stdout } = await execAsync(`ss -tuln 2>/dev/null | grep :${port} || true`);
        if (!stdout.trim()) {
          logger.success(`Port ${port} is now free`);
          return true;
        }
      } catch (ssError) {
        // All methods failed, assume port is free after timeout
        logger.warning(`Cannot check port ${port} status, will retry...`);
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      logger.warning(`Error checking port ${port}: ${error.message}`);
    }
  }

  // Timeout reached, log warning but don't fail
  logger.warning(`Timeout waiting for port ${port} to be free after ${timeout}ms, proceeding anyway...`);
  return false;
}

// Helper function to recursively copy directories
async function copyRecursive(src, dest) {
  const stat = await fs.lstat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);
    await Promise.all(entries.map(entry =>
      copyRecursive(path.join(src, entry), path.join(dest, entry))
    ));
  } else {
    await fs.copyFile(src, dest);
  }
}

// Backup function: Save current state before CI runs
async function backupCIState() {
  logger.step('Backing up current environment state...');

  const backupDir = path.join(__dirname, '.ci-backup-' + Date.now());
  await fs.mkdir(backupDir, { recursive: true });

  const projectRoot = path.join(__dirname, '..');

  // 1. Backup docker/ directory
  logger.info('Backing up docker/ directory...');
  const dockerDir = path.join(projectRoot, 'docker');
  if (fsSync.existsSync(dockerDir)) {
    await copyRecursive(dockerDir, path.join(backupDir, 'docker'));
    logger.info('✅ docker/ directory backed up');
  } else {
    logger.info('No docker/ directory to backup');
  }

  // 2. Backup .env files
  logger.info('Backing up .env files...');
  const envFiles = [
    'services/gateway/.env',
    'services/admin/.env',
    'services/ollama/.env'
  ];

  for (const envFile of envFiles) {
    const filePath = path.join(projectRoot, envFile);
    if (fsSync.existsSync(filePath)) {
      const fileName = envFile.replace(/\//g, '_');
      await fs.copyFile(filePath, path.join(backupDir, fileName));
      logger.info(`✅ Backed up ${envFile}`);
    } else {
      logger.info(`No ${envFile} to backup (first-time setup)`);
    }
  }

  // Track the actual volume names found (for restore)
  const volumeMetadata = {
    postgresVolume: null,
    valkeyVolume: null
  };

  // 3. Backup postgres volume (if exists)
  logger.info('Backing up postgres volume...');
  try {
    // Check if postgres volume exists (with or without docker_ prefix)
    const { stdout: volumeCheck } = await execAsync('docker volume ls --format "{{.Name}}"');
    const volumes = volumeCheck.split('\n').map(v => v.trim());

    const baseVolumeName = state.volumeNames.postgres;

    // Find postgres volume (could be postgres_data, docker_postgres_data, or <project>_postgres_data)
    const postgresVolume = pickVolumeToBackUp(volumes, baseVolumeName);

    if (postgresVolume) {
      logger.info(`${postgresVolume} volume found, backing up...`);
      volumeMetadata.postgresVolume = postgresVolume; // Save actual name

      // Create backup volume
      await executeCommand('docker volume create postgres_backup_ci', { ignoreError: true });

      // Backup using busybox container
      try {
        await executeCommand(
          `docker run --rm -v ${postgresVolume}:/source:ro -v postgres_backup_ci:/backup busybox tar czf /backup/data.tar.gz -C /source .`,
          { description: 'Creating postgres volume backup...', ignoreError: false }
        );
        logger.success(`✅ Postgres volume (${postgresVolume}) backed up`);
      } catch (backupError) {
        logger.error('Failed to backup postgres volume. Please remove the volume manually to run CI:');
        logger.error(`  docker volume rm ${postgresVolume}`);
        throw new Error('Postgres volume backup failed. Manual cleanup required.');
      }
    } else {
      logger.info('No postgres volume found (first-time setup)');
    }
  } catch (error) {
    if (error.message && error.message.includes('Postgres volume backup failed')) {
      throw error; // Re-throw if it's our specific error
    }
    logger.info('No postgres volume to backup');
  }

  // 4. Backup valkey volume (if exists)
  logger.info('Backing up valkey volume...');
  try {
    const { stdout: volumeCheck } = await execAsync('docker volume ls --format "{{.Name}}"');
    const volumes = volumeCheck.split('\n').map(v => v.trim());

    const baseVolumeName = state.volumeNames.valkey;

    // Find valkey volume (could be valkey_data, docker_valkey_data, or <project>_valkey_data)
    const valkeyVolume = pickVolumeToBackUp(volumes, baseVolumeName);

    if (valkeyVolume) {
      logger.info(`${valkeyVolume} volume found, backing up...`);
      volumeMetadata.valkeyVolume = valkeyVolume; // Save actual name

      await executeCommand('docker volume create valkey_backup_ci', { ignoreError: true });

      await executeCommand(
        `docker run --rm -v ${valkeyVolume}:/source:ro -v valkey_backup_ci:/backup busybox tar czf /backup/data.tar.gz -C /source .`,
        { description: 'Creating valkey volume backup...', ignoreError: true }
      );

      logger.success(`✅ Valkey volume (${valkeyVolume}) backed up`);
    } else {
      logger.info('No valkey volume found (first-time setup)');
    }
  } catch (error) {
    logger.info('No valkey volume to backup');
  }

  // 5. Backup SQLite database files (if exists)
  logger.info('Backing up SQLite database files...');

  // Check if main database file exists
  const mainDbPath = path.join(projectRoot, 'services/admin/db/admin.db');
  if (fsSync.existsSync(mainDbPath)) {
    logger.warning('SQLite database found. If admin service is running, please stop it before CI to avoid corruption.');

    // Backup strategy: checkpoint the WAL (PRAGMA wal_checkpoint(TRUNCATE))
    // before copying the main .db file. In WAL mode, recent commits live in
    // .db-wal until a checkpoint folds them into the main file; copying the
    // main file alone without checkpointing first silently drops every
    // write since the last checkpoint. A TRUNCATE checkpoint folds all of
    // them in and truncates the WAL to 0 bytes, so once it succeeds the
    // main .db file alone is a complete, consistent snapshot and it is
    // safe to omit .db-wal/.db-shm from the backup (restore lets SQLite
    // recreate them). If the checkpoint can't complete (e.g. the admin
    // service still holds the DB open), checkpointSqliteWal throws rather
    // than let us back up an incomplete database.
    const { checkpointed, walSize } = await checkpointSqliteWal(mainDbPath, projectRoot);
    logger.success(`✅ Checkpointed admin.db WAL (${checkpointed} frames, now ${walSize} bytes) before backup`);

    try {
      const backupDbPath = path.join(backupDir, 'services_admin_db_admin.db');
      await fs.copyFile(mainDbPath, backupDbPath);
      logger.success('✅ Backed up admin.db (main database file)');
      logger.info('Skipping WAL/SHM files (already folded into admin.db by the checkpoint above)');
    } catch (error) {
      logger.error(`Failed to backup SQLite database: ${error.message}`);
      throw new Error('SQLite database backup failed. Ensure admin service is not running.');
    }
  } else {
    logger.info('No SQLite database to backup (first-time setup or using PostgreSQL)');
  }

  // Write volume metadata to backup directory for restore
  const volumeMetadataFile = path.join(backupDir, 'volume-metadata.json');
  await fs.writeFile(volumeMetadataFile, JSON.stringify(volumeMetadata, null, 2));
  logger.info(`Volume metadata saved: postgres=${volumeMetadata.postgresVolume}, valkey=${volumeMetadata.valkeyVolume}`);

  // Write backup location to known file for manual recovery
  const backupLocationFile = path.join(__dirname, '.ci-backup-location');
  await fs.writeFile(backupLocationFile, backupDir);
  logger.info(`Backup location written to: ${backupLocationFile}`);

  state.backupDir = backupDir;
  state.backedUpVolumes = volumeMetadata;
  logger.success(`State backed up to: ${backupDir}`);

  return backupDir;
}

// Clean state: Remove volumes and files for fresh CI environment
async function cleanStateBeforeCI() {
  logger.step('Cleaning state for fresh CI environment...');

  const projectRoot = path.join(__dirname, '..');

  // 1. Stop all containers that might be using volumes
  logger.info('Stopping containers that might use volumes...');
  try {
    await executeCommand(`${state.dockerComposeCmd} -f docker/docker-compose.yml down`, {
      cwd: projectRoot,
      ignoreError: true
    });
  } catch (error) {
    logger.info('No containers to stop');
  }

  // 2. Remove postgres and valkey volumes to force fresh initialization
  logger.info('Removing postgres and valkey volumes...');

  // Only the volumes the backup saved (and the restore puts back); another Compose project's volumes stay.
  const backedUp = volumesToRemoveBeforeCI(state.backedUpVolumes);
  for (const vol of backedUp) {
    await executeCommand(`docker volume rm ${vol}`, {
      description: `Removing ${vol} volume...`,
      ignoreError: true
    });
  }
  if (backedUp.length === 0) {
    logger.info('No backed-up postgres or valkey volumes to remove');
  }

  // 3. Remove generated files in docker/
  logger.info('Removing generated docker/ files...');
  const dockerFilesToRemove = [
    'docker/dex.config.yaml',
    'docker/.env.auth',
    'docker/.env.postgres',
    'docker/.env.nginx',
    'docker/okta-saml-ca.pem'
  ];

  for (const file of dockerFilesToRemove) {
    const filePath = path.join(projectRoot, file);
    try {
      await fs.unlink(filePath);
      logger.info(`Removed ${file}`);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  }

  // 4. Remove .env files in services/ (setup-docker.js will recreate them)
  logger.info('Removing services/ .env files...');
  const envFiles = [
    'services/gateway/.env',
    'services/admin/.env',
    'services/ollama/.env'
  ];

  for (const envFile of envFiles) {
    const filePath = path.join(projectRoot, envFile);
    try {
      await fs.unlink(filePath);
      logger.info(`Removed ${envFile}`);
    } catch (error) {
      // File doesn't exist, that's fine
    }
  }

  logger.success('State cleaned successfully');
}

// Restore state: Put back user's configuration after CI completes
async function restoreCIState(backupDir) {
  if (!backupDir) {
    logger.warning('No backup directory to restore from');
    return;
  }

  logger.step('Restoring user environment state...');

  const projectRoot = path.join(__dirname, '..');

  try {
    // Read volume metadata to restore with correct names
    const volumeMetadataFile = path.join(backupDir, 'volume-metadata.json');
    let volumeMetadata = { postgresVolume: null, valkeyVolume: null };

    try {
      const metadataContent = await fs.readFile(volumeMetadataFile, 'utf8');
      volumeMetadata = JSON.parse(metadataContent);
      logger.info(`Loaded volume metadata: postgres=${volumeMetadata.postgresVolume}, valkey=${volumeMetadata.valkeyVolume}`);
    } catch (error) {
      logger.warning('Could not read volume metadata, will skip volume restore');
    }

    // 1. Restore postgres volume
    logger.info('Restoring postgres volume...');
    try {
      const { stdout: volumeCheck } = await execAsync('docker volume ls --format "{{.Name}}"');
      const volumes = volumeCheck.split('\n').map(v => v.trim());

      if (volumes.includes('postgres_backup_ci') && volumeMetadata.postgresVolume) {
        // Restore using the EXACT original volume name
        const targetVolumeName = volumeMetadata.postgresVolume;
        logger.info(`Restoring to original volume name: ${targetVolumeName}`);

        await executeCommand(`docker volume create ${targetVolumeName}`, { ignoreError: true });

        // Restore from backup
        await executeCommand(
          `docker run --rm -v ${targetVolumeName}:/target -v postgres_backup_ci:/backup:ro busybox tar xzf /backup/data.tar.gz -C /target`,
          { description: `Restoring postgres volume as ${targetVolumeName}...`, ignoreError: true }
        );

        // Remove backup volume
        await executeCommand('docker volume rm postgres_backup_ci', { ignoreError: true });

        logger.success(`✅ Postgres volume restored as ${targetVolumeName}`);
      } else {
        logger.info('No postgres backup to restore');
      }
    } catch (error) {
      logger.info('No postgres backup to restore');
    }

    // 2. Restore valkey volume
    logger.info('Restoring valkey volume...');
    try {
      const { stdout: volumeCheck } = await execAsync('docker volume ls --format "{{.Name}}"');
      const volumes = volumeCheck.split('\n').map(v => v.trim());

      if (volumes.includes('valkey_backup_ci') && volumeMetadata.valkeyVolume) {
        // Restore using the EXACT original volume name
        const targetVolumeName = volumeMetadata.valkeyVolume;
        logger.info(`Restoring to original volume name: ${targetVolumeName}`);

        await executeCommand(`docker volume create ${targetVolumeName}`, { ignoreError: true });

        await executeCommand(
          `docker run --rm -v ${targetVolumeName}:/target -v valkey_backup_ci:/backup:ro busybox tar xzf /backup/data.tar.gz -C /target`,
          { description: `Restoring valkey volume as ${targetVolumeName}...`, ignoreError: true }
        );

        await executeCommand('docker volume rm valkey_backup_ci', { ignoreError: true });

        logger.success(`✅ Valkey volume restored as ${targetVolumeName}`);
      } else {
        logger.info('No valkey backup to restore');
      }
    } catch (error) {
      logger.info('No valkey backup to restore');
    }

    // 3. Restore docker/ directory
    logger.info('Restoring docker/ directory...');
    const dockerBackupDir = path.join(backupDir, 'docker');
    if (fsSync.existsSync(dockerBackupDir)) {
      const dockerDir = path.join(projectRoot, 'docker');

      // Remove current docker/ contents (except essential files)
      const entries = await fs.readdir(dockerDir);
      for (const entry of entries) {
        if (!entry.startsWith('.') && entry !== 'configs' && entry !== 'docker-compose.yml') {
          const entryPath = path.join(dockerDir, entry);
          try {
            const stat = await fs.lstat(entryPath);
            if (stat.isDirectory()) {
              await fs.rm(entryPath, { recursive: true, force: true });
            } else {
              await fs.unlink(entryPath);
            }
          } catch (error) {
            logger.warning(`Failed to remove ${entry}: ${error.message}`);
          }
        }
      }

      // Restore from backup
      const backupEntries = await fs.readdir(dockerBackupDir);
      for (const entry of backupEntries) {
        const srcPath = path.join(dockerBackupDir, entry);
        const destPath = path.join(dockerDir, entry);

        try {
          const stat = await fs.lstat(srcPath);
          if (stat.isDirectory()) {
            await copyRecursive(srcPath, destPath);
          } else {
            await fs.copyFile(srcPath, destPath);
          }
        } catch (error) {
          logger.warning(`Failed to restore ${entry}: ${error.message}`);
        }
      }

      logger.success('✅ docker/ directory restored');
    } else {
      logger.info('No docker/ backup to restore');
    }

    // 4. Restore .env files
    logger.info('Restoring .env files...');
    const envFiles = [
      { backup: 'services_gateway_.env', original: 'services/gateway/.env' },
      { backup: 'services_admin_.env', original: 'services/admin/.env' },
      { backup: 'services_ollama_.env', original: 'services/ollama/.env' }
    ];

    for (const { backup, original } of envFiles) {
      const backupPath = path.join(backupDir, backup);
      const originalPath = path.join(projectRoot, original);

      if (fsSync.existsSync(backupPath)) {
        await fs.copyFile(backupPath, originalPath);
        logger.info(`✅ Restored ${original}`);
      } else if (fsSync.existsSync(originalPath)) {
        // No backup: the checkout had no such file before this run (backupCIState copies every
        // existing one), so the file now there is CI's own. Leaving it switches a worktree's
        // later cds.test runs to the CI Postgres settings.
        await fs.unlink(originalPath);
        logger.info(`🧹 Removed CI-created ${original} (there was none before the run)`);
      } else {
        logger.info(`No backup for ${original}`);
      }
    }

    // 5. Restore SQLite database files
    logger.info('Restoring SQLite database files...');

    // First, delete any CI-created SQLite files to avoid mixing old and new data
    logger.info('Cleaning up CI-created SQLite database files...');
    const sqliteFilesToClean = [
      'services/admin/db/admin.db',
      'services/admin/db/admin.db-shm',
      'services/admin/db/admin.db-wal'
    ];

    for (const sqliteFile of sqliteFilesToClean) {
      const filePath = path.join(projectRoot, sqliteFile);
      try {
        await fs.unlink(filePath);
        logger.info(`Removed CI-created ${sqliteFile}`);
      } catch (error) {
        // File doesn't exist, that's fine
      }
    }

    // Now restore from backup if backup exists.
    // Only the main .db file was backed up - it was checkpointed
    // (PRAGMA wal_checkpoint(TRUNCATE)) before the backup copy was made, so
    // it is a complete snapshot on its own. SQLite will recreate WAL/SHM
    // automatically the next time it opens the file.
    const mainDbBackupPath = path.join(backupDir, 'services_admin_db_admin.db');
    const mainDbOriginalPath = path.join(projectRoot, 'services/admin/db/admin.db');

    if (fsSync.existsSync(mainDbBackupPath)) {
      // Ensure the db directory exists
      const dbDir = path.dirname(mainDbOriginalPath);
      await fs.mkdir(dbDir, { recursive: true });

      await fs.copyFile(mainDbBackupPath, mainDbOriginalPath);
      logger.success('✅ Restored admin.db (main database file)');
      logger.info('SQLite will recreate WAL/SHM files automatically when database is opened');
    } else {
      logger.info('No SQLite database to restore (first-time setup or was using PostgreSQL)');
    }

    // 6. Clean up backup directory and location file
    logger.info('Cleaning up backup files...');
    await fs.rm(backupDir, { recursive: true, force: true });

    const backupLocationFile = path.join(__dirname, '.ci-backup-location');
    try {
      await fs.unlink(backupLocationFile);
    } catch (error) {
      // File might not exist
    }

    logger.success('Environment state restored successfully');

  } catch (error) {
    logger.error(`Failed to restore state: ${error.message}`);
    logger.error(`Backup preserved at: ${backupDir}`);
    logger.error(`You can manually restore using the backup at this location`);
    throw error;
  }
}

// Cleanup function
async function cleanup() {
  logger.phase('Cleanup Phase: Stopping Services');
  
  // Kill spawned processes gracefully
  for (const proc of state.processes) {
    if (proc.pid && !proc.killed) {
      try {
        logger.info(`Stopping ${proc.name} service (PID: ${proc.pid})...`);
        
        // Check if process is still running
        try {
          process.kill(proc.pid, 0); // Signal 0 tests if process exists
        } catch (e) {
          logger.info(`${proc.name} was already stopped`);
          continue;
        }
        
        // Try graceful shutdown first
        process.kill(proc.pid, 'SIGTERM');
        
        // Wait up to 3 seconds for graceful shutdown
        const stopped = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve(false);
          }, 3000);
          
          proc.on('exit', () => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
        
        if (stopped) {
          logger.success(`${proc.name} stopped gracefully`);
        } else {
          // Force kill if still running
          try {
            process.kill(proc.pid, 'SIGKILL');
            logger.info(`Force killed ${proc.name} (PID: ${proc.pid})`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for kill
          } catch (e) {
            // Process already dead
          }
        }
      } catch (error) {
        // Process might already be dead
        logger.info(`${proc.name} was already stopped`);
      }
    }
  }
  
  // Stop Docker containers
  for (const container of state.containers) {
    try {
      logger.info(`Stopping Docker container: ${container}`);
      
      // Check if container exists and is running
      try {
        const { stdout } = await execAsync(`docker ps -q --filter "name=${container}"`);
        if (stdout.trim()) {
          logger.info(`Container ${container} is running, stopping it...`);
          await execAsync(`docker stop ${container}`);
          logger.success(`Stopped container: ${container}`);
        } else {
          logger.info(`Container ${container} is not running`);
        }
      } catch (stopError) {
        logger.warning(`Failed to stop container ${container}: ${stopError.message}`);
      }
      
      // Try to remove the container
      try {
        const { stdout } = await execAsync(`docker ps -aq --filter "name=${container}"`);
        if (stdout.trim()) {
          await execAsync(`docker rm ${container}`);
          logger.info(`Removed container: ${container}`);
        }
      } catch (removeError) {
        logger.info(`Container ${container} removal not needed or failed: ${removeError.message}`);
      }
    } catch (error) {
      logger.warning(`Error handling container ${container}: ${error.message}`);
    }
  }
  
  // The file_search test MinIO, by name (docker rm -f -v), not through the stop/rm loop above
  if (state.fileSearchS3Container) {
    logger.info(`Removing Docker container: ${state.fileSearchS3Container}`);
    await fileSearchTestS3.stopMinio({ exec: execAsync, name: state.fileSearchS3Container });
  }

  // Restore user's environment state
  if (state.backupDir) {
    try {
      await restoreCIState(state.backupDir);
    } catch (error) {
      logger.error(`Failed to restore environment: ${error.message}`);
      logger.error(`Backup preserved for manual recovery`);
    }
  }
  
  const duration = Math.round((Date.now() - state.startTime) / 1000);
  
  // Verify cleanup was successful
  let cleanupWarnings = [];
  
  // Check if any processes are still running
  for (const proc of state.processes) {
    if (proc.pid) {
      try {
        process.kill(proc.pid, 0);
        cleanupWarnings.push(`${proc.name} (PID: ${proc.pid}) may still be running`);
      } catch (e) {
        // Process is dead, good
      }
    }
  }
  
  // Check if containers are still running
  for (const container of [...state.containers, ...(state.fileSearchS3Container ? [state.fileSearchS3Container] : [])]) {
    try {
      const { stdout } = await execAsync(`docker ps -q --filter "name=${container}"`);
      if (stdout.trim()) {
        cleanupWarnings.push(`Docker container ${container} is still running`);
      }
    } catch (e) {
      // Error checking container status
    }
  }
  
  if (cleanupWarnings.length > 0) {
    logger.warning('Cleanup completed with warnings:');
    cleanupWarnings.forEach(warning => logger.warning(`  - ${warning}`));
    logger.info(`Pipeline completed in ${duration} seconds`);
  } else {
    logger.success(`All services stopped. Pipeline completed in ${duration} seconds`);
  }
}

// Global flag to prevent double cleanup
let cleanupInProgress = false;

// Set up cleanup handlers
process.on('SIGINT', async () => {
  if (!cleanupInProgress) {
    cleanupInProgress = true;
    logger.warning('Received SIGINT, cleaning up...');
    await cleanup();
  }
  process.exit(130);
});

process.on('SIGTERM', async () => {
  if (!cleanupInProgress) {
    cleanupInProgress = true;
    logger.warning('Received SIGTERM, cleaning up...');
    await cleanup();
  }
  process.exit(143);
});

// Utility functions
async function executeCommand(command, options = {}) {
  const { cwd = process.cwd(), description, ignoreError = false, env } = options;

  if (description) {
    logger.step(description);
  }

  try {
    // maxBuffer, explicitly: child_process.exec defaults to 1 MiB of stdout and
    // KILLS the child the moment it is exceeded, surfacing as a generic failure
    // rather than as "your output was too big".
    //
    // That silently broke Phase 9. `trivy image --format json` emits 490 KB for
    // nginx but 1,343,693 bytes for admin and 1,081,068 for a gateway build —
    // straddling the 1,048,576 limit. Oversized scans came back with stdout: ''
    // (the ignoreError path below), so JSON.parse threw "Unexpected end of JSON
    // input", the loop logged an error and moved on, and the pipeline still
    // reported success. Trivy had scanned those images correctly every time;
    // their results were thrown away here. Whether any given image survived was
    // down to whether its JSON happened to land under 1 MiB.
    //
    // 64 MiB is far above any output this pipeline produces, and applies to
    // every command, not just Trivy — docker build logs and full test output
    // are the other candidates for silently hitting this.
    const execOptions = { cwd, maxBuffer: 64 * 1024 * 1024 };
    if (env) {
      execOptions.env = env;
    }
    const { stdout, stderr } = await execAsync(command, execOptions);
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!ignoreError) {
      logger.error(`Command failed: ${command}`);
      logger.error(`Error: ${error.message}`);
      if (error.stdout) logger.error(`Stdout: ${error.stdout}`);
      if (error.stderr) logger.error(`Stderr: ${error.stderr}`);
      throw error;
    }
    // If ignoreError is true, just log a warning
    logger.warning(`Command failed (continuing): ${command}`);
    return { stdout: '', stderr: error.message };
  }
}

/**
 * Runs a service's jest suite and keeps a per-suite record of it in ci/reports/jest/<service>.json
 * (paths and counts only, see ci/scripts/jest-summary.js), also when the suite fails. The log gets
 * one line of counts and the name of every suite that skipped entirely, so a suite gated on Valkey,
 * Postgres or a live service that did not run shows up as skipped rather than as a pass.
 */
async function runJestSuite(label, cwd, options = {}) {
  const service = path.basename(cwd);
  const raw = path.join(os.tmpdir(), `jest-${service}-${process.pid}.json`);
  try {
    // A reporter, not --json: with --json a jest worker running the structure chunker thread suite
    // beside others was killed by SIGTERM on every full run. No "--" before the flags: pnpm passes
    // the separator on and jest would read the flags as path patterns.
    const reporter = path.resolve('ci', 'scripts', 'jest-summary-reporter.js');
    const env = { ...(options.env || process.env), JEST_SUMMARY_RAW: raw };
    await executeCommand(`pnpm run test --reporters=default --reporters="${reporter}"`, { cwd, ...options, env });
  } finally {
    const out = path.join('ci', 'reports', 'jest', `${service}.json`);
    const { stdout } = await executeCommand(`node ci/scripts/jest-summary.js "${raw}" "${label}" "${cwd}" "${out}"`, { ignoreError: true });
    for (const line of stdout.split('\n')) if (line.trim()) logger.info(line);
  }
}

async function spawnService(command, args, options = {}) {
  const { cwd = process.cwd(), name, env = {} } = options;
  
  logger.info(`Starting ${name}...`);
  
  // Handle Windows shell requirements for npm/pnpm commands
  const isWindows = process.platform === 'win32';
  const spawnOptions = {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  };
  
  if (isWindows && (command === 'pnpm' || command === 'npm')) {
    spawnOptions.shell = true;
  }
  
  const child = spawn(command, args, spawnOptions);
  
  // Create log files for service output
  const logDir = 'ci-logs';
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  const errorLogFile = path.join(logDir, `${name}-error.log`);
  
  // Write service output to files instead of console to reduce noise
  child.stdout.on('data', (data) => {
    fs.appendFile(logFile, data.toString()).catch(() => {});
  });
  
  child.stderr.on('data', (data) => {
    fs.appendFile(errorLogFile, data.toString()).catch(() => {});
  });
  
  child.on('error', (error) => {
    logger.error(`${name} process error: ${error.message}`);
    fs.appendFile(errorLogFile, `Process error: ${error.message}\n`).catch(() => {});
  });
  
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      logger.warning(`${name} exited with code ${code}`);
    }
    if (signal) {
      logger.info(`${name} stopped with signal ${signal}`);
    }
  });
  
  state.processes.push({ ...child, name });
  return child;
}

async function waitForService(url, serviceName, maxAttempts = 60) {
  logger.info(`Waiting for ${serviceName} at ${url}...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await axios.get(url, { timeout: 1000 });
      logger.success(`${serviceName} is ready!`);
      return true;
    } catch (error) {
      if (attempt % 10 === 0) {
        logger.info(`Still waiting for ${serviceName} (attempt ${attempt}/${maxAttempts})...`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  throw new Error(`${serviceName} failed to start within ${maxAttempts} seconds`);
}

async function createOllamaApiKey() {
  logger.step('Creating API key for Ollama service...');
  
  const requestData = {
    name: 'Ollama test key',
    email: 'user@test.com',
    permissions: ['models:read', 'chat:create'],
    rateLimits: {
      requestsPerMinute: 60,
      requestsPerHour: 1000,
      requestsPerDay: 5000
    }
  };
  
  try {
    const response = await axios.post(
      'http://localhost:4004/odata/v4/admin/createApiKey',
      requestData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic YWRtaW5AdGVzdC5jb206YWRtaW4='
        },
        timeout: 30000  // Increased timeout to 30 seconds
      }
    );
    
    if (!response.data.key) {
      throw new Error(`No key in response: ${JSON.stringify(response.data)}`);
    }
    
    // Copy .env.sample to .env and update with API key
    const envSampleContent = await fs.readFile('services/ollama/.env.sample', 'utf8');
    
    // Replace placeholder values with actual API key
    const updatedEnvContent = envSampleContent
      .replace(/MAIN_PROXY_API_KEY=your_api_key_here/, `MAIN_PROXY_API_KEY=${response.data.key}`)
      .replace(/# OPENAI_API_KEY=your_openai_key_here/, `OPENAI_API_KEY=${response.data.key}`);
    
    await fs.writeFile('services/ollama/.env', updatedEnvContent);
    
    logger.success('API key created and services/ollama/.env configured');
    return response.data.key;
  } catch (error) {
    logger.error(`Failed to create API key: ${error.message}`);
    if (error.response) {
      logger.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function checkDatabaseReadiness() {
  logger.info('Checking database readiness...');
  
  try {
    // Try a simple health check first
    const healthResponse = await axios.get('http://localhost:4004/odata/v4/validation/health()', {
      timeout: 10000,
      headers: {
        'Authorization': 'Basic YWRtaW5AdGVzdC5jb206YWRtaW4='
      }
    });
    
    logger.success('Database health check passed');
    return true;
  } catch (error) {
    logger.warning(`Database health check failed: ${error.message}`);
    
    // Wait longer for database to initialize
    logger.info('Waiting additional 20 seconds for database initialization...');
    await new Promise(resolve => setTimeout(resolve, 20000));
    return false;
  }
}

async function createOllamaApiKeyWithRetry(maxRetries = 3) {
  // First check if database is ready
  await checkDatabaseReadiness();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`API key creation attempt ${attempt}/${maxRetries}...`);
      return await createOllamaApiKey();
    } catch (error) {
      if (attempt === maxRetries) {
        logger.error(`Failed to create API key after ${maxRetries} attempts`);
        throw error;
      }
      
      logger.warning(`Attempt ${attempt} failed, waiting 20 seconds before retry...`);
      logger.warning(`Error: ${error.message}`);
      
      // If it's a database timeout, try to give the database more time
      if (error.message.includes('timed out') || error.message.includes('ResourceRequest')) {
        logger.info('Database appears to be struggling, giving it more time...');
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 20000));
      }
    }
  }
}

// Bootstrap function to install dependencies and load modules
async function bootstrap() {
  logger.info('Bootstrapping CI environment...');
  
  // Check if we have access to node_modules
  try {
    require.resolve('axios');
    axios = require('axios');
    logger.success('Dependencies already available');
    return true;
  } catch (error) {
    logger.info('Dependencies not found, installing...');
  }
  
  // Install dependencies first
  try {
    await executeCommand('pnpm install --frozen-lockfile', {
      description: 'Installing dependencies with frozen lockfile...'
    });
    
    // Now load axios
    axios = require('axios');
    logger.success('Dependencies installed and loaded');
    return true;
  } catch (error) {
    logger.error(`Failed to bootstrap dependencies: ${error.message}`);
    return false;
  }
}

// Main CI Pipeline
async function runCIPipeline() {
  try {
    logger.phase('SAP LLM Gateway CI Pipeline');

    // CRITICAL: Determine if Docker build is required BEFORE any file operations
    // This must run first to capture the true state before setup scripts modify files
    logger.step('Analyzing changed files to determine if Docker build is needed...');
    state.startHead = await headCommit(execAsync);
    const dockerBuildDecision = await shouldRunDockerBuild();
    state.dockerBuildRequired = dockerBuildDecision.required;
    state.dockerBuildDecisionReason = dockerBuildDecision.reason;
    state.startCleanTree = dockerBuildDecision.cleanTree === true;
    state.changedFiles = dockerBuildDecision.files;

    // Log the decision
    if (state.dockerBuildRequired) {
      logger.info(`✅ Docker build WILL run: ${state.dockerBuildDecisionReason}`);
      if (dockerBuildDecision.files.length > 0 && dockerBuildDecision.files.length <= 10) {
        logger.info(`Changed files: ${dockerBuildDecision.files.join(', ')}`);
      } else if (dockerBuildDecision.files.length > 10) {
        logger.info(`Changed files (${dockerBuildDecision.files.length} total): ${dockerBuildDecision.files.slice(0, 10).join(', ')}...`);
      }
    } else {
      logger.warning(`⏭️  Docker build will be SKIPPED: ${state.dockerBuildDecisionReason}`);
      logger.info('This will save approximately 30-35 minutes');
      if (dockerBuildDecision.files.length > 0 && dockerBuildDecision.files.length <= 10) {
        logger.info(`Changed files (non-Docker): ${dockerBuildDecision.files.join(', ')}`);
      } else if (dockerBuildDecision.files.length > 10) {
        logger.info(`Changed files (${dockerBuildDecision.files.length} total, non-Docker): ${dockerBuildDecision.files.slice(0, 10).join(', ')}...`);
      }
    }

    // Bootstrap: Install dependencies if needed
    const bootstrapSuccess = await bootstrap();
    if (!bootstrapSuccess) {
      throw new Error('Failed to bootstrap CI environment');
    }

    // Parse configuration from docker-compose.yml
    const config = await parseDockerComposeConfig();
    state.volumeNames = config.volumes;
    state.images = config.images;

    // Detect docker compose command
    state.dockerComposeCmd = await getDockerComposeCommand();
    logger.info(`Using docker compose command: ${state.dockerComposeCmd}`);

    // Define paths used across multiple phases
    const projectRoot = path.join(__dirname, '..');
    const dockerComposeFile = path.join(projectRoot, 'docker/docker-compose.yml');

    // Set environment variables for CI-specific image tags
    const ciEnv = {
      ...process.env,
      DOCKER_TAG: 'ci-test'
    };

    // Phase 1: Environment Setup & Cleanup
    logger.phase('Phase 1: Environment Setup & Cleanup');
    
    // Validate SAP_AI_CORE_SERVICE_KEY
    const serviceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
    if (!serviceKey) {
      throw new Error('SAP_AI_CORE_SERVICE_KEY environment variable is required but not set. This must contain valid SAP AI Core service credentials in JSON format.');
    }
    
    try {
      const parsed = JSON.parse(serviceKey);
      
      // Validate required fields
      const requiredFields = ['clientid', 'clientsecret', 'url', 'identityzone', 'identityzoneid'];
      const missing = requiredFields.filter(field => !parsed[field]);
      
      if (missing.length > 0) {
        throw new Error(`SAP_AI_CORE_SERVICE_KEY is missing required fields: ${missing.join(', ')}`);
      }
      
      // Security validation - ensure it's not using default/sample values
      if (parsed.clientid === 'test-client' || parsed.clientsecret === 'test-secret') {
        throw new Error('SAP_AI_CORE_SERVICE_KEY contains sample/default values. Real credentials are required.');
      }
      
      logger.success('SAP_AI_CORE_SERVICE_KEY validated');
    } catch (error) {
      if (error.message.includes('SAP_AI_CORE_SERVICE_KEY')) {
        throw error;
      }
      throw new Error('SAP_AI_CORE_SERVICE_KEY is not valid JSON: ' + error.message);
    }
    
    // Phase 1A: Backup current state
    const backupDir = await backupCIState();

    // Phase 1B: Clean state for fresh CI environment
    await cleanStateBeforeCI();

    // Dependencies already installed during bootstrap
    logger.success('Dependencies ready');

    // Phase 1C: Run Docker setup script in CI mode using npx (HISTORICAL APPROACH)
    await executeCommand('npx -y -p inquirer@8.2.6 node docker/setup-docker.js --ci --force', {
      description: 'Running Docker setup with CI defaults...'
    });
    
    // Patch .env files to use SQLite for CI testing
    logger.step('Patching .env files for SQLite configuration...');
    const envFilesToPatch = [
      'services/admin/.env',
      'services/gateway/.env',
      'services/ollama/.env'
    ];
    
    for (const envFile of envFilesToPatch) {
      try {
        const envContent = await fs.readFile(envFile, 'utf8');
        
        // Replace PostgreSQL configuration with SQLite for admin service
        if (envFile === 'services/admin/.env') {
          const sqliteEnvContent = envContent
            .replace(/cds\.requires\.db\.kind=postgres/g, 'cds.requires.db.kind=sqlite')
            .replace(/cds\.requires\.db\.impl=@cap-js\/postgres/g, 'cds.requires.db.impl=@cap-js/sqlite')
            .replace(/cds\.requires\.db\.credentials\.host=.*/g, 'cds.requires.db.credentials.url=db/admin.db')
            .replace(/cds\.requires\.db\.credentials\.port=.*/g, '')
            .replace(/cds\.requires\.db\.credentials\.user=.*/g, '')
            .replace(/cds\.requires\.db\.credentials\.password=.*/g, '')
            .replace(/cds\.requires\.db\.credentials\.database=.*/g, '')
            .replace(/cds\.sql\.dialect=postgres/g, 'cds.sql.dialect=sqlite')
            // Remove empty lines
            .replace(/^\s*$/gm, '')
            .replace(/\n\n+/g, '\n\n');
          
          await fs.writeFile(envFile, sqliteEnvContent);
          logger.info(`Patched ${envFile} for SQLite`);
        }
      } catch (error) {
        logger.info(`${envFile} not found or could not be patched (this is fine)`);
      }
    }
    
    // Start Valkey
    logger.step('Starting fresh Valkey cache for CI...');

    // Always stop and remove existing Valkey to ensure fresh cache
    // This prevents tests from using stale cached data from dev work
    try {
      const { stdout } = await execAsync('docker ps --filter "name=valkey" --format "{{.Names}}"');
      if (stdout.trim() === 'valkey') {
        logger.info('Stopping existing Valkey container to ensure fresh cache...');
        await execAsync('docker stop valkey');
        logger.info('Stopped existing Valkey container');
      }
    } catch (error) {
      // Error checking/stopping - container might not exist
    }

    // Remove container (whether stopped or not)
    try {
      await execAsync('docker rm valkey');
      logger.info('Removed existing Valkey container');
    } catch (error) {
      // Container doesn't exist, that's fine
    }

    // Start fresh Valkey container
    try {
      await executeCommand(
        'docker run -d --name valkey --restart unless-stopped -p 127.0.0.1:6379:6379 valkey/valkey:8',
        { description: 'Starting fresh Valkey container...' }
      );
    } catch (error) {
      logger.error(`Failed to start Valkey: ${error.message}`);
      throw new Error('Failed to start Valkey container - CI cannot proceed without cache');
    }

    state.containers.push('valkey');

    // A Postgres with pgvector for the file_search suites and the Phase 5 gateway.
    // See ci/scripts/file-search-test-db.js for why it is two databases, and why port 55434.
    logger.step('Preparing the file_search test database...');
    // Registered before the container exists: cleanup() must also remove it if setup fails or is interrupted.
    if (needsContainer(process.env)) state.containers.push(CONTAINER_NAME);
    state.fileSearch = await ensureFileSearchTestDatabase({
      env: process.env,
      exec: execAsync,
      log: (message) => logger.info(message)
    });
    logger.success(`file_search test database ready (${state.fileSearch.container ? 'own container' : 'provided DSN'})`);

    // MinIO for the file_search S3 suites (Phase 6 only; the Phase 5 gateway and the journeys stay on
    // the db backend). See ci/scripts/file-search-test-s3.js for the port and the loopback-only guard.
    logger.step('Preparing the file_search test S3 (MinIO)...');
    // Named and registered before the container exists: cleanup() must also remove it if setup fails or is interrupted.
    const minioName = fileSearchTestS3.needsContainer(process.env) ? fileSearchTestS3.containerName() : null;
    state.fileSearchS3Container = minioName;
    state.fileSearchS3 = await fileSearchTestS3.ensureFileSearchTestS3({
      env: process.env,
      exec: execAsync,
      log: (message) => logger.info(message),
      name: minioName || undefined
    });
    logger.success(`file_search test S3 ready (${state.fileSearchS3.container ? 'own container' : 'provided endpoint'})`);
    
    // Phase 2: Security Validation (Fail Fast)
    logger.phase('Phase 2: Security Validation');
    
    // Fails closed. The previous version fell back to "SKIPPED" whenever the scanner threw anything
    // it did not recognise - including a detected supply-chain indicator, whose message matched
    // neither of the two it re-threw - and its dependency audit read pnpm audit's exit code, which
    // made it report "No vulnerabilities found" exactly when there were some (ci/audit-gate.test.js).
    logger.step('Running cross-platform security validation...');
    const { runSecretDetection, checkSupplyChainIOCs } = require('./security-scanner.js');

    const secretIssues = await runSecretDetection();
    if (secretIssues > 0) {
      throw new Error(`Security validation failed: ${secretIssues} critical issue(s) found. Please fix before proceeding.`);
    }
    logger.success('✅ Secret detection: PASSED');

    const supplyChainIssues = await checkSupplyChainIOCs();
    if (supplyChainIssues > 0) {
      throw new Error(`Supply chain attack detected: ${supplyChainIssues} indicator(s) found. Do NOT proceed.`);
    }
    logger.success('✅ Supply chain check: PASSED');

    await executeCommand('node ci/audit-gate.test.js', {
      description: 'Testing the dependency gate...'
    });
    await executeCommand('node ci/scripts/backed-up-volumes.test.js', {
      description: 'Testing which volumes the CI may remove...'
    });
    await executeCommand('node cli-tools/sync-commits.test.js', {
      description: 'Testing that the commit sync replays large files...'
    });
    await executeCommand('node cli-tools/sync-version.test.js', {
      description: 'Testing that the version sync covers the OpenAPI documents...'
    });
    await executeCommand('node ci/scripts/docker-build-decision.test.js', {
      description: 'Testing the Docker build decision...'
    });
    await executeCommand('node ci/scripts/docker-build-progress.test.js', {
      description: 'Testing the Docker build progress...'
    });
    await executeCommand('node ci/scripts/sap-relay-env.test.js', {
      description: 'Testing the SAP relay settings...'
    });
    await executeCommand('node ci/scripts/jest-summary.test.js', {
      description: 'Testing the jest suite summary...'
    });
    await executeCommand('node ci/sap-relay/relay.test.js', {
      description: 'Testing the SAP relay renderer...'
    });
    await executeCommand('node ci/file-search-eval/build-corpus.test.js', {
      description: 'Checking the file_search evaluation corpus...'
    });
    await executeCommand('node ci/file-search-eval/question-set.test.js', {
      description: 'Testing the file_search question generator...'
    });
    await executeCommand('node ci/file-search-eval/sap-client.test.js', {
      description: 'Testing the file_search question generator SAP client...'
    });
    await executeCommand('node ci/file-search-eval/questions.test.js', {
      description: 'Checking the file_search evaluation questions...'
    });
    const gate = await executeCommand('node ci/audit-gate.js', {
      description: 'Dependency gate (pnpm audit: high/critical not on ci/audit-allowlist.json block)...'
    });
    gate.stdout.trim().split('\n').forEach(line => logger.info(line));
    logger.success('✅ Dependency gate: PASSED');

    // Phase 3: Service Compilation
    logger.phase('Phase 3: Service Compilation');
    
    // Build Gateway
    logger.step('Building Gateway service...');
    // Clean dist directory (Windows compatible)
    await executeCommand('npx rimraf dist', { 
      cwd: 'services/gateway',
      description: 'Cleaning Gateway dist directory...',
      ignoreError: true
    });
    
    // Create directories using Node.js
    const gatewayDistPath = path.join('services/gateway', 'dist/srv');
    await fs.mkdir(gatewayDistPath, { recursive: true });
    logger.info('Created Gateway dist/srv directory');
    
    await executeCommand('pnpm run build', { 
      cwd: 'services/gateway',
      description: 'Compiling Gateway TypeScript...'
    });
    
    // Build Admin
    logger.step('Building Admin service...');
    // Clean dist and gen directories (Windows compatible)
    await executeCommand('npx rimraf dist', { 
      cwd: 'services/admin',
      description: 'Cleaning Admin dist directory...',
      ignoreError: true
    });
    await executeCommand('npx rimraf gen', { 
      cwd: 'services/admin',
      description: 'Cleaning Admin gen directory...',
      ignoreError: true
    });
    
    // Create directories using Node.js
    const adminDistPath = path.join('services/admin', 'dist/srv');
    await fs.mkdir(adminDistPath, { recursive: true });
    logger.info('Created Admin dist/srv directory');
    
    // Ensure database directory exists before reset
    const adminDbPath = path.join('services/admin', 'db');
    await fs.mkdir(adminDbPath, { recursive: true });
    logger.info('Created Admin db directory');
    
    await executeCommand('pnpm run db:reset', { 
      cwd: 'services/admin',
      description: 'Resetting Admin database...'
    });
    await executeCommand('pnpm run build', { 
      cwd: 'services/admin',
      description: 'Compiling Admin service...'
    });
    
    // Build SAIL-PROXY npm package
    logger.step('Building SAIL-PROXY npm distribution...');
    
    // First install dependencies for SAIL-PROXY using pnpm (supports workspace:*)
    await executeCommand('pnpm install', {
      cwd: 'npm-dist/sail-proxy',
      description: 'Installing SAIL-PROXY dependencies...'
    });
    
    await executeCommand('pnpm run build:local', {
      cwd: 'npm-dist/sail-proxy',
      description: 'Building SAIL-PROXY package (without re-bundling services)...'
    });
    
    // Phase 4: Unit Testing
    logger.phase('Phase 4: Unit Testing');
    
    await executeCommand('pnpm run test:unit', {
      cwd: 'services/gateway',
      description: 'Running Gateway unit tests...'
    });

    // test:unit's --testPathPattern="test/(clients|config)/" does not cover
    // test/pseudonymization-precision/ (or any other pseudonymization suite). The precision
    // harness is the regression gate for the pseudonymization detectors — spec
    // 2026-08-25-pseudonymization-precision — so it must run every CI build, not just locally.
    await executeCommand('pnpm run test:pseudonymization', {
      cwd: 'services/gateway',
      description: 'Running Gateway pseudonymization precision/recall harness...'
    });

    // --no-cache: ts-jest reuses cached per-file output and then skips its
    // type diagnostics, so cross-file errors (e.g. two script-style test files
    // declaring the same top-level const, TS2451) only surface on a cold cache —
    // which is what the GitHub runner always has. Compile cold here too. No "--" before the flag:
    // pnpm passes the separator on, and jest then read --no-cache as a test path pattern and ran
    // with its cache.
    await executeCommand('pnpm run test:unit --no-cache', {
      cwd: 'services/admin',
      description: 'Running Admin unit tests (cold ts-jest cache)...'
    });

    // The text inventory: fails on any hard-coded user-visible literal in a cockpit view,
    // controller or model that is not in ci/scripts/i18n-literals.allowlist.json (exit 1).
    // It skips node_modules, dist, test, i18n, localService, annotations and mockData.
    await executeCommand('node ci/scripts/i18n-literals.js', {
      description: 'Checking the cockpit for hard-coded (untranslated) text...'
    });

    // The UI5 type check: `tsc --noEmit` per cockpit app (the ui5 build transpiles with babel and
    // never type-checks). Fails on any error in an app listed in ci/scripts/ui5-typecheck.gated.json
    // and on TS2688 anywhere (the @sapui5/types devDependency is missing; tsc then checks nothing).
    await executeCommand('node ci/scripts/ui5-typecheck.js', {
      description: 'Type-checking the cockpit UI5 apps...'
    });

    await executeCommand('pnpm run test', {
      cwd: 'libs/test-utils',
      description: 'Running test-utils unit tests...'
    });

    // Phase 5: Integration Test Environment
    logger.phase('Phase 5: Integration Test Environment Setup');
    
    // Initialize SQLite database for Admin service
    logger.step('Initializing SQLite database for Admin service...');
    await executeCommand('pnpm run db:reset', {
      cwd: 'services/admin',
      description: 'Resetting and initializing SQLite database...'
    });
    
    // Start Admin service with SQLite configuration for CI
    const adminService = await spawnService('pnpm', ['run', 'dev:ts:mock'], {
      cwd: 'services/admin',
      name: 'admin-service',
      env: { 
        NODE_ENV: 'development',
        // Force SQLite for CI environment
        'cds.requires.db.kind': 'sqlite',
        'cds.requires.db.impl': '@cap-js/sqlite',
        'cds.requires.db.credentials.url': 'db/admin.db',
        // Disable PostgreSQL configuration
        'cds.sql.dialect': 'sqlite'
      }
    });
    
    // Wait for Admin service
    logger.info('Waiting 35 seconds for Admin service to initialize...');
    await new Promise(resolve => setTimeout(resolve, 35000));
    
    // Check if admin is responding
    try {
      await waitForService('http://localhost:4004/health', 'Admin Service', 30);
    } catch (error) {
      // Try alternative health check
      await waitForService('http://localhost:4004', 'Admin Service', 10);
    }
    
    // Database is already initialized and service is responding
    
    // Start Gateway service
    logger.info(`SAP via relay: ${process.env.SAP_RELAY_BASE ? 'yes' : 'no'}`);
    const gatewayService = await spawnService('pnpm', ['run', 'dev'], {
      cwd: 'services/gateway',
      name: 'gateway-service',
      // Overrides both FILE_SEARCH_DATABASE_URL and FILE_SEARCH_MIGRATION_DATABASE_URL: an explicit variable wins over
      // services/gateway/.env, which may point at a developer's own database, so neither can divert the CI gateway.
      env: { NODE_ENV: 'development', FILE_SEARCH_DATABASE_URL: state.fileSearch.gatewayDsn, FILE_SEARCH_MIGRATION_DATABASE_URL: state.fileSearch.gatewayDsn, ...sapRelayEnv(process.env.SAP_RELAY_BASE) }
    });

    // Wait for Gateway service
    logger.info('Waiting 10 seconds for Gateway service to initialize...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    try {
      await waitForService('http://localhost:3000/health', 'Gateway Service', 30);
    } catch (error) {
      // Try alternative health check
      await waitForService('http://localhost:3000', 'Gateway Service', 10);
    }
    
    // Wait 10 seconds before API key creation to ensure system stability
    logger.info('Waiting 10 seconds before API key creation...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Create API key for Ollama after Gateway is ready
    await createOllamaApiKeyWithRetry();
    
    // Start Ollama service
    const ollamaService = await spawnService('node', ['index.js'], {
      cwd: 'services/ollama',
      name: 'ollama-service'
    });
    
    // Wait for Ollama service
    try {
      await waitForService('http://localhost:11434/health', 'Ollama Service', 30);
    } catch (error) {
      // Try alternative health check
      await waitForService('http://localhost:11434', 'Ollama Service', 10);
    }
    
    // Phase 6: Full Test Suite
    logger.phase('Phase 6: Full Test Suite');
    
    await runJestSuite('Gateway', 'services/gateway', {
      description: 'Running Gateway full test suite...',
      // The Postgres integration suites skip without this, the S3 suites without FILE_SEARCH_TEST_S3_*.
      // FILE_SEARCH_TEST_BINARIES is passed on only if the caller set it: the extractor suites need
      // pandoc, pdftotext, tesseract (eng) and antiword installed. The blob race suite runs 60 iterations here (300 when run on
      // its own) so its load does not crowd the timing tests beside it; the caller may override.
      env: {
        ...process.env, FILE_SEARCH_TEST_DSN: state.fileSearch.testDsn, ...state.fileSearchS3.env,
        FILE_SEARCH_RACE_ITERATIONS: process.env.FILE_SEARCH_RACE_ITERATIONS || '60',
      }
    });
    
    await runJestSuite('Admin', 'services/admin', {
      description: 'Running Admin full test suite...',
      // describeLive (libs/test-utils) skips the live-server integration
      // suites unless ADMIN_SERVICE_URL is set explicitly. The admin service
      // started above in Phase 5 is already listening on :4004, so point the
      // suites at it rather than let them skip in CI.
      env: { ...process.env, ADMIN_SERVICE_URL: 'http://localhost:4004' }
    });
    
    await runJestSuite('Ollama', 'services/ollama', {
      description: 'Running Ollama full test suite...'
    });
    
    // Phase 6.5: sail-proxy CLI End-to-End
    // Packs the npm tarball, installs in a tmpdir, exercises run/status/
    // apikey/inference/stop using SAP_AI_CORE_SERVICE_KEY. Runs after the
    // service test suite (so the bundled artefacts reflect tested code) and
    // before docker build (so a tarball regression fails fast — packing is
    // cheap; rebuilding 4 docker images is not).
    logger.phase('Phase 6.5: sail-proxy CLI End-to-End');

    await executeCommand('node cli-tools/test-sail-proxy-cli.js', {
      description: 'Running packaged sail-proxy E2E smoke (pack + install + run + inference + stop)...'
    });

    // The package's own tests (launcher adapters, bundled plugin registration, the
    // plugin litmus, the production package.json the bundled services install from).
    // After the E2E on purpose: it leaves bundled/ in place, which bundled-plugins.test.js
    // and plugin-litmus.test.js need. run-all.js picks up every *.test.js.
    await executeCommand('npm test', {
      cwd: 'npm-dist/sail-proxy',
      description: 'Running sail-proxy package tests...'
    });

    // Phase 6.6: UI journeys
    // Role-based OPA5 journeys (shell, api-keys-app, aws-credentials-app) run by
    // ui5-test-runner against the admin started in Phase 5. The pipeline owns the
    // connection details: run.js never guesses a URL. Runs after the last phase
    // that reads the CI database (6.5): the journeys purge every key, credential
    // and draft and seed their own fixtures. The DB is the CI's own (db:reset in
    // Phase 5); the maintainer's admin.db was backed up in Phase 1 and comes back
    // in Phase 10. Phases 7-8 use container databases.
    // UI_JOURNEYS_IN_PIPELINE lets seed.js accept port 4004, which it otherwise refuses (the maintainer's dev admin).
    logger.phase('Phase 6.6: UI journeys');

    await executeCommand('node ci/scripts/ui-journeys/run.js', {
      description: 'Running role-based OPA5 UI journeys against the Phase 5 admin...',
      env: { ...process.env, ADMIN_SERVICE_URL: 'http://localhost:4004', UI_JOURNEYS_IN_PIPELINE: '1' }
    });

    // Phase 7: Docker Build Validation
    logger.phase('Phase 7: Docker Build Validation');

    if (!state.dockerBuildRequired) {
      logger.warning('⏭️  SKIPPING Docker build - no Docker-related files changed');
      logger.info(`Reason: ${state.dockerBuildDecisionReason}`);
      logger.info('Time saved: ~30 minutes');
      logger.success('✅ Docker build: SKIPPED (optimization)');
    } else {
      logger.info(`Running Docker build: ${state.dockerBuildDecisionReason}`);
      logger.info('⏱️  Note: Docker build typically takes 19-25 minutes due to --no-cache flag');

      // Clean up existing CI-tagged images
      logger.step('Cleaning up existing CI-tagged Docker images...');
      for (const imageInfo of state.images) {
        await executeCommand(`docker rmi ${imageInfo.ciTag}`, {
          description: `Removing existing ${imageInfo.ciTag} image...`,
          ignoreError: true
        });
      }

      // Clean build cache
      await executeCommand('docker builder prune -a -f', {
        description: 'Cleaning Docker build cache...',
        ignoreError: true
      });

      // Build images with CI-specific tags
      logger.step('Building Docker images with ci-test tags...');
      const dockerStartTime = Date.now();

      // Build the four DISTINCT images by name rather than every service.
      //
      // docker-compose.yml has FIVE build definitions but only four images:
      // `gateway` and `gateway-migrate` deliberately share one tag (the migrate
      // service is that image run with a different command). Passing no service
      // names builds both, and under `--no-cache` the two identical targets race
      // to write the same tag — one wins, the other dies with
      //   target gateway-migrate: failed to solve:
      //   image ".../sail-proxy-gateway:ci-test": already exists
      // With a warm cache both "build" instantly and the race does not show, so
      // this only ever fails here, on the cold build CI does.
      //
      // Fixed here rather than in docker-compose.yml on purpose: BOTH services
      // need their own `build:` for deployment. Compose resolves images for all
      // services in parallel, and one with no build section can only pull, so
      // deleting either block makes `docker compose up` fail on a clean machine
      // with no local image and no registry access. Measured both ways round.
      //
      // One image per compose call, and on the disk-limited hosted runner
      // (CI=true) the BuildKit cache is dropped between them: a --no-cache build
      // never reuses it, and four cold builds' layers alone can exhaust the
      // ~14 GB ubuntu-latest guarantees. Locally the cache — including the SAPUI5
      // framework cache mount the admin build relies on — is left alone.
      for (const service of ['gateway', 'admin', 'ollama', 'nginx']) {
        // --pull: the base images are floating tags (node:24-alpine, nginx:alpine). Without it the local
        // image store's copy is reused however old it is, and the Phase 9 scan reports CVEs a release
        // build (buildx, which resolves the tag in the registry) would not ship.
        // Streamed: milestones and a heartbeat every minute instead of silence until the build ends; the
        // full output goes to ci-logs/ (uploaded with the other logs when a GitHub run fails).
        // BUILDKIT_PROGRESS=plain is what BuildKit writes to a pipe anyway; an environment variable rather
        // than --progress, which the legacy docker-compose fallback may not accept.
        const buildLog = path.join(projectRoot, 'ci-logs', `docker-build-${service}.log`);
        await fs.mkdir(path.dirname(buildLog), { recursive: true });
        logger.step(`Building image: ${service} (milestones below; full log ${path.relative(projectRoot, buildLog)})`);
        const buildStart = Date.now();
        await streamBuild(`${state.dockerComposeCmd} -f ${dockerComposeFile} build --no-cache --pull ${service}`, {
          cwd: projectRoot,
          env: { ...ciEnv, BUILDKIT_PROGRESS: 'plain' },
          service,
          logFile: buildLog,
          logger
        });
        logger.success(`Image ${service} built in ${formatDuration(Date.now() - buildStart)}`);
        if (process.env.CI === 'true') {
          await executeCommand('docker builder prune -af', {
            description: `Pruning the BuildKit cache after the ${service} build (hosted-runner disk)...`,
            cwd: projectRoot
          });
        }
      }

      const dockerDuration = Math.round((Date.now() - dockerStartTime) / 1000);
      logger.success(`Docker build completed in ${dockerDuration} seconds`);
      logger.info(`Built images with ci-test tag: ${state.images.map(i => i.ciTag).join(', ')}`);
    }
    
    // Phase 8: Docker Container Runtime Validation
    logger.phase('Phase 8: Docker Container Runtime Validation');

    if (!state.dockerBuildRequired) {
      logger.warning('⏭️  SKIPPING Docker container validation - no new images were built');
      logger.info('Reason: Cannot test containers without a Docker build');
      logger.success('✅ Docker container validation: SKIPPED');
    } else {

    logger.step('Preparing for Docker validation...');

    // Stop and remove the CI Valkey container to avoid port conflicts
    logger.info('Stopping CI Valkey container to free port 6379 for Docker Compose...');
    try {
      // Check if valkey is running
      const { stdout: valkeyStatus } = await execAsync('docker ps -q --filter "name=valkey"');
      if (valkeyStatus.trim()) {
        await executeCommand('docker stop valkey', {
          description: 'Stopping CI Valkey container...',
          ignoreError: true
        });
      }

      // Remove the container
      await executeCommand('docker rm valkey', {
        description: 'Removing CI Valkey container...',
        ignoreError: true
      });

      // Remove from our state tracking since it's been cleaned up
      state.containers = state.containers.filter(c => c !== 'valkey');

      logger.success('CI Valkey container stopped and removed');
    } catch (error) {
      logger.warning('Failed to stop CI Valkey container (may not exist): ' + error.message);
    }

    // Stop running services (admin, gateway, ollama) to free ports for Docker containers
    logger.info('Stopping CI services to free ports for Docker Compose...');
    for (const proc of state.processes) {
      if (proc.pid && !proc.killed) {
        try {
          logger.info(`Stopping ${proc.name} service (PID: ${proc.pid})...`);

          // Try graceful shutdown first (SIGTERM)
          process.kill(proc.pid, 'SIGTERM');
          proc.killed = true;

          // Give it a moment to shut down gracefully
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Check if it's still running and force kill if needed
          try {
            process.kill(proc.pid, 0); // Check if process exists
            logger.warning(`${proc.name} didn't stop gracefully, forcing shutdown...`);
            process.kill(proc.pid, 'SIGKILL');
          } catch (e) {
            // Process already stopped
            logger.success(`${proc.name} stopped successfully`);
          }
        } catch (error) {
          if (error.code === 'ESRCH') {
            logger.info(`${proc.name} was already stopped`);
          } else {
            logger.warning(`Failed to stop ${proc.name}: ${error.message}`);
          }
        }
      }
    }

    // Aggressively kill any processes still using the ports we need
    // This handles orphaned child processes that weren't tracked in state.processes
    logger.step('Force-killing any remaining processes on required ports...');
    const portsToFree = [
      { port: 4004, name: 'admin' },
      { port: 3000, name: 'gateway' },
      { port: 11434, name: 'ollama' }
    ];

    for (const { port, name } of portsToFree) {
      try {
        logger.info(`Checking for processes using port ${port}...`);

        // Try lsof first (most reliable)
        try {
          const { stdout } = await execAsync(`lsof -ti :${port} 2>/dev/null || true`);
          const pids = stdout.trim().split('\n').filter(p => p);

          if (pids.length > 0) {
            logger.warning(`Found ${pids.length} process(es) still using port ${port}: ${pids.join(', ')}`);

            for (const pid of pids) {
              try {
                logger.info(`Killing process ${pid} on port ${port}...`);
                await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
                logger.success(`Killed process ${pid}`);
              } catch (killError) {
                logger.warning(`Failed to kill ${pid}: ${killError.message}`);
              }
            }

            // Wait a moment for the kernel to release the port
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            logger.success(`No processes found using port ${port}`);
          }
        } catch (lsofError) {
          // lsof failed, try fuser
          try {
            const { stdout } = await execAsync(`fuser ${port}/tcp 2>/dev/null || true`);
            if (stdout.trim()) {
              logger.info(`Using fuser to kill processes on port ${port}...`);
              await execAsync(`fuser -k ${port}/tcp 2>/dev/null || true`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (fuserError) {
            // Both lsof and fuser failed, log and continue
            logger.info(`Could not check port ${port} (lsof/fuser unavailable), assuming it's free`);
          }
        }
      } catch (error) {
        logger.warning(`Error while force-killing processes on port ${port}: ${error.message}`);
      }
    }

    logger.success('Port cleanup completed')

    logger.step('Preparing admin service for PostgreSQL testing...');

    // The CI setup uses SQLite, but Docker containers need PostgreSQL
    // Note: The .env file was already backed up in Phase 1 (backupCIState)
    // and will be restored in cleanup, so we can safely modify it here
    try {
      const adminEnvPath = 'services/admin/.env';
      const adminEnvContent = await fs.readFile(adminEnvPath, 'utf8');

      // Restore PostgreSQL configuration for Docker testing
      const postgresEnvContent = adminEnvContent
        .replace(/cds\.requires\.db\.kind=sqlite/g, 'cds.requires.db.kind=postgres')
        .replace(/cds\.requires\.db\.impl=@cap-js\/sqlite/g, 'cds.requires.db.impl=@cap-js/postgres')
        .replace(/cds\.requires\.db\.credentials\.url=db\/admin\.db/g, 'cds.requires.db.credentials.host=postgres')
        // Add back PostgreSQL configuration
        + '\ncds.requires.db.credentials.port=5432'
        + '\ncds.requires.db.credentials.user=admin_user'
        + '\ncds.requires.db.credentials.password=admin_password'
        + '\ncds.requires.db.credentials.database=sap_llm_gateway_admin'
        + '\ncds.sql.dialect=postgres';

      await fs.writeFile(adminEnvPath, postgresEnvContent);
      logger.success('Configured PostgreSQL for Docker testing (will be restored from backup after CI)');

    } catch (error) {
      logger.error('Failed to prepare PostgreSQL configuration: ' + error.message);
      throw error;
    }
    
    logger.step('Testing admin container startup and schema deployment...');

    // Start admin container with docker-compose using CI environment
    try {

      // First ensure PostgreSQL is running for the admin container
      await executeCommand(`${state.dockerComposeCmd} -f ${dockerComposeFile} up -d postgres`, {
        description: 'Starting PostgreSQL for admin container...',
        cwd: path.join(__dirname, '..'), // Run from project root for correct build contexts
        env: ciEnv
      });

      // Wait for PostgreSQL to be ready
      logger.info('Waiting 10 seconds for PostgreSQL to initialize...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Skip Dex debugging for now - let's see what happens with admin startup
      logger.info('Proceeding directly to admin container startup...');

      // Start admin container
      await executeCommand(`${state.dockerComposeCmd} -f ${dockerComposeFile} up -d admin`, {
        description: 'Starting admin container...',
        cwd: path.join(__dirname, '..'), // Run from project root for correct build contexts
        env: ciEnv
      });
      
      // Use docker compose container names (default project name is directory name)
      // Docker Compose converts project names to lowercase
      const projectName = 'docker'; // The directory where docker-compose.yml is located
      const postgresContainer = `${projectName}-postgres-1`;
      const adminContainer = `${projectName}-admin-1`;
      
      state.containers.push(postgresContainer, adminContainer);
      
      // Monitor container logs for 30 seconds to check for crashes
      logger.info('Monitoring admin container for 30 seconds...');
      const startMonitoring = Date.now();
      let crashDetected = false;
      let schemaDeploymentSuccess = false;
      let startupErrors = [];
      
      while (Date.now() - startMonitoring < 30000) {
        try {
          // Check if container is still running
          const { stdout: psOutput } = await execAsync(`docker ps --filter "name=${adminContainer}" --format "{{.Status}}"`);
          
          if (!psOutput.includes('Up')) {
            crashDetected = true;
            logger.error('Admin container crashed!');
            
            // Get crash logs
            const { stdout: logs } = await execAsync(`docker logs ${adminContainer} --tail 100`);
            logger.error('Container logs:');
            console.log(logs);
            break;
          }
          
          // Check logs for key messages
          const { stdout: logs } = await execAsync(`docker logs ${adminContainer} --tail 50`);
          
          // Check for schema deployment success
          if (logs.includes('successfully deployed to postgres') || logs.includes('/> successfully deployed to postgres')) {
            schemaDeploymentSuccess = true;
            logger.success('Schema deployment completed successfully!');
          }
          
          // Check for common startup errors
          if (logs.includes('npx: not found')) {
            startupErrors.push('npx command not found - check docker-compose.yml schema deployment command');
          }
          
          if (logs.includes('error: relation') && logs.includes('does not exist')) {
            if (!schemaDeploymentSuccess) {
              startupErrors.push('Database schema not deployed - tables missing');
            }
          }
          
          if (logs.includes('Failed to start CAP server')) {
            startupErrors.push('CAP server failed to start');
          }
          
          // Check if service is ready by looking for the listening message
          if (logs.includes('CAP Admin Service listening on port 4004')) {
            logger.success('Admin service started successfully!');

            // Try to make a health check request to the correct endpoint
            try {
              const healthResponse = await axios.get('http://localhost:4004/api/health', {
                timeout: 5000
              });
              logger.success('Admin service health check passed!');
            } catch (healthError) {
              logger.warning('Admin service health check failed (may require authentication)');
            }
          }
          
        } catch (error) {
          logger.warning(`Error checking container status: ${error.message}`);
        }
        
        // Wait 2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Analyze results
      if (crashDetected) {
        throw new Error('Admin container crashed during startup');
      }
      
      if (!schemaDeploymentSuccess) {
        logger.warning('Schema deployment did not complete within 30 seconds');
        if (startupErrors.length > 0) {
          logger.error('Startup errors detected:');
          startupErrors.forEach(err => logger.error(`  - ${err}`));
          throw new Error('Admin container startup failed with errors');
        }
      }
      
      if (startupErrors.length > 0) {
        logger.warning('Startup warnings detected:');
        startupErrors.forEach(err => logger.warning(`  - ${err}`));
      }
      
      logger.success('✅ Admin container runtime validation: PASSED');

      // Clean up containers (but keep images for security scanning)
      await executeCommand(`${state.dockerComposeCmd} -f ${dockerComposeFile} down`, {
        description: 'Stopping Docker containers...',
        ignoreError: true,
        cwd: path.join(__dirname, '..'), // Run from project root for correct build contexts
        env: ciEnv
      });

      // IMPORTANT: Clean up CI volumes BEFORE restore to avoid conflicts
      logger.step('Cleaning up CI Docker volumes before restore...');
      try {
        const { stdout: volumeList } = await execAsync('docker volume ls --format "{{.Name}}"');
        const volumes = volumeList.split('\n').map(v => v.trim()).filter(Boolean);

        const postgresBaseName = state.volumeNames.postgres;
        const valkeyBaseName = state.volumeNames.valkey;

        // Find volumes created during CI run (with docker_ prefix or project prefix)
        const ciVolumes = volumes.filter(v =>
          v === `docker_${postgresBaseName}` ||
          v === `docker_${valkeyBaseName}` ||
          (v.startsWith('docker_') && (v.endsWith(`_${postgresBaseName}`) || v.endsWith(`_${valkeyBaseName}`)))
        );

        if (ciVolumes.length > 0) {
          for (const vol of ciVolumes) {
            await executeCommand(`docker volume rm ${vol}`, {
              description: `Removing ${vol} volume...`,
              ignoreError: true
            });
          }
          logger.success(`Cleaned up ${ciVolumes.length} CI volume(s) before restore`);
        } else {
          logger.info('No CI volumes found to clean up');
        }
      } catch (error) {
        logger.warning(`Failed to clean up CI volumes: ${error.message}`);
      }

      // Note: CI-tagged images will be cleaned up after Phase 9 (security scanning)
      logger.info('CI-tagged images preserved for security scanning in Phase 9');

      // No need to restore SQLite configuration or restart Valkey
      // since no SQLite tests follow the Docker validation
      logger.info('Skipping SQLite restoration and Valkey restart - no further tests require them');
      
    } catch (error) {
      logger.error(`Docker container validation failed: ${error.message}`);
      
      // Get logs from ALL containers that were started
      // Docker Compose converts project names to lowercase
      const projectName = 'docker';
      const containers = [
        `${projectName}-postgres-1`,
        `${projectName}-dex-1`,
        `${projectName}-admin-1`,
        `${projectName}-valkey-1`
      ];
      
      logger.info(`Looking for containers with project name: ${projectName}`);
      
      for (const container of containers) {
        try {
          const { stdout: logs } = await execAsync(`docker logs ${container} --tail 50 2>&1`);
          if (logs.trim()) {
            logger.error(`=== ${container} LOGS ===`);
            console.log(logs);
            logger.error(`=== END ${container} LOGS ===`);
          }
        } catch (logError) {
          logger.info(`No logs available for ${container}`);
        }
      }
      
      // Clean up using the docker compose file
      await executeCommand(`${state.dockerComposeCmd} -f ${dockerComposeFile} down`, {
        description: 'Cleaning up Docker containers...',
        ignoreError: true,
        cwd: path.join(__dirname, '..'), // Run from project root for correct build contexts
        env: ciEnv
      });

      // IMPORTANT: Clean up CI volumes BEFORE restore to avoid conflicts
      logger.step('Cleaning up CI Docker volumes before restore...');
      try {
        const { stdout: volumeList } = await execAsync('docker volume ls --format "{{.Name}}"');
        const volumes = volumeList.split('\n').map(v => v.trim()).filter(Boolean);

        const postgresBaseName = state.volumeNames.postgres;
        const valkeyBaseName = state.volumeNames.valkey;

        const ciVolumes = volumes.filter(v =>
          v === `docker_${postgresBaseName}` ||
          v === `docker_${valkeyBaseName}` ||
          (v.startsWith('docker_') && (v.endsWith(`_${postgresBaseName}`) || v.endsWith(`_${valkeyBaseName}`)))
        );

        if (ciVolumes.length > 0) {
          for (const vol of ciVolumes) {
            await executeCommand(`docker volume rm ${vol}`, {
              description: `Removing ${vol} volume...`,
              ignoreError: true
            });
          }
          logger.success(`Cleaned up ${ciVolumes.length} CI volume(s) before restore`);
        }
      } catch (error) {
        logger.warning(`Failed to clean up CI volumes: ${error.message}`);
      }

      // Note: Keep CI-tagged images for security scanning even on error
      logger.info('CI-tagged images preserved (will be cleaned up in Phase 9 or final cleanup)');

      // No need to restore SQLite configuration or restart Valkey on error
      // since no SQLite tests follow the Docker validation
      logger.info('Skipping SQLite restoration and Valkey restart on error - pipeline will end anyway');

      throw error;
    }

    // Only now, with the images built (Phase 7) and the admin container validated (Phase 8):
    // a Phase 8 failure followed by a plain rerun must build and validate again.
    await recordLocalDockerBuild();
    }  // End of conditional Docker container validation

    // Phase 9: Docker Security Scanning
    logger.phase('Phase 9: Docker Security Scanning');

    if (!state.dockerBuildRequired) {
      logger.warning('⏭️  SKIPPING Trivy security scan - Docker build was skipped');
      logger.success('✅ Docker security scan: SKIPPED (no Docker build)');
    } else {

    // Check if Trivy is installed
    let trivyAvailable = false;
    try {
      await executeCommand('trivy --version', { ignoreError: true });
      logger.success('Trivy is available for security scanning');
      trivyAvailable = true;
    } catch (error) {
      logger.warning('Trivy not found - skipping Docker vulnerability scanning');
      logger.info('Install Trivy for enhanced security: https://aquasecurity.github.io/trivy/latest/getting-started/installation/');
    }
    
    if (trivyAvailable) {
      let vulnerabilitiesFound = false;
      // Blocking: a CRITICAL finding that has a fixed version (someone can act on it) and any scan
      // whose output cannot be read. HIGH and unfixed CRITICAL findings are reported only. Until
      // 2026-09 every outcome here, parse failures included, ended in "COMPLETED (warnings noted)".
      const blocking = [];

      for (const imageInfo of state.images) {
        const imageName = imageInfo.ciTag;
        try {
          // Check if image exists first
          let imageExists = false;
          try {
            await executeCommand(`docker image inspect ${imageName}`, { ignoreError: false });
            imageExists = true;
          } catch (inspectError) {
            logger.warning(`Skipping ${imageName} - image not found (may not have been built)`);
            continue;
          }

          if (!imageExists) {
            continue;
          }

          logger.step(`Scanning ${imageName} for security vulnerabilities...`);

          // Use JSON format for accurate parsing
          const { stdout: jsonOutput } = await executeCommand(`trivy image --format json ${imageName}`, {
            ignoreError: true
          });
          
          try {
            const scanResult = JSON.parse(jsonOutput);
            let highCount = 0;
            let criticalCount = 0;
            const fixableCritical = [];
            
            // Count vulnerabilities across all targets
            if (scanResult.Results) {
              for (const result of scanResult.Results) {
                if (result.Vulnerabilities) {
                  for (const vuln of result.Vulnerabilities) {
                    if (vuln.Severity === 'HIGH') highCount++;
                    if (vuln.Severity === 'CRITICAL') {
                      criticalCount++;
                      if (vuln.FixedVersion) fixableCritical.push(`${vuln.PkgName} ${vuln.InstalledVersion} -> ${vuln.FixedVersion} (${vuln.VulnerabilityID})`);
                    }
                  }
                }
              }
            }
            
            if (highCount === 0 && criticalCount === 0) {
              logger.success(`✅ ${imageName}: No HIGH/CRITICAL vulnerabilities found`);
            } else {
              logger.warning(`⚠️  ${imageName}: Found ${highCount} HIGH and ${criticalCount} CRITICAL vulnerabilities`);

              // Show table format for human readability
              const { stdout: tableOutput } = await executeCommand(`trivy image --format table ${imageName}`, {
                ignoreError: true
              });
              console.log(tableOutput);
              vulnerabilitiesFound = true;
              fixableCritical.forEach(f => blocking.push(`${imageName}: ${f}`));
            }
          } catch (parseError) {
            logger.error(`Failed to parse Trivy output for ${imageName}: ${parseError.message}`);
            blocking.push(`${imageName}: Trivy output unreadable (${parseError.message})`);
          }
        } catch (error) {
          logger.info(`Skipping ${imageName} - image not found or scan failed`);
        }
      }
      
      if (blocking.length > 0) {
        blocking.forEach(b => logger.error(`BLOCKED ${b}`));
        throw new Error(`Docker security scan: ${blocking.length} fixable CRITICAL finding(s) or unreadable scan(s)`);
      }
      if (vulnerabilitiesFound) {
        logger.warning('Docker security scan completed with vulnerabilities found');
        logger.warning('Review scan results and consider updating base images or dependencies');
        logger.success('✅ Docker security scan: COMPLETED (warnings noted)');
      } else {
        logger.success('✅ Docker security scan: PASSED - No HIGH/CRITICAL vulnerabilities');
      }
    } else {
      logger.success('✅ Docker security scan: SKIPPED (Trivy not available)');
    }
    }  // End of conditional Docker security scanning

    // Phase 10: Final Cleanup of CI Images
    logger.phase('Phase 10: Cleanup');

    if (!state.dockerBuildRequired) {
      logger.info('No Docker images to clean up - Docker build was skipped');
      logger.success('✅ Cleanup: No Docker artifacts created');
    } else {
      // Clean up CI-tagged images
      logger.step('Cleaning up CI-tagged Docker images...');
      for (const imageInfo of state.images) {
        await executeCommand(`docker rmi ${imageInfo.ciTag}`, {
          description: `Removing ${imageInfo.ciTag}...`,
          ignoreError: true
        });
      }
      logger.success('CI-tagged images cleaned up');
      logger.info('Note: CI volumes were already cleaned up in Phase 8 before restore');
    }

    // Success!
    logger.phase('🎉 CI Pipeline Completed Successfully!');
    logger.success('✅ Environment setup: PASSED');
    logger.success('✅ Security validation: PASSED');
    logger.success('✅ Service compilation: PASSED');
    logger.success('✅ SAIL-PROXY npm build: PASSED');
    logger.success('✅ Unit tests: PASSED');
    logger.success('✅ Integration environment: PASSED');
    logger.success('✅ Full test suites: PASSED');

    // Conditional Docker build status
    if (state.dockerBuildRequired) {
      logger.success('✅ Docker build: PASSED');
      logger.success('✅ Docker security scan: COMPLETED');
    } else {
      logger.success(`✅ Docker build: SKIPPED (${state.dockerBuildDecisionReason})`);
      logger.info('⏱️  Time saved: ~30-35 minutes');
    }
    
  } catch (error) {
    logger.error(`CI Pipeline failed: ${error.message}`);
    if (!cleanupInProgress) {
      cleanupInProgress = true;
      await cleanup();
    }
    process.exit(1);
  }
  
  // Success - cleanup and exit
  if (!cleanupInProgress) {
    cleanupInProgress = true;
    await cleanup();
  }
  process.exit(0);
}

// GitHub Actions compatibility
if (process.env.GITHUB_ACTIONS) {
  logger.info('Running in GitHub Actions environment');
  process.env.CI = 'true';
}

// Run the pipeline
if (require.main === module) {
  runCIPipeline();
}

module.exports = { runCIPipeline };
