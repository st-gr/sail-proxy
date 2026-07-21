#!/usr/bin/env node

/**
 * Database Migration Tool for Kyma-deployed PostgreSQL
 *
 * This script provides backup, restore, and info operations for PostgreSQL databases
 * running in Kubernetes (Kyma) environments via kubectl.
 *
 * Commands:
 *   backup  - Create a backup of the PostgreSQL database
 *   restore - Restore a PostgreSQL database from a backup file
 *   reset   - Truncate all tables (delete all data, preserve schema)
 *   info    - Display database information and table statistics
 *
 * Usage:
 *   node cli-tools/kyma-db-manager.js <command> [options]
 *
 * Examples:
 *   node cli-tools/kyma-db-manager.js backup --namespace sail-proxy --output backup.sql
 *   node cli-tools/kyma-db-manager.js restore --namespace sail-proxy --input backup.sql --data-only
 *   node cli-tools/kyma-db-manager.js info --namespace sail-proxy
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Command } = require('commander');

const program = new Command();

// Read version from package.json
const packageJson = require('../package.json');
const version = packageJson.version;

// Colors for terminal output (simple, no dependencies)
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Secrets registered here are masked in ALL log output. Error messages from
// execSync include the full failed command line — which embeds PGPASSWORD —
// so without central redaction a failed kubectl/psql call echoes the database
// password to the terminal.
const secretsToRedact = new Set();

function redactSecrets(message) {
  let result = String(message);
  for (const secret of secretsToRedact) {
    if (secret) result = result.split(secret).join('***');
  }
  return result;
}

function log(message, color = colors.reset) {
  console.log(`${color}${redactSecrets(message)}${colors.reset}`);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, colors.cyan);
}

function logWarning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

/**
 * Get PostgreSQL credentials from Kubernetes secret
 * @param {string} namespace - Kubernetes namespace
 * @returns {Object} - { user, password, database }
 */
function getKubernetesCredentials(namespace) {
  logInfo(`Retrieving PostgreSQL credentials from Kubernetes secret in namespace: ${namespace}`);

  try {
    const user = execSync(
      `kubectl -n ${namespace} get secret postgres-env -o jsonpath='{.data.POSTGRES_USER}'`,
      { encoding: 'utf8' }
    );

    const password = execSync(
      `kubectl -n ${namespace} get secret postgres-env -o jsonpath='{.data.POSTGRES_PASSWORD}'`,
      { encoding: 'utf8' }
    );

    const database = execSync(
      `kubectl -n ${namespace} get secret postgres-env -o jsonpath='{.data.POSTGRES_DB}'`,
      { encoding: 'utf8' }
    );

    // Base64 decode
    const credentials = {
      user: Buffer.from(user, 'base64').toString('utf8').trim(),
      password: Buffer.from(password, 'base64').toString('utf8').trim(),
      database: Buffer.from(database, 'base64').toString('utf8').trim(),
    };

    if (!credentials.user || !credentials.password || !credentials.database) {
      throw new Error('Failed to retrieve valid credentials from secret');
    }

    // Mask the password in every subsequent log line (incl. echoed commands)
    secretsToRedact.add(credentials.password);

    logSuccess('Credentials retrieved successfully');
    return credentials;
  } catch (error) {
    logError(`Failed to retrieve credentials: ${error.message}`);
    logInfo('Make sure kubectl is configured and you have access to the namespace');
    process.exit(1);
  }
}

/**
 * Get current replica count for a deployment
 * @param {string} namespace - Kubernetes namespace
 * @param {string} deployment - Deployment name
 * @returns {number} - Current replica count
 */
function getReplicaCount(namespace, deployment) {
  try {
    const result = execSync(
      `kubectl -n ${namespace} get deployment ${deployment} -o jsonpath='{.spec.replicas}'`,
      { encoding: 'utf8' }
    );
    const count = parseInt(result.replace(/['"]/g, '').trim(), 10);
    return isNaN(count) ? 0 : count;
  } catch (error) {
    logWarning(`Could not get replica count for ${deployment}: ${error.message}`);
    return 0;
  }
}

/**
 * Scale deployment to specified replica count
 * @param {string} namespace - Kubernetes namespace
 * @param {string} deployment - Deployment name
 * @param {number} replicas - Target replica count
 */
function scaleDeployment(namespace, deployment, replicas) {
  try {
    execSync(
      `kubectl -n ${namespace} scale deployment ${deployment} --replicas=${replicas}`,
      { encoding: 'utf8' }
    );
    logSuccess(`Scaled ${deployment} to ${replicas} replicas`);
  } catch (error) {
    logError(`Failed to scale ${deployment}: ${error.message}`);
    throw error;
  }
}

/**
 * Wait for deployment to have desired number of ready replicas
 * @param {string} namespace - Kubernetes namespace
 * @param {string} deployment - Deployment name
 * @param {number} replicas - Expected replica count
 * @param {number} timeoutSeconds - Timeout in seconds (default 300s to match deploy-kyma.js)
 */
function waitForDeployment(namespace, deployment, replicas, timeoutSeconds = 300) {
  if (replicas === 0) {
    // Wait for all pods to terminate
    logInfo(`Waiting for ${deployment} pods to terminate...`);
    try {
      execSync(
        `kubectl -n ${namespace} wait --for=delete pod -l app=${deployment} --timeout=${timeoutSeconds}s`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      logSuccess(`${deployment} pods terminated`);
    } catch (error) {
      // Ignore timeout errors if no pods exist
      logInfo(`${deployment} pods terminated`);
    }
  } else {
    // Wait for deployment rollout to complete (matches deploy-kyma.js pattern)
    logInfo(`Waiting for ${deployment} to be ready (${replicas} replicas)...`);
    try {
      execSync(
        `kubectl -n ${namespace} rollout status deployment/${deployment} --timeout=${timeoutSeconds}s`,
        { encoding: 'utf8' }
      );
      logSuccess(`${deployment} is ready`);
    } catch (error) {
      logWarning(`Timeout waiting for ${deployment}: ${error.message}`);
    }
  }
}

/**
 * Pause deployments (scale to 0) and return original replica counts
 * @param {string} namespace - Kubernetes namespace
 * @returns {Object} - Map of deployment names to original replica counts
 */
function pauseDeployments(namespace) {
  logInfo('Pausing gateway and admin deployments...');

  const deployments = ['gateway', 'admin'];
  const originalCounts = {};

  for (const deployment of deployments) {
    const originalCount = getReplicaCount(namespace, deployment);
    originalCounts[deployment] = originalCount;

    if (originalCount > 0) {
      logInfo(`${deployment}: ${originalCount} replicas → 0 replicas`);
      scaleDeployment(namespace, deployment, 0);
      waitForDeployment(namespace, deployment, 0, 60);
    } else {
      logInfo(`${deployment}: already scaled to 0`);
    }
  }

  logSuccess('Deployments paused successfully');
  return originalCounts;
}

/**
 * Resume deployments (restore original replica counts)
 * Follows the same deployment order as deploy-kyma.js: admin → gateway
 * @param {string} namespace - Kubernetes namespace
 * @param {Object} originalCounts - Map of deployment names to original replica counts
 */
function resumeDeployments(namespace, originalCounts) {
  logInfo('Resuming deployments to original state...');

  // Deploy in correct order: admin first, then gateway (matches deploy-kyma.js sequence)
  const deploymentOrder = ['admin', 'gateway'];

  for (const deployment of deploymentOrder) {
    const originalCount = originalCounts[deployment];

    if (originalCount === undefined) {
      continue; // Skip if this deployment wasn't paused
    }

    if (originalCount > 0) {
      logInfo(`${deployment}: 0 replicas → ${originalCount} replicas`);
      scaleDeployment(namespace, deployment, originalCount);
      waitForDeployment(namespace, deployment, originalCount); // Uses default 300s timeout
    } else {
      logInfo(`${deployment}: keeping at 0 replicas (original state)`);
    }
  }

  logSuccess('Deployments resumed successfully');
}

/**
 * Verify PostgreSQL pod is running
 * @param {string} namespace - Kubernetes namespace
 */
function verifyPodRunning(namespace) {
  try {
    const result = execSync(
      `kubectl -n ${namespace} get pod postgres-0 -o jsonpath='{.status.phase}'`,
      { encoding: 'utf8' }
    );

    // Remove quotes if present and trim
    const status = result.replace(/['"]/g, '').trim();

    if (status !== 'Running') {
      throw new Error(`Pod postgres-0 is not running (status: ${status})`);
    }

    logSuccess('PostgreSQL pod is running');
  } catch (error) {
    logError(`Failed to verify pod status: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Prompt user for confirmation
 * @param {string} message - Confirmation message
 * @returns {Promise<boolean>} - True if confirmed
 */
function promptConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${colors.yellow}${message} (yes/no): ${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Execute pg_dump to create a backup
 * @param {string} namespace - Kubernetes namespace
 * @param {Object} credentials - Database credentials
 * @param {Object} options - Backup options
 */
async function executePgDump(namespace, credentials, options) {
  const { output, dataOnly, schemaOnly, excludeTable, compress, pauseDeployments: shouldPause, yes } = options;

  let originalCounts = null;

  // Show downtime warning if deployments will be paused
  if (shouldPause) {
    logWarning('⚠️  ⚠️  SERVICE DOWNTIME WARNING ⚠️  ⚠️');
    console.log(`${colors.yellow}This operation will pause the gateway and admin services.${colors.reset}`);
    console.log(`${colors.yellow}Your API endpoints will be UNAVAILABLE during database backup.${colors.reset}`);
    console.log(`${colors.yellow}Expected downtime: 1-5 minutes depending on database size.${colors.reset}\n`);

    if (!yes) {
      const downtimeConfirmed = await promptConfirmation('Proceed with service downtime?');
      if (!downtimeConfirmed) {
        logWarning('Backup cancelled by user');
        process.exit(0);
      }
    } else {
      logInfo('Auto-confirmed: Proceeding with service downtime (--yes flag)');
    }

    originalCounts = pauseDeployments(namespace);
  }

  logInfo('Starting database backup...');

  // Build pg_dump command
  let pgDumpCmd = `pg_dump -U ${credentials.user} -d ${credentials.database} --no-password`;

  if (dataOnly) {
    pgDumpCmd += ' --data-only';
  }

  if (schemaOnly) {
    pgDumpCmd += ' --schema-only';
  }

  if (excludeTable) {
    const tables = excludeTable.split(',');
    tables.forEach(table => {
      pgDumpCmd += ` --exclude-table=${table.trim()}`;
    });
  }

  // Always add --clean and --if-exists for safer restores
  if (!dataOnly) {
    pgDumpCmd += ' --clean --if-exists';
  }

  try {
    // Set PGPASSWORD environment variable for kubectl exec
    const kubectlCmd = `kubectl -n ${namespace} exec -i postgres-0 -- sh -c "PGPASSWORD='${credentials.password}' ${pgDumpCmd}"`;

    logInfo(`Executing: pg_dump (via kubectl)`);

    const backupData = execSync(kubectlCmd, {
      encoding: 'utf8',
      maxBuffer: 500 * 1024 * 1024 // 500MB buffer for large databases
    });

    // Write to file
    const outputPath = path.resolve(output);
    fs.writeFileSync(outputPath, backupData, 'utf8');

    const stats = fs.statSync(outputPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    logSuccess(`Backup completed: ${outputPath} (${sizeMB} MB)`);

    // Optionally compress
    if (compress) {
      logInfo('Compressing backup...');
      const compressedPath = `${outputPath}.tar.gz`;

      try {
        // Use tar with gzip compression (cross-platform: Windows 10+, Linux, macOS)
        execSync(`tar -czf "${compressedPath}" -C "${path.dirname(outputPath)}" "${path.basename(outputPath)}"`, {
          encoding: 'utf8'
        });

        // Remove original uncompressed file
        fs.unlinkSync(outputPath);

        const compressedStats = fs.statSync(compressedPath);
        const compressedSizeMB = (compressedStats.size / (1024 * 1024)).toFixed(2);

        logSuccess(`Compressed backup: ${compressedPath} (${compressedSizeMB} MB)`);
      } catch (error) {
        logWarning(`Compression failed: ${error.message}`);
        logInfo(`Backup saved uncompressed: ${outputPath}`);
      }
    }

  } catch (error) {
    logError(`Backup failed: ${error.message}`);

    // Resume deployments if they were paused
    if (originalCounts) {
      try {
        resumeDeployments(namespace, originalCounts);
      } catch (resumeError) {
        logError(`Failed to resume deployments: ${resumeError.message}`);
      }
    }

    process.exit(1);
  } finally {
    // Resume deployments if they were paused
    if (originalCounts) {
      try {
        resumeDeployments(namespace, originalCounts);
      } catch (resumeError) {
        logError(`Failed to resume deployments: ${resumeError.message}`);
      }
    }
  }
}

/**
 * Truncate all data tables while preserving schema
 * @param {string} namespace - Kubernetes namespace
 * @param {Object} credentials - Database credentials
 * @param {Array<string>} excludeTables - Tables to exclude from truncation (optional)
 */
function truncateAllTables(namespace, credentials, excludeTables = []) {
  logInfo('Truncating all data tables...');

  try {
    // Get list of all user tables (excluding system tables)
    const listTablesQuery = "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;";
    const listCmd = `kubectl -n ${namespace} exec postgres-0 -- env PGPASSWORD=${credentials.password} psql -U ${credentials.user} -d ${credentials.database} -t -A -c "${listTablesQuery}"`;

    const tableList = execSync(listCmd, { encoding: 'utf8' });
    let tables = tableList.split('\n').filter(t => t.trim() !== '');

    // Exclude specified tables
    if (excludeTables.length > 0) {
      const originalCount = tables.length;
      tables = tables.filter(t => !excludeTables.includes(t));
      const excludedCount = originalCount - tables.length;
      if (excludedCount > 0) {
        logInfo(`Excluding ${excludedCount} table(s) from truncate: ${excludeTables.join(', ')}`);
      }
    }

    if (tables.length === 0) {
      logWarning('No tables found to truncate');
      return;
    }

    logInfo(`Found ${tables.length} tables to truncate`);

    // Truncate all tables with CASCADE to handle foreign key constraints
    const truncateQuery = `TRUNCATE TABLE ${tables.join(', ')} CASCADE;`;
    const truncateCmd = `kubectl -n ${namespace} exec postgres-0 -- env PGPASSWORD=${credentials.password} psql -U ${credentials.user} -d ${credentials.database} -c "${truncateQuery}"`;

    execSync(truncateCmd, { encoding: 'utf8' });

    logSuccess(`Successfully truncated ${tables.length} tables`);

  } catch (error) {
    logError(`Failed to truncate tables: ${error.message}`);
    throw error;
  }
}

/**
 * Execute database reset (truncate all tables)
 * @param {string} namespace - Kubernetes namespace
 * @param {Object} credentials - Database credentials
 * @param {Object} options - Reset options
 */
async function executeReset(namespace, credentials, options) {
  const { pauseDeployments: shouldPause, yes } = options;
  let originalCounts = null;

  try {
    // Show downtime warning if deployments will be paused
    if (shouldPause) {
      logWarning('⚠️  ⚠️  SERVICE DOWNTIME WARNING ⚠️  ⚠️');
      console.log(`${colors.yellow}This operation will pause the gateway and admin services.${colors.reset}`);
      console.log(`${colors.yellow}Your API endpoints will be UNAVAILABLE during database reset.${colors.reset}`);
      console.log(`${colors.yellow}Expected downtime: Less than 1 minute.${colors.reset}\n`);

      if (!yes) {
        const downtimeConfirmed = await promptConfirmation('Proceed with service downtime?');
        if (!downtimeConfirmed) {
          logWarning('Reset cancelled by user');
          process.exit(0);
        }
      } else {
        logInfo('Auto-confirmed: Proceeding with service downtime (--yes flag)');
      }
    }

    // Confirm destructive operation
    logWarning('⚠️  ⚠️  DATA DELETION WARNING ⚠️  ⚠️');
    console.log(`${colors.yellow}This will DELETE ALL DATA from all tables in the database.${colors.reset}`);
    console.log(`${colors.yellow}The schema (table structure) will be preserved.${colors.reset}`);
    console.log(`${colors.yellow}This action cannot be undone without a backup.${colors.reset}\n`);

    if (!yes) {
      const confirmed = await promptConfirmation('Proceed with deleting all data?');
      if (!confirmed) {
        logWarning('Reset cancelled by user');
        process.exit(0);
      }
    } else {
      logInfo('Auto-confirmed: Proceeding with data deletion (--yes flag)');
    }

    // Pause deployments if requested
    if (shouldPause) {
      originalCounts = pauseDeployments(namespace);
    }

    // Execute truncate
    logInfo('Starting database reset...');
    truncateAllTables(namespace, credentials);
    logSuccess('Database reset completed - all tables truncated');

  } catch (error) {
    logError(`Reset failed: ${error.message}`);
    process.exit(1);
  } finally {
    // Resume deployments if they were paused
    if (originalCounts) {
      try {
        resumeDeployments(namespace, originalCounts);
      } catch (resumeError) {
        logError(`Failed to resume deployments: ${resumeError.message}`);
      }
    }
  }
}

/**
 * Execute psql to restore a backup
 * @param {string} namespace - Kubernetes namespace
 * @param {Object} credentials - Database credentials
 * @param {Object} options - Restore options
 */
async function executePsql(namespace, credentials, options) {
  const { input, dataOnly, clean, ifExists, dryRun, truncateFirst, pauseDeployments: shouldPause, yes } = options;
  // Commander stores `--no-X` flags as `options.x` (camelCase, default true,
  // false when the flag is passed) — reading `options.noX` silently made the
  // flag a no-op. NOTE: the negated option must NOT be given an explicit
  // `false` default, or the un-passed default itself becomes false.
  const noAutoBackup = options.autoBackup === false;

  let inputPath = path.resolve(input);
  let tempExtractedPath = null;
  let originalCounts = null;

  // Check if file exists
  if (!fs.existsSync(inputPath)) {
    logError(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // If compressed (.tar.gz), extract it first
  if (inputPath.endsWith('.tar.gz')) {
    logInfo(`Compressed backup detected: ${inputPath}`);
    logInfo('Extracting backup...');

    try {
      const extractDir = path.dirname(inputPath);
      execSync(`tar -xzf "${inputPath}" -C "${extractDir}"`, { encoding: 'utf8' });

      // Find the extracted SQL file (remove .tar.gz extension)
      const baseName = path.basename(inputPath, '.tar.gz');
      tempExtractedPath = path.join(extractDir, baseName);

      if (!fs.existsSync(tempExtractedPath)) {
        throw new Error(`Extracted file not found: ${tempExtractedPath}`);
      }

      inputPath = tempExtractedPath;
      logSuccess(`Backup extracted: ${inputPath}`);
    } catch (error) {
      logError(`Failed to extract compressed backup: ${error.message}`);
      process.exit(1);
    }
  }

  logInfo(`Restoring from: ${inputPath}`);

  // Auto-backup before restore (unless disabled)
  if (!noAutoBackup && !dryRun) {
    let createBackup = yes;
    if (!yes) {
      createBackup = await promptConfirmation('Create automatic safety backup before restore?');
    } else {
      logInfo('Auto-confirmed: Creating safety backup (--yes flag)');
    }

    if (createBackup) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const safetyBackupPath = path.join(path.dirname(inputPath), `safety-backup-${timestamp}.sql`);

      try {
        await executePgDump(namespace, credentials, {
          output: safetyBackupPath,
          dataOnly: false,
          schemaOnly: false,
          yes: true  // Skip prompts in safety backup
        });
        logSuccess(`Safety backup created: ${safetyBackupPath}`);
      } catch (error) {
        logError(`Failed to create safety backup: ${error.message}`);
        if (!yes) {
          const proceed = await promptConfirmation('Continue without safety backup?');
          if (!proceed) {
            process.exit(1);
          }
        } else {
          logWarning('Continuing without safety backup (--yes flag, backup failed)');
        }
      }
    }
  }

  // Show downtime warning if deployments will be paused
  if (shouldPause && !dryRun) {
    logWarning('⚠️  ⚠️  SERVICE DOWNTIME WARNING ⚠️  ⚠️');
    console.log(`${colors.yellow}This operation will pause the gateway and admin services.${colors.reset}`);
    console.log(`${colors.yellow}Your API endpoints will be UNAVAILABLE during database operations.${colors.reset}`);
    console.log(`${colors.yellow}Expected downtime: 1-5 minutes depending on database size.${colors.reset}\n`);

    if (!yes) {
      const downtimeConfirmed = await promptConfirmation('Proceed with service downtime?');
      if (!downtimeConfirmed) {
        logWarning('Restore cancelled by user');
        process.exit(0);
      }
    } else {
      logInfo('Auto-confirmed: Proceeding with service downtime (--yes flag)');
    }
  }

  // Confirm destructive operation first (before any changes)
  if (!dryRun) {
    const confirmMsg = clean
      ? 'This will DROP all existing database objects and restore from backup. Continue?'
      : truncateFirst
      ? 'This will TRUNCATE all tables (delete all data) and restore from backup. Continue?'
      : 'This will restore data to the database. Existing data may be overwritten. Continue?';

    if (!yes) {
      const confirmed = await promptConfirmation(confirmMsg);
      if (!confirmed) {
        logWarning('Restore cancelled by user');
        process.exit(0);
      }
    } else {
      logInfo('Auto-confirmed: Proceeding with restore operation (--yes flag)');
    }
  }

  if (dryRun) {
    logInfo('[DRY RUN] Would execute the following operations:');
    if (shouldPause) {
      logInfo(`  - Pause gateway and admin deployments`);
    }
    if (truncateFirst) {
      logInfo(`  - Truncate all tables in database: ${credentials.database}`);
    }
    logInfo(`  - Read SQL from: ${inputPath}`);
    logInfo(`  - Restore to database: ${credentials.database}`);
    logInfo(`  - Options: dataOnly=${dataOnly}, clean=${clean}, truncateFirst=${truncateFirst}`);
    if (shouldPause) {
      logInfo(`  - Resume deployments to original state`);
    }
    logSuccess('[DRY RUN] No changes made');
    return;
  }

  // Pause deployments BEFORE any database operations (truncate or restore)
  if (shouldPause) {
    originalCounts = pauseDeployments(namespace);
  }

  // Truncate tables if requested (after pausing deployments)
  if (truncateFirst) {
    logWarning('⚠️  TRUNCATE MODE: Removing all existing data from tables...');

    // When using --data-only, exclude cds_model from truncate to preserve schema metadata
    const excludeTables = (dataOnly && !options.includeCdsModel) ? ['cds_model'] : [];
    if (excludeTables.length > 0) {
      logInfo('💾 Preserving cds_model table (contains schema metadata for deployed code version)');
    }
    // When --skip-api-config is set, also preserve the api-config table from truncate
    // Note: Postgres stores CDS-generated entity names in lowercase (e.g., ApiConfigurations → apiconfigurations)
    if (options.skipApiConfig) {
      excludeTables.push('sap_llm_gateway_admin_apiconfigurations');
      logInfo('💾 Preserving sap_llm_gateway_admin_apiconfigurations table (contains active api_config.json)');
    }

    try {
      truncateAllTables(namespace, credentials, excludeTables);
    } catch (error) {
      logError('Failed to truncate tables. Aborting restore.');
      // Resume deployments before exiting
      if (originalCounts) {
        try {
          resumeDeployments(namespace, originalCounts);
        } catch (resumeError) {
          logError(`Failed to resume deployments: ${resumeError.message}`);
        }
      }
      process.exit(1);
    }
  }

  logInfo('Starting database restore...');

  // Read SQL file
  const sqlContent = fs.readFileSync(inputPath, 'utf8');

  // Auto-exclude cds_model table when using --data-only to prevent schema metadata corruption
  let filteredSqlContent = sqlContent;
  if (dataOnly && !options.includeCdsModel) {
    logWarning('⚠️  --data-only flag detected: Automatically excluding cds_model table');
    logInfo('Reason: cds_model contains CAP schema metadata that must match the deployed code version');
    logInfo('To override: use --include-cds-model flag (NOT recommended)');

    // Filter out COPY statements for cds_model table
    // Pattern matches: COPY public.cds_model ... through \.
    const cdsModelPattern = /^COPY public\.cds_model.*?^\\\.$/gms;
    const originalLength = filteredSqlContent.length;
    filteredSqlContent = filteredSqlContent.replace(cdsModelPattern, '');
    const filteredLength = filteredSqlContent.length;

    if (filteredLength < originalLength) {
      logSuccess(`✅ Excluded cds_model table data (removed ${(originalLength - filteredLength).toLocaleString()} bytes)`);
    } else {
      logWarning('⚠️  cds_model table not found in backup (this is expected if the backup is old)');
    }
  } else if (dataOnly && options.includeCdsModel) {
    logWarning('⚠️  --include-cds-model flag detected: NOT excluding cds_model table');
    logWarning('WARNING: This may cause schema deployment errors if backup is from a different version!');
  }

  // Optionally exclude the api-config table to preserve the currently active api_config.json
  if (options.skipApiConfig) {
    logWarning('⚠️  --skip-api-config flag detected: Excluding sap_llm_gateway_admin_apiconfigurations table');
    logInfo('Reason: preserves the currently active api_config.json in the running database');

    // Postgres lowercases unquoted CDS-generated identifiers, so pg_dump emits the table name in lowercase
    // without quotes (same convention as cds_model). Match both quoted and unquoted variants for safety.
    const apiConfigPattern = /^COPY public\.("?)sap_llm_gateway_admin_apiconfigurations\1.*?^\\\.$/gims;
    const beforeLength = filteredSqlContent.length;
    filteredSqlContent = filteredSqlContent.replace(apiConfigPattern, '');
    const afterLength = filteredSqlContent.length;

    if (afterLength < beforeLength) {
      logSuccess(`✅ Excluded sap_llm_gateway_admin_apiconfigurations table data (removed ${(beforeLength - afterLength).toLocaleString()} bytes)`);
    } else {
      logWarning('⚠️  sap_llm_gateway_admin_apiconfigurations table not found in backup');
    }
  }

  // Extract table names from COPY statements in SQL file (use filtered content)
  const tableNames = [];
  const copyRegex = /^COPY\s+(\S+)\s+\(/gm;
  let match;
  while ((match = copyRegex.exec(filteredSqlContent)) !== null) {
    tableNames.push(match[1]);
  }

  if (tableNames.length > 0) {
    logInfo(`Found ${tableNames.length} tables in backup file`);
  }

  // Build psql command with echo-all to show table names.
  // (No --no-owner here: that is a pg_restore/pg_dump flag — psql does not
  // recognize it and exits immediately, breaking the stdin pipe.)
  let psqlCmd = `psql -U ${credentials.user} -d ${credentials.database} --no-password --echo-errors`;

  try {
    // Execute psql via kubectl with stdin pipe
    const kubectlCmd = `kubectl -n ${namespace} exec -i postgres-0 -- sh -c "PGPASSWORD='${credentials.password}' ${psqlCmd}"`;

    logInfo(`Executing: psql (via kubectl)`);

    // Use spawn for streaming stdin
    const child = spawn('sh', ['-c', kubectlCmd], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // If psql/kubectl exits early (bad flag, auth failure, dropped exec
    // channel), writing the remaining SQL raises EPIPE on stdin. Without a
    // handler that is an unhandled 'error' event and kills the whole process
    // BEFORE the close-handler can resume paused deployments — swallow it
    // here and let the child's exit code + stderr report the real failure.
    child.stdin.on('error', (err) => {
      logWarning(`psql stdin closed early (${err.code || err.message}) — waiting for exit status...`);
    });
    child.on('error', (err) => {
      logError(`Failed to launch restore command: ${err.message}`);
    });

    // Write SQL to stdin (use filtered content if cds_model was excluded)
    child.stdin.write(filteredSqlContent);
    child.stdin.end();

    child.on('close', (code) => {
      // Cleanup temporary extracted file if it was created
      if (tempExtractedPath && fs.existsSync(tempExtractedPath)) {
        try {
          fs.unlinkSync(tempExtractedPath);
          logInfo('Cleaned up temporary extracted file');
        } catch (cleanupError) {
          logWarning(`Failed to cleanup temporary file: ${cleanupError.message}`);
        }
      }

      // Resume deployments if they were paused
      if (originalCounts) {
        try {
          resumeDeployments(namespace, originalCounts);
        } catch (resumeError) {
          logError(`Failed to resume deployments: ${resumeError.message}`);
        }
      }

      if (code === 0) {
        logSuccess('Database restore completed successfully');

        // Parse and display restore summary
        const copyLines = stdout.match(/^COPY \d+$/gm);
        if (copyLines && copyLines.length > 0) {
          const totalRows = copyLines.reduce((sum, line) => {
            const count = parseInt(line.replace('COPY ', ''));
            return sum + count;
          }, 0);

          const nonEmptyTables = copyLines.filter(line => !line.endsWith(' 0')).length;

          logInfo(`Restore Summary:`);
          console.log(`  ${colors.cyan}Total tables processed:${colors.reset} ${copyLines.length}`);
          console.log(`  ${colors.cyan}Tables with data:${colors.reset} ${nonEmptyTables}`);
          console.log(`  ${colors.cyan}Total rows restored:${colors.reset} ${totalRows.toLocaleString()}`);

          // Show individual table counts with names (COPY results)
          console.log(`\n  ${colors.cyan}Row counts by table:${colors.reset}`);
          copyLines.forEach((line, index) => {
            const count = parseInt(line.replace('COPY ', ''));
            if (count > 0) {
              const tableName = tableNames[index] || `Table ${index + 1}`;
              console.log(`    ${tableName}: ${count.toLocaleString()} rows`);
            }
          });
        }

        if (stdout && process.env.VERBOSE) {
          logInfo('Full output:');
          console.log(stdout);
        }
      } else {
        logError(`Restore failed with exit code ${code}`);
        if (stderr) {
          console.error(stderr);
        }
        process.exit(1);
      }
    });

  } catch (error) {
    logError(`Restore failed: ${error.message}`);

    // Resume deployments if they were paused
    if (originalCounts) {
      try {
        resumeDeployments(namespace, originalCounts);
      } catch (resumeError) {
        logError(`Failed to resume deployments: ${resumeError.message}`);
      }
    }

    process.exit(1);
  }
}

/**
 * Get database information and statistics
 * @param {string} namespace - Kubernetes namespace
 * @param {Object} credentials - Database credentials
 */
function getDatabaseInfo(namespace, credentials) {
  logInfo(`Fetching database information for: ${credentials.database}`);

  try {
    // Use \dt to list tables (simpler and more reliable)
    const psqlCmd = `PGPASSWORD='${credentials.password}' psql -U ${credentials.user} -d ${credentials.database} -c '\\dt'`;
    const kubectlCmd = `kubectl -n ${namespace} exec -i postgres-0 -- sh -c "${psqlCmd}"`;

    const result = execSync(kubectlCmd, { encoding: 'utf8' });

    log('\n' + colors.bright + '=== Database Information ===' + colors.reset);
    log(`${colors.cyan}Namespace:${colors.reset} ${namespace}`);
    log(`${colors.cyan}Database:${colors.reset} ${credentials.database}`);
    log(`${colors.cyan}User:${colors.reset} ${credentials.user}`);
    log(`${colors.cyan}Pod:${colors.reset} postgres-0`);
    log('\n' + colors.bright + '=== Tables ===' + colors.reset);
    console.log(result);

    // Get row counts for key tables
    logInfo('Fetching row counts for key tables...');

    // Use a simpler approach - execute multiple queries
    const tables = [
      { name: 'ApiKeys', table: 'sap_llm_gateway_admin_apikeys' },
      { name: 'ApiKeyUsage', table: 'sap_llm_gateway_admin_apikeyusage' },
      { name: 'ModelCosts', table: 'sap_llm_gateway_admin_modelcosts' },
      { name: 'AwsCredentials', table: 'sap_llm_gateway_admin_awscredentials' },
      { name: 'UserPreferences', table: 'sap_llm_gateway_admin_userpreferences' }
    ];

    log('\n' + colors.bright + '=== Row Counts (Key Tables) ===' + colors.reset);

    // Try a simpler approach - use kubectl exec without sh -c wrapper
    tables.forEach(({ name, table }) => {
      try {
        // Execute psql directly in the pod with environment variable
        const kubectlCmd = `kubectl -n ${namespace} exec postgres-0 -- env PGPASSWORD=${credentials.password} psql -U ${credentials.user} -d ${credentials.database} -t -A -c "SELECT COUNT(*) FROM ${table}"`;

        const rawCount = execSync(kubectlCmd, {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024
        });

        // Clean up output
        const count = rawCount
          .replace(/\x1b\[[0-9;]*m/g, '')
          .replace(/[\r\n]+/g, '')
          .trim();

        if (count && /^\d+$/.test(count)) {
          log(`${colors.cyan}${name.padEnd(20)}:${colors.reset} ${count} rows`);
        } else {
          log(`${colors.cyan}${name.padEnd(20)}:${colors.reset} ${colors.yellow}0 rows${colors.reset}`);
        }
      } catch (error) {
        log(`${colors.cyan}${name.padEnd(20)}:${colors.reset} ${colors.red}Error${colors.reset}`);
      }
    });

    // Get database size. The SQL sits inside sh -c "..." — its quotes must be
    // escaped or they terminate the outer double-quoted string (shell syntax error).
    const sizeQuery = `SELECT pg_size_pretty(pg_database_size('${credentials.database}')) AS database_size;`;
    const sizeCmd = `PGPASSWORD='${credentials.password}' psql -U ${credentials.user} -d ${credentials.database} -t -c \\"${sizeQuery}\\"`;
    const sizeKubectlCmd = `kubectl -n ${namespace} exec -i postgres-0 -- sh -c "${sizeCmd}"`;

    const sizeResult = execSync(sizeKubectlCmd, { encoding: 'utf8' }).trim();
    log(`${colors.bright}Total Database Size:${colors.reset} ${sizeResult}\n`);

    logSuccess('Database information retrieved successfully');

  } catch (error) {
    logError(`Failed to retrieve database info: ${error.message}`);
    process.exit(1);
  }
}

// Configure CLI commands
program
  .name('kyma-db-manager')
  .description('Database management tool for Kyma-deployed PostgreSQL')
  .version(version);

// Backup command
program
  .command('backup')
  .description('Create a backup of the PostgreSQL database')
  .requiredOption('-n, --namespace <namespace>', 'Kubernetes namespace')
  .option('-o, --output <file>', 'Output file path', `backup-${new Date().toISOString().slice(0, 10)}.sql`)
  .option('--data-only', 'Backup only data (no schema)', false)
  .option('--schema-only', 'Backup only schema (no data)', false)
  .option('--exclude-table <tables>', 'Comma-separated list of tables to exclude')
  .option('--compress', 'Compress backup with tar.gz', false)
  .option('--pause-deployments', 'Pause gateway and admin deployments during backup', false)
  .option('-y, --yes', 'Assume yes to all prompts (unattended mode)', false)
  .action(async (options) => {
    verifyPodRunning(options.namespace);
    const credentials = getKubernetesCredentials(options.namespace);
    await executePgDump(options.namespace, credentials, options);
  });

// Restore command
program
  .command('restore')
  .description('Restore a PostgreSQL database from a backup file')
  .requiredOption('-n, --namespace <namespace>', 'Kubernetes namespace')
  .requiredOption('-i, --input <file>', 'Input backup file path')
  .option('--data-only', 'Restore only data (assumes schema exists)', false)
  .option('--include-cds-model', 'Include cds_model table when using --data-only (NOT recommended)', false)
  .option('--skip-api-config', 'Skip the sap_llm_gateway_admin_apiconfigurations table (preserves current api_config.json)', false)
  .option('--clean', 'Drop existing objects before restore', false)
  .option('--if-exists', 'Use IF EXISTS for drops', false)
  .option('--no-auto-backup', 'Disable automatic safety backup')
  .option('--truncate-first', 'Truncate all tables before restore (removes data, keeps schema)', false)
  .option('--pause-deployments', 'Pause gateway and admin deployments during restore (recommended)', false)
  .option('--dry-run', 'Show what would be restored without executing', false)
  .option('-y, --yes', 'Assume yes to all prompts (unattended mode)', false)
  .action(async (options) => {
    verifyPodRunning(options.namespace);
    const credentials = getKubernetesCredentials(options.namespace);
    await executePsql(options.namespace, credentials, options);
  });

// Reset command
program
  .command('reset')
  .description('Truncate all tables (delete all data while preserving schema)')
  .requiredOption('-n, --namespace <namespace>', 'Kubernetes namespace')
  .option('--pause-deployments', 'Pause gateway and admin deployments during reset', false)
  .option('-y, --yes', 'Assume yes to all prompts (unattended mode)', false)
  .action(async (options) => {
    verifyPodRunning(options.namespace);
    const credentials = getKubernetesCredentials(options.namespace);
    await executeReset(options.namespace, credentials, options);
  });

// Info command
program
  .command('info')
  .description('Display database information and table statistics')
  .requiredOption('-n, --namespace <namespace>', 'Kubernetes namespace')
  .action((options) => {
    verifyPodRunning(options.namespace);
    const credentials = getKubernetesCredentials(options.namespace);
    getDatabaseInfo(options.namespace, credentials);
  });

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
