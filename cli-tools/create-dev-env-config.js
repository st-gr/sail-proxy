#!/usr/bin/env node

/**
 * Local Development Environment Configuration Script
 * 
 * Creates .env files for local development with SQLite database.
 * This script wraps docker/setup-docker.js and then patches the configuration
 * for local development needs (SQLite instead of PostgreSQL).
 * 
 * Usage:
 *   node cli-tools/create-dev-env-config.js
 *   node cli-tools/create-dev-env-config.js --force
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

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

async function runSetupDocker(args = []) {
  return new Promise((resolve, reject) => {
    logger.step('Running docker/setup-docker.js to create initial .env files...');
    
    const setupScript = path.join(__dirname, '..', 'docker', 'setup-docker.js');
    const nodeArgs = [setupScript, ...args];
    
    // Run setup-docker.js with the same arguments
    const setupProcess = spawn('node', nodeArgs, {
      stdio: 'inherit', // Pass through all I/O
      cwd: path.join(__dirname, '..')
    });
    
    setupProcess.on('close', (code) => {
      if (code === 0) {
        logger.success('Initial .env files created successfully');
        resolve();
      } else {
        reject(new Error(`setup-docker.js exited with code ${code}`));
      }
    });
    
    setupProcess.on('error', (error) => {
      reject(error);
    });
  });
}

async function patchAdminEnvForSQLite() {
  logger.step('Patching Admin service .env for SQLite (local development)...');
  
  const adminEnvPath = path.join(__dirname, '..', 'services', 'admin', '.env');
  
  try {
    // Check if the file exists
    await fs.access(adminEnvPath);
    
    // Read the current content
    let envContent = await fs.readFile(adminEnvPath, 'utf8');
    
    // Apply SQLite patches (same as CI pipeline)
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
    
    // Write the patched content back
    await fs.writeFile(adminEnvPath, sqliteEnvContent);
    
    logger.success('Admin service .env patched for SQLite');
    
    // Log what was changed
    logger.info('Database configuration changed:');
    logger.info('  - kind: postgres → sqlite');
    logger.info('  - impl: @cap-js/postgres → @cap-js/sqlite');
    logger.info('  - credentials: PostgreSQL connection → SQLite file (db/admin.db)');
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warning('Admin service .env file not found. You may need to run this script from the project root.');
    } else {
      throw error;
    }
  }
}

async function verifyDatabaseDirectory() {
  logger.step('Ensuring database directory exists...');
  
  const dbPath = path.join(__dirname, '..', 'services', 'admin', 'db');
  
  try {
    await fs.mkdir(dbPath, { recursive: true });
    logger.success('Database directory ready: services/admin/db/');
  } catch (error) {
    logger.error(`Failed to create database directory: ${error.message}`);
  }
}

async function showNextSteps() {
  console.log('\n' + '='.repeat(60));
  console.log(`${colors.green}${colors.bold}✅ Local Development Environment Configuration Complete!${colors.reset}`);
  console.log('='.repeat(60));
  
  console.log('\n📋 Next steps:\n');
  console.log('1. Start the services:');
  console.log(`   ${colors.cyan}pnpm run dev:all${colors.reset}      # Start both gateway and admin services`);
  console.log(`   ${colors.cyan}pnpm run dev:gateway${colors.reset}   # Start only gateway service`);
  console.log(`   ${colors.cyan}pnpm run dev:admin${colors.reset}     # Start only admin service`);
  
  console.log('\n2. Initialize the admin database (if needed):');
  console.log(`   ${colors.cyan}cd services/admin && pnpm run db:reset${colors.reset}`);
  
  console.log('\n3. Check service health:');
  console.log(`   Gateway: ${colors.cyan}http://localhost:3000/health${colors.reset}`);
  console.log(`   Admin:   ${colors.cyan}http://localhost:4004/health${colors.reset}`);
  
  console.log('\n💡 Tips:');
  console.log('   - Admin service uses SQLite database at: services/admin/db/admin.db');
  console.log('   - Use --force flag to overwrite existing .env files');
  console.log('   - Check logs in services/{service}/logs/ if issues occur\n');
}

async function main() {
  try {
    logger.phase('Local Development Environment Setup');
    
    // Get command line arguments
    const args = process.argv.slice(2);
    
    // Check for help
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`
Local Development Environment Configuration Script

This script sets up the local development environment for SAP LLM Gateway
with SQLite database (instead of PostgreSQL used in Docker deployment).

Usage:
  node cli-tools/create-dev-env-config.js [options]

Options:
  --help, -h     Show this help message
  --force, -f    Force overwrite existing .env files

What this script does:
  1. Runs docker/setup-docker.js to create initial .env files
  2. Patches admin service .env to use SQLite instead of PostgreSQL
  3. Ensures database directory exists
  4. Provides next steps for starting services

Files created/modified:
  - services/gateway/.env
  - services/admin/.env (patched for SQLite)
  - services/ollama/.env
`);
      process.exit(0);
    }
    
    // Phase 1: Run setup-docker.js
    logger.phase('Phase 1: Creating Initial Configuration');
    await runSetupDocker(args);
    
    // Phase 2: Patch for local development
    logger.phase('Phase 2: Configuring for Local Development');
    await patchAdminEnvForSQLite();
    await verifyDatabaseDirectory();
    
    // Phase 3: Show next steps
    await showNextSteps();
    
  } catch (error) {
    logger.error(`Setup failed: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}