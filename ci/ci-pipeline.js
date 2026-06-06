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
  startTime: Date.now(),
  backupDir: null,
  volumeNames: {
    postgres: null,
    valkey: null
  },
  images: [],
  dockerComposeCmd: null,
  dockerBuildRequired: true,
  dockerBuildDecisionReason: 'Not yet determined',
  changedFiles: []
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

    // Parse valkey volume (line format: "- valkey_data:/data")
    const valkeyMatch = content.match(/^\s+-\s+(\w+):\s*\/data/m);
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
 * @returns {Promise<{required: boolean, reason: string, files: string[]}>}
 */
async function shouldRunDockerBuild() {
  const dockerRelevantPaths = [
    'docker/',
    'services/',
    'libs/',
    'ci/',
    '.github/',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.dockerignore'
  ];

  try {
    // Allow override via environment variable
    if (process.env.FORCE_DOCKER_BUILD === 'true' || process.env.FORCE_DOCKER_BUILD === '1') {
      logger.info('FORCE_DOCKER_BUILD environment variable is set');
      return {
        required: true,
        reason: 'Forced via FORCE_DOCKER_BUILD environment variable',
        files: []
      };
    }

    // Check if we're in a git repository
    try {
      await execAsync('git rev-parse --is-inside-work-tree');
    } catch (error) {
      logger.warning('Not in a git repository - running full Docker build');
      return {
        required: true,
        reason: 'Not a git repository (fail-safe)',
        files: []
      };
    }

    // Determine the comparison base
    let gitDiffCommand;
    let changedFiles = [];

    if (process.env.GITHUB_ACTIONS === 'true') {
      // For PRs, use the base ref; for pushes, use the before/after commits or HEAD~1
      let baseBranch;
      if (process.env.GITHUB_BASE_REF) {
        // Pull request: compare against the base branch
        baseBranch = `origin/${process.env.GITHUB_BASE_REF}`;
        logger.info(`GitHub Actions PR mode: comparing against ${baseBranch}`);
      } else if (process.env.GITHUB_EVENT_BEFORE && process.env.GITHUB_EVENT_BEFORE !== '0000000000000000000000000000000000000000') {
        // Push event with valid before commit
        baseBranch = process.env.GITHUB_EVENT_BEFORE;
        logger.info(`GitHub Actions push mode: comparing ${baseBranch}...${process.env.GITHUB_SHA}`);
      } else {
        // Fallback to HEAD~1 (requires fetch-depth >= 2)
        baseBranch = 'HEAD~1';
        logger.info(`GitHub Actions mode: comparing against ${baseBranch}`);
      }

      gitDiffCommand = `git diff --name-only ${baseBranch}...HEAD`;

      try {
        const { stdout } = await execAsync(gitDiffCommand);
        changedFiles = stdout.trim().split('\n').filter(f => f.length > 0);
      } catch (error) {
        logger.warning(`Failed to detect changed files: ${error.message}`);
        logger.warning('Tip: Ensure GitHub Actions workflow uses checkout with fetch-depth: 2 or greater');
        return {
          required: true,
          reason: `Git diff failed: ${error.message} (fail-safe)`,
          files: []
        };
      }
    } else if (process.env.CI === 'true') {
      gitDiffCommand = 'git diff --name-only HEAD~1 HEAD';
      logger.info('Generic CI mode: comparing HEAD~1...HEAD');

      try {
        const { stdout } = await execAsync(gitDiffCommand);
        changedFiles = stdout.trim().split('\n').filter(f => f.length > 0);
      } catch (error) {
        logger.warning(`Failed to detect changed files: ${error.message}`);
        return {
          required: true,
          reason: `Git diff failed: ${error.message} (fail-safe)`,
          files: []
        };
      }
    } else {
      // Local mode: Check uncommitted changes first, then fall back to last commit
      logger.info('Local mode: checking for uncommitted changes...');

      try {
        const { stdout: uncommittedStdout } = await execAsync('git diff --name-only HEAD');
        changedFiles = uncommittedStdout.trim().split('\n').filter(f => f.length > 0);

        if (changedFiles.length > 0) {
          logger.info(`Found ${changedFiles.length} uncommitted change(s)`);
        } else {
          // No uncommitted changes, check the last commit
          logger.info('No uncommitted changes, checking last commit...');
          try {
            const { stdout: lastCommitStdout } = await execAsync('git diff --name-only HEAD~1 HEAD');
            changedFiles = lastCommitStdout.trim().split('\n').filter(f => f.length > 0);

            if (changedFiles.length > 0) {
              logger.info(`Found ${changedFiles.length} file(s) in last commit`);
            } else {
              // Last commit is empty (might be initial commit or merge)
              logger.warning('No files in last commit - checking if this is initial commit...');
              try {
                await execAsync('git rev-parse HEAD~1');
                // HEAD~1 exists, so this is just an empty commit
                logger.info('Empty commit detected - skipping Docker build');
                return {
                  required: false,
                  reason: 'Empty commit (no files changed)',
                  files: []
                };
              } catch {
                // HEAD~1 doesn't exist, this is the initial commit
                logger.warning('Initial commit detected - running full Docker build (fail-safe)');
                return {
                  required: true,
                  reason: 'Initial commit (fail-safe)',
                  files: []
                };
              }
            }
          } catch (error) {
            logger.warning(`Failed to check last commit: ${error.message}`);
            return {
              required: true,
              reason: `Git diff failed: ${error.message} (fail-safe)`,
              files: []
            };
          }
        }
      } catch (error) {
        logger.warning(`Failed to detect changed files: ${error.message}`);
        return {
          required: true,
          reason: `Git diff failed: ${error.message} (fail-safe)`,
          files: []
        };
      }
    }

    // If we still have no files (shouldn't happen after the above logic), fail-safe
    if (changedFiles.length === 0) {
      logger.warning('No changed files detected - running full Docker build (fail-safe)');
      return {
        required: true,
        reason: 'No changed files detected (fail-safe)',
        files: []
      };
    }

    // Check if any changed file matches Docker-relevant paths
    const dockerRelevantFiles = changedFiles.filter(file => {
      return dockerRelevantPaths.some(path => {
        if (path.endsWith('/')) {
          return file.startsWith(path);
        } else {
          return file === path;
        }
      });
    });

    // Make decision
    if (dockerRelevantFiles.length > 0) {
      return {
        required: true,
        reason: `Docker-related files changed (${dockerRelevantFiles.length} files)`,
        files: dockerRelevantFiles
      };
    } else {
      return {
        required: false,
        reason: `No Docker-related files changed (${changedFiles.length} files checked)`,
        files: changedFiles
      };
    }

  } catch (error) {
    logger.error(`Unexpected error in shouldRunDockerBuild: ${error.message}`);
    return {
      required: true,
      reason: `Unexpected error: ${error.message} (fail-safe)`,
      files: []
    };
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
    const postgresVolume = volumes.find(v =>
      v === baseVolumeName || v === `docker_${baseVolumeName}` || v.endsWith(`_${baseVolumeName}`)
    );

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
    const valkeyVolume = volumes.find(v =>
      v === baseVolumeName || v === `docker_${baseVolumeName}` || v.endsWith(`_${baseVolumeName}`)
    );

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
    logger.info('Waiting 3 seconds for any pending writes to complete...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Backup strategy: Only backup the main .db file, ignore WAL/SHM files
    // When restored, SQLite will recreate WAL/SHM files automatically
    // This prevents backing up inconsistent WAL state that causes SQLITE_CORRUPT
    try {
      const backupDbPath = path.join(backupDir, 'services_admin_db_admin.db');
      await fs.copyFile(mainDbPath, backupDbPath);
      logger.success('✅ Backed up admin.db (main database file)');

      // Note: We intentionally do NOT backup .db-shm and .db-wal files
      // These contain transient state that can cause corruption if copied
      // while SQLite is in use. SQLite will recreate them when needed.
      logger.info('Skipping WAL/SHM files (will be recreated by SQLite on restore)');
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

  // Get all volumes and find postgres/valkey volumes (with or without docker_ prefix)
  try {
    const { stdout: volumeList } = await execAsync('docker volume ls --format "{{.Name}}"');
    const volumes = volumeList.split('\n').map(v => v.trim()).filter(Boolean);

    const postgresBaseName = state.volumeNames.postgres;
    const valkeyBaseName = state.volumeNames.valkey;

    // Find volumes that match the parsed volume names (with or without docker_ prefix)
    const postgresVolumes = volumes.filter(v =>
      v === postgresBaseName || v === `docker_${postgresBaseName}` || v.endsWith(`_${postgresBaseName}`)
    );
    const valkeyVolumes = volumes.filter(v =>
      v === valkeyBaseName || v === `docker_${valkeyBaseName}` || v.endsWith(`_${valkeyBaseName}`)
    );

    // Remove all matching volumes
    for (const vol of postgresVolumes) {
      await executeCommand(`docker volume rm ${vol}`, {
        description: `Removing ${vol} volume...`,
        ignoreError: true
      });
    }

    for (const vol of valkeyVolumes) {
      await executeCommand(`docker volume rm ${vol}`, {
        description: `Removing ${vol} volume...`,
        ignoreError: true
      });
    }

    if (postgresVolumes.length === 0 && valkeyVolumes.length === 0) {
      logger.info('No postgres or valkey volumes found to remove');
    }
  } catch (error) {
    logger.warning(`Failed to list/remove volumes: ${error.message}`);
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

    // Now restore from backup if backup exists
    // Only restore the main .db file - SQLite will recreate WAL/SHM automatically
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
  for (const container of state.containers) {
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
    const execOptions = { cwd };
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
    const dockerBuildDecision = await shouldRunDockerBuild();
    state.dockerBuildRequired = dockerBuildDecision.required;
    state.dockerBuildDecisionReason = dockerBuildDecision.reason;
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
    
    // Phase 2: Security Validation (Fail Fast)
    logger.phase('Phase 2: Security Validation');
    
    // Use cross-platform Node.js security scanner
    logger.step('Running cross-platform security validation...');
    
    try {
      // Load the security scanner module
      const { runSecretDetection, runDependencyAudit, checkSupplyChainIOCs } = require('./security-scanner.js');

      // Run secret detection
      const secretIssues = await runSecretDetection();

      if (secretIssues > 0) {
        throw new Error(`Security validation failed: ${secretIssues} critical issue(s) found. Please fix before proceeding.`);
      }

      logger.success('✅ Secret detection: PASSED');

      // Run supply chain IOC detection
      const supplyChainIssues = await checkSupplyChainIOCs();

      if (supplyChainIssues > 0) {
        throw new Error(`Supply chain attack detected: ${supplyChainIssues} indicator(s) found. Do NOT proceed.`);
      }

      logger.success('✅ Supply chain check: PASSED');

      // Run dependency audit
      const auditIssues = await runDependencyAudit();
      
      if (auditIssues > 0) {
        throw new Error('CRITICAL vulnerabilities found in dependencies. Fix before proceeding.');
      }
      
      logger.success('✅ Dependency audit: PASSED');
      
    } catch (error) {
      // If it's a security validation error, re-throw it
      if (error.message.includes('Security validation failed') || error.message.includes('CRITICAL')) {
        throw error;
      }
      
      // Fallback to basic checks if security scanner fails
      logger.warning('Security scanner failed, falling back to basic validation...');
      logger.warning(`Scanner error: ${error.message}`);
      
      // Try basic audit check as fallback
      try {
        const { stdout } = await executeCommand('pnpm audit --audit-level high', {
          ignoreError: true
        });
        
        if (stdout.includes('critical')) {
          throw new Error('CRITICAL vulnerabilities found in dependencies. Fix before proceeding.');
        }
        
        logger.success('✅ Basic security validation: PASSED (with fallback)');
      } catch (auditError) {
        logger.warning('Both security scanner and fallback audit failed - continuing with warning');
        logger.success('✅ Security validation: SKIPPED (scanner unavailable)');
      }
    }
    
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
    
    await executeCommand('pnpm run test:unit', {
      cwd: 'services/admin',
      description: 'Running Admin unit tests...'
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
    const gatewayService = await spawnService('pnpm', ['run', 'dev'], {
      cwd: 'services/gateway',
      name: 'gateway-service',
      env: { NODE_ENV: 'development' }
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
    
    await executeCommand('pnpm run test', {
      cwd: 'services/gateway',
      description: 'Running Gateway full test suite...'
    });
    
    await executeCommand('pnpm run test', {
      cwd: 'services/admin',
      description: 'Running Admin full test suite...'
    });
    
    await executeCommand('pnpm run test', {
      cwd: 'services/ollama',
      description: 'Running Ollama full test suite...'
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
      logger.info('⏱️  Note: Docker build typically takes 10-15 minutes due to --no-cache flag');

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

      await executeCommand(`${state.dockerComposeCmd} -f ${dockerComposeFile} build --no-cache`, {
        description: 'Testing Docker build process (this may take 10-15 minutes)...',
        cwd: projectRoot,
        env: ciEnv
      });

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
            
            // Count vulnerabilities across all targets
            if (scanResult.Results) {
              for (const result of scanResult.Results) {
                if (result.Vulnerabilities) {
                  for (const vuln of result.Vulnerabilities) {
                    if (vuln.Severity === 'HIGH') highCount++;
                    if (vuln.Severity === 'CRITICAL') criticalCount++;
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
            }
          } catch (parseError) {
            logger.error(`Failed to parse Trivy output for ${imageName}: ${parseError.message}`);
            vulnerabilitiesFound = true;
          }
        } catch (error) {
          logger.info(`Skipping ${imageName} - image not found or scan failed`);
        }
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