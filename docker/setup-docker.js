#!/usr/bin/env node

/**
 * SAIL-PROXY Docker Deployment Setup Script
 * 
 * Copies template files and configures them based on deployment type
 * (development vs production). Follows the pattern established in dex-oauth2/setup.js
 * 
 * Usage (from docker directory): 
 *   node setup-docker.js
 *   npx -p inquirer@8.2.6 node setup-docker.js  (if inquirer not installed)
 *   npx -y -p inquirer@8.2.6 node setup-docker.js  (auto-confirm download)
 * 
 * Or from project root:
 *   node docker/setup-docker.js
 *   npx -y -p inquirer@8.2.6 node docker/setup-docker.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { PromptSession } = require('./setup-flow/session');
const { askKeyRegeneration, askSecret, keysForProviderChange, mask } = require('./setup-flow/secrets');
const { INSTALL_KEY, askPluginInstall, pluginInstallToWrite, pluginInstallFromEnv, applyPluginInstallToEnvText } = require('./setup-flow/pluginInstall');
const { BILLING_KEYS, askBilling, billingToWrite, billingFromEnv, applyBillingToEnvText, isValidBillingValue } = require('./setup-flow/billing');
const { readDockerConfigValues, isExternalLdap, usesImageRegistry, githubTeam } = require('./setup-flow/docker-config');
/** First line of the local-build docker-compose.override.yml this script writes. */
const LOCAL_BUILD_OVERRIDE_HEADER = '# Docker Compose Override - Local Build Mode';
/** First line of the LDAP provider's docker-compose.override.yml (configs/providers/ldap). */
const LDAP_OVERRIDE_HEADER = '# Docker Compose override for LDAP provider';

/**
 * Whether docker-compose.override.yml is one this script wrote (local build or local LDAP). Only
 * those are removed or replaced: an override of the admin's own (ports, volumes, limits) is theirs,
 * and an upgrade, which runs this script, must not lose it.
 */
function isSetupOverride(file) {
  const first = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0].trim();
  return first === LOCAL_BUILD_OVERRIDE_HEADER || first === LDAP_OVERRIDE_HEADER;
}

/** Before setup writes its own override: an admin's file is renamed aside, never overwritten. */
function setAsideForeignOverride(file) {
  if (!fs.existsSync(file) || isSetupOverride(file)) return;
  const aside = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(file, aside);
  console.log(`ℹ️  Your docker-compose.override.yml was moved to ${path.basename(aside)}; merge what you need into the new one`);
}
const { recordDockerAnswers, writeInstallRecord } = require('./setup-flow/install-record');

// VALIDATION_TOKEN_SECRET values anyone can know: the built-in default and the .env.sample
// placeholder. The admin and gateway refuse both outside development, so an existing .env holding
// one is treated as unset. Mirrors REJECTED_VALIDATION_TOKEN_SECRETS in
// libs/aws-token-validation/validation-token-secrets.ts (TypeScript, which this plain-node script
// cannot load); services/gateway/test/setup-docker-validation-secret.test.ts pins them equal.
const PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS = [
  'dev-secret-change-in-production',
  'generate-a-secure-64-character-hex-string'
];

// Generated values a re-run keeps from the current configuration unless the user regenerates them
// (the gateway's shared secrets and the admin's credential keys are carried over separately).
const KEPT_GENERATED_SECRETS = [
  'AWS_SECRET_ENCRYPTION_KEY',
  'FILE_SEARCH_RUNTIME_PASSWORD',
  'OAUTH2_PROXY_CLIENT_SECRET',
  'OAUTH2_PROXY_COOKIE_SECRET'
];

function validateDatabaseUsername(input) {
  if (!input || input.trim().length === 0) {
    return 'Database username is required';
  }
  // PostgreSQL identifier rules
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(input)) {
    return 'Username must start with a letter or underscore, followed by letters, numbers, underscores, or dollar signs';
  }
  // PostgreSQL restriction: role names cannot start with "pg_"
  if (input.toLowerCase().startsWith('pg_')) {
    return 'Username cannot start with "pg_" (reserved for PostgreSQL system roles)';
  }
  // Length limit (PostgreSQL NAMEDATALEN = 63 bytes)
  if (input.length > 63) {
    return 'Username cannot exceed 63 characters';
  }
  return true;
}

function validateDatabasePassword(input) {
  if (!input || input.trim() === '' || input.trim().length >= 8) return true;
  return 'Password must be at least 8 characters long';
}

function validateBaseUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return 'URL is required';
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'Please enter a valid URL starting with http:// or https://';
  }
  return true;
}

function validateRequired(message) {
  return (input) => (String(input).trim() ? true : message);
}

// Check for help/version flags BEFORE loading inquirer
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
  console.log(`
SAIL-PROXY Docker Deployment Setup Script

This script helps you configure the SAP LLM Gateway for Docker deployment.

Usage:
  node setup-docker.js [options]

Options:
  --help, -h     Show this help message
  --version, -v  Show version information
  --force, -f    Force overwrite existing .env files
  --ci           CI/CD mode - use default options (local auth, no backup, localhost)
  --config JSON  Pass complete configuration as JSON (overrides interactive prompts)

Examples:
  From docker directory:
    node setup-docker.js
    node setup-docker.js --force
    node setup-docker.js --ci
    node setup-docker.js --ci --force
    npx -p inquirer@8.2.6 node setup-docker.js
    npx -y -p inquirer@8.2.6 node setup-docker.js --force

  From project root:
    node docker/setup-docker.js
    node docker/setup-docker.js --ci
    node docker/setup-docker.js --config '{"provider":"github","providerConfig":{...}}'
    npx -y -p inquirer@8.2.6 node docker/setup-docker.js --force

What this script does:
  1. Creates .env files for gateway, admin, and ollama services
  2. Configures authentication provider (Local, GitHub, LDAP, Okta)
  3. Sets up shared security tokens between services
  4. Generates configuration files for Docker deployment

Files created/modified:
  - services/gateway/.env
  - services/admin/.env  
  - services/ollama/.env
  - docker/dex.config.yaml
  - docker/.env.auth
  - docker/nginx.conf
  `);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('SAIL-PROXY Docker Setup v1.0.0');
  process.exit(0);
}

// Check for force flag
const forceOverwrite = args.includes('--force') || args.includes('-f');

// Check for CI flag
const ciMode = args.includes('--ci');

// Check for config parameter
let configFromJson = null;
const configIndex = args.findIndex(arg => arg === '--config');
if (configIndex !== -1 && args[configIndex + 1]) {
  try {
    // Parse JSON configuration from command line
    configFromJson = JSON.parse(args[configIndex + 1]);
    console.log('📋 Using configuration from --config parameter');
  } catch (error) {
    console.error('❌ Failed to parse --config JSON:', error.message);
    process.exit(1);
  }
}

// Try to find inquirer in multiple locations
let inquirer;
const { execSync } = require('child_process');

function tryLoadInquirer() {
  const locations = [
    '../npm-dist/sail-proxy/node_modules/inquirer',
    'inquirer',
    '../node_modules/inquirer',
    './node_modules/inquirer'
  ];
  
  for (const location of locations) {
    try {
      return require(location);
    } catch (e) {
      // Continue to next location
    }
  }
  // The release kit `sail-proxy upgrade` runs from has no node_modules of its own
  if (process.env.SAIL_PROXY_KIT_MODULES) {
    try {
      return require(require.resolve('inquirer', { paths: [process.env.SAIL_PROXY_KIT_MODULES] }));
    } catch (e) {
      // Not there either
    }
  }
  return null;
}

inquirer = tryLoadInquirer();

if (!inquirer && ciMode) {
  // CI mode must never block on stdin: an unanswered prompt in a headless
  // shell hangs forever and the whole pipeline gets reaped from outside.
  // Fail loudly with the actual remedy instead.
  console.error('\n❌ inquirer not found and --ci mode cannot prompt to install it.');
  console.error('   Run "pnpm install" at the repo root first (it provides');
  console.error('   npm-dist/sail-proxy/node_modules/inquirer), then re-run.');
  process.exit(1);
}

if (!inquirer && !configFromJson) {
  console.log('\n📦 The inquirer package is required but not found.');
  console.log('This package is needed for the interactive setup prompts.\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question('Would you like to install it now? (Y/n): ', (answer) => {
    rl.close();
    
    if (answer.trim().toLowerCase() !== 'n') {
      console.log('\nInstalling inquirer...');
      try {
        // Create a temporary package.json if it doesn't exist
        const dockerDir = __dirname;
        const packageJsonPath = path.join(dockerDir, 'package.json');
        
        if (!fs.existsSync(packageJsonPath)) {
          const packageJson = {
            name: "docker-setup",
            version: "1.0.0",
            private: true,
            dependencies: {}
          };
          fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        }
        
        // Install inquirer locally
        execSync('npm install inquirer@8.2.6 --no-save', {
          cwd: dockerDir,
          stdio: 'inherit'
        });
        
        // Try loading again
        inquirer = require('./node_modules/inquirer');
        console.log('✅ inquirer installed successfully!\n');
        
        // Re-run the script with the installed inquirer and preserve original arguments
        const { spawn } = require('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
          shell: false
        });
        
        child.on('exit', (code) => {
          process.exit(code);
        });
        
        return;
      } catch (error) {
        console.error('\n❌ Failed to install inquirer:', error.message);
        console.error('\nAlternatively, you can run:');
        console.error('  npx -p inquirer@8.2.6 node setup-docker.js');
        console.error('  npx -y -p inquirer@8.2.6 node setup-docker.js  (auto-confirm)');
        process.exit(1);
      }
    } else {
      console.log('\nTo run this script without installing, use:');
      console.log('  npx -p inquirer@8.2.6 node setup-docker.js');
      console.log('  npx -y -p inquirer@8.2.6 node setup-docker.js  (auto-confirm)');
      process.exit(0);
    }
  });
  
  // Exit here since we need to wait for the user response
  return;
}

// Provider configurations
const PROVIDERS = {
  local: {
    name: 'Local Development (hardcoded users)',
    description: 'For development only - uses static test users',
    warning: '⚠️  WARNING: Do not use in production!',
    files: ['dex.config.yaml', '.env.auth']
  },
  github: {
    name: 'GitHub OAuth',
    description: 'GitHub organization/team-based authentication',
    files: ['dex.config.yaml', '.env.auth']
  },
  ldap: {
    name: 'LDAP/Active Directory',
    description: 'Enterprise LDAP or Active Directory integration',
    files: ['dex.config.yaml', '.env.auth'],
    override: 'docker-compose.override.yml'
  },
  okta: {
    name: 'Okta SAML',
    description: 'Okta SAML-based single sign-on',
    files: ['dex.config.yaml', '.env.auth']
  }
};

// Provider-specific configuration prompts
const PROVIDER_PROMPTS = {
  local: [
    { key: 'LOGOUT_REDIRECT_URL', prompt: 'Logout redirect URL', default: 'auto-shell' }
  ],
  github: [
    { key: 'GITHUB_CLIENT_ID', prompt: 'GitHub OAuth App Client ID', required: true },
    { key: 'GITHUB_CLIENT_SECRET', prompt: 'GitHub OAuth App Client Secret', required: true, secret: true },
    // Dex matches team names inside the organization, so "my-org/admins" never matches.
    { key: 'GITHUB_ORG', prompt: 'GitHub Organization name (the org that owns the teams, not a team)', required: true },
    { key: 'GITHUB_ADMIN_TEAM', prompt: 'Admin team name (inside that org, without the org prefix)', default: 'admins' },
    { key: 'GITHUB_USER_TEAM', prompt: 'User team name (inside that org, without the org prefix)', default: 'users' },
    { key: 'LOGOUT_REDIRECT_URL', prompt: 'Logout redirect URL', default: 'auto-shell' }
  ],
  ldap: [
    { key: 'LDAP_SERVER_TYPE', prompt: 'LDAP server type (local/external)', required: true, default: 'local', options: ['local', 'external'] },
    { key: 'LDAP_ADMIN_GROUP', prompt: 'LDAP admin group name', default: 'sap-llm-gateway-admin' },
    { key: 'LDAP_USER_GROUP', prompt: 'LDAP user group name', default: 'sap-llm-gateway-user' },
    { key: 'LOGOUT_REDIRECT_URL', prompt: 'Logout redirect URL', default: 'auto-shell' }
  ],
  'ldap-external': [
    { key: 'LDAP_HOST', prompt: 'LDAP server (host:port)', required: true },
    { key: 'LDAP_INSECURE_NO_SSL', prompt: 'Allow insecure connection (true/false)', required: true, default: 'false' },
    { key: 'LDAP_BIND_DN', prompt: 'Bind DN (service account)', required: true },
    { key: 'LDAP_BIND_PASSWORD', prompt: 'Bind password', required: true, secret: true },
    { key: 'LDAP_USER_BASE_DN', prompt: 'User search base DN', required: true },
    { key: 'LDAP_USER_FILTER', prompt: 'User search filter', required: true, default: '(objectClass=person)' },
    { key: 'LDAP_USERNAME_ATTR', prompt: 'Username attribute', required: true, default: 'sAMAccountName' },
    { key: 'LDAP_ID_ATTR', prompt: 'ID attribute', required: true, default: 'sAMAccountName' },
    { key: 'LDAP_EMAIL_ATTR', prompt: 'Email attribute', required: true, default: 'mail' },
    { key: 'LDAP_NAME_ATTR', prompt: 'Name attribute', required: true, default: 'displayName' },
    { key: 'LDAP_PREFERRED_USERNAME_ATTR', prompt: 'Preferred username attribute', required: true, default: 'sAMAccountName' },
    { key: 'LDAP_GROUP_BASE_DN', prompt: 'Group search base DN', required: true },
    { key: 'LDAP_GROUP_FILTER', prompt: 'Group search filter', required: true, default: '(objectClass=group)' },
    { key: 'LDAP_GROUP_NAME_ATTR', prompt: 'Group name attribute', required: true, default: 'cn' },
    { key: 'LDAP_GROUP_MEMBER_ATTR', prompt: 'Group member attribute', required: true, default: 'member' }
  ],
  okta: [
    { key: 'OKTA_METADATA_URL', prompt: 'Okta SAML metadata URL', required: true },
    { key: 'OKTA_SSO_URL', prompt: 'Okta SSO URL', required: true },
    { key: 'OKTA_SAML_CA_DATA', prompt: 'SAML certificate (base64)', required: true, default: 'auto-fetch-from-metadata' },
    { key: 'OKTA_ADMIN_GROUP', prompt: 'Okta admin group name (from Okta app assignments)', default: 'sap-llm-gateway-admin' },
    { key: 'OKTA_USER_GROUP', prompt: 'Okta user group name (from Okta app assignments)', default: 'sap-llm-gateway-user' },
    { key: 'LOGOUT_REDIRECT_URL', prompt: 'Logout redirect URL', default: 'auto-shell' }
  ]
};

class DockerSetup {
  constructor(options = {}) {
    this.dockerDir = path.resolve(__dirname);
    this.configsDir = path.join(this.dockerDir, 'configs');
    this.projectRoot = path.resolve(this.dockerDir, '..');
    this.sharedSecrets = {};
    this.forceOverwrite = options.forceOverwrite || false;
    this.ciMode = options.ciMode || false;
    this.configFromJson = options.configFromJson || null;
    this.imageMode = null; // Track image mode for completion logic
    this.registryConfig = null; // Track registry configuration
    this.session = null; // PromptSession while answers are collected (interactive questions)
    this.answers = {}; // DockerAnswers while applyAnswers writes them
    this.currentSecrets = {}; // secrets of the current configuration (interactive re-run without --force)
    this.databasePasswordReplaced = false; // a re-run's "Enter new" database password
  }

  /** Asks questions through the prompt session while collecting, else plain inquirer. */
  prompt(questions) {
    return this.session ? this.session.ask(questions) : inquirer.prompt(questions);
  }

  /**
   * The prompt session for an interactive run (replaced in tests by a scripted one).
   * @param {object} [current] current values by question id: the first defaults
   */
  createSession(current) {
    return new PromptSession({ inquirer, current });
  }

  /**
   * Detect host architecture for Docker platform compatibility
   * Returns information about the host architecture and Docker compatibility
   */
  detectArchitecture() {
    const nodeArch = process.arch;
    let dockerArch = 'unknown';
    let isAppleSilicon = false;

    try {
      // Try to get Docker's reported architecture
      const dockerInfo = require('child_process').execSync('docker info --format "{{.Architecture}}" 2>/dev/null || echo "unknown"', {
        encoding: 'utf8'
      }).trim();
      dockerArch = dockerInfo;
    } catch (error) {
      // Docker might not be available, fall back to Node.js arch
      dockerArch = nodeArch;
    }

    // Detect Apple Silicon (M1/M2/M3)
    isAppleSilicon = nodeArch === 'arm64' && process.platform === 'darwin';

    return {
      nodeArch,
      dockerArch,
      isAppleSilicon,
      isARM64: dockerArch === 'arm64' || nodeArch === 'arm64',
      isAMD64: dockerArch === 'x86_64' || dockerArch === 'amd64' || nodeArch === 'x64'
    };
  }

  /**
   * Check if running under WSL2 with Rancher Desktop
   * @returns {boolean} True if WSL2 + Rancher Desktop detected
   */
  isRancherDesktopDocker() {
    try {
      const procVersion = fs.readFileSync('/proc/version', 'utf8');
      return procVersion.toLowerCase().includes('microsoft') &&
             fs.existsSync('/mnt/wsl/rancher-desktop/');
    } catch {
      return false;
    }
  }

  /**
   * Parse docker-compose.yml to extract volume names
   * @returns {Array<string>} List of volume names defined in docker-compose.yml
   */
  parseDockerComposeVolumes() {
    const dockerComposePath = path.join(this.dockerDir, 'docker-compose.yml');

    if (!fs.existsSync(dockerComposePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(dockerComposePath, 'utf8');
      const volumeNames = [];

      // Find the volumes section at the end of the file
      const volumesMatch = content.match(/^volumes:\s*$/m);
      if (!volumesMatch) {
        return [];
      }

      // Extract volume names from the volumes section
      const volumesSection = content.substring(volumesMatch.index);
      const lines = volumesSection.split('\n');

      for (const line of lines) {
        // Match volume declarations like "  postgres_data:" or "  valkey_data:"
        const match = line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*$/);
        if (match && match[1]) {
          volumeNames.push(match[1]);
        }
      }

      return volumeNames;
    } catch (error) {
      console.log(`⚠️  Warning: Could not parse docker-compose.yml: ${error.message}`);
      return [];
    }
  }

  /**
   * Check if Docker volumes exist
   * @param {Array<string>} volumeNames - List of volume names to check
   * @returns {Array<string>} List of existing volume names
   */
  checkExistingVolumes(volumeNames) {
    if (!volumeNames || volumeNames.length === 0) {
      return [];
    }

    try {
      const { execSync } = require('child_process');
      const existingVolumes = [];

      // Get list of all Docker volumes
      const volumeList = execSync('docker volume ls --format "{{.Name}}"', {
        encoding: 'utf8'
      }).trim().split('\n').filter(v => v);

      // Check each expected volume name with possible prefixes
      for (const volumeName of volumeNames) {
        // Check base name, docker_ prefix, and project prefix
        const possibleNames = [
          volumeName,
          `docker_${volumeName}`,
          `project_${volumeName}`,
          `sap-llm-gateway_${volumeName}`
        ];

        for (const name of possibleNames) {
          if (volumeList.includes(name) && !existingVolumes.includes(name)) {
            existingVolumes.push(name);
          }
        }
      }

      return existingVolumes;
    } catch (error) {
      // Docker might not be available or volumes command failed
      return [];
    }
  }

  /**
   * Delete Docker volumes
   * @param {Array<string>} volumeNames - List of volume names to delete
   * @returns {boolean} True if all volumes were deleted successfully
   */
  deleteVolumes(volumeNames) {
    if (!volumeNames || volumeNames.length === 0) {
      return true;
    }

    try {
      const { execSync } = require('child_process');

      for (const volumeName of volumeNames) {
        try {
          execSync(`docker volume rm ${volumeName}`, {
            encoding: 'utf8',
            stdio: 'pipe'
          });
          console.log(`✅ Deleted volume: ${volumeName}`);
        } catch (error) {
          console.log(`⚠️  Warning: Could not delete volume ${volumeName}: ${error.message}`);
        }
      }

      return true;
    } catch (error) {
      console.log(`❌ Error deleting volumes: ${error.message}`);
      return false;
    }
  }

  /**
   * Show architecture-appropriate Docker commands
   * @param {Object} config - Configuration object
   * @param {Object} archInfo - Architecture information from detectArchitecture()
   * @param {string} mode - 'registry' or 'local' build mode
   * @param {boolean} imagesReady - Whether images are already pulled
   */
  showDockerCommands(config, archInfo, mode, imagesReady = false) {
    console.log('Next steps:');

    if (mode === 'registry' && !imagesReady) {
      console.log('1. Pull images:');
      console.log('   docker-compose pull');
      console.log('');
    } else if (mode === 'local') {
      console.log('1. Build containers (only needed once):');
      console.log('   docker-compose build');
      console.log('');
      console.log('   Note: Future configuration changes only require container restart.');
      console.log('');
    }

    const stepNum = (mode === 'registry' && !imagesReady) || mode === 'local' ? '2' : '1';
    console.log(`${stepNum}. Start the services:`);
    console.log('   docker-compose up -d');
    console.log('');

    const accessStep = (mode === 'registry' && !imagesReady) || mode === 'local' ? '3' : '2';
    console.log(`${accessStep}. Access the application:`);
    console.log(`   ${config.baseUrl}/admin/`);
    console.log('');

    if (archInfo.isAppleSilicon) {
      console.log('💡 Apple Silicon Notes:');
      console.log('   • All images are now multi-architecture (ARM64 and AMD64)');
      console.log('   • Native ARM64 performance for optimal speed');
      console.log('   • No platform-specific overrides needed');
      console.log('');
    }

    // Warn about Rancher Desktop WSL2 file mount bug that breaks single-file volume mounts
    if (this.isRancherDesktopDocker()) {
      console.log('╔═════════════════════════════════════════════════════════════════════╗');
      console.log('║                           ⚠️  WARNING                               ║');
      console.log('╠═════════════════════════════════════════════════════════════════════╣');
      console.log('║ Do not run docker-compose from Windows WSL2 (e.g. Ubuntu) with SUSE ║');
      console.log('║ Rancher Desktop - bug: single file mounts may be interpreted as     ║');
      console.log('║ directories.                                                        ║');
      console.log('║                                                                     ║');
      console.log('║ See: https://github.com/rancher-sandbox/rancher-desktop/issues/5632 ║');
      console.log('║                                                                     ║');
      console.log('║ Please execute docker-compose from a Windows shell, not WSL.        ║');
      console.log('╚═════════════════════════════════════════════════════════════════════╝');
      console.log('');
    }
  }

  /**
   * Extract region from SAP AI Core URL
   * Example: https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com → prod.us-east-1
   */
  extractRegion(aiApiUrl) {
    const match = aiApiUrl.match(/https:\/\/api\.ai\.([^.]+\.[^.]+)\./);
    if (match && match[1]) {
      return match[1];
    }
    
    // Fallback to try extracting from a different pattern if needed
    const fallbackMatch = aiApiUrl.match(/\.([^.]+\.[^.]+)\.aws\./);
    if (fallbackMatch && fallbackMatch[1]) {
      return fallbackMatch[1];
    }
    
    return 'unknown';
  }

  /**
   * Parse SAP BTP service key and extract configuration values
   */
  parseServiceKeyInline(serviceKeyJson) {
    let serviceKey;
    
    try {
      serviceKey = JSON.parse(serviceKeyJson);
    } catch (error) {
      throw new Error('Invalid JSON format. Please provide a valid SAP BTP service key.');
    }
    
    // Validate required fields
    if (!serviceKey.serviceurls?.AI_API_URL) {
      throw new Error('Missing required field: serviceurls.AI_API_URL');
    }
    if (!serviceKey.url) {
      throw new Error('Missing required field: url');
    }
    if (!serviceKey.clientid) {
      throw new Error('Missing required field: clientid');
    }
    if (!serviceKey.clientsecret) {
      throw new Error('Missing required field: clientsecret');
    }
    
    // Extract region from AI_API_URL
    const region = this.extractRegion(serviceKey.serviceurls.AI_API_URL);
    
    return {
      SAP_AI_CORE_URL: serviceKey.serviceurls.AI_API_URL,
      AUTH_URL: `${serviceKey.url}/oauth/token`,
      CLIENT_ID: serviceKey.clientid,
      CLIENT_SECRET: serviceKey.clientsecret,
      SAP_AI_REGION: region,
      SAP_AI_RESOURCE_GROUP: 'default'
    };
  }

  generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate OAuth2 Proxy Client Secret (64 characters hex)
   * Must match the exact length of current hardcoded secret
   */
  generateOAuth2ClientSecret() {
    return crypto.randomBytes(32).toString('hex'); // 32 bytes = 64 hex chars
  }

  /**
   * Generate OAuth2 Proxy Cookie Secret (32 characters hex)
   * Must match the exact length of current hardcoded secret
   */
  generateOAuth2CookieSecret() {
    return crypto.randomBytes(16).toString('hex'); // 16 bytes = 32 hex chars
  }

  /**
   * Generate secure database password (16 characters hex)
   * Safe for env files and database connections
   */
  generateDatabasePassword() {
    return crypto.randomBytes(8).toString('hex'); // 8 bytes = 16 hex chars
  }

  async parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const envVars = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      // Skip comments and empty lines
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;
      
      // Parse key=value pairs
      const separatorIndex = trimmedLine.indexOf('=');
      if (separatorIndex > 0) {
        const key = trimmedLine.substring(0, separatorIndex).trim();
        const value = trimmedLine.substring(separatorIndex + 1).trim();
        envVars[key] = value;
      }
    }
    
    return envVars;
  }

  /**
   * Read Docker environment variables from .env.docker file
   * @returns {Object} Docker environment variables
   */
  readDockerEnvFile() {
    const envDockerPath = path.join(this.dockerDir, '.env.docker');
    
    if (!fs.existsSync(envDockerPath)) {
      return {};
    }
    
    try {
      const content = fs.readFileSync(envDockerPath, 'utf8');
      const dockerEnvVars = {};
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        // Skip comments and empty lines
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;
        
        // Parse key=value pairs for Docker variables
        const separatorIndex = trimmedLine.indexOf('=');
        if (separatorIndex > 0) {
          const key = trimmedLine.substring(0, separatorIndex).trim();
          const value = trimmedLine.substring(separatorIndex + 1).trim();
          
          // Only include Docker-related environment variables
          if (key.startsWith('DOCKER_')) {
            dockerEnvVars[key] = value;
          }
        }
      }
      
      return dockerEnvVars;
    } catch (error) {
      console.log(`⚠️  Warning: Could not read .env.docker: ${error.message}`);
      return {};
    }
  }

  async updateEnvFilePreservingComments(templatePath, targetPath, updates) {
    // Read the template file
    const templateContent = fs.readFileSync(templatePath, 'utf8');
    const lines = templateContent.split('\n');
    
    // Process each line
    const updatedLines = lines.map(line => {
      const trimmedLine = line.trim();
      
      // Keep comments and empty lines as-is
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        return line;
      }
      
      // Check if this is a key=value line
      const separatorIndex = line.indexOf('=');
      if (separatorIndex > 0) {
        const key = line.substring(0, separatorIndex).trim();
        const originalValue = line.substring(separatorIndex + 1);
        
        // If we have an update for this key, apply it
        if (key in updates && updates[key] !== undefined) {
          const newValue = updates[key];
          
          // Special handling for CLIENT_SECRET - quote if contains special characters
          if (key === 'CLIENT_SECRET' && newValue && /[$=]/.test(newValue)) {
            return `${key}='${newValue}'`;
          }
          
          return `${key}=${newValue}`;
        }
        
        // Special handling for CAP database credentials - replace admin_user with chosen username
        if (key === 'cds.requires.db.credentials.user' && updates.POSTGRES_USER && updates.POSTGRES_USER !== 'admin_user') {
          return `${key}=${updates.POSTGRES_USER}`;
        }
        
        // Special handling for CAP database password - replace admin_password with generated password
        if (key === 'cds.requires.db.credentials.password' && updates.POSTGRES_PASSWORD) {
          return `${key}=${updates.POSTGRES_PASSWORD}`;
        }
      }
      
      // Keep the line as-is if no update
      return line;
    });
    
    // Write the updated content
    fs.writeFileSync(targetPath, updatedLines.join('\n'), 'utf8');
  }

  cleanupTempFiles() {
    // Clean up temporary files created by inquirer editor
    const tempPatterns = ['.servicekey.tmp.json*', '.*.swp', '.*.tmp'];
    
    for (const pattern of tempPatterns) {
      try {
        const files = fs.readdirSync(this.dockerDir).filter(file => {
          // Match patterns like .servicekey.tmp.json12345
          if (pattern.includes('*')) {
            const basePattern = pattern.replace('*', '');
            return file.startsWith(basePattern);
          }
          return file === pattern;
        });
        
        for (const file of files) {
          const filePath = path.join(this.dockerDir, file);
          try {
            fs.unlinkSync(filePath);
            console.log(`🧹 Cleaned up temporary file: ${file}`);
          } catch (err) {
            // Ignore errors for individual files
          }
        }
      } catch (err) {
        // Ignore errors when reading directory
      }
    }
  }

  /**
   * Check for SAP AI Core service key in environment variable
   * @returns {Object|null} Parsed service key configuration or null if not found/invalid
   */
  checkEnvServiceKey() {
    const envServiceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
    
    if (!envServiceKey || !envServiceKey.trim()) {
      return null;
    }
    
    try {
      // Validate JSON format
      JSON.parse(envServiceKey);
      
      // Parse using existing inline parser for consistency
      const parsedConfig = this.parseServiceKeyInline(envServiceKey);
      
      console.log('✅ Found SAP AI Core service key in environment variable SAP_AI_CORE_SERVICE_KEY');
      console.log('Extracted configuration:');
      console.log(`  - SAP AI Core URL: ${parsedConfig.SAP_AI_CORE_URL}`);
      console.log(`  - Auth URL: ${parsedConfig.AUTH_URL}`);
      console.log(`  - Region: ${parsedConfig.SAP_AI_REGION}`);
      
      return {
        SAP_AI_CORE_URL: parsedConfig.SAP_AI_CORE_URL,
        AUTH_URL: parsedConfig.AUTH_URL,
        CLIENT_ID: parsedConfig.CLIENT_ID,
        CLIENT_SECRET: parsedConfig.CLIENT_SECRET,
        SAP_AI_REGION: parsedConfig.SAP_AI_REGION,
        SAP_AI_RESOURCE_GROUP: parsedConfig.SAP_AI_RESOURCE_GROUP
      };
    } catch (error) {
      console.warn(`⚠️  Warning: SAP_AI_CORE_SERVICE_KEY environment variable found but invalid: ${error.message}`);
      console.warn('   Falling back to interactive configuration...');
      return null;
    }
  }

  /**
   * Prompt for database credentials with environment variable override support
   * @returns {Object} Database configuration object
   */
  async promptForDatabaseCredentials() {
    // Check for environment variables first (allows Kyma script to pass credentials transparently)
    const envUsername = process.env.POSTGRES_USER;
    const envPassword = process.env.POSTGRES_PASSWORD;
    
    if (envUsername && envPassword) {
      console.log('✅ Using database credentials from environment variables');
      console.log(`   - Username: ${envUsername}`);
      console.log('   - Password: [REDACTED]');
      return {
        POSTGRES_USER: envUsername,
        POSTGRES_PASSWORD: envPassword
      };
    }
    
    if (this.ciMode) {
      // CI mode: use secure defaults
      return {
        POSTGRES_USER: 'admin_user',
        POSTGRES_PASSWORD: this.sharedSecrets.POSTGRES_PASSWORD,
        useGeneratedSecrets: true
      };
    }

    console.log('\n📊 Database Configuration');
    console.log('=========================================');
    console.log('Configure PostgreSQL database credentials for the deployment.');
    console.log('💡 Tip: Leave password empty to auto-generate a secure random password');
    
    // First, get the username
    const usernameConfig = await this.prompt([
      {
        type: 'input',
        name: 'POSTGRES_USER',
        message: 'Database username:',
        default: 'admin_user',
        validate: validateDatabaseUsername
      }
    ]);

    // Re-run: the password in use is kept, replaced, or regenerated (askKeyRegeneration).
    this.databasePasswordReplaced = false;
    const currentPassword = this.currentSecrets.POSTGRES_PASSWORD;
    if (this.session && currentPassword) {
      const { value, origin } = await askSecret(this.session, {
        name: 'POSTGRES_PASSWORD',
        message: 'Database password:',
        current: currentPassword,
        validate: (input) => (input && input.trim() ? validateDatabasePassword(input) : 'A value is required')
      });
      const password = origin === 'kept' ? value : value.trim();
      if (origin === 'new') {
        await this.confirmDatabasePassword(password);
        this.databasePasswordReplaced = true;
      }
      return { POSTGRES_USER: usernameConfig.POSTGRES_USER, POSTGRES_PASSWORD: password, passwordWasGenerated: false };
    }

    // Then, handle password with confirmation for manual entry. A rejected value is asked again
    // by the prompt itself (validate), so it never enters the session's answers.
    const { POSTGRES_PASSWORD: entered } = await this.prompt([
      {
        type: 'password',
        name: 'POSTGRES_PASSWORD',
        message: 'Database password (leave empty for auto-generated):',
        mask: '*',
        review: false,
        validate: validateDatabasePassword
      }
    ]);

    let password;
    let passwordWasGenerated = false;
    if (!entered || entered.trim() === '') {
      // Auto-generate secure password (the same one on every replay of the session)
      if (this.session) {
        if (!this.session.generated.has('POSTGRES_PASSWORD')) {
          this.session.generated.set('POSTGRES_PASSWORD', this.generateDatabasePassword());
        }
        password = this.session.generated.get('POSTGRES_PASSWORD');
      } else {
        password = this.generateDatabasePassword();
      }
      passwordWasGenerated = true;
      console.log('✅ Auto-generated secure database password');
    } else {
      password = entered.trim();
      await this.confirmDatabasePassword(password);
    }

    if (this.session) {
      this.session.record({
        id: 'POSTGRES_PASSWORD',
        label: 'Database password',
        value: password,
        display: passwordWasGenerated ? 'generated' : 'new',
        secret: true,
        changed: true
      });
    }

    return {
      POSTGRES_USER: usernameConfig.POSTGRES_USER,
      POSTGRES_PASSWORD: password,
      passwordWasGenerated: passwordWasGenerated
    };
  }

  /**
   * Asks for the database password again until it matches. The loop also catches a remembered
   * confirmation that no longer matches after the password was changed (Enter keeps a remembered
   * secret unchecked).
   */
  async confirmDatabasePassword(password) {
    for (;;) {
      const { confirmPassword } = await this.prompt([
        {
          type: 'password',
          name: 'confirmPassword',
          message: 'Confirm database password:',
          mask: '*',
          review: false,
          validate: (input) => (input === password ? true : 'Passwords do not match. Please try again.')
        }
      ]);
      if (confirmPassword === password) return;
      console.log('❌ Passwords do not match. Please try again.');
    }
  }

  async promptForServiceKey() {
    console.log('\nSAP AI Core Configuration');
    console.log('========================\n');
    
    // Check for environment variable first (a read-only probe: once per prompt session)
    const envConfig = this.session
      ? await this.session.once('env-service-key', () => this.checkEnvServiceKey())
      : this.checkEnvServiceKey();
    if (envConfig) {
      console.log('\n🚀 Using SAP AI Core service key from environment variable');
      console.log('   Skipping interactive configuration...\n');
      return envConfig;
    }

    const { configMethod } = await this.prompt([
      {
        type: 'list',
        name: 'configMethod',
        message: 'Configure SAP AI Core?',
        choices: [
          { name: 'Enter service key JSON', value: 'json' },
          { name: 'Enter values manually', value: 'manual' },
          { name: 'Skip', value: 'skip' }
        ]
      }
    ]);
    
    if (configMethod === 'skip') {
      return null;
    }
    
    if (configMethod === 'json') {
      // Editor temp files are cleaned up when the run ends (run() → cleanupTempFiles), not
      // here: nothing in the project changes before the answers are reviewed.
      const { serviceKeyJson } = await this.prompt([
        {
          type: 'editor',
          name: 'serviceKeyJson',
          message: 'Please paste your SAP BTP AI Core service key JSON and save (for vi enter ESC,:wq):',
          validate: (input) => {
            if (!input.trim()) {
              return 'Service key cannot be empty';
            }
            try {
              JSON.parse(input);
              return true;
            } catch (error) {
              return 'Invalid JSON format. Please provide a valid service key.';
            }
          }
        }
      ]);

      try {
        // Use inline service key parser (no build dependency)
        const parsedConfig = this.parseServiceKeyInline(serviceKeyJson);

        console.log('\n✅ Service key parsed successfully!\n');
        console.log('Extracted configuration:');
        console.log(`  - SAP AI Core URL: ${parsedConfig.SAP_AI_CORE_URL}`);
        console.log(`  - Auth URL: ${parsedConfig.AUTH_URL}`);
        console.log(`  - Region: ${parsedConfig.SAP_AI_REGION}`);

        return {
          SAP_AI_CORE_URL: parsedConfig.SAP_AI_CORE_URL,
          AUTH_URL: parsedConfig.AUTH_URL,
          CLIENT_ID: parsedConfig.CLIENT_ID,
          CLIENT_SECRET: parsedConfig.CLIENT_SECRET,
          SAP_AI_REGION: parsedConfig.SAP_AI_REGION,
          SAP_AI_RESOURCE_GROUP: parsedConfig.SAP_AI_RESOURCE_GROUP
        };
      } catch (error) {
        console.error(`\n❌ Failed to parse service key: ${error.message}`);
        return null;
      }
    } else {
      // Manual entry using inquirer
      const sapConfig = await this.prompt([
        {
          type: 'input',
          name: 'SAP_AI_CORE_URL',
          message: 'SAP AI Core URL:',
          validate: (input) => input.trim() ? true : 'This field is required'
        },
        {
          type: 'input',
          name: 'AUTH_URL',
          message: 'OAuth token URL:',
          validate: (input) => input.trim() ? true : 'This field is required'
        },
        {
          type: 'input',
          name: 'CLIENT_ID',
          message: 'Client ID:',
          validate: (input) => input.trim() ? true : 'This field is required'
        },
        {
          type: 'password',
          name: 'CLIENT_SECRET',
          message: 'Client Secret:',
          validate: (input) => input.trim() ? true : 'This field is required'
        },
        {
          type: 'input',
          name: 'SAP_AI_REGION',
          message: 'SAP AI Region (e.g., prod.us-east-1):',
          validate: (input) => input.trim() ? true : 'This field is required'
        },
        {
          type: 'input',
          name: 'SAP_AI_RESOURCE_GROUP',
          message: 'Resource Group:',
          default: 'default'
        }
      ]);
      
      return sapConfig;
    }
  }

  async fetchSamlCertificateFromMetadata(metadataUrl) {
    return new Promise((resolve, reject) => {
      console.log(`Fetching SAML certificate from metadata: ${metadataUrl}`);
      
      const client = metadataUrl.startsWith('https:') ? https : http;
      
      client.get(metadataUrl, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            // Extract certificate from X509Certificate element
            const certMatch = data.match(/<(?:ds:)?X509Certificate[^>]*>([^<]+)<\/(?:ds:)?X509Certificate>/s);
            if (certMatch && certMatch[1]) {
              // Clean up the certificate data (remove whitespace/newlines)  
              const rawCertData = certMatch[1].replace(/\s+/g, '');
              // Format as PEM certificate
              const certData = `-----BEGIN CERTIFICATE-----\n${rawCertData}\n-----END CERTIFICATE-----`;
              
              // Extract SSO URL from SingleSignOnService element (prefer HTTP-POST)
              const ssoMatch = data.match(/<(?:md:)?SingleSignOnService[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]*Location="([^"]*)"[^>]*\/?>/);
              const ssoUrl = ssoMatch ? ssoMatch[1] : null;
              
              console.log('✅ SAML certificate extracted from metadata');
              console.log(`Certificate length: ${certData.length} characters`);
              if (ssoUrl) {
                console.log(`✅ SSO URL extracted: ${ssoUrl}`);
              }
              
              resolve({
                certificate: certData,
                ssoUrl: ssoUrl,
                metadata: data
              });
            } else {
              reject(new Error('No X509Certificate found in metadata'));
            }
          } catch (error) {
            reject(new Error(`Failed to parse metadata: ${error.message}`));
          }
        });
        
      }).on('error', (error) => {
        reject(new Error(`Failed to fetch metadata: ${error.message}`));
      });
    });
  }

  /**
   * Writes the service .env files. sapConfig: the SAP AI Core settings, null to skip them, or
   * undefined to resolve them now (environment key, else ask) when the gateway .env is created.
   */
  async setupServiceEnvFiles(sapConfig = undefined, dbConfig = null) {
    console.log('\nChecking service configuration files...\n');
    
    // Generate shared secrets if not already generated
    if (!this.sharedSecrets.VALIDATION_TOKEN_SECRET) {
      // Core service secrets (64 chars hex each)
      this.sharedSecrets.VALIDATION_TOKEN_SECRET = this.generateSecureToken();
      this.sharedSecrets.METADATA_ENCRYPTION_KEY = this.generateSecureToken();
      this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY = this.generateSecureToken();
      // Admin-only (the gateway never touches SiemCredentials). Without it every
      // setSiemCredential call in the running stack fails - services/admin/src/siem/
      // credentialStore.ts refuses to encrypt under a default key - and .env.sample ships
      // the placeholder `changeme`, which is a guessable master key, not a usable one.
      this.sharedSecrets.SIEM_CREDENTIAL_KEY = this.generateSecureToken();
      // Admin-only, like SIEM_CREDENTIAL_KEY: encrypts the Connection credentials
      // (services/admin/src/services/connectionCredentialStore.ts refuses to work without it).
      this.sharedSecrets.CONNECTION_CREDENTIAL_KEY = this.generateSecureToken();
      
      // Database credentials (16 chars hex, safe for env files)
      this.sharedSecrets.POSTGRES_PASSWORD = this.generateDatabasePassword();

      // OAuth2 Proxy secrets (matching hardcoded lengths for compatibility)
      this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET = this.generateOAuth2ClientSecret(); // 64 chars
      this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET = this.generateOAuth2CookieSecret(); // 32 chars
    }

    // Interactive re-run: generated values the current configuration holds are kept, except the
    // ones the user chose to regenerate (those keep the value generated above).
    const regenerate = this.answers.regenerateKeys || [];
    for (const key of KEPT_GENERATED_SECRETS) {
      if (this.currentSecrets[key] && !regenerate.includes(key)) {
        this.sharedSecrets[key] = this.currentSecrets[key];
        if (key === 'FILE_SEARCH_RUNTIME_PASSWORD') this.sharedSecrets.FILE_SEARCH_RUNTIME_USER = 'file_search_app';
      }
    }
    
    // Prompt for database credentials if not provided via config or environment
    const finalDbConfig = dbConfig || await this.promptForDatabaseCredentials();
    
    // Store database credentials for consistent replacement across all files
    if (finalDbConfig && finalDbConfig.POSTGRES_USER) {
      this.sharedSecrets.POSTGRES_USER = finalDbConfig.POSTGRES_USER;
    }
    if (finalDbConfig && finalDbConfig.POSTGRES_PASSWORD) {
      this.sharedSecrets.POSTGRES_PASSWORD = finalDbConfig.POSTGRES_PASSWORD;
    }
    if (finalDbConfig && finalDbConfig.passwordWasGenerated !== undefined) {
      this.sharedSecrets.passwordWasGenerated = finalDbConfig.passwordWasGenerated;
    }

    // file_search runtime role: DML only (SELECT/INSERT/UPDATE/DELETE on the
    // file_search tables, no CREATE) — provisioned by the gateway-migrate
    // compose service using FILE_SEARCH_MIGRATION_DATABASE_URL (which reuses
    // POSTGRES_USER/POSTGRES_PASSWORD above) to grant it. Username is fixed
    // rather than prompted: it's an internal service account no operator
    // needs to choose, unlike POSTGRES_USER. Guarded on its own key, not
    // folded into the `!this.sharedSecrets.VALIDATION_TOKEN_SECRET` block
    // above: a caller supplying `--config` (or a pre-populated
    // this.sharedSecrets) from before this release would already have
    // VALIDATION_TOKEN_SECRET set, skip that whole block, and — without this
    // independent guard — never generate a runtime password at all, silently
    // writing docker/configs/shared/.env.filesearch-runtime's committed
    // placeholder password verbatim into the generated .env.filesearch-runtime,
    // which the migration step would then `CREATE ROLE ... PASSWORD` with.
    if (!this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD) {
      this.sharedSecrets.FILE_SEARCH_RUNTIME_USER = 'file_search_app';
      this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD = this.generateDatabasePassword();
    }
    
    await this.setupGatewayEnv(sapConfig);
    await this.setupAdminEnv(finalDbConfig);
    await this.setupOllamaEnv();
    
    // Validate tokens match between gateway and admin
    await this.validateSharedTokens();
  }
  
  async validateSharedTokens() {
    console.log('\n🔐 Validating shared security tokens...\n');
    
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    const adminEnvPath = path.join(this.projectRoot, 'services/admin/.env');
    
    // Both files must exist for validation
    if (!fs.existsSync(gatewayEnvPath) || !fs.existsSync(adminEnvPath)) {
      console.log('⚠️  Warning: Cannot validate tokens - .env files not found');
      return false;
    }
    
    const gatewayEnv = await this.parseEnvFile(gatewayEnvPath);
    const adminEnv = await this.parseEnvFile(adminEnvPath);
    
    let isValid = true;
    
    // Check VALIDATION_TOKEN_SECRET
    if (!gatewayEnv.VALIDATION_TOKEN_SECRET || !adminEnv.VALIDATION_TOKEN_SECRET) {
      console.log('❌ VALIDATION_TOKEN_SECRET is missing in one or both .env files');
      isValid = false;
    } else if (gatewayEnv.VALIDATION_TOKEN_SECRET !== adminEnv.VALIDATION_TOKEN_SECRET) {
      console.log('❌ VALIDATION_TOKEN_SECRET does not match between gateway and admin');
      isValid = false;
    } else {
      console.log('✅ VALIDATION_TOKEN_SECRET matches');
    }
    
    // Check METADATA_ENCRYPTION_KEY
    if (!gatewayEnv.METADATA_ENCRYPTION_KEY || !adminEnv.METADATA_ENCRYPTION_KEY) {
      console.log('❌ METADATA_ENCRYPTION_KEY is missing in one or both .env files');
      isValid = false;
    } else if (gatewayEnv.METADATA_ENCRYPTION_KEY !== adminEnv.METADATA_ENCRYPTION_KEY) {
      console.log('❌ METADATA_ENCRYPTION_KEY does not match between gateway and admin');
      isValid = false;
    } else {
      console.log('✅ METADATA_ENCRYPTION_KEY matches');
    }
    
    if (!isValid) {
      console.log('\n⚠️  CRITICAL: Security tokens do not match between services!');
      console.log('   The gateway and admin services must use the same tokens.');
      console.log('   Please fix the .env files manually or delete them and run setup again.\n');
      
      // In config mode, continue without prompting
      if (this.configFromJson) {
        console.log('   Continuing in configuration mode...');
      } else {
        // Answered before the review (continueDespiteMismatch); undefined in an unattended run,
        // which asks here as it always did.
        let continueAnyway = this.answers.continueDespiteMismatch;
        if (continueAnyway === undefined) {
          ({ continueAnyway } = await this.prompt([
            {
              type: 'confirm',
              name: 'continueAnyway',
              message: 'Continue anyway?',
              default: false
            }
          ]));
        }
        
        if (!continueAnyway) {
          throw new Error('Token validation failed - setup aborted');
        }
      }
    } else {
      console.log('\n✅ All security tokens validated successfully');
    }
    
    return isValid;
  }

  async setupGatewayEnv(sapConfig = undefined) {
    const envPath = path.join(this.projectRoot, 'services/gateway/.env');
    const samplePath = path.join(this.projectRoot, 'services/gateway/.env.sample');
    
    if (fs.existsSync(envPath) && !this.forceOverwrite) {
      console.log('✅ Gateway .env already exists');
      
      // Extract secrets from existing file to share with admin service
      const existingEnv = await this.parseEnvFile(envPath);
      if (PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS.includes(existingEnv.VALIDATION_TOKEN_SECRET)) {
        // Never carry a publicly known secret over: write the freshly generated one into this
        // .env instead (setupAdminEnv does the same for the admin's), so the two still match.
        if (!this.sharedSecrets.VALIDATION_TOKEN_SECRET || PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS.includes(this.sharedSecrets.VALIDATION_TOKEN_SECRET)) {
          this.sharedSecrets.VALIDATION_TOKEN_SECRET = this.generateSecureToken();
        }
        await this.updateEnvFilePreservingComments(envPath, envPath, { VALIDATION_TOKEN_SECRET: this.sharedSecrets.VALIDATION_TOKEN_SECRET });
        console.log('🔑 Gateway .env held the default or .env.sample VALIDATION_TOKEN_SECRET: replaced with a generated one');
      } else if (existingEnv.VALIDATION_TOKEN_SECRET) {
        this.sharedSecrets.VALIDATION_TOKEN_SECRET = existingEnv.VALIDATION_TOKEN_SECRET;
      }
      if (existingEnv.METADATA_ENCRYPTION_KEY) {
        this.sharedSecrets.METADATA_ENCRYPTION_KEY = existingEnv.METADATA_ENCRYPTION_KEY;
      }

      // Keys the user chose to regenerate on the review screen: a fresh value in this file, which
      // setupAdminEnv then writes into the admin .env as well.
      const regenerated = {};
      for (const key of ['VALIDATION_TOKEN_SECRET', 'METADATA_ENCRYPTION_KEY']) {
        if ((this.answers.regenerateKeys || []).includes(key)) {
          this.sharedSecrets[key] = this.generateSecureToken();
          regenerated[key] = this.sharedSecrets[key];
        }
      }
      if (Object.keys(regenerated).length > 0) {
        await this.updateEnvFilePreservingComments(envPath, envPath, regenerated);
        console.log(`🔑 Regenerated in the gateway .env: ${Object.keys(regenerated).join(', ')}`);
      }
      
      return;
    }
    
    if (fs.existsSync(envPath) && this.forceOverwrite) {
      console.log('⚠️  Overwriting existing Gateway .env file (--force flag used)');
    }
    
    console.log('📝 Creating Gateway .env file...');
    
    // Prepare updates
    const updates = {};
    
    // Use provided SAP config (null: skipped) or prompt for it
    const sapConfigToUse = sapConfig !== undefined ? sapConfig : await this.promptForServiceKey();
    
    if (sapConfigToUse) {
      // Apply SAP AI Core configuration
      Object.assign(updates, sapConfigToUse);
    }
    
    // Apply shared secrets
    updates.VALIDATION_TOKEN_SECRET = this.sharedSecrets.VALIDATION_TOKEN_SECRET;
    updates.METADATA_ENCRYPTION_KEY = this.sharedSecrets.METADATA_ENCRYPTION_KEY;
    
    // Copy .env.sample to .env with updates, preserving comments
    await this.updateEnvFilePreservingComments(samplePath, envPath, updates);
    console.log('✅ Gateway .env created successfully');
    
    if (sapConfig) {
      console.log('');
      console.log('🔒 SECURITY WARNING: SAP AI Core credentials stored in .env file');
      console.log('   For production deployments, consider using:');
      console.log('   - OS environment variables (export CLIENT_SECRET=xxx)');
      console.log('   - Docker secrets or Kubernetes secrets');
      console.log('   - External secret management (HashiCorp Vault, etc.)');
      console.log('   - Set file permissions: chmod 600 services/gateway/.env');
    }
  }

  /**
   * An admin .env from before Connections has no CONNECTION_CREDENTIAL_KEY (or the .env.sample
   * placeholder): add a generated one, leaving every other line as it is. Without it the admin
   * refuses to store a connection credential. A real key is never replaced.
   */
  async ensureConnectionCredentialKey(envPath) {
    const existing = (await this.parseEnvFile(envPath)).CONNECTION_CREDENTIAL_KEY;
    if (existing && existing !== 'changeme') return;
    const key = this.sharedSecrets.CONNECTION_CREDENTIAL_KEY || this.generateSecureToken();
    this.sharedSecrets.CONNECTION_CREDENTIAL_KEY = key;
    if (existing === 'changeme') {
      await this.updateEnvFilePreservingComments(envPath, envPath, { CONNECTION_CREDENTIAL_KEY: key });
    } else {
      const text = fs.readFileSync(envPath, 'utf8');
      fs.appendFileSync(envPath, `${text.endsWith('\n') ? '' : '\n'}\n# Master key for the Connection credentials (added by setup-docker.js)\nCONNECTION_CREDENTIAL_KEY=${key}\n`, 'utf8');
    }
    console.log('🔑 Admin .env had no CONNECTION_CREDENTIAL_KEY: added a generated one');
  }

  async setupAdminEnv(dbConfig = null) {
    const envPath = path.join(this.projectRoot, 'services/admin/.env');
    const samplePath = path.join(this.projectRoot, 'services/admin/.env.sample');
    
    if (fs.existsSync(envPath) && !this.forceOverwrite) {
      // Check if we need to update database credentials even in existing file
      const needsDbUpdate = (dbConfig && (dbConfig.POSTGRES_USER || dbConfig.POSTGRES_PASSWORD)) ||
                           (this.sharedSecrets.POSTGRES_USER || this.sharedSecrets.POSTGRES_PASSWORD);
      
      if (!needsDbUpdate) {
        // A publicly known secret here would not match the generated one setupGatewayEnv put in
        // its place; replace it in the existing file, leaving everything else as it is.
        const existingSecret = (await this.parseEnvFile(envPath)).VALIDATION_TOKEN_SECRET;
        if (PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS.includes(existingSecret) && this.sharedSecrets.VALIDATION_TOKEN_SECRET) {
          await this.updateEnvFilePreservingComments(envPath, envPath, { VALIDATION_TOKEN_SECRET: this.sharedSecrets.VALIDATION_TOKEN_SECRET });
          console.log('🔑 Admin .env held the default or .env.sample VALIDATION_TOKEN_SECRET: replaced with the shared generated one');
        }
        await this.ensureConnectionCredentialKey(envPath);
        console.log('✅ Admin .env already exists');
        return;
      } else {
        console.log('🔄 Admin .env exists, but updating database credentials...');
      }
    }
    
    if (fs.existsSync(envPath) && this.forceOverwrite) {
      console.log('⚠️  Overwriting existing Admin .env file (--force flag used)');
    }
    
    console.log('📝 Creating Admin .env file...');
    
    // This rewrites .env from .env.sample, so a real SIEM_CREDENTIAL_KEY already in the
    // existing file is carried over rather than replaced - the same carry-over setupGatewayEnv
    // does for its shared secrets. Rotating this key does not merely re-key the
    // SiemCredentials rows: it makes every stored SIEM sink credential undecryptable, and they
    // must be re-entered by hand. A database-credential update pass must not cost that
    // silently. The `else if` is the independent guard FILE_SEARCH_RUNTIME_PASSWORD needs for
    // the same reason - a caller supplying `--config` (or a pre-populated sharedSecrets) skips
    // the generation block in setupServiceEnvFiles entirely, and without this the placeholder
    // `changeme` from .env.sample would be written through as the master key.
    // A key the user chose to regenerate is not carried over: the value generated for this run
    // replaces it.
    const existingAdminEnv = fs.existsSync(envPath) ? await this.parseEnvFile(envPath) : {};
    const regenerate = this.answers.regenerateKeys || [];
    if (regenerate.includes('SIEM_CREDENTIAL_KEY')) {
      this.sharedSecrets.SIEM_CREDENTIAL_KEY = this.generateSecureToken();
    } else if (existingAdminEnv.SIEM_CREDENTIAL_KEY && existingAdminEnv.SIEM_CREDENTIAL_KEY !== 'changeme') {
      this.sharedSecrets.SIEM_CREDENTIAL_KEY = existingAdminEnv.SIEM_CREDENTIAL_KEY;
    } else if (!this.sharedSecrets.SIEM_CREDENTIAL_KEY) {
      this.sharedSecrets.SIEM_CREDENTIAL_KEY = this.generateSecureToken();
    }
    // Same carry-over for the Connection credentials' master key: rotating it would make every
    // stored connection credential undecryptable.
    if (regenerate.includes('CONNECTION_CREDENTIAL_KEY')) {
      this.sharedSecrets.CONNECTION_CREDENTIAL_KEY = this.generateSecureToken();
    } else if (existingAdminEnv.CONNECTION_CREDENTIAL_KEY && existingAdminEnv.CONNECTION_CREDENTIAL_KEY !== 'changeme') {
      this.sharedSecrets.CONNECTION_CREDENTIAL_KEY = existingAdminEnv.CONNECTION_CREDENTIAL_KEY;
    } else if (!this.sharedSecrets.CONNECTION_CREDENTIAL_KEY) {
      this.sharedSecrets.CONNECTION_CREDENTIAL_KEY = this.generateSecureToken();
    }
    
    // Prepare updates
    const updates = {};
    
    // Apply shared secrets (must match gateway)
    updates.VALIDATION_TOKEN_SECRET = this.sharedSecrets.VALIDATION_TOKEN_SECRET;
    updates.METADATA_ENCRYPTION_KEY = this.sharedSecrets.METADATA_ENCRYPTION_KEY;
    updates.AWS_SECRET_ENCRYPTION_KEY = this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY;
    // Admin-only: encrypts the SiemCredentials rows the SIEM sinks authenticate with.
    updates.SIEM_CREDENTIAL_KEY = this.sharedSecrets.SIEM_CREDENTIAL_KEY;
    // Admin-only: encrypts the Connection credentials (ConnectionCredentials rows).
    updates.CONNECTION_CREDENTIAL_KEY = this.sharedSecrets.CONNECTION_CREDENTIAL_KEY;
    
    // Include database credentials for CAP configuration replacement
    if (this.sharedSecrets.POSTGRES_PASSWORD) {
      updates.POSTGRES_PASSWORD = this.sharedSecrets.POSTGRES_PASSWORD;
    }
    
    // Include database username if provided (from Kyma setup or sharedSecrets)
    if (dbConfig && dbConfig.POSTGRES_USER) {
      updates.POSTGRES_USER = dbConfig.POSTGRES_USER;
    } else if (this.sharedSecrets.POSTGRES_USER) {
      updates.POSTGRES_USER = this.sharedSecrets.POSTGRES_USER;
    }
    
    // Note: DEPLOY_TARGET should be set to 'docker' for Docker deployment
    // but we keep it as the sample default for flexibility
    // docker-compose.yml will override it anyway
    
    // ROLE_MAPPING will be set based on auth provider selection
    // This is handled later in the auth setup
    
    // Copy .env.sample to .env with updates, preserving comments
    await this.updateEnvFilePreservingComments(samplePath, envPath, updates);
    console.log('✅ Admin .env created successfully');
  }

  async setupOllamaEnv() {
    const envPath = path.join(this.projectRoot, 'services/ollama/.env');
    const samplePath = path.join(this.projectRoot, 'services/ollama/.env.sample');
    
    if (fs.existsSync(envPath) && !this.forceOverwrite) {
      console.log('✅ Ollama .env already exists');
      return;
    }
    
    if (fs.existsSync(envPath) && this.forceOverwrite) {
      console.log('⚠️  Overwriting existing Ollama .env file (--force flag used)');
    }
    
    console.log('📝 Creating Ollama .env file...');
    
    // Prepare updates
    const updates = {};
    
    // Note: For Docker deployment, you may want to set:
    // - OLLAMA_HOST=0.0.0.0 (to listen on all interfaces)
    // - MAIN_PROXY_URL=http://gateway:3000 (Docker service name)
    // But we keep the sample defaults for flexibility
    
    // Copy .env.sample to .env with updates, preserving comments
    await this.updateEnvFilePreservingComments(samplePath, envPath, updates);
    console.log('✅ Ollama .env created successfully');
  }

  async showWelcome() {
    console.log('\n' + '='.repeat(60));
    console.log('   SAIL-PROXY Docker Setup');
    console.log('='.repeat(60));
    console.log('\nThis script will help you configure the SAP LLM Gateway');
    console.log('for Docker deployment, including:');
    console.log('  - Service environment files (.env)');
    console.log('  - Authentication providers');
    console.log('  - Security tokens and secrets\n');
    
    if (this.ciMode) {
      console.log('🤖 Running in CI/CD mode - using default options');
      console.log('   - Local Development authentication');
      console.log('   - No backup creation');
      console.log('   - Localhost deployment\n');
    }
    
    if (this.forceOverwrite) {
      console.log('⚠️  Running in FORCE mode - existing .env files will be overwritten!\n');
    }
  }

  async selectProvider() {
    console.log('Available authentication providers:\n');
    
    const providerKeys = Object.keys(PROVIDERS);
    const choices = providerKeys.map((key) => {
      const provider = PROVIDERS[key];
      let name = provider.name;
      if (provider.warning) {
        name += ` - ${provider.warning}`;
      }
      return {
        name: name,
        value: key,
        short: provider.name
      };
    });

    const { provider } = await this.prompt([
      {
        type: 'list',
        name: 'provider',
        message: 'Select authentication provider:',
        choices: choices
      }
    ]);

    return provider;
  }

  /** The provider settings an unattended (--ci) run uses: every question's default. */
  defaultProviderConfig(provider) {
    const prompts = PROVIDER_PROMPTS[provider];
    if (!prompts || prompts.length === 0) return {};

    // Return default values for all prompts
    const config = {};
    prompts.forEach(prompt => {
      if (prompt.default !== undefined) {
        config[prompt.key] = prompt.default;
      }
    });
    
    // Generate ROLE_MAPPING based on provider
    if (provider === 'local') {
      config.ROLE_MAPPING = '{"admin@example.com":"admin","user@example.com":"user"}';
    }
    
    return config;
  }

  async collectProviderConfig(provider) {
    let prompts = PROVIDER_PROMPTS[provider];
    if (!prompts || prompts.length === 0) return {};

    console.log(`\nConfiguring ${PROVIDERS[provider].name}...\n`);
    
    const config = {};
    
    // Convert prompts to inquirer format
    const inquirerPrompts = [];
    
    for (const prompt of prompts) {
      const inquirerPrompt = {
        name: prompt.key,
        message: prompt.prompt,
        default: prompt.default
      };
      
      // Set the appropriate type
      if (prompt.secret) {
        inquirerPrompt.type = 'password';
      } else if (prompt.options) {
        inquirerPrompt.type = 'list';
        inquirerPrompt.choices = prompt.options;
      } else {
        inquirerPrompt.type = 'input';
      }
      
      // Add validation for required fields
      if (prompt.required) {
        inquirerPrompt.validate = (input) => {
          if (!input.trim()) {
            return 'This field is required.';
          }
          return true;
        };
      }
      
      // Special handling for Okta auto-fetch
      if (prompt.key === 'OKTA_SAML_CA_DATA' && prompt.default === 'auto-fetch-from-metadata') {
        inquirerPrompt.type = 'list';
        inquirerPrompt.choices = [
          { name: 'Auto-fetch from metadata URL', value: 'auto-fetch-from-metadata' },
          { name: 'Enter certificate manually', value: 'manual' }
        ];
        inquirerPrompt.default = 'auto-fetch-from-metadata';
      }
      
      inquirerPrompts.push(inquirerPrompt);
    }
    
    // Collect all answers at once
    const answers = await this.prompt(inquirerPrompts);
    
    // Process answers
    for (const [key, value] of Object.entries(answers)) {
      if (key === 'OKTA_SAML_CA_DATA' && value === 'auto-fetch-from-metadata') {
        // Handle auto-fetch
        if (answers.OKTA_METADATA_URL) {
          try {
            console.log('Auto-fetching SAML certificate from metadata...');
            // A read-only probe: fetched once per metadata URL while the answers are collected.
            const fetchMetadata = () => this.fetchSamlCertificateFromMetadata(answers.OKTA_METADATA_URL);
            const metadataInfo = this.session
              ? await this.session.once(`saml-metadata:${answers.OKTA_METADATA_URL}`, fetchMetadata)
              : await fetchMetadata();
            config[key] = metadataInfo.certificate;
            
            // Auto-populate SSO URL (always override with metadata value)
            if (metadataInfo.ssoUrl) {
              config.OKTA_SSO_URL = metadataInfo.ssoUrl;
              console.log(`✅ SSO URL auto-populated: ${metadataInfo.ssoUrl}`);
            }
          } catch (error) {
            console.log(`❌ Auto-fetch failed: ${error.message}`);
            // Ask for manual input
            const { manualCert } = await this.prompt([
              {
                type: 'editor',
                name: 'manualCert',
                message: 'Please enter the certificate data manually:',
                validate: (input) => input.trim() ? true : 'Certificate data is required'
              }
            ]);
            config[key] = manualCert;
          }
        } else {
          console.log('❌ Metadata URL required for auto-fetch.');
          // Ask for manual input
          const { manualCert } = await this.prompt([
            {
              type: 'editor',
              name: 'manualCert',
              message: 'Please enter the certificate data manually:',
              validate: (input) => input.trim() ? true : 'Certificate data is required'
            }
          ]);
          config[key] = manualCert;
        }
      } else if (key === 'OKTA_SAML_CA_DATA' && value === 'manual') {
        // Ask for manual input
        const { manualCert } = await this.prompt([
          {
            type: 'editor',
            name: 'manualCert',
            message: 'Please enter the certificate data:',
            validate: (input) => input.trim() ? true : 'Certificate data is required'
          }
        ]);
        config[key] = manualCert;
      } else {
        config[key] = value;
      }
    }
    
    // Handle LDAP external configuration
    if (provider === 'ldap' && config.LDAP_SERVER_TYPE === 'external') {
      console.log('\nConfiguring external LDAP server...\n');
      const externalPrompts = PROVIDER_PROMPTS['ldap-external'];
      
      // Convert external prompts to inquirer format
      const inquirerExternalPrompts = externalPrompts.map(prompt => {
        const inquirerPrompt = {
          name: prompt.key,
          message: prompt.prompt,
          default: prompt.default
        };
        
        // Set the appropriate type
        if (prompt.secret) {
          inquirerPrompt.type = 'password';
        } else {
          inquirerPrompt.type = 'input';
        }
        
        // Add validation for required fields
        if (prompt.required) {
          inquirerPrompt.validate = (input) => {
            if (!input.trim()) {
              return 'This field is required.';
            }
            return true;
          };
        }
        
        return inquirerPrompt;
      });
      
      // Collect external LDAP configuration
      const externalAnswers = await this.prompt(inquirerExternalPrompts);
      Object.assign(config, externalAnswers);
    }
    
    // Note: auto-shell resolution for LOGOUT_REDIRECT_URL happens later in copyAndConfigureFiles()
    // when baseUrl is available
    
    // Generate ROLE_MAPPING based on provider
    if (provider === 'github') {
      // Generate ROLE_MAPPING for GitHub
      const roleMapping = {};
      
      // Handle case where GITHUB_ORG might be empty
      if (config.GITHUB_ORG) {
        // With organization prefix: "ORG:team"
        roleMapping[`${config.GITHUB_ORG}:${config.GITHUB_ADMIN_TEAM}`] = 'admin';
        roleMapping[`${config.GITHUB_ORG}:${config.GITHUB_USER_TEAM}`] = 'user';
      } else {
        // Without organization prefix (just team names)
        roleMapping[config.GITHUB_ADMIN_TEAM] = 'admin';
        roleMapping[config.GITHUB_USER_TEAM] = 'user';
      }
      
      config.ROLE_MAPPING = JSON.stringify(roleMapping);
    } else if (provider === 'local') {
      // For local provider, ROLE_MAPPING is same as LOCAL_USER_MAPPING (hardcoded in template)
      // The template already has LOCAL_USER_MAPPING={"admin@example.com":"admin","user@example.com":"user"}
      config.ROLE_MAPPING = '{"admin@example.com":"admin","user@example.com":"user"}';
    } else if (provider === 'okta') {
      // Generate ROLE_MAPPING for Okta
      const roleMapping = {};
      
      // Map Okta groups to application roles
      if (config.OKTA_ADMIN_GROUP) {
        roleMapping[config.OKTA_ADMIN_GROUP] = 'admin';
      }
      if (config.OKTA_USER_GROUP) {
        roleMapping[config.OKTA_USER_GROUP] = 'user';
      }
      
      config.ROLE_MAPPING = JSON.stringify(roleMapping);
    } else if (provider === 'ldap') {
      // Generate ROLE_MAPPING for LDAP
      const roleMapping = {};
      
      // Map LDAP groups to application roles
      if (config.LDAP_ADMIN_GROUP) {
        roleMapping[config.LDAP_ADMIN_GROUP] = 'admin';
      }
      if (config.LDAP_USER_GROUP) {
        roleMapping[config.LDAP_USER_GROUP] = 'user';
      }
      
      config.ROLE_MAPPING = JSON.stringify(roleMapping);
    }
    
    return config;
  }

  async getBaseUrl() {
    console.log('\nDeployment configuration:');
    const { useDevelopment } = await this.prompt([
      {
        type: 'confirm',
        name: 'useDevelopment',
        message: 'Use localhost for development?',
        default: true
      }
    ]);
    
    if (useDevelopment) {
      return 'http://localhost:8080';
    }
    
    const { baseUrl } = await this.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Enter your domain (e.g., https://yourdomain.com):',
        validate: validateBaseUrl
      }
    ]);
    
    return baseUrl.trim().replace(/\/$/, ''); // Remove trailing slash
  }

  async selectImageMode() {
    console.log('\n' + '='.repeat(60));
    console.log('   Docker Image Configuration');
    console.log('='.repeat(60));
    console.log('\nChoose how Docker images should be managed:');
    console.log('  • Local builds: Build images on this machine (recommended for development)');
    console.log('  • Pull from registry: Use pre-built images from a container registry (faster startup)');
    console.log('');

    const { imageMode } = await this.prompt([
      {
        type: 'list',
        name: 'imageMode',
        message: 'Select image mode:',
        choices: [
          { name: 'Build locally (development mode)', value: 'local' },
          { name: 'Pull from container registry (production mode)', value: 'registry' }
        ],
        default: 'local'
      }
    ]);

    let registry = 'ghcr.io';
    let organization = 'st-gr';

    if (imageMode === 'registry') {
      const registryConfig = await this.prompt([
        {
          type: 'input',
          name: 'registry',
          message: 'Container registry (e.g., ghcr.io, docker.io):',
          default: 'ghcr.io',
          validate: validateRequired('Registry is required')
        },
        {
          type: 'input',
          name: 'organization',
          message: 'Registry organization/username:',
          default: 'st-gr',
          validate: validateRequired('Organization is required')
        }
      ]);

      registry = registryConfig.registry.trim();
      organization = registryConfig.organization.trim();
    }

    return { imageMode, registry, organization };
  }

  /** tag: the image tag to write (sail-proxy upgrade); default the project's package.json version. */
  async configureDockerImages(imageMode, registry, organization, tag = undefined) {
    console.log('\nConfiguring Docker image settings...');

    const version = tag || this.projectVersion();

    // Create .env.docker file. Registry mode also records DOCKER_IMAGE_MODE=registry: the files
    // otherwise look the same in both modes (local builds use the default registry and the
    // compose override can be replaced or removed by the provider step), and a re-run reads the
    // mode back from it. Local mode (all --ci runs) writes the file as before.
    const envDockerPath = path.join(this.dockerDir, '.env.docker');
    const envDockerContent = `# Docker Image Configuration
# This file controls which Docker images are used in docker-compose.yml
#
# Registry: The container registry hostname (e.g., ghcr.io, docker.io)
# Organization: Your organization or username on the registry
# Tag: The image version tag (automatically extracted from package.json)

DOCKER_REGISTRY=${registry}
DOCKER_ORGANIZATION=${organization}
DOCKER_TAG=${version}
${imageMode === 'registry' ? 'DOCKER_IMAGE_MODE=registry\n' : ''}
# Note: This file is auto-generated by docker/setup-docker.js
# You can manually edit these values if needed
`;

    fs.writeFileSync(envDockerPath, envDockerContent);
    console.log(`✅ Created .env.docker with ${imageMode} mode configuration`);

    // Create or remove docker-compose.override.yml based on mode
    const overridePath = path.join(this.dockerDir, 'docker-compose.override.yml');

    if (imageMode === 'local') {
      // Create override file for local builds
      const overrideContent = `${LOCAL_BUILD_OVERRIDE_HEADER}
#
# This file is automatically loaded by docker-compose and overrides settings
# in docker-compose.yml. It forces Docker to build images locally instead of
# pulling them from a registry.
#
# This is useful for:
#   - Local development with code changes
#   - Testing Dockerfile modifications
#   - Building custom images before pushing to registry
#
# To disable local builds and use registry images:
#   1. Rename or remove this file
#   2. Or use: docker-compose -f docker-compose.yml up (skip override)
#   3. Or use: docker/scripts/use-registry-only.sh
#
# To force local builds:
#   docker-compose up --build
#

services:
  gateway:
    pull_policy: build

  admin:
    pull_policy: build

  ollama:
    pull_policy: build

  nginx:
    pull_policy: build
`;
      setAsideForeignOverride(overridePath);
      fs.writeFileSync(overridePath, overrideContent);
      console.log('✅ Created docker-compose.override.yml for local builds');
    } else {
      // Remove the local-build override this script wrote (registry mode). An override of the
      // admin's own (ports, volumes, limits) is theirs: kept, or an upgrade would lose it.
      if (fs.existsSync(overridePath) && !isSetupOverride(overridePath)) {
        console.log('ℹ️  Kept docker/docker-compose.override.yml (not the local-build file this setup writes)');
      } else if (fs.existsSync(overridePath)) {
        fs.unlinkSync(overridePath);
        console.log('✅ Removed docker-compose.override.yml (registry mode)');
      }
    }

    console.log('');
    
    // Create OR REFRESH .env for manual docker-compose commands.
    //
    // `docker compose` auto-loads `.env` from this directory and never reads
    // `.env.docker` — only the explicit `--env-file` invocations further down
    // do. This block previously ran only when `.env` was ABSENT, so once
    // created it never changed again: a version bump updated package.json and
    // .env.docker while `.env` kept the tag it was born with, and every manual
    // `docker compose up` silently ran whatever images still matched that stale
    // tag. Observed as .env pinning DOCKER_TAG=0.9.0 against a 0.9.4 repo, with
    // one profile-gated service left on a two-month-old image under that tag.
    //
    // The DOCKER_* keys are rewritten in place rather than the file being
    // overwritten, because its own header invites manual edits.
    const envPath = path.join(this.dockerDir, '.env');

    if (fs.existsSync(envDockerPath)) {
      try {
        if (!fs.existsSync(envPath)) {
          fs.writeFileSync(envPath, fs.readFileSync(envDockerPath, 'utf8'), 'utf8');
          console.log('✅ Created .env file for manual docker-compose commands');
        } else {
          const desired = {
            DOCKER_REGISTRY: registry,
            DOCKER_ORGANIZATION: organization,
            DOCKER_TAG: version
          };
          let content = fs.readFileSync(envPath, 'utf8');
          const changes = [];

          for (const [key, value] of Object.entries(desired)) {
            const line = new RegExp(`^${key}=(.*)$`, 'm');
            const found = content.match(line);

            if (!found) {
              content += `${content.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
              changes.push(`${key} added as ${value}`);
            } else if (found[1].trim() !== String(value)) {
              content = content.replace(line, `${key}=${value}`);
              changes.push(`${key} ${found[1].trim()} -> ${value}`);
            }
          }

          if (changes.length > 0) {
            fs.writeFileSync(envPath, content, 'utf8');
            console.log(`✅ Updated .env (${changes.join('; ')})`);
          } else {
            console.log('✅ .env already matches the configured images');
          }
        }
      } catch (error) {
        console.log(`⚠️  Warning: Could not create or update .env file: ${error.message}`);
      }
    }
    
    // Store image mode and registry config for completion logic
    this.imageMode = imageMode;
    this.registryConfig = { registry, organization, version };
    
    return { registry, organization, version };
  }

  /** The project's package.json version, '1.0.0' when it cannot be read. */
  projectVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf8')).version || '1.0.0';
    } catch (error) {
      console.log('⚠️  Warning: Could not read version from package.json, using default: 1.0.0');
      return '1.0.0';
    }
  }

  /** Files a backup copies, relative to docker/. */
  backupFileList() {
    return [
      'nginx.conf',
      'dex.config.yaml',
      '.env.auth',
      '.env.postgres',
      'docker-compose.override.yml',
      '../services/gateway/.env',
      '../services/admin/.env',
      '../services/ollama/.env'
    ];
  }

  hasExistingConfigFiles() {
    return this.backupFileList().some(file =>
      fs.existsSync(path.join(this.dockerDir, file))
    );
  }

  /** createBackup: the answer to "Create backup?" (asked before the review). */
  async backupExistingFiles(createBackup) {
    const filesToBackup = this.backupFileList();
    
    if (this.hasExistingConfigFiles()) {
      if (this.ciMode) {
        console.log('🤖 CI Mode: Existing configuration files detected - skipping backup\n');
        return;
      }
      
      if (createBackup) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(this.dockerDir, `backup-${timestamp}`);
        
        fs.mkdirSync(backupDir, { recursive: true });
        
        filesToBackup.forEach(file => {
          const filePath = path.join(this.dockerDir, file);
          if (fs.existsSync(filePath)) {
            const backupPath = path.join(backupDir, file);
            // Ensure backup subdirectory exists
            const backupSubDir = path.dirname(backupPath);
            if (!fs.existsSync(backupSubDir)) {
              fs.mkdirSync(backupSubDir, { recursive: true });
            }
            fs.copyFileSync(filePath, backupPath);
          }
        });
        
        console.log(`✅ Backup created in: ${backupDir}`);
      }
    }
  }

  async copyAndConfigureFiles(provider, providerConfig, baseUrl, dbConfig = null) {
    console.log('\nCopying and configuring files...');
    
    const providerInfo = PROVIDERS[provider];
    const config = { baseUrl, provider, ...providerConfig, ...dbConfig };
    
    // Update admin .env with ROLE_MAPPING based on auth provider
    const adminEnvPath = path.join(this.projectRoot, 'services/admin/.env');
    if (fs.existsSync(adminEnvPath) && config.ROLE_MAPPING) {
      // Use the comment-preserving update method
      await this.updateEnvFilePreservingComments(adminEnvPath, adminEnvPath, {
        ROLE_MAPPING: config.ROLE_MAPPING
      });
      console.log('✅ Updated admin .env with ROLE_MAPPING');
    }
    
    // NOTE: nginx.conf is no longer generated here
    // The new Nginx image uses environment variables for configuration
    console.log('ℹ️  Nginx configuration is now handled via environment variables');
    console.log('   See docker/nginx/README.md for details');
    
    // .env.postgres carries the privileged migration DSN (consumed only by
    // the one-shot gateway-migrate compose service); .env.filesearch-runtime
    // carries the restricted runtime DSN the long-running gateway service
    // actually uses. Kept as two files, not one, specifically so
    // docker-compose.yml can hand each service only the file it needs —
    // see that file's `gateway` vs `gateway-migrate` service definitions.
    const sharedFiles = ['.env.postgres', '.env.filesearch-runtime'];
    for (const file of sharedFiles) {
      const srcPath = path.join(this.configsDir, 'shared', file);
      const destPath = path.join(this.dockerDir, file);
      
      if (fs.existsSync(srcPath)) {
        let content = fs.readFileSync(srcPath, 'utf8');
        
        // Apply comprehensive secret replacement to shared files using precise patterns
        if (file === '.env.postgres') {
          // Handle CAP database configuration format: cds.requires.db.credentials.user=value
          if (this.sharedSecrets.POSTGRES_USER) {
            content = content.replace(
              /cds\.requires\.db\.credentials\.user=[^\s\n]+/g,
              `cds.requires.db.credentials.user=${this.sharedSecrets.POSTGRES_USER}`
            );
          }
          if (this.sharedSecrets.POSTGRES_PASSWORD) {
            content = content.replace(
              /cds\.requires\.db\.credentials\.password=[^\s\n]+/g,
              `cds.requires.db.credentials.password=${this.sharedSecrets.POSTGRES_PASSWORD}`
            );
          }
          // FILE_SEARCH_MIGRATION_DATABASE_URL is a plain env var embedded in
          // this CAP-style file (the gateway reads it via process.env, not
          // CDS config), so its user/password segments need their own
          // replacement, scoped to that one line so they can't collide with
          // the cds.requires.db.credentials.* keys above or with each other.
          // Unlike those CAP keys (plain key=value, never parsed as a URI),
          // this segment is embedded in an actual postgresql:// URL, so
          // reserved URI characters in a manually-entered username/password
          // (e.g. "/", which pg-connection-string rejects outright with
          // "Invalid URL") must be percent-encoded — encodeURIComponent also
          // neutralises any literal "$" in the value, which would otherwise
          // be misread as a regex backreference by the capturing-group
          // replacement below.
          if (this.sharedSecrets.POSTGRES_USER) {
            content = content.replace(
              /(FILE_SEARCH_MIGRATION_DATABASE_URL=postgresql:\/\/)[^:]+(:)/,
              `$1${encodeURIComponent(this.sharedSecrets.POSTGRES_USER)}$2`
            );
          }
          if (this.sharedSecrets.POSTGRES_PASSWORD) {
            content = content.replace(
              /(FILE_SEARCH_MIGRATION_DATABASE_URL=postgresql:\/\/[^:]+:)[^@]+(@)/,
              `$1${encodeURIComponent(this.sharedSecrets.POSTGRES_PASSWORD)}$2`
            );
          }
        } else if (file === '.env.filesearch-runtime') {
          // Same percent-encoding rationale as FILE_SEARCH_MIGRATION_DATABASE_URL
          // above, applied to the restricted runtime role's own DSN.
          if (this.sharedSecrets.FILE_SEARCH_RUNTIME_USER) {
            content = content.replace(
              /(FILE_SEARCH_DATABASE_URL=postgresql:\/\/)[^:]+(:)/,
              `$1${encodeURIComponent(this.sharedSecrets.FILE_SEARCH_RUNTIME_USER)}$2`
            );
          }
          if (this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD) {
            content = content.replace(
              /(FILE_SEARCH_DATABASE_URL=postgresql:\/\/[^:]+:)[^@]+(@)/,
              `$1${encodeURIComponent(this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD)}$2`
            );
          }
        } else {
          // Handle standard environment variable format: KEY=value
          if (this.sharedSecrets.POSTGRES_USER) {
            content = content.replace(
              /POSTGRES_USER=[^\s\n]+/g,
              `POSTGRES_USER=${this.sharedSecrets.POSTGRES_USER}`
            );
          }
          if (this.sharedSecrets.POSTGRES_PASSWORD) {
            content = content.replace(
              /POSTGRES_PASSWORD=[^\s\n]+/g,
              `POSTGRES_PASSWORD=${this.sharedSecrets.POSTGRES_PASSWORD}`
            );
          }
        }
        
        fs.writeFileSync(destPath, content);
        console.log(`✅ ${path.basename(destPath)} configured`);
      }
    }
    
    // Export BASE_URL for docker-compose to use
    const nginxEnvPath = path.join(this.dockerDir, '.env.nginx');
    const nginxEnvContent = `# Nginx configuration environment variables
# Generated by setup-docker.js
BASE_URL=${baseUrl}
LOGOUT_REDIRECT_URL=${config.LOGOUT_REDIRECT_URL || `${baseUrl}/admin/app/shell/`}
REQUEST_TIMEOUT_SECONDS=900  # Request timeout in seconds (default: 15 minutes)
`;
    fs.writeFileSync(nginxEnvPath, nginxEnvContent);
    console.log(`✅ .env.nginx created with BASE_URL=${baseUrl}`);
    
    // Write the generated database credentials to docker/.env, NOT into
    // docker-compose.yml.
    //
    // This used to rewrite the POSTGRES_USER= / POSTGRES_PASSWORD= literals in
    // docker-compose.yml with a global regex. docker-compose.yml is TRACKED, so
    // every setup run planted a live database password in a file staged for
    // commit — observed as a real secret sitting in `git diff` after a routine
    // setup. The compose file now carries
    //   POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-admin_password}
    // and takes the real value from here instead.
    //
    // docker/.env specifically: compose substitutes ${VAR} only from the shell
    // and from docker/.env, never from an `env_file:` — see the note on the
    // gateway service in docker-compose.yml. Putting these in .env.postgres or
    // .env.auth would silently fall back to the placeholders.
    const envForComposePath = path.join(this.dockerDir, '.env');
    const composeCreds = {
      POSTGRES_USER: this.sharedSecrets.POSTGRES_USER,
      POSTGRES_PASSWORD: this.sharedSecrets.POSTGRES_PASSWORD
    };

    try {
      let envForCompose = fs.existsSync(envForComposePath)
        ? fs.readFileSync(envForComposePath, 'utf8')
        : '';
      const written = [];

      for (const [key, value] of Object.entries(composeCreds)) {
        if (!value) continue;
        const line = new RegExp(`^${key}=.*$`, 'm');
        if (line.test(envForCompose)) {
          envForCompose = envForCompose.replace(line, `${key}=${value}`);
        } else {
          if (envForCompose.length > 0 && !envForCompose.endsWith('\n')) {
            envForCompose += '\n';
          }
          envForCompose += `${key}=${value}\n`;
        }
        written.push(key);
      }

      if (written.length > 0) {
        fs.writeFileSync(envForComposePath, envForCompose, 'utf8');
        console.log(`✅ Database credentials written to docker/.env (${written.join(', ')})`);
      }
    } catch (error) {
      console.log(`⚠️  Warning: Could not write database credentials to docker/.env: ${error.message}`);
    }
    
    // Update dex.config.yaml with database credentials
    const dexConfigPath = path.join(this.dockerDir, 'dex.config.yaml');
    if (fs.existsSync(dexConfigPath)) {
      let dexConfigContent = fs.readFileSync(dexConfigPath, 'utf8');
      
      // Replace database user in YAML format (match any existing value)
      if (this.sharedSecrets.POSTGRES_USER) {
        dexConfigContent = dexConfigContent.replace(
          /(\s+)user:\s*[^\s\n]+/g,
          `$1user: ${this.sharedSecrets.POSTGRES_USER}`
        );
      }
      
      // Replace database password in YAML format (match any existing value)
      if (this.sharedSecrets.POSTGRES_PASSWORD) {
        dexConfigContent = dexConfigContent.replace(
          /(\s+)password:\s*[^\s\n]+/g,
          `$1password: ${this.sharedSecrets.POSTGRES_PASSWORD}`
        );
      }
      
      fs.writeFileSync(dexConfigPath, dexConfigContent, 'utf8');
      console.log(`✅ dex.config.yaml updated with database credentials`);
    }
    
    // Copy provider-specific files
    for (const file of providerInfo.files) {
      let srcPath = path.join(this.configsDir, 'providers', provider, file);
      
      // Handle LDAP external configuration
      if (provider === 'ldap' && config.LDAP_SERVER_TYPE === 'external' && file === 'dex.config.yaml') {
        srcPath = path.join(this.configsDir, 'providers', provider, 'dex.config.external.yaml');
      }
      
      if (!fs.existsSync(srcPath)) {
        console.log(`⚠️  Warning: Provider file ${file} not found at ${srcPath}`);
        continue;
      }
      
      let destPath;
      let content = fs.readFileSync(srcPath, 'utf8');
      
      if (file === '.env.auth') {
        destPath = path.join(this.dockerDir, '.env.auth');
      } else {
        destPath = path.join(this.dockerDir, file);
      }
      
      // Replace placeholders - handle variable references first (more specific pattern)
      content = content.replace(/\$\{BASE_URL\}/g, baseUrl);
      
      // For YAML files (like dex.config.yaml), replace plain BASE_URL placeholders
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        content = content.replace(/BASE_URL/g, baseUrl);
      }
      
      // Configure logout redirect URL - provider-specific with auto-shell resolution
      let logoutRedirectUrl;
      if (config.LOGOUT_REDIRECT_URL === 'auto-shell') {
        logoutRedirectUrl = `${baseUrl}/admin/app/shell/`;
      } else if (config.LOGOUT_REDIRECT_URL) {
        logoutRedirectUrl = config.LOGOUT_REDIRECT_URL;
      } else {
        // Fallback for older configurations
        logoutRedirectUrl = `${baseUrl}/admin/app/shell/`;
      }
      content = content.replace(/__LOGOUT_REDIRECT_URL__/g, logoutRedirectUrl);
      
      // Validation: ensure no unresolved variables remain
      const unresolvedVars = content.match(/\$\{[^}]+\}/g);
      if (unresolvedVars) {
        console.warn(`⚠️  Warning: Unresolved variables in ${file}:`, unresolvedVars);
      }
      
      // Replace database credentials using precise patterns for provider-specific files
      if (file.endsWith('.env.auth') || file.endsWith('.env')) {
        // Handle environment variable format: KEY=value
        if (this.sharedSecrets.POSTGRES_USER) {
          content = content.replace(
            /POSTGRES_USER=[^\s\n]+/g,
            `POSTGRES_USER=${this.sharedSecrets.POSTGRES_USER}`
          );
        }
        if (this.sharedSecrets.POSTGRES_PASSWORD) {
          content = content.replace(
            /POSTGRES_PASSWORD=[^\s\n]+/g,
            `POSTGRES_PASSWORD=${this.sharedSecrets.POSTGRES_PASSWORD}`
          );
        }
      } else if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        // Handle YAML format: key: value
        if (this.sharedSecrets.POSTGRES_USER) {
          content = content.replace(
            /(\s+)user:\s*[^\s\n]+/g,
            `$1user: ${this.sharedSecrets.POSTGRES_USER}`
          );
        }
        if (this.sharedSecrets.POSTGRES_PASSWORD) {
          content = content.replace(
            /(\s+)password:\s*[^\s\n]+/g,
            `$1password: ${this.sharedSecrets.POSTGRES_PASSWORD}`
          );
        }
      }
      
      if (this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET) {
        // Replace OAuth2 client secret placeholder
        content = content.replace(/__OAUTH2_PROXY_CLIENT_SECRET__/g, this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET);
      }
      
      if (this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET) {
        // Replace OAuth2 cookie secret placeholder
        content = content.replace(/__OAUTH2_PROXY_COOKIE_SECRET__/g, this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET);
      }
      
      // Replace provider-specific placeholders (following dex-oauth2 pattern)
      if (provider === 'github' && file === 'dex.config.yaml') {
        // Replace GitHub-specific placeholders in YAML
        content = content.replace(/GITHUB_CLIENT_ID/g, providerConfig.GITHUB_CLIENT_ID || '');
        content = content.replace(/GITHUB_CLIENT_SECRET/g, providerConfig.GITHUB_CLIENT_SECRET || '');
        content = content.replace(/GITHUB_ORG/g, providerConfig.GITHUB_ORG || '');
        content = content.replace(/GITHUB_ADMIN_TEAM/g, providerConfig.GITHUB_ADMIN_TEAM || 'admins');
        content = content.replace(/GITHUB_USER_TEAM/g, providerConfig.GITHUB_USER_TEAM || 'users');
      } else if (provider === 'okta' && file === 'dex.config.yaml') {
        // Handle certificate data - write to file like dex-oauth2
        if (providerConfig.OKTA_SAML_CA_DATA && providerConfig.OKTA_SAML_CA_DATA !== 'auto-fetch-from-metadata') {
          // Write certificate to a file that will be mounted in the container
          const certPath = path.join(this.dockerDir, 'okta-saml-ca.pem');
          fs.writeFileSync(certPath, providerConfig.OKTA_SAML_CA_DATA);
          
          // Use file-based certificate reference instead of inline data
          content = content.replace(/# caData: OKTA_SAML_CA_DATA/g, '# caData: <inline certificate data>');
          content = content.replace(/caData: OKTA_SAML_CA_DATA/g, '# caData: <inline certificate data>');
          content = content.replace(/# ca: \/etc\/dex\/saml-ca\.pem/g, 'ca: /etc/dex/saml-ca.pem');
          
          console.log('✅ Certificate written to okta-saml-ca.pem');
          
          // Also need to update docker-compose.yml to mount the certificate file
          const dockerComposePath = path.join(this.dockerDir, 'docker-compose.yml');
          if (fs.existsSync(dockerComposePath)) {
            let dockerComposeContent = fs.readFileSync(dockerComposePath, 'utf8');
            
            // Add certificate volume mount to dex service if not already present
            if (!dockerComposeContent.includes('okta-saml-ca.pem')) {
              dockerComposeContent = dockerComposeContent.replace(
                /- \.\/dex\.config\.yaml:\/etc\/dex\/config\.yaml:ro/g,
                `- ./dex.config.yaml:/etc/dex/config.yaml:ro
      - ./okta-saml-ca.pem:/etc/dex/saml-ca.pem:ro`
              );
              fs.writeFileSync(dockerComposePath, dockerComposeContent);
              console.log('✅ Docker Compose updated with certificate mount');
            }
          }
        }
        
        // Replace SSO URL
        if (providerConfig.OKTA_SSO_URL) {
          content = content.replace(/ssoURL: OKTA_SSO_URL/g, `ssoURL: ${providerConfig.OKTA_SSO_URL}`);
        }
      } else if (file === '.env.auth') {
        // Standard replacement for .env.auth files
        const lines = content.split('\n');
        Object.entries(providerConfig).forEach(([key, value]) => {
          // Skip LOGOUT_REDIRECT_URL - it's handled by template replacement below
          if (key === 'LOGOUT_REDIRECT_URL') {
            return;
          }
          
          // Find the line with the key, replace everything after first =
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith(key + '=')) {
              lines[i] = `${key}=${value}`;
              break;
            }
          }
        });
        
        // Also handle BASE_URL replacement for .env.auth files
        if (file === '.env.auth') {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip comments and empty lines
            if (!line.trim() || line.trim().startsWith('#')) continue;
            
            // Find key=value pairs and replace BASE_URL only in the value part
            const equalIndex = line.indexOf('=');
            if (equalIndex > 0) {
              const key = line.substring(0, equalIndex);
              const value = line.substring(equalIndex + 1);
              // Replace BASE_URL in the value part only
              const newValue = value.replace(/BASE_URL/g, baseUrl);
              lines[i] = key + '=' + newValue;
            }
          }
        }
        
        content = lines.join('\n');
      }
      
      fs.writeFileSync(destPath, content, 'utf8');
      console.log(`✅ ${path.basename(destPath)} configured`);
    }
    
    // Handle Docker Compose override
    const overrideDestPath = path.join(this.dockerDir, 'docker-compose.override.yml');
    
    // First, check if we need to remove an existing override file
    // This happens when switching away from a provider that uses override
    if (fs.existsSync(overrideDestPath)) {
      // Check if current provider needs override
      const needsOverride = providerInfo.override && 
        (provider !== 'ldap' || config.LDAP_SERVER_TYPE === 'local');
      
      if (!needsOverride && isSetupOverride(overrideDestPath)) {
        // Current provider doesn't need setup's override, so remove it (an admin's own stays)
        fs.unlinkSync(overrideDestPath);
        console.log('✅ Removed docker-compose.override.yml (not needed for this provider)');
      }
    }
    
    // Now copy override file if current provider needs it
    if (providerInfo.override && (provider !== 'ldap' || config.LDAP_SERVER_TYPE === 'local')) {
      const overrideSrcPath = path.join(this.configsDir, 'providers', provider, providerInfo.override);
      
      if (fs.existsSync(overrideSrcPath)) {
        setAsideForeignOverride(overrideDestPath);
        fs.copyFileSync(overrideSrcPath, overrideDestPath);
        console.log(`✅ ${providerInfo.override} configured`);
        
        if (provider === 'ldap' && config.LDAP_SERVER_TYPE === 'local') {
          console.log('\nℹ️  Local LDAP server includes:');
          console.log('   - OpenLDAP server with test data');
          console.log('   - Optional phpLDAPadmin (start with: docker-compose --profile ldap-admin up)');
        }
      }
    }
    
    // Ensure okta-saml-ca.pem exists for Dex service to start properly
    // This file is required by docker-compose.yml volume mount even if not using OKTA
    const oktaCertPath = path.join(this.dockerDir, 'okta-saml-ca.pem');
    if (!fs.existsSync(oktaCertPath)) {
      // Create empty file with placeholder content
      const placeholderContent = `# OKTA SAML Certificate Placeholder
# This file is created automatically by setup-docker.js to satisfy
# the docker-compose.yml volume mount requirement for the Dex service.
# 
# When using OKTA SAML authentication, this file will be replaced
# with the actual certificate data during provider configuration.
#
# For other authentication providers, this file can remain empty.
`;
      fs.writeFileSync(oktaCertPath, placeholderContent, 'utf8');
      console.log('✅ Created placeholder okta-saml-ca.pem file for Dex service');
    }
    
    return config;
  }

  async showCompletion(config) {
    console.log('\n' + '='.repeat(60));
    console.log('   Setup Complete! 🎉');
    console.log('='.repeat(60));
    
    console.log(`\n✅ Configured for: ${PROVIDERS[config.provider].name}`);
    console.log(`✅ Base URL: ${config.baseUrl}`);
    
    // Detect architecture for platform-specific instructions
    const archInfo = this.detectArchitecture();
    
    console.log('\nGenerated/Updated files:');
    console.log('  Service Configuration:');
    console.log('  - services/gateway/.env (SAP AI Core configuration)');
    console.log('  - services/admin/.env (Admin service configuration)');
    console.log('  - services/ollama/.env (Ollama service configuration)');
    console.log('  Authentication Configuration:');
    console.log('  - .env.nginx (Nginx environment variables)');
    console.log('  - dex.config.yaml (with provider-specific configuration)');
    console.log('  - .env.auth (updated OAuth2 URLs)');
    console.log('  - .env.postgres (PostgreSQL configuration for Docker)');
    
    console.log('\n💡 Configuration verification:');
    console.log('   node verify-config.js');
    console.log('');
    console.log('✅ Nginx uses environment variables for configuration!');
    console.log('   No rebuild required - configuration is applied at container startup.');
    console.log('   The nginx image can be built once and reused across environments.');
    console.log('');
    
    // Show architecture-specific information
    if (archInfo.isAppleSilicon) {
      console.log('🍎 Apple Silicon (ARM64) Detected');
      console.log('   All services support native ARM64 for optimal performance.');
      console.log('');
    }

    // Check for existing Docker volumes and prompt for cleanup to prevent authentication errors
    // When Postgres password changes, existing volume data causes Dex authentication failures
    const volumeNames = this.parseDockerComposeVolumes();
    const existingVolumes = this.checkExistingVolumes(volumeNames);

    if (existingVolumes.length > 0) {
      console.log('⚠️  Warning: Existing Docker volumes detected:');
      existingVolumes.forEach(vol => console.log(`   - ${vol}`));
      console.log('');

      // In CI mode or config mode, auto-delete volumes - unless the caller
      // restores this checkout's .env files afterwards (setup-kyma.js), in
      // which case the old Postgres password stays and deleting would only lose data
      if (this.configFromJson && this.configFromJson.keepDockerVolumes) {
        console.log('🤖 Keeping existing volumes (the caller restores the local configuration)');
        console.log('');
      } else if (this.ciMode || this.configFromJson) {
        console.log('🤖 Unattended mode: Automatically deleting existing volumes...');
        this.deleteVolumes(existingVolumes);
        console.log('');
      } else if (this.answers.deleteVolumes) {
        // Interactive mode: answered before the review
        console.log('🗑️  Deleting existing volumes...');
        this.deleteVolumes(existingVolumes);
        console.log('');
      } else {
        console.log('⚠️  Volumes preserved. The dex service is likely not starting up unless an');
        console.log('   identical postgres username and password was chosen.');
        console.log('');
      }
    }

    // Handle registry mode docker pull for interactive sessions
    if (this.imageMode === 'registry' && !this.configFromJson && !this.ciMode) {
      console.log('🐳 Registry Mode Configuration Detected');
      console.log(`Images will be pulled from: ${this.registryConfig.registry}/${this.registryConfig.organization}`);
      console.log('');
      
      if (this.answers.pullImages) {
        console.log('');
        console.log('🚀 Pulling Docker images from registry...');
        
        try {
          const { spawnSync } = require('child_process');
          const path = require('path');
          
          // Use Docker Compose --env-file approach for cross-platform reliability
          const envFile = path.join(this.dockerDir, '.env.docker');
          
          // Use Docker Compose v2 (docker compose) or fallback to v1 (docker-compose)
          const cmd = 'docker';
          const args = ['compose', '--env-file', envFile, 'pull'];
          
          const result = spawnSync(cmd, args, {
            cwd: this.dockerDir,
            stdio: 'inherit',
            env: process.env // Use standard environment, let Compose read .env.docker
          });
          
          if (result.error || result.status !== 0) {
            // Fallback to docker-compose v1 if docker compose v2 fails
            console.log('ℹ️  Trying docker-compose v1...');
            const fallbackResult = spawnSync('docker-compose', ['--env-file', envFile, 'pull'], {
              cwd: this.dockerDir,
              stdio: 'inherit',
              env: process.env
            });
            
            if (fallbackResult.error || fallbackResult.status !== 0) {
              throw new Error('Both docker compose and docker-compose commands failed');
            }
          }
          
          console.log('');
          console.log('✅ Docker images pulled successfully!');
          console.log('');
          this.showDockerCommands(config, archInfo, 'registry', true);
          
        } catch (error) {
          console.log('');
          console.log('❌ Failed to pull images:', error.message);
          console.log('You can manually pull images later with the appropriate pull command below.');
          console.log('');
          this.showDockerCommands(config, archInfo, 'registry', false);
        }
      } else {
        console.log('');
        this.showDockerCommands(config, archInfo, 'registry', false);
      }
    } else if (this.imageMode === 'registry') {
      // Registry mode but automated/CI - provide instructions only
      this.showDockerCommands(config, archInfo, 'registry', false);
    } else {
      // Local build mode
      this.showDockerCommands(config, archInfo, 'local', false);
    }
    
    if (config.provider === 'local') {
      console.log('4. Test users:');
      console.log('   - admin@example.com / admin123');
      console.log('   - user@example.com / user123');
    } else if (config.provider === 'github') {
      console.log('4. Ensure GitHub OAuth app is configured with:');
      console.log(`   - Authorization callback URL: ${config.baseUrl}/auth/callback`);
      console.log(`   - Organization: ${config.GITHUB_ORG}`);
    } else if (config.provider === 'ldap') {
      if (config.LDAP_SERVER_TYPE === 'local') {
        console.log('4. Local LDAP server will be started automatically.');
        console.log('   Test users: testuser1/password, testuser2/password');
        console.log('   Test with: docker-compose logs ldap-server');
      } else {
        console.log('4. Ensure external LDAP connectivity and test with:');
        console.log('   docker-compose logs dex | grep -i ldap');
        console.log(`   Server: ${config.LDAP_HOST}`);
      }
    } else if (config.provider === 'okta') {
      console.log('4. Ensure Okta SAML app is configured with:');
      console.log(`   - Single sign on URL: ${config.baseUrl}/dex/callback`);
      console.log(`   - Audience URI: ${config.baseUrl}/dex`);
    }
    
    // Display generated credentials for user reference
    console.log('');
    console.log('🔑 Generated Credentials:');
    console.log('   Save these credentials for future access:');
    console.log('');
    console.log('   📊 Database Credentials:');
    console.log(`   - Username: ${this.sharedSecrets.POSTGRES_USER || 'admin_user'}`);
    
    // Only show password if it was generated (not user-entered) and not called by Kyma script
    if (this.sharedSecrets.passwordWasGenerated && !this.configFromJson) {
      console.log(`   - Password: ${mask(this.sharedSecrets.POSTGRES_PASSWORD || 'admin_password')}`);
    } else if (this.configFromJson) {
      console.log('   - Password: [Set via Kyma configuration]');
    } else {
      console.log('   - Password: [User-provided password]');
    }
    console.log('');
    console.log('   🔐 OAuth2 Proxy Secrets:');
    console.log(`   - Client Secret: ${this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET ? mask(this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET) : '(using default)'}`);
    console.log(`   - Cookie Secret: ${this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET ? mask(this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET) : '(using default)'}`);
    console.log('');
    console.log('   These credentials are stored in your .env files and used by the services.');
    console.log('   The database password is randomized for security.');
    
    console.log('');
    console.log('🔒 Security Reminders:');
    console.log('   - Review .env files for sensitive data before committing to git');
    console.log('   - Use OS environment variables for production secrets');
    console.log('   - Set restrictive file permissions: chmod 600 services/*/.env');
    console.log('   - Consider external secret management for enterprise deployments');
    console.log('');
    console.log('For troubleshooting, check the logs:');
    console.log('   docker-compose logs');
    console.log('');
  }

  /**
   * Generated keys an existing configuration already holds and a run keeps: the gateway's shared
   * secrets (when its .env is kept) and the admin's credential master keys (carried over).
   */
  async existingGeneratedKeys() {
    const keys = [];
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    if (fs.existsSync(gatewayEnvPath) && !this.forceOverwrite) {
      const gatewayEnv = await this.parseEnvFile(gatewayEnvPath);
      if (gatewayEnv.VALIDATION_TOKEN_SECRET && !PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS.includes(gatewayEnv.VALIDATION_TOKEN_SECRET)) {
        keys.push('VALIDATION_TOKEN_SECRET');
      }
      if (gatewayEnv.METADATA_ENCRYPTION_KEY) keys.push('METADATA_ENCRYPTION_KEY');
    }
    const adminEnvPath = path.join(this.projectRoot, 'services/admin/.env');
    if (fs.existsSync(adminEnvPath)) {
      const adminEnv = await this.parseEnvFile(adminEnvPath);
      for (const key of ['SIEM_CREDENTIAL_KEY', 'CONNECTION_CREDENTIAL_KEY']) {
        if (adminEnv[key] && adminEnv[key] !== 'changeme') keys.push(key);
      }
    }
    // Kept from the current configuration on an interactive re-run (loadCurrentSecrets).
    // A database password typed in this run is not offered for regeneration.
    for (const key of [...KEPT_GENERATED_SECRETS, 'POSTGRES_PASSWORD']) {
      if (key === 'POSTGRES_PASSWORD' && this.databasePasswordReplaced) continue;
      if (this.currentSecrets[key]) keys.push(key);
    }
    return keys;
  }

  /**
   * Whether validateSharedTokens will find the gateway and admin tokens apart after writing: a
   * kept gateway .env without VALIDATION_TOKEN_SECRET or METADATA_ENCRYPTION_KEY (the admin .env
   * is written with generated values the gateway then lacks). Read-only.
   */
  async predictTokenMismatch() {
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    if (!fs.existsSync(gatewayEnvPath) || this.forceOverwrite) return false;
    const gatewayEnv = await this.parseEnvFile(gatewayEnvPath);
    return !gatewayEnv.VALIDATION_TOKEN_SECRET || !gatewayEnv.METADATA_ENCRYPTION_KEY;
  }

  /** A usable SAP_AI_CORE_SERVICE_KEY in the environment (checked quietly). */
  hasUsableEnvServiceKey() {
    const envServiceKey = process.env.SAP_AI_CORE_SERVICE_KEY;
    if (!envServiceKey || !envServiceKey.trim()) return false;
    try {
      this.parseServiceKeyInline(envServiceKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  /** Text of a generated file under docker/, '' when it does not exist. */
  readDockerFile(name) {
    const filePath = path.join(this.dockerDir, name);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  }

  /** Whether a current value would pass its question (choices, validate); invalid ones are dropped. */
  isValidCurrentValue(id, value) {
    const checks = {
      POSTGRES_USER: validateDatabaseUsername,
      provider: (v) => Object.keys(PROVIDERS).includes(v),
      useDevelopment: (v) => typeof v === 'boolean',
      baseUrl: validateBaseUrl,
      imageMode: (v) => ['local', 'registry'].includes(v),
      registry: validateRequired('Registry is required'),
      organization: validateRequired('Organization is required'),
      [INSTALL_KEY]: (v) => typeof v === 'boolean'
    };
    if (BILLING_KEYS.includes(id)) return isValidBillingValue(id, value);
    if (typeof value !== 'boolean' && typeof value !== 'string') return false;
    if (checks[id]) return checks[id](value) === true;
    const prompt = Object.values(PROVIDER_PROMPTS).flat().find((p) => p.key === id);
    if (!prompt) return false;
    if (prompt.options && !prompt.options.includes(value)) return false;
    if (prompt.required && !String(value).trim()) return false;
    return true;
  }

  /**
   * The current configuration's answers, keyed by question id, from the files this script wrote
   * (docker/.env, .env.docker, .env.nginx, .env.auth, dex.config.yaml, docker-compose.override.yml
   * and the admin's ROLE_MAPPING through .env.auth). Values a question would reject are left out,
   * so it falls back to today's default. Secrets the session keeps itself (a provider's client
   * secret or bind password) are included: the prompt never shows them. {} with --force.
   * Not read back: the Okta metadata URL and certificate choice, the external LDAP search
   * attributes and filters (not written to any file), and the SAP AI Core settings (only asked
   * when the gateway .env is created).
   */
  async loadCurrentValues() {
    if (this.forceOverwrite) return {};
    const docker = readDockerConfigValues(this.dockerDir);
    const values = { POSTGRES_USER: docker.POSTGRES_USER };

    // Provider: IDENTITY_PROVIDER in .env.auth; group names from its ROLE_MAPPING.
    const provider = docker.IDENTITY_PROVIDER;
    values.provider = provider;
    values.LOGOUT_REDIRECT_URL = docker.LOGOUT_REDIRECT_URL;
    const groups = docker.groups;
    if (provider === 'github') {
      values.GITHUB_CLIENT_ID = docker.GITHUB_CLIENT_ID;
      values.GITHUB_CLIENT_SECRET = docker.GITHUB_CLIENT_SECRET;
      if (docker.GITHUB_ORG !== undefined) {
        values.GITHUB_ORG = docker.GITHUB_ORG;
        values.GITHUB_ADMIN_TEAM = githubTeam(values.GITHUB_ORG, groups.admin);
        values.GITHUB_USER_TEAM = githubTeam(values.GITHUB_ORG, groups.user);
      }
    } else if (provider === 'ldap') {
      const external = isExternalLdap(docker);
      values.LDAP_SERVER_TYPE = external ? 'external' : 'local';
      values.LDAP_ADMIN_GROUP = groups.admin;
      values.LDAP_USER_GROUP = groups.user;
      if (external) {
        for (const key of ['LDAP_HOST', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_USER_BASE_DN', 'LDAP_GROUP_BASE_DN']) {
          values[key] = docker[key];
        }
      }
    } else if (provider === 'okta') {
      if (docker.OKTA_SSO_URL !== 'OKTA_SSO_URL') values.OKTA_SSO_URL = docker.OKTA_SSO_URL;
      values.OKTA_ADMIN_GROUP = groups.admin;
      values.OKTA_USER_GROUP = groups.user;
    }

    // Base URL: .env.nginx; localhost is the "Use localhost for development?" answer.
    if (docker.BASE_URL) {
      values.useDevelopment = docker.BASE_URL === 'http://localhost:8080';
      if (!values.useDevelopment) values.baseUrl = docker.BASE_URL;
    }

    // Image mode: .env.docker. Registry mode records DOCKER_IMAGE_MODE=registry; local builds
    // always write the default registry, so another registry (a file written before the marker
    // existed) also means registry mode.
    if (docker.DOCKER_REGISTRY !== undefined) {
      values.imageMode = usesImageRegistry(docker) ? 'registry' : 'local';
      values.registry = docker.DOCKER_REGISTRY;
      values.organization = docker.DOCKER_ORGANIZATION;
    }

    // Billing: the admin .env (written by an earlier interactive run).
    const adminEnv = await this.parseEnvFile(path.join(this.projectRoot, 'services/admin/.env'));
    Object.assign(values, billingFromEnv(adminEnv), pluginInstallFromEnv(adminEnv));

    const current = {};
    for (const [id, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && this.isValidCurrentValue(id, value)) current[id] = value;
    }
    return current;
  }

  /**
   * Secrets of the current configuration a re-run keeps unless they are regenerated: the database
   * password (docker/.env), AWS_SECRET_ENCRYPTION_KEY (admin .env), the OAuth2 proxy secrets
   * (.env.auth) and the file search runtime password (.env.filesearch-runtime). Placeholders from
   * the templates count as unset. {} with --force.
   */
  async loadCurrentSecrets() {
    if (this.forceOverwrite) return {};
    const secrets = {};
    const dockerEnv = await this.parseEnvFile(path.join(this.dockerDir, '.env'));
    if (dockerEnv.POSTGRES_PASSWORD && validateDatabasePassword(dockerEnv.POSTGRES_PASSWORD) === true) {
      secrets.POSTGRES_PASSWORD = dockerEnv.POSTGRES_PASSWORD;
    }
    const adminEnv = await this.parseEnvFile(path.join(this.projectRoot, 'services/admin/.env'));
    const adminSample = await this.parseEnvFile(path.join(this.projectRoot, 'services/admin/.env.sample'));
    if (adminEnv.AWS_SECRET_ENCRYPTION_KEY && adminEnv.AWS_SECRET_ENCRYPTION_KEY !== adminSample.AWS_SECRET_ENCRYPTION_KEY) {
      secrets.AWS_SECRET_ENCRYPTION_KEY = adminEnv.AWS_SECRET_ENCRYPTION_KEY;
    }
    const authEnv = await this.parseEnvFile(path.join(this.dockerDir, '.env.auth'));
    for (const key of ['OAUTH2_PROXY_CLIENT_SECRET', 'OAUTH2_PROXY_COOKIE_SECRET']) {
      if (authEnv[key] && authEnv[key] !== `__${key}__`) secrets[key] = authEnv[key];
    }
    const runtimePassword = (url) => {
      const match = (url || '').match(/^postgresql:\/\/[^:]+:([^@]+)@/);
      if (!match) return undefined;
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return undefined;
      }
    };
    const runtime = runtimePassword(this.readDockerFile('.env.filesearch-runtime').match(/^FILE_SEARCH_DATABASE_URL=(.*)$/m)?.[1]);
    const templatePath = path.join(this.configsDir, 'shared', '.env.filesearch-runtime');
    const template = fs.existsSync(templatePath)
      ? runtimePassword(fs.readFileSync(templatePath, 'utf8').match(/^FILE_SEARCH_DATABASE_URL=(.*)$/m)?.[1])
      : undefined;
    if (runtime && runtime !== template) secrets.FILE_SEARCH_RUNTIME_PASSWORD = runtime;
    return secrets;
  }

  /**
   * Asks every interactive question (and runs the read-only probes) without writing anything.
   * Re-run by the prompt session on Back and on a jump from the review screen.
   * @returns {Promise<DockerAnswers>} { dbConfig, sapConfig, provider, providerConfig, baseUrl,
   *   imageMode, registry, organization, createBackup, deleteVolumes, pullImages,
   *   continueDespiteMismatch, regenerateKeys, providerChange, billing, pluginInstall }
   */
  async collectAnswers(session) {
    this.session = session;
    const answers = {
      dbConfig: null,
      sapConfig: null,
      provider: null,
      providerConfig: {},
      baseUrl: null,
      imageMode: null,
      registry: null,
      organization: null,
      createBackup: false,
      deleteVolumes: null,
      pullImages: false,
      continueDespiteMismatch: null,
      regenerateKeys: [],
      providerChange: null,
      billing: null,
      pluginInstall: null
    };

    answers.dbConfig = await this.promptForDatabaseCredentials();

    // The SAP AI Core questions belong to a gateway .env that is created (not kept).
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    if (!fs.existsSync(gatewayEnvPath) || this.forceOverwrite) {
      answers.sapConfig = await this.promptForServiceKey();
    }

    const keys = await this.existingGeneratedKeys();
    if (keys.length > 0) {
      answers.regenerateKeys = await askKeyRegeneration(session, keys);
    }
    if (answers.regenerateKeys.includes('POSTGRES_PASSWORD') && !this.databasePasswordReplaced) {
      // The same generated password on every replay of the session.
      if (!session.generated.has('POSTGRES_PASSWORD')) {
        session.generated.set('POSTGRES_PASSWORD', this.generateDatabasePassword());
      }
      answers.dbConfig = { ...answers.dbConfig, POSTGRES_PASSWORD: session.generated.get('POSTGRES_PASSWORD'), passwordWasGenerated: true };
    }

    if (await this.predictTokenMismatch()) {
      console.log('\n⚠️  CRITICAL: Security tokens will not match between services!');
      console.log('   The existing gateway .env has no VALIDATION_TOKEN_SECRET or METADATA_ENCRYPTION_KEY,');
      console.log('   so the gateway and admin services would not use the same tokens.');
      console.log('   Fix services/gateway/.env manually or run setup again with --force.\n');
      const { continueAnyway } = await this.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue anyway?',
          default: false
        }
      ]);
      if (!continueAnyway) {
        throw new Error('Token validation failed - setup aborted');
      }
      answers.continueDespiteMismatch = true;
    }

    console.log('\n' + '='.repeat(60));
    console.log('   Authentication Provider Setup');
    console.log('='.repeat(60) + '\n');

    answers.provider = await this.selectProvider();
    const withCookie = keysForProviderChange(answers.regenerateKeys, {
      previous: session.current.provider,
      provider: answers.provider,
      carried: keys
    });
    answers.providerChange = withCookie !== answers.regenerateKeys ? { from: session.current.provider, to: answers.provider } : null;
    answers.regenerateKeys = withCookie;

    if (this.hasExistingConfigFiles()) {
      console.log('\nExisting configuration files detected.');
      ({ createBackup: answers.createBackup } = await this.prompt([
        {
          type: 'confirm',
          name: 'createBackup',
          message: 'Create backup?',
          default: false
        }
      ]));
    }

    answers.providerConfig = await this.collectProviderConfig(answers.provider);
    answers.baseUrl = await this.getBaseUrl();

    const imageModeConfig = await this.selectImageMode();
    answers.imageMode = imageModeConfig.imageMode;
    answers.registry = imageModeConfig.registry;
    answers.organization = imageModeConfig.organization;

    answers.billing = billingToWrite(await askBilling(session, session.current), session.current);
    answers.pluginInstall = pluginInstallToWrite(await askPluginInstall(session, session.current), session.current);

    // Existing volumes would keep the old Postgres password: ask now, delete after the review.
    const existingVolumes = await session.once('docker-volumes', () =>
      this.checkExistingVolumes(this.parseDockerComposeVolumes())
    );
    if (existingVolumes.length > 0) {
      console.log('\n⚠️  Warning: Existing Docker volumes detected:');
      existingVolumes.forEach(vol => console.log(`   - ${vol}`));
      console.log('');
      console.log('If you changed your Postgres password then the dex service will report');
      console.log("'pq: password authentication failed'.");
      console.log('');
      // The volumes hold the data: with the database user and password unchanged (a re-run that
      // kept both) they still match, so Enter keeps them.
      const credentialsKept = Boolean(this.currentSecrets.POSTGRES_PASSWORD) &&
        answers.dbConfig.POSTGRES_PASSWORD === this.currentSecrets.POSTGRES_PASSWORD &&
        answers.dbConfig.POSTGRES_USER === session.current.POSTGRES_USER;
      ({ deleteVolumes: answers.deleteVolumes } = await this.prompt([
        {
          type: 'confirm',
          name: 'deleteVolumes',
          message: 'Delete volumes to prevent authentication errors? (Choose No only if keeping same credentials)',
          default: !credentialsKept
        }
      ]));
    }

    if (answers.imageMode === 'registry') {
      console.log(`\nImages will be pulled from: ${answers.registry}/${answers.organization}`);
      ({ pullImages: answers.pullImages } = await this.prompt([
        {
          type: 'confirm',
          name: 'pullImages',
          message: 'Pull Docker images now? This prevents local builds and ensures immediate startup.',
          default: true
        }
      ]));
    }

    return answers;
  }

  /**
   * What an unattended --ci run decides. undefined leaves a decision to the write step as before
   * (database credentials and SAP AI Core key from the environment or CI defaults, the token
   * mismatch confirmation).
   */
  unattendedAnswers() {
    return {
      dbConfig: undefined,
      sapConfig: undefined,
      provider: 'local',
      providerConfig: this.defaultProviderConfig('local'),
      baseUrl: 'http://localhost:8080',
      imageMode: 'local',
      registry: 'ghcr.io',
      organization: 'st-gr',
      createBackup: false,
      deleteVolumes: true,
      pullImages: false,
      continueDespiteMismatch: undefined,
      regenerateKeys: [],
      billing: null,
      pluginInstall: null
    };
  }

  /**
   * Interactive runs only (--ci and --config leave billing null): sets the billing currency in
   * the admin .env and sets or removes the CU prices to match the answer.
   */
  writeBilling(billing) {
    if (!billing) return;
    const envPath = path.join(this.projectRoot, 'services/admin/.env');
    if (!fs.existsSync(envPath)) return;
    fs.writeFileSync(envPath, applyBillingToEnvText(fs.readFileSync(envPath, 'utf8'), billing), 'utf8');
    console.log('✅ Updated admin .env with the SAP billing currency');
  }

  /** Interactive runs only (--ci and --config leave pluginInstall null): sets INSTALLED_PLUGINS_ENABLED in the admin .env. */
  writePluginInstall(enabled) {
    if (typeof enabled !== 'boolean') return;
    const envPath = path.join(this.projectRoot, 'services/admin/.env');
    if (!fs.existsSync(envPath)) return;
    fs.writeFileSync(envPath, applyPluginInstallToEnvText(fs.readFileSync(envPath, 'utf8'), enabled), 'utf8');
    console.log('✅ Updated admin .env with the plugin install setting');
  }

  /**
   * Writes the configuration from the answers, in the order the setup always wrote it: service
   * .env files, backup, Docker image settings, provider and compose files, then volumes, image
   * pull and the completion summary.
   */
  async applyAnswers(answers) {
    this.answers = answers;
    if (answers.providerChange) {
      console.log(`\n🔑 The login provider changed from ${answers.providerChange.from} to ${answers.providerChange.to}: ` +
        'a new cookie key signs everyone out, so no session made through the old provider stays valid.');
    }

    await this.setupServiceEnvFiles(answers.sapConfig, answers.dbConfig || null);
    this.writeBilling(answers.billing);
    this.writePluginInstall(answers.pluginInstall);

    if (this.configFromJson) {
      // Skip backup in config mode
      console.log('📋 Skipping backup in configuration mode');
    } else {
      if (this.ciMode) {
        console.log('\n' + '='.repeat(60));
        console.log('   Authentication Provider Setup');
        console.log('='.repeat(60) + '\n');
        console.log('🤖 CI Mode: Auto-selecting Local Development provider\n');
      }

      await this.backupExistingFiles(answers.createBackup);

      if (this.ciMode) {
        console.log(`🤖 CI Mode: Using default configuration for ${PROVIDERS[answers.provider].name}\n`);
        console.log('🤖 CI Mode: Using localhost for development\n');
        console.log('🤖 CI Mode: Using local builds for Docker images\n');
      }

      // Configure Docker image mode (local builds vs registry)
      await this.configureDockerImages(answers.imageMode, answers.registry, answers.organization, answers.imageTag);
    }

    const config = await this.copyAndConfigureFiles(answers.provider, answers.providerConfig, answers.baseUrl, answers.dbConfig);

    // The install record (docker/.sail-proxy-install.json). Not in --config mode (setup-kyma.js
    // only wants the .env files) and not for `sail-proxy upgrade`, which writes it as its last step.
    if (!this.configFromJson && !answers.skipInstallRecord) {
      writeInstallRecord(this.dockerDir, {
        version: answers.imageTag || this.projectVersion(),
        // The database user as written (--ci decides it in the write step, not in the answers)
        answers: recordDockerAnswers({ ...answers, dbConfig: { POSTGRES_USER: this.sharedSecrets.POSTGRES_USER } }),
        recordedBy: 'setup'
      });
      console.log('✅ docker/.sail-proxy-install.json records this installation');
    }

    await this.showCompletion(config);
  }

  async runWithConfig(config) {
    console.log('\n' + '='.repeat(60));
    console.log('   SAIL-PROXY Docker Setup (Configuration Mode)');
    console.log('='.repeat(60) + '\n');
    
    // Validate required configuration
    if (!config.provider) {
      throw new Error('Missing required field: provider');
    }
    if (!PROVIDERS[config.provider]) {
      throw new Error(`Invalid provider: ${config.provider}`);
    }
    
    // Set shared secrets if provided
    if (config.sharedSecrets) {
      this.sharedSecrets = config.sharedSecrets;
    }
    
    // Set image mode and registry config if provided
    if (config.imageMode) {
      this.imageMode = config.imageMode;
      if (config.registryConfig) {
        this.registryConfig = config.registryConfig;
      } else {
        // Default registry config for automated setup
        this.registryConfig = { 
          registry: 'ghcr.io', 
          organization: 'st-gr', 
          version: '1.0.0' 
        };
      }
    }
    
    // Setup database configuration - use provided config or environment variables
    let dbConfig = null;
    if (config.POSTGRES_USER || config.POSTGRES_PASSWORD) {
      dbConfig = {
        POSTGRES_USER: config.POSTGRES_USER,
        POSTGRES_PASSWORD: config.POSTGRES_PASSWORD
      };
    }

    const answers = {
      dbConfig,
      sapConfig: config.sapConfig || undefined,
      provider: config.provider,
      providerConfig: config.providerConfig || {},
      baseUrl: config.baseUrl || 'http://localhost:8080',
      imageMode: this.imageMode,
      registry: this.registryConfig ? this.registryConfig.registry : null,
      organization: this.registryConfig ? this.registryConfig.organization : null,
      createBackup: false,
      deleteVolumes: !config.keepDockerVolumes,
      pullImages: false,
      continueDespiteMismatch: true,
      regenerateKeys: [],
      billing: null,
      pluginInstall: null
    };

    // What the configuration leaves open and only a person can answer (database credentials
    // without environment variables, the SAP AI Core key for a new gateway .env) is asked before
    // anything is written; a run that asks nothing shows no review screen.
    const askDatabase = !dbConfig && !(process.env.POSTGRES_USER && process.env.POSTGRES_PASSWORD) && !this.ciMode;
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    const askServiceKey = !answers.sapConfig && (!fs.existsSync(gatewayEnvPath) || this.forceOverwrite) &&
      !this.hasUsableEnvServiceKey();
    if (askDatabase || askServiceKey) {
      const session = this.createSession();
      try {
        const asked = await session.run(async (s) => {
          this.session = s;
          const out = {};
          if (askDatabase) out.dbConfig = await this.promptForDatabaseCredentials();
          if (askServiceKey) out.sapConfig = await this.promptForServiceKey();
          return out;
        });
        Object.assign(answers, asked);
      } finally {
        this.session = null;
      }
    }

    await this.applyAnswers(answers);
  }

  async run() {
    try {
      // If configuration is provided via JSON, use it directly
      if (this.configFromJson) {
        await this.runWithConfig(this.configFromJson);
      } else if (this.ciMode) {
        await this.showWelcome();
        await this.applyAnswers(this.unattendedAnswers());
      } else {
        // Normal interactive flow: every question first (with Back and a review screen), then
        // the writes. Ctrl-C or an error before "Write configuration" writes nothing.
        await this.showWelcome();
        // Without --force a re-run starts from the current configuration (both loaders return {}
        // with --force, which starts from today's defaults).
        this.currentSecrets = await this.loadCurrentSecrets();
        const session = this.createSession(await this.loadCurrentValues());
        let answers;
        try {
          answers = await session.run((s) => this.collectAnswers(s));
        } finally {
          this.session = null;
        }
        await this.applyAnswers(answers);
      }
      
    } catch (error) {
      console.error('\n❌ Setup failed:', error.message);
      process.exit(1);
    } finally {
      // Clean up any remaining temp files
      this.cleanupTempFiles();
    }
  }
}

// Main execution
if (require.main === module) {
  // If config is provided, we don't need inquirer
  if (configFromJson) {
    const setup = new DockerSetup({ forceOverwrite, ciMode, configFromJson });
    setup.run().catch(console.error);
  } else if (inquirer) {
    // Only run if inquirer is loaded
    const setup = new DockerSetup({ forceOverwrite, ciMode });
    setup.run().catch(console.error);
  }
  // Otherwise, the script will exit after prompting to install inquirer
}

module.exports = DockerSetup;
module.exports.PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS = PUBLICLY_KNOWN_VALIDATION_TOKEN_SECRETS;
