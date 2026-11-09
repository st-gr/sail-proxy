#!/usr/bin/env node

/**
 * SAIL-PROXY Kyma Deployment Setup Script
 * 
 * Generates Kubernetes manifests and ConfigMaps based on deployment configuration
 * Supports both public HTTPS (APIRule) and internal-only (Cloud Connector) deployment
 * 
 * Usage (from kyma directory): 
 *   node scripts/setup-kyma.js
 *   npx -p inquirer@8.2.6 node scripts/setup-kyma.js  (if inquirer not installed)
 *   npx -y -p inquirer@8.2.6 node scripts/setup-kyma.js  (auto-confirm download)
 * 
 * Or from project root:
 *   node kyma/scripts/setup-kyma.js
 *   npx -y -p inquirer@8.2.6 node kyma/scripts/setup-kyma.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const {
  DEFAULT_NAMESPACE,
  isDefaultNamespace,
  validateNamespace,
  outputRoot,
  istioSystemName,
  istioSystemPrefix,
  namespaceLabels,
  parseNamespaceArg
} = require('./kyma-namespace');
const { dockerSetupOutputs, snapshotFiles, restoreFiles } = require('./local-config-snapshot');
const {
  KUBECTL_CONFIG_READS,
  runKubectlRead,
  stderrOf,
  isServerNotFound,
  isUnreachable,
  readResourceData
} = require('./kubectl-read');
const { PromptSession } = require('../../docker/setup-flow/session');
const { askKeyRegeneration, keysForProviderChange, mask } = require('../../docker/setup-flow/secrets');
const { INSTALL_KEY, askPluginInstall, pluginInstallToWrite, pluginInstallFromEnv } = require('../../docker/setup-flow/pluginInstall');
const { BILLING_KEYS, askBilling, billingToWrite, billingFromEnv, isValidBillingValue } = require('../../docker/setup-flow/billing');
const { readDockerConfigValues, isExternalLdap, usesImageRegistry, githubTeam } = require('../../docker/setup-flow/docker-config');
const { REGISTRY_SECRET_FILE, writeRegistrySecret, readRegistrySecret } = require('./registry-secret');
const { INSTALL_RECORD_FILE, recordAnswers, renderInstallRecord, readInstallRecord, registryAnswers } = require('./install-record');
const {
  valuesFromDexConfig,
  valuesFromImages,
  valuesFromAllowlistPolicy,
  readLiveValues,
  readLiveOauth2Secrets,
  readLiveRegistrySecret
} = require('./live-values');

// RFC 1123 validation functions
function validateRFC1123Label(label) {
  if (!label || typeof label !== 'string') {
    return 'Label must be a non-empty string';
  }
  
  // RFC 1123 requirements:
  // - Max 63 characters
  // - Lowercase alphanumeric characters or hyphens
  // - Must start and end with alphanumeric character
  
  if (label.length > 63) {
    return 'Label must not exceed 63 characters';
  }
  
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
    return 'Label must consist of lowercase alphanumeric characters or hyphens, and must start and end with an alphanumeric character';
  }
  
  return true;
}

function validateRFC1123Domain(domain) {
  if (!domain || typeof domain !== 'string') {
    return 'Domain must be a non-empty string';
  }
  
  // Split domain into labels and validate each
  const labels = domain.split('.');
  
  if (labels.length === 0) {
    return 'Domain must contain at least one label';
  }
  
  // Total domain name length limit (253 characters)
  if (domain.length > 253) {
    return 'Domain name must not exceed 253 characters';
  }
  
  for (const label of labels) {
    const labelValidation = validateRFC1123Label(label);
    if (labelValidation !== true) {
      return `Invalid label "${label}": ${labelValidation}`;
    }
  }
  
  return true;
}

/** PostgreSQL role name rules for the database username question (and its current value). */
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

// Check for help/version flags BEFORE loading inquirer
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
  console.log(`
SAIL-PROXY Kyma Deployment Setup Script

This script helps you configure the SAP LLM Gateway for Kyma deployment.

Usage:
  node scripts/setup-kyma.js [options]

Options:
  --help, -h     Show this help message
  --version, -v  Show version information
  --force, -f    Force overwrite existing manifests
  --ci           CI/CD mode - use default options (local auth, internal deployment)
  --namespace <ns>
                 Kubernetes namespace to deploy into (default: sail-proxy; asked
                 interactively unless --ci). Any namespace other than sail-proxy
                 renders into kyma/deployments/<ns>/ and prefixes the names of its
                 istio-system and cluster-scoped objects with <ns>-

Examples:
  From kyma directory:
    node scripts/setup-kyma.js
    node scripts/setup-kyma.js --force
    node scripts/setup-kyma.js --ci
    node scripts/setup-kyma.js --ci --force
    node scripts/setup-kyma.js --namespace sail-proxy-test

  From project root:
    node kyma/scripts/setup-kyma.js
    node kyma/scripts/setup-kyma.js --ci

What this script does:
  1. Creates Kubernetes Secret manifests for sensitive data
  2. Creates ConfigMap manifests for application configuration
  3. Configures authentication provider (Local, GitHub, LDAP, Okta)
  4. Generates deployment manifests for all services
  5. Sets up APIRule for public access or Cloud Connector for internal access
  6. Configures IP allowlisting with Istio AuthorizationPolicy

Files created/modified:
  - manifests/core/*.yaml (PostgreSQL, Valkey, Gateway, Admin, NGINX)
  - manifests/auth/*.yaml (Dex, OAuth2-Proxy configurations)
  - manifests/networking/*.yaml (APIRule, AuthorizationPolicy)
  - templates/secrets/*.yaml (Kubernetes Secrets)
  - templates/configmaps/*.yaml (Kubernetes ConfigMaps)
  `);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('SAIL-PROXY Kyma Setup v1.0.0');
  process.exit(0);
}

// Check for force flag
const forceOverwrite = args.includes('--force') || args.includes('-f');

// Check for CI flag
const ciMode = args.includes('--ci');

// Try to find required packages in multiple locations
let inquirer, yaml;
const { execSync } = require('child_process');

function tryLoadPackage(packageName) {
  const locations = [
    `../../npm-dist/sail-proxy/node_modules/${packageName}`,
    packageName,
    `../../node_modules/${packageName}`,
    `./node_modules/${packageName}`
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
      return require(require.resolve(packageName, { paths: [process.env.SAIL_PROXY_KIT_MODULES] }));
    } catch (e) {
      // Not there either
    }
  }
  return null;
}

inquirer = tryLoadPackage('inquirer');
yaml = tryLoadPackage('js-yaml');

// Only when run as a script: a caller that requires this module (the tests)
// supplies what it needs and must never be prompted or have packages installed.
if ((!inquirer || !yaml) && require.main === module) {
  const missingPackages = [];
  if (!inquirer) missingPackages.push('inquirer@8.2.6 (for interactive setup prompts)');
  if (!yaml) missingPackages.push('js-yaml@4.1.0 (for YAML configuration processing)');
  
  console.log('\n📦 Required packages are missing:');
  missingPackages.forEach(pkg => console.log(`   - ${pkg}`));
  console.log('');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question('Would you like to install them now? (Y/n): ', (answer) => {
    rl.close();
    
    if (answer.trim().toLowerCase() !== 'n') {
      console.log('\nInstalling required packages...');
      try {
        // Create a temporary package.json if it doesn't exist
        const kymaDir = __dirname;
        const packageJsonPath = path.join(kymaDir, 'package.json');
        
        if (!fs.existsSync(packageJsonPath)) {
          const packageJson = {
            name: "kyma-setup",
            version: "1.0.0",
            private: true,
            dependencies: {}
          };
          fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        }
        
        // Install both packages locally
        const packagesToInstall = [];
        if (!inquirer) packagesToInstall.push('inquirer@8.2.6');
        if (!yaml) packagesToInstall.push('js-yaml@4.1.0');
        
        execSync(`npm install ${packagesToInstall.join(' ')} --no-save`, {
          cwd: kymaDir,
          stdio: 'inherit'
        });
        
        // Try loading again
        if (!inquirer) inquirer = require('./node_modules/inquirer');
        if (!yaml) yaml = require('./node_modules/js-yaml');
        console.log('✅ Required packages installed successfully!\n');
        
        // Re-run the script with the installed packages
        const { spawn } = require('child_process');
        // Pass the original arguments on: dropping --namespace here would re-run
        // setup against the default (production) namespace.
        const child = spawn(process.argv[0], [__filename, ...args], {
          stdio: 'inherit',
          shell: false
        });
        
        child.on('exit', (code) => {
          process.exit(code);
        });
        
        return;
      } catch (error) {
        console.error('\n❌ Failed to install packages:', error.message);
        console.error('\nAlternatively, you can run:');
        console.error('  npx -p inquirer@8.2.6 -p js-yaml@4.1.0 node scripts/setup-kyma.js');
        console.error('  npx -y -p inquirer@8.2.6 -p js-yaml@4.1.0 node scripts/setup-kyma.js  (auto-confirm)');
        process.exit(1);
      }
    } else {
      console.log('\nTo run this script without installing, use:');
      console.log('  npx -p inquirer@8.2.6 -p js-yaml@4.1.0 node scripts/setup-kyma.js');
      console.log('  npx -y -p inquirer@8.2.6 -p js-yaml@4.1.0 node scripts/setup-kyma.js  (auto-confirm)');
      process.exit(0);
    }
  });
  
  // Exit here since we need to wait for the user response
  return;
}

// Provider configurations - same as Docker setup
/** Entries one registry tag listing reads (a single page). */
const LISTING_PAGE_SIZE = 100;

/**
 * Writes a rendered Secret owner-only, and tightens it when an earlier render left the file readable
 * to all (writeFileSync keeps an existing file's mode).
 */
function writeSecret(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const PROVIDERS = {
  local: {
    name: 'Local Development (hardcoded users)',
    description: 'For development only - uses static test users',
    warning: '⚠️  WARNING: Do not use in production!',
    files: ['dex.config.yaml', 'nginx.conf']
  },
  github: {
    name: 'GitHub OAuth',
    description: 'GitHub organization/team-based authentication',
    files: ['dex.config.yaml', 'nginx.conf']
  },
  ldap: {
    name: 'LDAP/Active Directory',
    description: 'Enterprise LDAP or Active Directory integration',
    files: ['dex.config.yaml', 'nginx.conf']
  },
  okta: {
    name: 'Okta SAML',
    description: 'Okta SAML-based single sign-on',
    files: ['dex.config.yaml', 'nginx.conf']
  }
};

// Provider-specific configuration prompts (same as Docker setup)
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
    { key: 'LDAP_SERVER_TYPE', prompt: 'LDAP server type (local/external)', required: true, default: 'external', options: ['external'] },
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

// Keys that protect data a running deployment has stored, by the live
// Secret that holds them. loadExistingKeys carries them over.
const LIVE_SECRET_KEYS = {
  'admin-env': ['VALIDATION_TOKEN_SECRET', 'METADATA_ENCRYPTION_KEY', 'AWS_SECRET_ENCRYPTION_KEY', 'SIEM_CREDENTIAL_KEY', 'CONNECTION_CREDENTIAL_KEY'],
  'gateway-env': ['VALIDATION_TOKEN_SECRET', 'METADATA_ENCRYPTION_KEY']
};

// The optional Secret with the file_search S3 credentials (see loadLiveS3Env).
const S3_ENV_SECRET = 'gateway-s3-env';
const S3_ENV_KEYS = ['FILE_SEARCH_S3_ACCESS_KEY_ID', 'FILE_SEARCH_S3_SECRET_ACCESS_KEY'];

/** "1 entry" / "9 entries": the count beside a list makes a lost entry visible. */
const entriesLabel = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

class KymaSetup {
  constructor(options = {}) {
    this.kymaDir = path.resolve(__dirname, '..');
    this.scriptsDir = path.join(this.kymaDir, 'scripts');
    this.configsDir = path.join(this.kymaDir, 'configs');
    // Source templates (templates/manifests/*) are always read from here;
    // rendered output goes to the namespace's folder (see setNamespace).
    this.templatesDir = path.join(this.kymaDir, 'templates');
    // Base of the rendered output; injectable so tests render into a temp dir.
    this.outputBaseDir = options.outputRoot || this.kymaDir;
    // A temporary render (the upgrade's) is no folder to show the user
    this.outputIsTemporary = options.outputIsTemporary || false;
    this.projectRoot = path.resolve(this.kymaDir, '..');
    this.sharedSecrets = {};
    // Generated secrets of the namespace's earlier render that a re-run keeps unless they are
    // regenerated (interactive, without --force; see loadCurrentSecrets).
    this.currentSecrets = {};
    this.forceOverwrite = options.forceOverwrite || false;
    this.ciMode = options.ciMode || false;
    this.setNamespace(options.namespace || DEFAULT_NAMESPACE);
  }

  /**
   * Every question goes through here: the prompt session of an interactive run (Back, review
   * screen), else inquirer directly (callers outside run(), e.g. tests of single steps).
   */
  prompt(questions) {
    return this.session ? this.session.ask(questions) : inquirer.prompt(questions);
  }

  /** The prompt session for an interactive run (replaced in tests by a scripted one). */
  createSession() {
    return new PromptSession({ inquirer });
  }

  /**
   * Read-only work (cluster reads, registry lookups, metadata fetches) runs once per session, so
   * Back and review jumps do not repeat it; outside a session it simply runs.
   */
  once(key, fn) {
    return this.session ? this.session.once(key, fn) : Promise.resolve().then(fn);
  }

  /** A value generated during the questions stays the same across Back and review jumps. */
  generatedOnce(key, generate) {
    if (!this.session) return generate();
    if (!this.session.generated.has(key)) this.session.generated.set(key, generate());
    return this.session.generated.get(key);
  }

  /**
   * Select the Kubernetes namespace and the output folders that go with it.
   * The default namespace keeps kyma/manifests/ and kyma/templates/{secrets,configmaps}/;
   * any other renders into kyma/deployments/<ns>/, so it can never overwrite
   * the default deployment's gitignored renders.
   */
  setNamespace(namespace) {
    const labelValidation = validateRFC1123Label(namespace);
    const validation = labelValidation === true ? validateNamespace(namespace) : labelValidation;
    if (validation !== true) {
      throw new Error(`Invalid Kubernetes namespace "${namespace}": ${validation}`);
    }
    this.namespace = namespace;
    const root = outputRoot(this.outputBaseDir, namespace);
    this.manifestsDir = path.join(root, 'manifests');
    this.secretsDir = path.join(root, 'templates', 'secrets');
    this.configmapsDir = path.join(root, 'templates', 'configmaps');
  }

  namespaceQuestion() {
    return {
      type: 'input',
      name: 'namespace',
      message: 'Kubernetes namespace to deploy into:',
      default: this.namespace,
      validate: (input) => {
        const value = String(input).trim();
        const labelValidation = validateRFC1123Label(value);
        return labelValidation === true ? validateNamespace(value) : labelValidation;
      }
    };
  }

  async selectNamespace() {
    if (!this.ciMode) {
      const { namespace } = await this.prompt([this.namespaceQuestion()]);
      this.setNamespace(String(namespace).trim());
    }

    if (isDefaultNamespace(this.namespace)) {
      console.log(`Kubernetes namespace: ${this.namespace}\n`);
    } else {
      console.log(`Kubernetes namespace: ${this.namespace} (not the default ${DEFAULT_NAMESPACE})`);
      if (!this.outputIsTemporary) console.log(`   Output: ${path.relative(process.cwd(), outputRoot(this.outputBaseDir, this.namespace)) || '.'}`);
      console.log(`   istio-system and cluster-scoped objects are prefixed "${istioSystemPrefix(this.namespace)}"\n`);
    }
    return this.namespace;
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

  /**
   * Quote a value for safe embedding in generated YAML.
   * YAML's double-quoted scalar style is JSON-compatible, so JSON.stringify
   * yields a valid, fully-escaped YAML string. Without this, a generated hex
   * password that happens to look numeric (all digits, or digits with a
   * single 'e' like 7522e0966 — a YAML float) is emitted unquoted, and
   * kubectl rejects the Secret with "cannot unmarshal number into ...
   * stringData of type string". Also protects values containing ':', '#',
   * quotes, etc. (e.g. service-key CLIENT_SECRETs).
   */
  yamlQuote(value) {
    return JSON.stringify(String(value ?? ''));
  }

  generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  generateSiemCredentialKey() {
    return crypto.randomBytes(32).toString('hex'); // 64 chars hex
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

  /**
   * Compare semantic versions
   * Returns: -1 if a < b, 0 if a === b, 1 if a > b
   */
  compareSemver(a, b) {
    const parseVersion = (v) => {
      const parts = v.replace(/^v/, '').split('.');
      return {
        major: parseInt(parts[0] || 0),
        minor: parseInt(parts[1] || 0),
        patch: parseInt(parts[2] || 0)
      };
    };
    
    const va = parseVersion(a);
    const vb = parseVersion(b);
    
    if (va.major !== vb.major) return va.major - vb.major;
    if (va.minor !== vb.minor) return va.minor - vb.minor;
    return va.patch - vb.patch;
  }

  /**
   * Validate semantic version format
   */
  isValidSemver(version) {
    return /^\d+\.\d+\.\d+$/.test(version.replace(/^v/, ''));
  }

  /** A valid Docker image tag: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}. */
  isValidDockerTag(tag) {
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag);
  }

  /**
   * Validation for a typed image version. Any valid Docker tag is accepted
   * (release, v-prefixed release, or a branch tag like review-fixes-d697e0eb).
   * A semver release must not be below the lowest listed one; any other tag
   * must be in the registry listing of sail-proxy-gateway when that listing
   * succeeded (fetchImageTags records it); when it failed, the tag is refused if
   * the registry answers 404 for its manifest (a wrong registry or organization
   * answer looks just like this), else accepted with a warning after the prompt.
   */
  async validateCustomTag(input, semverTags, registryLabel, config) {
    const tag = String(input || '').trim();
    if (!this.isValidDockerTag(tag)) {
      return 'Please enter a valid image tag: up to 128 letters, digits, "_", "." or "-", not starting with "." or "-" (e.g., 1.2.3 or review-fixes-d697e0eb)';
    }
    if (this.isValidSemver(tag)) {
      if (semverTags.length > 0) {
        const lowestAvailable = semverTags[semverTags.length - 1];
        if (this.compareSemver(tag, lowestAvailable) < 0) {
          return `Version must be ${lowestAvailable} or higher`;
        }
      }
      return true;
    }
    if (this.listedTags && !this.listedTags.has(tag)) {
      return `Tag "${tag}" was not found for sail-proxy-gateway in ${registryLabel}`;
    }
    if (!this.listedTags && config && (await this.manifestState(config, tag)) === 'missing') {
      return `Tag "${tag}" was not found for sail-proxy-gateway in ${registryLabel} (the registry answered 404): check the registry or organization answer (Up arrow goes back)`;
    }
    return true;
  }

  /**
   * Whether sail-proxy-gateway has `tag` in the registry: true when the listing has it or, beyond
   * the listing, the registry serves its manifest; false when a complete listing lacks it; null when
   * that cannot be told (the listing failed or filled its one page of LISTING_PAGE_SIZE entries, and
   * the manifest could not be read). A 404 for the manifest is false whatever the listing.
   */
  async isTagPublished(config, tag) {
    if (this.listedTags && this.listedTags.has(tag)) return true;
    const manifest = await this.manifestState(config, tag);
    if (manifest === 'present') return true;
    if (manifest === 'missing') return false;
    if (!this.listedTags) return null;
    return this.listedTags.size >= LISTING_PAGE_SIZE ? null : false;
  }

  warnIfTagUnverified(tag, registryLabel) {
    if (!this.isValidSemver(tag) && !this.listedTags) {
      console.warn(`⚠️  Tag "${tag}" could not be verified: the tags of ${registryLabel} could not be listed. Make sure it exists for all images.`);
    }
  }

  /**
   * Where the registry APIs live for a registry answer. Images are named registry/organization/name,
   * and the registry answer may carry a path ("ghcr.io/st-gr" with organization "sail-proxy-private"):
   * the APIs then live at the host alone, with the path as the start of the repository namespace.
   */
  registryApiTarget(config) {
    const [host, ...path] = String(config.registry).split('/').filter(Boolean);
    const namespace = [...path, ...String(config.organization || '').split('/')].filter(Boolean).join('/');
    return { host, namespace };
  }

  /**
   * Fetch available image tags from registry
   */
  async fetchImageTags(config) {
    const { dockerUsername, dockerPassword } = config;
    const { host: registry, namespace: organization } = this.registryApiTarget(config);

    console.log('\n🔍 Fetching available versions...');
    // Every tag the listing returned (for validateCustomTag); null = listing failed.
    this.listedTags = null;

    try {
      let tags = [];
      
      if (registry === 'ghcr.io') {
        // GitHub Container Registry.
        //
        // Two very different APIs are available:
        //  - The GitHub Packages REST API (api.github.com) returns rich version
        //    metadata but REQUIRES authentication on every request — there is
        //    no anonymous access even for PUBLIC packages. Without a PAT it
        //    always answers 401.
        //  - The Docker Registry V2 API (ghcr.io/v2/...) issues anonymous pull
        //    tokens for public packages, so tags can be listed with no
        //    credentials at all.
        // Therefore: use the REST API only when credentials were provided
        // (needed for private packages), and fall back to the registry API —
        // which is the only option that can work anonymously.
        if (dockerUsername && dockerPassword) {
          try {
            // First, detect if it's a user or organization by checking the user endpoint
            // The package of a nested image (st-gr/sail-proxy-private/sail-proxy-gateway) belongs to
            // the first segment and is named by the rest, URL-encoded.
            const [owner, ...packagePath] = organization.split('/');
            const packageName = encodeURIComponent([...packagePath, 'sail-proxy-gateway'].join('/'));
            const checkUrl = `https://api.github.com/users/${owner}`;
            const checkOptions = {
              headers: {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'sail-proxy-setup',
                'Authorization': `Bearer ${dockerPassword}`
              }
            };

            let isOrganization = false;
            try {
              const checkResponse = await this.makeHttpRequest(checkUrl, checkOptions);
              const userData = JSON.parse(checkResponse);
              // GitHub returns type: "Organization" for orgs and type: "User" for users
              isOrganization = userData.type === 'Organization';
            } catch (error) {
              // If the check fails, default to user
              console.warn('Could not determine account type, defaulting to user endpoint');
            }

            // Build the appropriate URL based on the account type
            const urlPath = isOrganization ? 'orgs' : 'users';
            const url = `https://api.github.com/${urlPath}/${owner}/packages/container/${packageName}/versions?per_page=${LISTING_PAGE_SIZE}`;

            const options = {
              headers: {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'sail-proxy-setup',
                'Authorization': `Bearer ${dockerPassword}`
              }
            };

            const response = await this.makeHttpRequest(url, options);
            const versions = JSON.parse(response);

            // Extract tags from GitHub response
            tags = versions
              .filter(v => v.metadata && v.metadata.container && v.metadata.container.tags && v.metadata.container.tags.length > 0)
              .flatMap(v => v.metadata.container.tags);
          } catch (error) {
            // Provided token may lack read:packages — the registry API with
            // Basic auth (or anonymously, for public packages) can still work.
            console.warn(`GitHub API listing failed, falling back to registry API...`);
            try {
              tags = await this.fetchGhcrTagsViaRegistry(organization, dockerUsername, dockerPassword);
            } catch (registryError) {
              // Even a bad/expired token must not block PUBLIC packages:
              // retry with an anonymous pull token as the last resort.
              console.warn('Authenticated registry listing failed, retrying anonymously (works for public packages)...');
              tags = await this.fetchGhcrTagsViaRegistry(organization, null, null);
            }
          }
        } else {
          // No credentials: anonymous registry token (works for public packages)
          tags = await this.fetchGhcrTagsViaRegistry(organization, null, null);
        }

      } else if (registry === 'docker.io' || registry.includes('docker.io')) {
        // Docker Hub
        const authToken = await this.getDockerHubToken(organization, 'sail-proxy-gateway', dockerUsername, dockerPassword);
        const url = `https://registry.hub.docker.com/v2/repositories/${organization}/sail-proxy-gateway/tags/?page_size=${LISTING_PAGE_SIZE}`;
        
        const options = {
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${authToken}`
          }
        };
        
        const response = await this.makeHttpRequest(url, options);
        const data = JSON.parse(response);
        
        // Extract tags from Docker Hub response
        tags = data.results
          .map(r => r.name);
          
      } else {
        // Generic Docker Registry V2 API
        const authHeader = dockerUsername && dockerPassword 
          ? 'Basic ' + Buffer.from(`${dockerUsername}:${dockerPassword}`).toString('base64')
          : '';
          
        const url = `https://${registry}/v2/${organization}/sail-proxy-gateway/tags/list`;
        const options = {
          headers: {
            'Accept': 'application/json'
          }
        };
        
        if (authHeader) {
          options.headers['Authorization'] = authHeader;
        }
        
        const response = await this.makeHttpRequest(url, options);
        const data = JSON.parse(response);
        tags = data.tags || [];
      }

      // Keep the full listing; offer only releases, newest first
      this.listedTags = new Set(tags);
      tags = [...new Set(tags)].filter(tag => this.isValidSemver(tag)).sort((a, b) => -this.compareSemver(a, b));
      
      return tags;
      
    } catch (error) {
      console.warn('⚠️  Could not fetch image tags:', error.message);
      console.log('   You can still enter a version manually.\n');
      return [];
    }
  }

  /**
   * Get Docker Hub authentication token
   */
  async getDockerHubToken(namespace, repository, username, password) {
    const authUrl = 'https://auth.docker.io/token';
    const scope = `repository:${namespace}/${repository}:pull`;
    const service = 'registry.docker.io';
    
    const url = `${authUrl}?service=${service}&scope=${scope}`;
    const options = {
      headers: {
        'Accept': 'application/json'
      }
    };
    
    if (username && password) {
      options.headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    
    const response = await this.makeHttpRequest(url, options);
    const data = JSON.parse(response);
    return data.token;
  }

  /**
   * List image tags via the Docker Registry V2 API on ghcr.io.
   * Unlike the GitHub Packages REST API, the registry issues anonymous pull
   * tokens for public packages, so this works without any credentials.
   */
  async fetchGhcrTagsViaRegistry(organization, username, password) {
    const authToken = await this.getGhcrToken(organization, 'sail-proxy-gateway', username, password);
    const url = `https://ghcr.io/v2/${organization}/sail-proxy-gateway/tags/list`;
    const response = await this.makeHttpRequest(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });
    const data = JSON.parse(response);
    return data.tags || [];
  }

  /**
   * Get GitHub Container Registry (ghcr.io) authentication token
   */
  async getGhcrToken(namespace, repository, username, password) {
    const scope = `repository:${namespace}/${repository}:pull`;
    const service = 'ghcr.io';
    
    const url = `https://ghcr.io/token?scope=${scope}&service=${service}`;
    const options = {
      headers: {
        'Accept': 'application/json'
      }
    };
    
    if (username && password) {
      // For ghcr.io, use Basic auth with username:token
      options.headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    
    const response = await this.makeHttpRequest(url, options);
    const data = JSON.parse(response);
    return data.token;
  }

  /**
   * Make HTTP request (helper method)
   */
  async makeHttpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      
      client.get(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Fetch image digest for a specific image with platform validation
   * @param {Object} config - Container configuration (registry, organization, credentials)
   * @param {string} imageName - Image name (e.g., 'sail-proxy-gateway')
   * @param {string} tag - Image tag (e.g., '1.0.0')
   * @param {string} platform - Target platform (default: 'linux/amd64')
   * @returns {Promise<string|null>} Platform-specific digest or null on error
   */
  async fetchImageDigest(config, imageName, tag, platform = 'linux/amd64') {
    try {
      return await this.lookupImageDigest(config, imageName, tag, platform);
    } catch (error) {
      console.warn(`⚠️  Could not fetch digest for ${imageName}:${tag}:`, error.message);
      return null;
    }
  }

  /**
   * fetchImageDigest without the fallback: rejects when the manifest cannot be read, with the
   * registry's HTTP status as error.statusCode when it answered one.
   */
  async lookupImageDigest(config, imageName, tag, platform = 'linux/amd64') {
    const { dockerUsername, dockerPassword } = config;
    const { host: registry, namespace: organization } = this.registryApiTarget(config);

    let authToken = '';
    let registryUrl = '';
    let authHeader = '';

    // Registry-specific setup
    if (registry === 'ghcr.io') {
      // ghcr answers 401 to a manifest request without a token, even for a public image; without a
      // login the token is an anonymous pull token, which serves public images.
      authToken = await this.getGhcrToken(organization, imageName, dockerUsername, dockerPassword);
      registryUrl = `https://ghcr.io/v2/${organization}/${imageName}/manifests/${tag}`;

    } else if (registry === 'docker.io' || registry.includes('docker.io')) {
      authToken = await this.getDockerHubToken(organization, imageName, dockerUsername, dockerPassword);
      registryUrl = `https://registry-1.docker.io/v2/${organization}/${imageName}/manifests/${tag}`;

    } else {
      // Generic registry
      if (dockerUsername && dockerPassword) {
        authHeader = 'Basic ' + Buffer.from(`${dockerUsername}:${dockerPassword}`).toString('base64');
      }
      registryUrl = `https://${registry}/v2/${organization}/${imageName}/manifests/${tag}`;
    }

    // Fetch manifest and resolve to platform-specific digest
    return this.fetchManifestAndResolve(registryUrl, authToken, authHeader, platform);
  }

  /**
   * Whether the registry has sail-proxy-gateway:`tag`: 'present' when it serves the manifest,
   * 'missing' when it answers 404, 'unknown' otherwise (refused, unreachable). Read-only, once per
   * registry, credentials and tag in a session.
   */
  manifestState(config, tag) {
    return this.once(`manifest-state:${this.registryLookupKey(config)}:${tag}`, async () => {
      try {
        return (await this.lookupImageDigest(config, 'sail-proxy-gateway', tag)) ? 'present' : 'unknown';
      } catch (error) {
        return error && error.statusCode === 404 ? 'missing' : 'unknown';
      }
    });
  }

  /**
   * Parse Docker/OCI manifest and extract digest for specified platform
   * @param {Object} manifest - Parsed manifest JSON
   * @param {string} contentType - Content-Type header from response
   * @param {string} dockerContentDigest - Docker-Content-Digest header from response
   * @param {string} platform - Target platform (e.g., 'linux/amd64')
   * @returns {string} Platform-specific digest
   * @throws {Error} If platform not found in manifest list
   */
  parseManifestForPlatform(manifest, contentType, dockerContentDigest, platform = 'linux/amd64') {
    const [targetOS, targetArch] = platform.split('/');

    // Single-arch manifest: use header digest directly
    if (contentType.includes('application/vnd.docker.distribution.manifest.v2+json')) {
      return dockerContentDigest;
    }

    // Multi-arch manifest list or OCI index: extract platform-specific digest
    if (contentType.includes('application/vnd.docker.distribution.manifest.list.v2+json') ||
        contentType.includes('application/vnd.oci.image.index.v1+json')) {

      if (!manifest.manifests || !Array.isArray(manifest.manifests)) {
        throw new Error('Invalid manifest list: missing manifests array');
      }

      // Find matching platform
      const platformManifest = manifest.manifests.find(m =>
        m.platform?.os === targetOS && m.platform?.architecture === targetArch
      );

      if (!platformManifest) {
        const available = manifest.manifests
          .map(m => m.platform ? `${m.platform.os}/${m.platform.architecture}` : 'unknown')
          .join(', ');
        throw new Error(
          `Platform ${platform} not found in manifest. Available: ${available}`
        );
      }

      return platformManifest.digest;
    }

    // Unknown manifest type: fallback to header digest with warning
    console.warn(`⚠️  Unknown manifest type: ${contentType}, using header digest`);
    return dockerContentDigest;
  }

  /**
   * Fetch manifest using GET request and resolve to platform-specific digest
   * @param {string} url - Manifest URL
   * @param {string} authToken - Bearer token (for ghcr.io, docker.io)
   * @param {string} authHeader - Authorization header (for generic registries)
   * @param {string} platform - Target platform
   * @returns {Promise<string>} Platform-specific digest
   */
  fetchManifestAndResolve(url, authToken, authHeader, platform) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const options = {
        method: 'GET',
        headers: {
          'Accept': 'application/vnd.docker.distribution.manifest.v2+json, ' +
                    'application/vnd.oci.image.index.v1+json, ' +
                    'application/vnd.docker.distribution.manifest.list.v2+json'
        }
      };

      if (authToken) {
        options.headers['Authorization'] = `Bearer ${authToken}`;
      } else if (authHeader) {
        options.headers['Authorization'] = authHeader;
      }

      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`Failed to get manifest: HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const contentType = res.headers['content-type'] || '';
            const dockerContentDigest = res.headers['docker-content-digest'];

            if (!dockerContentDigest) {
              reject(new Error('No Docker-Content-Digest header in response'));
              return;
            }

            const manifest = JSON.parse(data);
            const platformDigest = this.parseManifestForPlatform(
              manifest, contentType, dockerContentDigest, platform
            );

            // Validate digest format (sha256:[64 hex chars])
            if (!/^sha256:[a-f0-9]{64}$/.test(platformDigest)) {
              reject(new Error(`Invalid digest format: ${platformDigest}`));
              return;
            }

            resolve(platformDigest);
          } catch (error) {
            reject(new Error(`Failed to parse manifest: ${error.message}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /** Identifies a registry lookup; the password only as a hash (never kept or shown in clear). */
  registryLookupKey(config) {
    const password = config.dockerPassword
      ? crypto.createHash('sha256').update(String(config.dockerPassword)).digest('hex')
      : '';
    return JSON.stringify([config.registry, config.organization, config.dockerUsername || '', password]);
  }

  /**
   * Select image version with digest support
   */
  async selectImageVersion(config) {
    // Read-only registry lookups run once per registry, organization and
    // credentials in a session; listedTags (validateCustomTag) goes with them.
    const lookupKey = this.registryLookupKey(config);
    const listing = await this.once(`image-tags:${lookupKey}`, async () => {
      const tags = await this.fetchImageTags(config);
      return { tags, listedTags: this.listedTags };
    });
    const availableTags = listing.tags;
    this.listedTags = listing.listedTags;
    const registryLabel = `${config.registry}/${config.organization}`;
    
    let selectedVersion;
    let useDigests = false;
    const imageDigests = {};
    // A re-run's current image tag (loadCurrentValues): the listed version, else a custom one.
    let currentTag = this.session ? this.session.current.imageTag : undefined;
    // Images pinned by digest carry no tag: the listed tag with that digest is the current
    // version (read-only lookups, cached like the digest fetch below). Without a match the
    // version must be chosen explicitly - never default to the newest one.
    let pinnedUnmatched = false;
    const pinned = this.session ? this.session.current.imageDigest : undefined;
    if (currentTag === undefined && pinned && availableTags.length > 0) {
      const [image, digest] = pinned.split('@');
      for (const tag of availableTags) {
        const tagDigest = await this.once(`image-digest:${lookupKey}:${image}:${tag}`, () =>
          this.fetchImageDigest(config, image, tag)
        );
        if (tagDigest === digest) {
          currentTag = tag;
          break;
        }
      }
      if (currentTag === undefined) {
        pinnedUnmatched = true;
        console.log(`ℹ️  The current ${image} image is pinned by a digest that none of the listed versions has; choose the version explicitly.`);
      }
    }
    
    if (availableTags.length > 0) {
      console.log('\nChoose image version:');
      
      const choices = availableTags.map((tag, index) => ({
        name: index === 0 ? `${tag} (latest)` : tag,
        value: tag
      }));
      
      choices.push({ name: 'Enter custom version...', value: 'custom' });
      
      const { version } = await this.prompt([
        {
          type: 'list',
          name: 'version',
          message: 'Select version:',
          choices: choices,
          default: pinnedUnmatched ? 'custom' : currentTag === undefined ? undefined : (availableTags.includes(currentTag) ? currentTag : 'custom')
        }
      ]);
      
      if (version === 'custom') {
        const { customVersion } = await this.prompt([
          {
            type: 'input',
            name: 'customVersion',
            message: 'Enter version or image tag (e.g., 1.2.3 or review-fixes-d697e0eb):',
            default: currentTag,
            validate: (input) => this.validateCustomTag(input, availableTags, registryLabel, config),
            filter: (input) => String(input || '').trim()
          }
        ]);
        selectedVersion = customVersion;
        this.warnIfTagUnverified(selectedVersion, registryLabel);
      } else {
        selectedVersion = version;
        useDigests = true; // Use digests for available versions
      }
      
    } else {
      // No tags found, ask for manual version
      const { customVersion } = await this.prompt([
        {
          type: 'input',
          name: 'customVersion',
          message: 'Enter image version or tag (e.g., 1.0.0 or review-fixes-d697e0eb):',
          default: currentTag || '1.0.0',
          validate: (input) => this.validateCustomTag(input, availableTags, registryLabel, config),
          filter: (input) => String(input || '').trim()
        }
      ]);
      selectedVersion = customVersion;
      this.warnIfTagUnverified(selectedVersion, registryLabel);
    }
    
    // If using digests, fetch them for all three images
    if (useDigests) {
      console.log('\n🔐 Fetching image digests...');
      const images = ['sail-proxy-admin', 'sail-proxy-gateway', 'sail-proxy-nginx'];
      
      for (const image of images) {
        const digest = await this.once(`image-digest:${lookupKey}:${image}:${selectedVersion}`, () =>
          this.fetchImageDigest(config, image, selectedVersion)
        );
        if (digest) {
          imageDigests[image] = digest;
          console.log(`✅ ${image}@${digest.substring(0, 19)}...`);
        } else {
          console.log(`⚠️  ${image}: digest not found, will use tag`);
        }
      }
    }
    
    const result = {
      tag: selectedVersion,
      useDigests: useDigests && Object.keys(imageDigests).length > 0,  // Use digests if we have ANY
      imageDigests: imageDigests,
      // Whether sail-proxy-gateway has this tag in the registry: true when it was listed (chosen
      // from the list or typed and found), false when the listing succeeded without it, null when
      // the registry could not be listed. The completion summary asks for a build only when needed.
      published: await this.isTagPublished(config, selectedVersion)
    };
    
    console.log(`\n📊 Image version selection result:`);
    console.log(`   Tag: ${result.tag}`);
    console.log(`   Use Digests: ${result.useDigests}`);
    console.log(`   Digests found: ${Object.keys(imageDigests).length}/3`);
    
    return result;
  }

  /**
   * Parse a .env file and return key-value pairs
   */
  async parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace Windows line endings with Unix line endings
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    const envVars = {};
    
    content.split('\n').forEach(line => {
      // Skip empty lines and comments
      if (!line.trim() || line.trim().startsWith('#')) {
        return;
      }
      
      // Parse KEY=VALUE pairs
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        
        envVars[key] = value;
      }
    });
    
    return envVars;
  }

  /**
   * Read-only kubectl (`get`, or one of the two config reads) - see
   * kubectl-read.js, shared with deploy-kyma.js. A method so tests can mock it.
   */
  runKubectl(args) {
    return runKubectlRead(args);
  }

  /** Current kube context and its cluster server, for display; 'unknown' when unreadable. */
  describeKubeContext() {
    const read = (args) => {
      try {
        return String(this.runKubectl(args)).trim() || 'unknown';
      } catch (error) {
        return 'unknown';
      }
    };
    return { context: read(KUBECTL_CONFIG_READS[0]), server: read(KUBECTL_CONFIG_READS[1]) };
  }

  /**
   * Carry the encryption keys of an existing namespace over instead of
   * generating new ones. They protect data the running deployment has
   * stored - AWS credentials, SIEM sink credentials, issued tokens - so a
   * rotation would make it unreadable. Read-only (`kubectl get`); values are
   * never printed.
   *
   * - namespace does not exist: nothing to carry, generateSecrets makes new keys
   * - namespace exists: every key present in the live Secrets is reused verbatim
   *   (SIEM_CREDENTIAL_KEY from admin-env, or admin-config for a deployment made
   *   before it moved into the Secret); missing ones are generated
   * - kubectl cannot tell, or cannot read the Secrets: stop - never rotate
   *   silently. --ci keeps generating when the cluster is unreachable.
   */
  async loadExistingKeys() {
    const namespace = this.namespace;
    // The cluster is read once per namespace and session (Back / review jumps
    // do not read again); the questions about what was found are asked here.
    const live = await this.once(`existing-keys:${namespace}`, () => this.readExistingKeys());

    if (live.state === 'absent') {
      await this.confirmNewNamespace(live.kubeContext);
      return { carried: [] };
    }
    if (live.state === 'unreachable') {
      const { context, server } = live.kubeContext;
      console.log(`🤖 CI Mode: cluster not reachable (${live.reason}; context ${context}, server ${server}) - generating new encryption keys\n`);
      return { carried: [] };
    }

    if (live.absentKeySecrets.length > 0) {
      await this.confirmGenerateInExistingNamespace(live.absentKeySecrets);
    }

    Object.assign(this.sharedSecrets, live.found);
    if (live.db) {
      this.liveDbCredentials = live.db;
      console.log(`🔑 Namespace ${namespace} exists - carrying over its Postgres credentials`);
    }
    if (live.runtime) {
      this.sharedSecrets.FILE_SEARCH_RUNTIME_USER = live.runtime.user;
      this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD = live.runtime.password;
    }
    if (live.s3) {
      this.liveS3Env = live.s3;
      console.log(`🔑 Namespace ${namespace} has a ${S3_ENV_SECRET} Secret - carrying over its values`);
    }
    const carried = Object.keys(live.found);
    const missing = [...new Set(Object.values(LIVE_SECRET_KEYS).flat())].filter(k => !live.found[k]);
    console.log(`🔑 Namespace ${namespace} exists - carrying over its encryption keys: ${carried.join(', ') || 'none found'}`);
    if (missing.length > 0) {
      console.log(`   Not found in the live namespace, generated new: ${missing.join(', ')}`);
    }
    console.log('');
    return { carried };
  }

  /**
   * The read-only half of loadExistingKeys: what the live namespace holds,
   * without asking or changing anything. Returns
   * - { state: 'absent', kubeContext } - the namespace does not exist
   * - { state: 'unreachable', kubeContext, reason } - --ci only, cluster unreachable
   * - { state: 'exists', found, absentKeySecrets, db, runtime, s3, secrets }
   *   (secrets: the data of every Secret read, by name - the source of the current values a
   *   re-run falls back to; never printed)
   * and throws where setup must stop. --ci stops on an absent key Secret
   * right here, before reading further, as it always has.
   */
  async readExistingKeys() {
    const namespace = this.namespace;
    // isServerNotFound / isUnreachable (kubectl-read.js): only the API
    // server's own NotFound for exactly this object means "absent", and --ci
    // treats the cluster as unreachable only when it positively is.

    try {
      this.runKubectl(['get', 'namespace', namespace, '-o', 'name']);
    } catch (error) {
      if (isServerNotFound(error, 'namespaces', namespace)) {
        return { state: 'absent', kubeContext: this.describeKubeContext() };
      }
      if (this.ciMode && isUnreachable(error)) {
        return { state: 'unreachable', kubeContext: this.describeKubeContext(), reason: stderrOf(error) };
      }
      throw new Error(
        `Cannot tell whether namespace ${namespace} already exists (kubectl: ${stderrOf(error)}). ` +
        'Its encryption keys must be carried over, not generated anew - an existing deployment would lose ' +
        'access to its stored credentials. Point kubectl at the cluster (context, access) and run setup again.'
      );
    }

    const readData = (kind, name) => {
      try {
        return readResourceData((args) => this.runKubectl(args), kind, name, namespace);
      } catch (error) {
        throw new Error(`${error.message} Refusing to generate new encryption keys for an existing deployment.`);
      }
    };

    const secretCache = {};
    const absentSecrets = [];
    const secretData = (name) => {
      if (!(name in secretCache)) {
        const data = readData('secret', name);
        if (data === null) absentSecrets.push(name);
        secretCache[name] = data || {};
      }
      return secretCache[name];
    };

    const found = {};
    for (const [secret, keys] of Object.entries(LIVE_SECRET_KEYS)) {
      const data = secretData(secret);
      for (const key of keys) {
        if (!data[key]) continue;
        if (found[key] !== undefined && found[key] !== data[key]) {
          throw new Error(
            `The live Secrets in namespace ${namespace} disagree on ${key} (admin-env vs gateway-env). ` +
            'Resolve that first; setup will not pick one.'
          );
        }
        found[key] = data[key];
      }
    }
    // An existing namespace whose admin-env or gateway-env is gone would get
    // new keys for everything that Secret held - never quietly. --ci stops
    // here; interactively loadExistingKeys asks.
    const absentKeySecrets = Object.keys(LIVE_SECRET_KEYS).filter(name => absentSecrets.includes(name));
    if (absentKeySecrets.length > 0 && this.ciMode) {
      await this.confirmGenerateInExistingNamespace(absentKeySecrets);
    }

    // Deployed before SIEM_CREDENTIAL_KEY moved into admin-env, it is only in
    // admin-config; during the move it can be in both, and then must agree.
    const configMapSiem = (readData('configmap', 'admin-config') || {}).SIEM_CREDENTIAL_KEY;
    if (configMapSiem) {
      if (found.SIEM_CREDENTIAL_KEY && found.SIEM_CREDENTIAL_KEY !== configMapSiem) {
        throw new Error(
          `The live admin-env Secret and admin-config ConfigMap in namespace ${namespace} disagree on ` +
          'SIEM_CREDENTIAL_KEY. Resolve that first; setup will not pick one.'
        );
      }
      found.SIEM_CREDENTIAL_KEY = configMapSiem;
    }

    const { db, runtime } = this.readLiveDbCredentials(secretData);
    const s3 = this.readLiveS3Env();
    return { state: 'exists', found, absentKeySecrets, db, runtime, s3, secrets: { ...secretCache } };
  }

  /**
   * The Postgres credentials of the live namespace: the volume keeps the user
   * and password it was initialised with, so a re-run must render exactly
   * those. Sources, which must all agree where present: postgres-env
   * (POSTGRES_USER/PASSWORD), admin-env (DATABASE_URL and
   * cds.requires.db.credentials.password) and gateway-migration-env
   * (FILE_SEARCH_MIGRATION_DATABASE_URL). The file_search runtime role's
   * credentials (gateway-env FILE_SEARCH_DATABASE_URL) are carried too, so
   * running gateway pods keep working while new ones start. Never printed.
   * @returns {{ db: object|null, runtime: object|null }}
   */
  readLiveDbCredentials(secretData) {
    const namespace = this.namespace;
    const parseUrl = (url, encoded) => {
      const match = /^postgres(?:ql)?:\/\/(.*)@[^@]*$/.exec(url || '');
      if (!match) return null;
      const separator = match[1].indexOf(':');
      if (separator < 0) return null;
      const decode = encoded ? decodeURIComponent : (v) => v;
      return { user: decode(match[1].slice(0, separator)), password: decode(match[1].slice(separator + 1)) };
    };

    const postgres = secretData('postgres-env');
    const admin = secretData('admin-env');
    const migration = secretData('gateway-migration-env');
    const sources = [
      ['postgres-env', { user: postgres.POSTGRES_USER, password: postgres.POSTGRES_PASSWORD }],
      ['admin-env DATABASE_URL', parseUrl(admin.DATABASE_URL, false)],
      ['admin-env cds.requires.db.credentials.password', { password: admin['cds.requires.db.credentials.password'] }],
      ['gateway-migration-env', parseUrl(migration.FILE_SEARCH_MIGRATION_DATABASE_URL, true)]
    ];

    let user;
    let password;
    for (const [source, creds] of sources) {
      if (!creds) continue;
      for (const [field, value] of [['user', creds.user], ['password', creds.password]]) {
        if (!value) continue;
        const current = field === 'user' ? user : password;
        if (current !== undefined && current !== value) {
          throw new Error(
            `The live Secrets in namespace ${namespace} disagree on the Postgres credentials (${field}, at ${source}). ` +
            'Resolve that first; setup will not pick one.'
          );
        }
        if (field === 'user') user = value; else password = value;
      }
    }

    let db = null;
    if (user && password) {
      db = { POSTGRES_USER: user, POSTGRES_PASSWORD: password };
    } else if (user || password) {
      throw new Error(
        `The live Secrets in namespace ${namespace} hold only part of the Postgres credentials. ` +
        'Resolve that first; setup will not guess the rest.'
      );
    }

    const parsed = parseUrl(secretData('gateway-env').FILE_SEARCH_DATABASE_URL, true);
    const runtime = parsed && parsed.user && parsed.password ? parsed : null;
    return { db, runtime };
  }

  /**
   * The optional gateway-s3-env Secret (file_search blobs in S3): the operator
   * creates it by hand, so nothing here generates it. A re-run renders the
   * live values unchanged as gateway-s3-env.yaml, which deploy-kyma.js applies
   * like the other Secrets; without this the rendered secrets would be all a
   * re-run knows, and an operator restoring from them would lose the keys.
   * Absent: nothing is rendered and the gateway runs without S3 credentials.
   * Never printed.
   * @returns {object|null} the values to carry over
   */
  readLiveS3Env() {
    let data;
    try {
      data = readResourceData((args) => this.runKubectl(args), 'secret', S3_ENV_SECRET, this.namespace);
    } catch (error) {
      throw new Error(`${error.message} Cannot carry over the file_search S3 credentials; fix access and run setup again.`);
    }
    if (!data) return null;
    const values = {};
    for (const key of S3_ENV_KEYS) {
      if (data[key]) values[key] = data[key];
    }
    return Object.keys(values).length === 0 ? null : values;
  }

  /** The gateway-s3-env Secret manifest for the carried-over values, or null. */
  renderS3EnvSecret(namespace) {
    if (!this.liveS3Env) return null;
    const lines = S3_ENV_KEYS.filter((key) => this.liveS3Env[key])
      .map((key) => `  ${key}: ${this.yamlQuote(this.liveS3Env[key])}`);
    return `apiVersion: v1
kind: Secret
metadata:
  name: ${S3_ENV_SECRET}
  namespace: ${namespace}
type: Opaque
stringData:
${lines.join('\n')}
`;
  }

  /**
   * An existing namespace's Postgres volume only accepts the credentials it
   * was created with. Anything else stops the setup; values are not printed.
   */
  assertDbCredentialsMatchLive(dbConfig) {
    const live = this.liveDbCredentials;
    if (!live) return;
    if (dbConfig.POSTGRES_USER !== live.POSTGRES_USER || dbConfig.POSTGRES_PASSWORD !== live.POSTGRES_PASSWORD) {
      throw new Error(
        `Namespace ${this.namespace} already has a Postgres database, and its volume keeps the user and password ` +
        'it was created with - different credentials cannot work. Leave the database prompts at their defaults ' +
        '(empty password) to keep the existing credentials.'
      );
    }
  }

  /**
   * The namespace does not exist on the current context: show which context
   * and cluster that is - a wrong context would otherwise look like a new
   * namespace - and, interactively, ask before generating new keys.
   */
  async confirmNewNamespace({ context, server } = this.describeKubeContext()) {
    console.log(`🔑 Namespace ${this.namespace} does not exist yet on kube context ${context} (${server})`);
    if (!this.ciMode) {
      const { confirmNewNamespace } = await this.prompt([
        {
          type: 'confirm',
          name: 'confirmNewNamespace',
          message: `Is this the right cluster? Generate new encryption keys and database credentials for namespace ${this.namespace}?`,
          default: false
        }
      ]);
      if (!confirmNewNamespace) {
        throw new Error(
          `Setup stopped: namespace ${this.namespace} was not found on kube context ${context}. ` +
          'Switch to the right context and run setup again.'
        );
      }
    }
    console.log(`   Generating new encryption keys for namespace ${this.namespace}\n`);
  }

  /**
   * Namespace exists, but a Secret holding its keys does not: generating
   * would replace keys the deployment may still have data encrypted with.
   * Interactive: ask (default no). --ci: stop.
   */
  async confirmGenerateInExistingNamespace(absentKeySecrets) {
    const names = absentKeySecrets.join(', ');
    const message = `Namespace ${this.namespace} exists but has no ${names} Secret, so its encryption keys ` +
      'would be generated anew - data the deployment stored with the old keys would become unreadable.';
    if (this.ciMode) {
      throw new Error(`${message} Stopping (--ci never generates keys for an existing namespace).`);
    }
    console.log(`⚠️  ${message}`);
    const { confirmGenerateInExistingNamespace } = await this.prompt([
      {
        type: 'confirm',
        name: 'confirmGenerateInExistingNamespace',
        message: `Generate new keys for the ones missing from ${names} in namespace ${this.namespace}?`,
        default: false
      }
    ]);
    if (!confirmGenerateInExistingNamespace) {
      throw new Error(`Setup stopped: namespace ${this.namespace} has no ${names} Secret and new keys were not confirmed.`);
    }
  }

  generateSecrets() {
    // Each key only when missing: loadExistingKeys may already have carried
    // some over from the live namespace, and those must never be replaced.
    // Core service secrets (64 chars hex each)
    if (!this.sharedSecrets.VALIDATION_TOKEN_SECRET) {
      this.sharedSecrets.VALIDATION_TOKEN_SECRET = this.generateSecureToken();
    }
    if (!this.sharedSecrets.METADATA_ENCRYPTION_KEY) {
      this.sharedSecrets.METADATA_ENCRYPTION_KEY = this.generateSecureToken();
    }
    if (!this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY) {
      this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY = this.generateSecureToken();
    }
    // Encrypts the admin's SiemCredentials rows (admin-env Secret).
    if (!this.sharedSecrets.SIEM_CREDENTIAL_KEY) {
      this.sharedSecrets.SIEM_CREDENTIAL_KEY = this.generateSiemCredentialKey();
    }
    // Encrypts the admin's ConnectionCredentials rows (admin-env Secret); same shape as the SIEM key.
    if (!this.sharedSecrets.CONNECTION_CREDENTIAL_KEY) {
      this.sharedSecrets.CONNECTION_CREDENTIAL_KEY = this.generateSiemCredentialKey();
    }

    // OAuth2 Proxy secrets (matching current hardcoded lengths)
    if (!this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET) {
      this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET = this.generateOAuth2ClientSecret(); // 64 chars
    }
    if (!this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET) {
      this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET = this.generateOAuth2CookieSecret(); // 32 chars
    }

    // Database password: only generate if not already set by user
    if (!this.sharedSecrets.POSTGRES_PASSWORD) {
      this.sharedSecrets.POSTGRES_PASSWORD = this.generateDatabasePassword();
    }

    // file_search runtime role: DML only (SELECT/INSERT/UPDATE/DELETE on the
    // file_search tables, no CREATE) — provisioned by the gateway pod's
    // migrate-file-search initContainer, which uses gateway-migration-env's
    // FILE_SEARCH_MIGRATION_DATABASE_URL (POSTGRES_USER/POSTGRES_PASSWORD
    // above) to grant it. Username is fixed rather than prompted: it's an
    // internal service account, not something an operator needs to choose.
    if (!this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD) {
      this.sharedSecrets.FILE_SEARCH_RUNTIME_USER = 'file_search_app';
      this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD = this.generateDatabasePassword();
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

  async promptForServiceKey() {
    console.log('\nSAP AI Core Configuration');
    console.log('========================\n');
    
    // Check for existing gateway .env file
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    let existingConfig = null;
    
    if (fs.existsSync(gatewayEnvPath)) {
      console.log('📄 Checking existing gateway configuration...');
      const gatewayEnv = await this.parseEnvFile(gatewayEnvPath);
      
      // Check if valid SAP AI Core credentials exist
      if (gatewayEnv.CLIENT_ID && gatewayEnv.CLIENT_ID !== 'your-client-id' &&
          gatewayEnv.CLIENT_SECRET && gatewayEnv.CLIENT_SECRET !== 'your-client-secret' &&
          gatewayEnv.SAP_AI_CORE_URL && gatewayEnv.AUTH_URL) {
        
        console.log('\n✅ Found existing SAP AI Core configuration:');
        console.log(`   - SAP AI Core URL: ${gatewayEnv.SAP_AI_CORE_URL}`);
        console.log(`   - Auth URL: ${gatewayEnv.AUTH_URL}`);
        console.log(`   - Client ID: ${gatewayEnv.CLIENT_ID}`);
        console.log(`   - Region: ${gatewayEnv.SAP_AI_REGION || 'Not specified'}`);
        
        existingConfig = {
          SAP_AI_CORE_URL: gatewayEnv.SAP_AI_CORE_URL,
          AUTH_URL: gatewayEnv.AUTH_URL,
          CLIENT_ID: gatewayEnv.CLIENT_ID,
          CLIENT_SECRET: gatewayEnv.CLIENT_SECRET,
          SAP_AI_REGION: gatewayEnv.SAP_AI_REGION || 'unknown',
          SAP_AI_RESOURCE_GROUP: gatewayEnv.SAP_AI_RESOURCE_GROUP || 'default'
        };
        
        // In CI mode, always use existing config
        if (this.ciMode) {
          console.log('\n🤖 CI Mode: Using existing configuration from gateway .env file');
          return existingConfig;
        }
        
        const { useExisting } = await this.prompt([
          {
            type: 'confirm',
            name: 'useExisting',
            message: 'Use existing SAP AI Core configuration?',
            default: true
          }
        ]);
        
        if (useExisting) {
          console.log('\n🔄 Using existing configuration from gateway .env file');
          return existingConfig;
        } else {
          // Nothing to delete: every Kyma render starts from fresh .env files
          // (see withLocalConfigRestored in generateManifests), and the
          // local ones are restored afterwards.
          console.log('\nℹ️  The Kyma configuration is built from fresh .env files; your local');
          console.log('   services/gateway/.env and services/admin/.env are left as they are.');
        }
      }
    }
    
    // Check for environment variable: a first install only. A re-run or upgrade reads the
    // installation's SAP answer (configMethod and its values) from the cluster, and a key that
    // happens to be in the admin's shell must not replace those credentials.
    const hasCurrentAnswer = this.session && this.session.current.configMethod !== undefined;
    const envConfig = hasCurrentAnswer ? null : this.checkEnvServiceKey();
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
      // Manual entry
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

  /**
   * Prompt for database credentials with secure defaults
   * @returns {Object} Database configuration object
   */
  async promptForDatabaseCredentials() {
    if (this.ciMode && this.liveDbCredentials) {
      console.log('🤖 CI Mode: using the database credentials of the existing namespace');
      this.sharedSecrets.POSTGRES_PASSWORD = this.liveDbCredentials.POSTGRES_PASSWORD;
      return { ...this.liveDbCredentials, useGeneratedSecrets: false, passwordWasGenerated: false };
    }
    if (this.ciMode) {
      // CI mode: use secure generated defaults. This runs before
      // generateSecrets, so the password must be generated here - it used to
      // be read while still unset and rendered as an empty password.
      if (!this.sharedSecrets.POSTGRES_PASSWORD) {
        this.sharedSecrets.POSTGRES_PASSWORD = this.generateDatabasePassword();
      }
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
        default: this.liveDbCredentials ? this.liveDbCredentials.POSTGRES_USER : 'admin_user',
        validate: validateDatabaseUsername
      }
    ]);

    // Then, handle password with confirmation for manual entry
    let passwordConfig = {};
    let passwordConfirmed = false;
    
    while (!passwordConfirmed) {
      passwordConfig = await this.prompt([
        {
          type: 'password',
          name: 'POSTGRES_PASSWORD',
          message: this.liveDbCredentials
            ? 'Database password (leave empty to keep the existing one):'
            : 'Database password (leave empty for auto-generated):',
          mask: '*',
          review: false, // one review entry for the password step, see recordDatabasePassword
          validate: (input) => {
            if (input && input.length > 0 && input.length < 8) {
              return 'Password must be at least 8 characters long if provided';
            }
            if (input && input.includes('=')) {
              return 'Password cannot contain the "=" character (conflicts with env files)';
            }
            return true;
          }
        }
      ]);
      
      // If password is empty, user wants auto-generation - no confirmation needed
      if (!passwordConfig.POSTGRES_PASSWORD || passwordConfig.POSTGRES_PASSWORD.trim().length === 0) {
        passwordConfirmed = true;
        break;
      }
      
      // User provided a password - require confirmation
      const confirmConfig = await this.prompt([
        {
          type: 'password',
          name: 'POSTGRES_PASSWORD_CONFIRM',
          message: 'Confirm database password:',
          mask: '*',
          review: false
        }
      ]);
      
      // Check if passwords match
      if (passwordConfig.POSTGRES_PASSWORD === confirmConfig.POSTGRES_PASSWORD_CONFIRM) {
        passwordConfirmed = true;
        console.log('   ✅ Password confirmed successfully');
      } else {
        console.log('\n❌ Passwords do not match. Please try again.\n');
        // Continue the loop to re-prompt for password
      }
    }
    
    // Combine username and password config
    const dbConfig = {
      ...usernameConfig,
      ...passwordConfig
    };

    // An existing namespace keeps its credentials: empty means "the live
    // password", anything that differs from it stops the setup.
    if (this.liveDbCredentials) {
      if (!dbConfig.POSTGRES_PASSWORD || dbConfig.POSTGRES_PASSWORD.trim().length === 0) {
        dbConfig.POSTGRES_PASSWORD = this.liveDbCredentials.POSTGRES_PASSWORD;
      }
      this.assertDbCredentialsMatchLive(dbConfig);
      dbConfig.useGeneratedSecrets = false;
      dbConfig.passwordWasGenerated = false;
      this.recordDatabasePassword('set');
      console.log('   ✅ Using the existing database credentials');
      this.sharedSecrets.POSTGRES_PASSWORD = dbConfig.POSTGRES_PASSWORD;
      return dbConfig;
    }

    // Use generated password if user didn't provide one
    if (!dbConfig.POSTGRES_PASSWORD || dbConfig.POSTGRES_PASSWORD.trim().length === 0) {
      dbConfig.POSTGRES_PASSWORD = this.generatedOnce('POSTGRES_PASSWORD', () => this.generateDatabasePassword());
      dbConfig.useGeneratedSecrets = true;
      dbConfig.passwordWasGenerated = true;
      this.recordDatabasePassword('generated');
      console.log(`   ✅ Using auto-generated secure password: ${mask(dbConfig.POSTGRES_PASSWORD)}`);
    } else {
      dbConfig.useGeneratedSecrets = false;
      dbConfig.passwordWasGenerated = false;
      this.recordDatabasePassword('new');
      console.log('   ✅ Using provided password');
    }
    
    // Always update sharedSecrets with the final password (generated or provided)
    this.sharedSecrets.POSTGRES_PASSWORD = dbConfig.POSTGRES_PASSWORD;

    return dbConfig;
  }

  /** The review screen's one entry for the database password step: its origin, never the value. */
  recordDatabasePassword(display) {
    if (!this.session) return;
    this.session.record({
      id: 'POSTGRES_PASSWORD',
      label: 'Database password',
      value: display,
      display,
      secret: true,
      changed: display !== 'set'
    });
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

  async showWelcome() {
    console.log('\n' + '='.repeat(60));
    console.log('   SAIL-PROXY Kyma Setup');
    console.log('='.repeat(60));
    console.log('\nThis script will help you configure the SAP LLM Gateway');
    console.log('for Kyma deployment, including:');
    console.log('  - Kubernetes manifests and ConfigMaps');
    console.log('  - Authentication providers');
    console.log('  - Public HTTPS or internal-only deployment');
    console.log('  - IP allowlisting with Istio AuthorizationPolicy\n');
    
    if (this.ciMode) {
      console.log('🤖 Running in CI/CD mode - using default options');
      console.log('   - Local Development authentication');
      console.log('   - Internal-only deployment (Cloud Connector)\n');
    }
    
    if (this.forceOverwrite) {
      console.log('⚠️  Running in FORCE mode - existing manifests will be overwritten!\n');
    }
  }

  async selectDeploymentType() {
    if (this.ciMode) {
      console.log('🤖 CI Mode: Auto-selecting internal-only deployment\n');
      return 'internal';
    }
    
    console.log('Deployment Options:\n');
    
    const { deploymentType } = await this.prompt([
      {
        type: 'list',
        name: 'deploymentType',
        message: 'Select deployment type:',
        choices: [
          {
            name: 'Public HTTPS - Internet accessible with IP allowlisting',
            value: 'public',
            short: 'Public HTTPS'
          },
          {
            name: 'Internal-only - Access via Cloud Connector Service Channel',
            value: 'internal',
            short: 'Internal-only'
          }
        ]
      }
    ]);

    return deploymentType;
  }

  async selectProvider() {
    if (this.ciMode) {
      console.log('🤖 CI Mode: Auto-selecting Local Development provider\n');
      return 'local';
    }
    
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

  async collectProviderConfig(provider) {
    let prompts = PROVIDER_PROMPTS[provider];
    if (!prompts || prompts.length === 0) return {};

    if (this.ciMode) {
      console.log(`🤖 CI Mode: Using default configuration for ${PROVIDERS[provider].name}\n`);
      
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
    
    // Process answers (similar to Docker setup)
    for (const [key, value] of Object.entries(answers)) {
      if (key === 'OKTA_SAML_CA_DATA' && value === 'auto-fetch-from-metadata') {
        // Handle auto-fetch
        if (answers.OKTA_METADATA_URL) {
          try {
            console.log('Auto-fetching SAML certificate from metadata...');
            const fetched = await this.once(`saml-metadata:${answers.OKTA_METADATA_URL}`, () =>
              this.fetchSamlCertificateFromMetadata(answers.OKTA_METADATA_URL).then(
                (info) => ({ info }),
                (error) => ({ error })
              )
            );
            if (fetched.error) throw fetched.error;
            const metadataInfo = fetched.info;
            config[key] = metadataInfo.certificate;
            
            // Auto-populate SSO URL
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
    
    // Handle LDAP external configuration (Kyma only supports external LDAP)
    if (provider === 'ldap') {
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
    
    // Generate ROLE_MAPPING based on provider (same logic as Docker setup)
    if (provider === 'github') {
      const roleMapping = {};
      
      if (config.GITHUB_ORG) {
        roleMapping[`${config.GITHUB_ORG}:${config.GITHUB_ADMIN_TEAM}`] = 'admin';
        roleMapping[`${config.GITHUB_ORG}:${config.GITHUB_USER_TEAM}`] = 'user';
      } else {
        roleMapping[config.GITHUB_ADMIN_TEAM] = 'admin';
        roleMapping[config.GITHUB_USER_TEAM] = 'user';
      }
      
      config.ROLE_MAPPING = JSON.stringify(roleMapping);
    } else if (provider === 'local') {
      config.ROLE_MAPPING = '{"admin@example.com":"admin","user@example.com":"user"}';
    } else if (provider === 'okta') {
      const roleMapping = {};
      
      if (config.OKTA_ADMIN_GROUP) {
        roleMapping[config.OKTA_ADMIN_GROUP] = 'admin';
      }
      if (config.OKTA_USER_GROUP) {
        roleMapping[config.OKTA_USER_GROUP] = 'user';
      }
      
      config.ROLE_MAPPING = JSON.stringify(roleMapping);
    } else if (provider === 'ldap') {
      const roleMapping = {};
      
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

  async getContainerConfig() {
    if (this.ciMode) {
      // Read version from package.json
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
      console.log('🤖 CI Mode: Using default container registry (ghcr.io)\n');
      return {
        registry: 'ghcr.io',
        organization: 'st-gr',
        tag: packageJson.version,
        imagePullSecrets: false,
        useDigests: false
      };
    }
    
    console.log('\nContainer Registry Configuration:');
    
    const config = await this.prompt([
      {
        type: 'list',
        name: 'registry',
        message: 'Select container registry:',
        choices: [
          { name: 'GitHub Container Registry (ghcr.io)', value: 'ghcr.io', short: 'ghcr.io' },
          { name: 'Docker Hub (docker.io)', value: 'docker.io', short: 'docker.io' },
          { name: 'Azure Container Registry (*.azurecr.io)', value: 'custom-acr', short: 'ACR' },
          { name: 'Custom registry', value: 'custom', short: 'Custom' }
        ],
        default: 'ghcr.io'
      }
    ]);
    
    if (config.registry === 'custom' || config.registry === 'custom-acr') {
      const { customRegistry } = await this.prompt([
        {
          type: 'input',
          name: 'customRegistry',
          message: config.registry === 'custom-acr' ? 'ACR registry name (e.g., myregistry.azurecr.io):' : 'Custom registry URL:',
          validate: (input) => input.trim() ? true : 'Registry URL is required',
          filter: (input) => {
            // Remove protocol if provided
            return input.replace(/^https?:\/\//, '').trim();
          }
        }
      ]);
      config.registry = customRegistry;
    }
    
    const orgAndAuthConfig = await this.prompt([
      {
        type: 'input',
        name: 'organization',
        message: 'Organization/namespace (e.g., your-org, your-username):',
        validate: (input) => input.trim() ? true : 'Organization is required',
        default: config.registry === 'ghcr.io' ? 'st-gr' : 'your-org'
      },
      {
        type: 'confirm',
        name: 'imagePullSecrets',
        message: 'Requires image pull secrets (private registry)?',
        default: config.registry !== 'docker.io' && config.registry !== 'ghcr.io'
      }
    ]);
    
    config.organization = orgAndAuthConfig.organization;
    config.imagePullSecrets = orgAndAuthConfig.imagePullSecrets;
    
    // If image pull secrets are required, collect the credentials. A re-run offers the login
    // stored in the namespace's registry-secret.yaml as current values, only for the registry it
    // was made for: the session shows the token as set, Enter keeps it, and the review marks it
    // set. A login answered for another registry (before Back or a review jump) is forgotten.
    let registryCredentials = {};
    if (config.imagePullSecrets) {
      // Without a rendered file (an upgrade's temp copy), the namespace's live pull secret.
      const stored = this.forceOverwrite ? null : readRegistrySecret(this.secretsDir) ||
        await this.once(`live-registry:${this.namespace}`, () => this.readLiveRegistryLogin());
      const storedLogin = stored && stored.server === config.registry ? stored : null;
      if (this.session) {
        if (this.loginRegistry !== undefined && this.loginRegistry !== config.registry) {
          this.session.forget(['dockerUsername', 'dockerPassword']);
        }
        this.loginRegistry = config.registry;
        if (storedLogin) {
          this.session.current.dockerUsername = storedLogin.username;
          this.session.current.dockerPassword = storedLogin.password;
        } else {
          delete this.session.current.dockerUsername;
          delete this.session.current.dockerPassword;
        }
      }
      console.log('\nDocker Registry Authentication:');
      registryCredentials = await this.prompt([
        {
          type: 'input',
          name: 'dockerUsername',
          message: 'Docker registry username:',
          validate: (input) => input.trim() ? true : 'Username is required'
        },
        {
          type: 'password',
          name: 'dockerPassword',
          message: 'Docker registry password/token:',
          mask: '*',
          validate: (input) => input.trim() ? true : 'Password/token is required'
        }
      ]);
      config.dockerUsername = registryCredentials.dockerUsername;
      config.dockerPassword = registryCredentials.dockerPassword;
    }
    
    // Now fetch available versions and let user select
    const versionInfo = await this.selectImageVersion(config);
    
    return {
      ...config,
      ...versionInfo
    };
  }

  /** The live namespace's pull-secret login (live-values.js), or null when it has none. */
  async readLiveRegistryLogin() {
    const live = await this.once(`existing-keys:${this.namespace}`, () => this.readExistingKeys());
    return live.state === 'exists' ? readLiveRegistrySecret((args) => this.runKubectl(args), this.namespace) : null;
  }

  /**
   * A non-default namespace must not claim production's host: two
   * VirtualServices for one host on the shared kyma-gateway would split
   * production's traffic between the two deployments.
   */
  validateOwnHost(host) {
    if (!isDefaultNamespace(this.namespace) && host === DEFAULT_NAMESPACE) {
      return `"${host}" is production's host name; namespace ${this.namespace} needs a host of its own (e.g. ${this.namespace})`;
    }
    return true;
  }

  /**
   * Does the shared Istio ingress gateway already have an ALLOW policy? Any
   * ALLOW selecting it makes it deny-by-default for every host no ALLOW
   * matches. Counts policies in istio-system whose action is ALLOW (Istio's
   * default when unset) and that select the ingress gateway, or select
   * nothing (istio-system is the root namespace: mesh-wide). Read-only
   * (`kubectl get`); null when the policies cannot be read.
   */
  detectIngressAllowPolicies() {
    try {
      const items = JSON.parse(this.runKubectl(['get', 'authorizationpolicies', '-n', 'istio-system', '-o', 'json'])).items || [];
      return items.some(policy => {
        const spec = policy.spec || {};
        const labels = (spec.selector && spec.selector.matchLabels) || null;
        const selectsGateway = !labels || labels.istio === 'ingressgateway' || labels.app === 'istio-ingressgateway';
        return (spec.action === undefined || spec.action === 'ALLOW') && selectsGateway;
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Shown at the IP allowlist prompt of a non-default namespace. On a gateway
   * that already has ALLOW policies (production's IP allowlist, others) a new
   * host without its own ALLOW is refused for everyone; only on a gateway
   * without any does adding one make every other host deny-by-default.
   * this.ingressHasAllowPolicies (detectIngressAllowPolicies) picks the
   * sentence; unknown states the rule for both.
   */
  ipAllowlistWarning() {
    if (isDefaultNamespace(this.namespace)) return null;
    const needsOwn = `namespace ${this.namespace} NEEDS its own IP allowlist - enter the client IPs that should reach ` +
      'it - or its host is refused for everyone.';
    const locksOthers = `an IP allowlist here makes the gateway deny-by-default for every other host on the cluster, ` +
      `production (${DEFAULT_NAMESPACE}) included, unless another allowlist admits their clients.`;
    if (this.ingressHasAllowPolicies === true) {
      return `⚠️  The shared Istio ingress gateway already has ALLOW policies (e.g. production's IP allowlist), so ` +
        `it is deny-by-default:\n  ${needsOwn}`;
    }
    if (this.ingressHasAllowPolicies === false) {
      return `⚠️  The shared Istio ingress gateway has no ALLOW policies yet: ${locksOthers}`;
    }
    return `⚠️  If the shared ingress gateway already has ALLOW policies (e.g. production uses an IP allowlist), ` +
      `${needsOwn}\n  Only on a gateway with no ALLOW policies does adding one make every other host on the ` +
      `cluster, production (${DEFAULT_NAMESPACE}) included, deny-by-default.`;
  }

  publicConfigQuestions() {
    return [
      {
        type: 'input',
        name: 'domain',
        message: 'APIRule host name (e.g., sail-proxy):',
        // A second namespace needs a host of its own: two VirtualServices for
        // one host on the shared kyma-gateway would split production's traffic.
        default: this.namespace,
        validate: (input) => {
          if (!input.trim()) return 'Domain is required';
          const validation = validateRFC1123Label(input.trim());
          return validation === true ? this.validateOwnHost(input.trim()) : validation;
        }
      },
      {
        type: 'input',
        name: 'clusterSubdomain',
        message: 'Kyma cluster subdomain (e.g., c-abc123 from https://console.c-abc123.kyma.ondemand.com):',
        default: 'c-XXXXX',
        validate: (input) => {
          if (!input.trim()) return 'Cluster subdomain is required';
          if (!/^c-[a-z0-9]+$/.test(input)) return 'Invalid format. Should be like: c-abc123';
          return true;
        }
      },
      {
        type: 'input',
        name: 'ipAllowlist',
        message: (this.ipAllowlistWarning() ? `${this.ipAllowlistWarning()}\n  ` : '') +
          'IP allowlist (comma-separated CIDRs, e.g., 198.51.100.0/24,203.0.113.12/32):',
        default: '',
        validate: (input) => {
          if (!input.trim()) return true; // Allow empty (no IP restrictions)
          
          const cidrs = input.split(',').map(s => s.trim()).filter(Boolean);
          for (const cidr of cidrs) {
            // Basic CIDR validation
            if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(cidr)) {
              return `Invalid CIDR format: ${cidr}. Use format like 192.168.1.0/24 or 203.0.113.12/32`;
            }
          }
          return true;
        }
      },
      {
        type: 'confirm',
        name: 'allowIstioSystemChanges',
        message: 'Allow deployment to manage IP restrictions in istio-system namespace? (Required for IP allowlist)',
        default: true,
        when: (answers) => answers.ipAllowlist && answers.ipAllowlist.trim()
      },
      {
        type: 'confirm',
        name: 'sccTunnel',
        message: 'Does this cluster use the SAP Cloud Connector / Connectivity Proxy tunnel? (keeps cp.* reachable)',
        default: true
      }
    ];
  }

  async getPublicConfig() {
    if (this.ciMode) {
      console.log('🤖 CI Mode: Using localhost for development\n');
      return {
        domain: this.namespace,
        clusterSubdomain: 'c-XXXXX',
        ipAllowlist: [],
        sccTunnel: true
        // allowIstioSystemChanges not set - will skip IP restrictions in CI mode
      };
    }
    
    console.log('\nPublic HTTPS Configuration:');
    if (!isDefaultNamespace(this.namespace)) {
      // Picks the IP allowlist warning that applies to this cluster.
      this.ingressHasAllowPolicies = await this.once('ingress-allow-policies', () => this.detectIngressAllowPolicies());
    }

    const config = await this.prompt(this.publicConfigQuestions());
    
    // Process IP allowlist
    config.ipAllowlist = config.ipAllowlist 
      ? config.ipAllowlist.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    
    // Warn if IP allowlist was provided but istio-system changes denied
    if (config.ipAllowlist.length > 0 && config.allowIstioSystemChanges === false) {
      console.log('\n⚠️  Warning: IP allowlist specified but istio-system changes denied.');
      console.log('   IP restrictions will not be enforced. Anyone will be able to access your deployment.');
      config.ipAllowlist = []; // Clear the allowlist since it can't be enforced
    }
    
    return config;
  }

  async generateManifests(deploymentType, provider, providerConfig, publicConfig, containerConfig, dbConfig, sapConfig) {
    console.log('\nGenerating Kubernetes manifests...\n');

    // Never render other database credentials than the live namespace's.
    this.assertDbCredentialsMatchLive(dbConfig || {});

    // Also enforced here, not only at the prompt, so no path (--ci included)
    // renders a second namespace onto production's host.
    if (deploymentType === 'public' && publicConfig) {
      const hostValidation = this.validateOwnHost(publicConfig.domain);
      if (hostValidation !== true) {
        throw new Error(hostValidation);
      }
    }

    // Generate shared secrets
    this.generateSecrets();
    
    // Determine base URL based on deployment type
    let baseUrl;
    if (deploymentType === 'public' && publicConfig) {
      // For Kyma deployments, you need to provide the full cluster subdomain
      // e.g., if your Kyma dashboard is at https://console.c-abc123.kyma.ondemand.com
      // then your cluster ID is 'c-abc123'
      const clusterSubdomain = publicConfig.clusterSubdomain || 'c-XXXXX';
      baseUrl = `https://${publicConfig.domain}.${clusterSubdomain}.kyma.ondemand.com`;
    } else {
      baseUrl = 'http://localhost:22001'; // Cloud Connector local port
    }
    
    const config = {
      deploymentType,
      provider,
      baseUrl,
      namespace: this.namespace,
      containerRegistry: containerConfig.registry,
      containerOrganization: containerConfig.organization,
      containerTag: containerConfig.tag,
      imagePullSecrets: containerConfig.imagePullSecrets,
      dockerUsername: containerConfig.dockerUsername,
      dockerPassword: containerConfig.dockerPassword,
      useDigests: containerConfig.useDigests,
      imageDigests: containerConfig.imageDigests,
      imagesPublished: containerConfig.published,
      ...providerConfig,
      ...publicConfig,
      ...sapConfig,
      ...dbConfig
    };
    
    // Create namespace manifest
    await this.createNamespaceManifest();
    
    // Create secrets
    await this.createSecretsManifests(config);
    
    // Create ConfigMaps  
    await this.createConfigMapManifests(config);
    
    // Create core service manifests
    await this.createCoreManifests(config);
    
    // The installation's record of its version and non-secret answers (install-record.js),
    // applied by deploy-kyma.js after the workloads.
    fs.writeFileSync(path.join(this.manifestsDir, 'core', INSTALL_RECORD_FILE), renderInstallRecord({
      namespace: this.namespace,
      version: containerConfig.tag,
      answers: recordAnswers({ deploymentType, provider, providerConfig, publicConfig, containerConfig, dbConfig, sapConfig }),
      recordedBy: 'setup'
    }));

    // Create auth manifests
    await this.createAuthManifests(config);
    
    // Create networking manifests
    if (deploymentType === 'public') {
      await this.createNetworkingManifests(config);
    }
    
    // Run setup-docker.js with matching configuration to prepare nginx build.
    // It writes the checkout's local .env/docker files; put them back once the
    // ConfigMaps have been built from them.
    await this.withLocalConfigRestored(async () => {
      this.removeServiceEnvFiles();
      await this.runDockerSetup(config);
    });

    return config;
  }

  async createNamespaceManifest() {
    const manifest = `apiVersion: v1
kind: Namespace
metadata:
  name: ${this.namespace}
  labels:
    app: sail-proxy
`;

    const coreManifestsDir = path.join(this.manifestsDir, 'core');
    fs.mkdirSync(coreManifestsDir, { recursive: true });

    const manifestPath = path.join(coreManifestsDir, 'namespace.yaml');
    fs.writeFileSync(manifestPath, manifest);
    console.log('✅ namespace.yaml created');
  }

  async createSecretsManifests(config) {
    // PostgreSQL secret
    const postgresSecret = `apiVersion: v1
kind: Secret
metadata:
  name: postgres-env
  namespace: ${config.namespace}
type: Opaque
stringData:
  POSTGRES_DB: sap_llm_gateway
  POSTGRES_USER: ${this.yamlQuote(config.POSTGRES_USER)}
  POSTGRES_PASSWORD: ${this.yamlQuote(config.POSTGRES_PASSWORD)}
`;
    
    // Gateway secret. FILE_SEARCH_DATABASE_URL is the restricted, DML-only
    // runtime role — the gateway pod itself never receives DDL-capable
    // credentials. Those (FILE_SEARCH_MIGRATION_DATABASE_URL, built from
    // POSTGRES_USER/POSTGRES_PASSWORD like this used to be) live only in
    // the separate gateway-migration-env Secret below, consumed only by
    // the gateway Deployment's migrate-file-search initContainer — never
    // by the long-running `gateway` container. See
    // docs/developer/release.md.
    let gatewayEnvData = `VALKEY_URL: redis://valkey:6379
PORT: "8080"
DEPLOY_TARGET: docker
ADMIN_SERVICE_URL: http://admin:4004
FILE_SEARCH_DATABASE_URL: ${this.yamlQuote(`postgresql://${encodeURIComponent(this.sharedSecrets.FILE_SEARCH_RUNTIME_USER)}:${encodeURIComponent(this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD)}@postgres:5432/sap_llm_gateway`)}
VALIDATION_TOKEN_SECRET: ${this.yamlQuote(this.sharedSecrets.VALIDATION_TOKEN_SECRET)}
METADATA_ENCRYPTION_KEY: ${this.yamlQuote(this.sharedSecrets.METADATA_ENCRYPTION_KEY)}`;

    if (config.SAP_AI_CORE_URL) {
      gatewayEnvData += `
SAP_AI_CORE_URL: ${this.yamlQuote(config.SAP_AI_CORE_URL)}
AUTH_URL: ${this.yamlQuote(config.AUTH_URL)}
CLIENT_ID: ${this.yamlQuote(config.CLIENT_ID)}
CLIENT_SECRET: ${this.yamlQuote(config.CLIENT_SECRET)}
SAP_AI_REGION: ${this.yamlQuote(config.SAP_AI_REGION)}
SAP_AI_RESOURCE_GROUP: ${this.yamlQuote(config.SAP_AI_RESOURCE_GROUP)}`;
    }
    
    const gatewaySecret = `apiVersion: v1
kind: Secret
metadata:
  name: gateway-env
  namespace: ${config.namespace}
type: Opaque
stringData:
${gatewayEnvData.split('\n').map(line => '  ' + line).join('\n')}
`;

    // Privileged migration secret — DDL rights, consumed only by the
    // gateway Deployment's migrate-file-search initContainer (see
    // kyma/templates/manifests/core/gateway.yaml), never by the
    // long-running `gateway` container itself.
    const gatewayMigrationSecret = `apiVersion: v1
kind: Secret
metadata:
  name: gateway-migration-env
  namespace: ${config.namespace}
type: Opaque
stringData:
  FILE_SEARCH_MIGRATION_DATABASE_URL: ${this.yamlQuote(`postgresql://${encodeURIComponent(config.POSTGRES_USER)}:${encodeURIComponent(config.POSTGRES_PASSWORD)}@postgres:5432/sap_llm_gateway`)}
`;

    // Admin secret
    let adminEnvData = `DATABASE_URL: ${this.yamlQuote(`postgres://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@postgres:5432/sap_llm_gateway`)}
VALKEY_URL: redis://valkey:6379
PORT: "4004"
VALIDATION_TOKEN_SECRET: ${this.yamlQuote(this.sharedSecrets.VALIDATION_TOKEN_SECRET)}
METADATA_ENCRYPTION_KEY: ${this.yamlQuote(this.sharedSecrets.METADATA_ENCRYPTION_KEY)}
AWS_SECRET_ENCRYPTION_KEY: ${this.yamlQuote(this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY)}
SIEM_CREDENTIAL_KEY: ${this.yamlQuote(this.sharedSecrets.SIEM_CREDENTIAL_KEY)}
CONNECTION_CREDENTIAL_KEY: ${this.yamlQuote(this.sharedSecrets.CONNECTION_CREDENTIAL_KEY)}
cds.requires.db.credentials.password: ${this.yamlQuote(config.POSTGRES_PASSWORD)}
ROLE_MAPPING: ${this.yamlQuote(config.ROLE_MAPPING || '{}')}
IDENTITY_PROVIDER: ${this.yamlQuote(config.provider || 'github')}
JWT_ISSUER: ${this.yamlQuote(`${config.baseUrl}/dex`)}
BASE_URL: ${this.yamlQuote(config.baseUrl)}
LOGOUT_REDIRECT_URL: ${this.yamlQuote(`${config.baseUrl}/admin/app/shell/`)}`;
    // Billing answers (interactive runs only): the admin reads them from its environment.
    if (this.billing) {
      adminEnvData += BILLING_KEYS.filter((key) => this.billing[key] !== undefined)
        .map((key) => `\n${key}: ${this.yamlQuote(this.billing[key])}`).join('');
    }
    // Plugin install answer (interactive runs only; null when yes changes nothing).
    if (typeof this.pluginInstall === 'boolean') {
      adminEnvData += `\n${INSTALL_KEY}: ${this.yamlQuote(String(this.pluginInstall))}`;
    }

    const adminSecret = `apiVersion: v1
kind: Secret
metadata:
  name: admin-env
  namespace: ${config.namespace}
type: Opaque
stringData:
${adminEnvData.split('\n').map(line => '  ' + line).join('\n')}
`;
    
    // OAuth2-Proxy secret - cookie-secret must be exactly 32 bytes for AES-256. A re-run keeps
    // the earlier render's value (loadCurrentSecrets); a new one signs every user out.
    const cookieSecret = this.currentSecrets.OAUTH2_PROXY_COOKIE_SECRET || this.generateSecureToken().substring(0, 32);
    const oauth2ProxySecret = `apiVersion: v1
kind: Secret
metadata:
  name: oauth2-proxy-secrets
  namespace: ${config.namespace}
type: Opaque
stringData:
  cookie-secret: ${this.yamlQuote(cookieSecret)}
  client-secret: ${this.yamlQuote(this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET)}
`;
    
    // Ensure directories exist
    fs.mkdirSync(this.secretsDir, { recursive: true });
    fs.mkdirSync(this.configmapsDir, { recursive: true });
    
    writeSecret(path.join(this.secretsDir, 'postgres-env.yaml'), postgresSecret);
    writeSecret(path.join(this.secretsDir, 'gateway-env.yaml'), gatewaySecret);
    writeSecret(path.join(this.secretsDir, 'gateway-migration-env.yaml'), gatewayMigrationSecret);
    writeSecret(path.join(this.secretsDir, 'admin-env.yaml'), adminSecret);
    writeSecret(path.join(this.secretsDir, 'oauth2-proxy-secrets.yaml'), oauth2ProxySecret);
    const s3EnvSecret = this.renderS3EnvSecret(config.namespace);
    const s3EnvPath = path.join(this.secretsDir, `${S3_ENV_SECRET}.yaml`);
    if (s3EnvSecret) {
      writeSecret(s3EnvPath, s3EnvSecret);
    } else if (fs.existsSync(s3EnvPath)) {
      // No live gateway-s3-env: a file left by an earlier render would make deploy-kyma.js re-apply
      // credentials that were deleted from the cluster.
      fs.unlinkSync(s3EnvPath);
      console.log(`🧹 Removed the stale rendered ${S3_ENV_SECRET}.yaml (the namespace has no ${S3_ENV_SECRET} Secret)`);
    }

    // Create image pull secret if needed
    const registrySecretFile = path.join(this.secretsDir, REGISTRY_SECRET_FILE);
    const registryTemplateFile = path.join(this.secretsDir, 'registry-secret.yaml.template');
    if (!config.imagePullSecrets) {
      // A registry that no longer needs a pull secret leaves no token behind.
      fs.rmSync(registrySecretFile, { force: true });
    } else if (config.dockerUsername && config.dockerPassword) {
      writeRegistrySecret(this.secretsDir, {
        namespace: config.namespace,
        server: config.containerRegistry,
        username: config.dockerUsername,
        password: config.dockerPassword
      });
      console.log(`✅ ${REGISTRY_SECRET_FILE} created (image pull secret)`);
    } else {
      const imagePullSecret = `# Image Pull Secret Template
# IMPORTANT: You must create this secret manually with your registry credentials
# 
# Run this command:
# kubectl create secret docker-registry registry-secret \\
#   --docker-server=${config.containerRegistry} \\
#   --docker-username=<your-username> \\
#   --docker-password=<your-token> \\
#   --namespace=${config.namespace}
#
# This file is just a reminder - do not apply it directly!
---
apiVersion: v1
kind: Secret
metadata:
  name: registry-secret
  namespace: ${config.namespace}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64-encoded-docker-config>
`;
      
      fs.writeFileSync(registryTemplateFile, imagePullSecret);
      console.log('✅ Image pull secret template created as registry-secret.yaml.template (requires manual configuration)');
    }
    
    console.log('✅ Secret manifests created');
  }

  async createConfigMapManifests(config) {
    // NGINX ConfigMap - different config per auth provider
    let nginxConfig;
    if (config.provider === 'local') {
      nginxConfig = `map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
server {
  listen 8080;
  location ~ ^/(openai/)?v1/realtime$ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_pass http://gateway:8080;
  }
  location / {
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_pass http://gateway:8080;
  }
}`;
    } else {
      nginxConfig = `map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
server {
  listen 8080;
  location /auth {
    proxy_set_header Host $host;
    proxy_pass http://oauth2-proxy:4180;
  }
  location ~ ^/(openai/)?v1/realtime$ {
    auth_request /auth;
    auth_request_set $user $upstream_http_x_auth_request_user;
    auth_request_set $groups $upstream_http_x_auth_request_groups;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header X-Auth-Request-User $user;
    proxy_set_header X-Auth-Request-Groups $groups;
    proxy_pass http://gateway:8080;
  }
  location / {
    auth_request /auth;
    auth_request_set $user $upstream_http_x_auth_request_user;
    auth_request_set $groups $upstream_http_x_auth_request_groups;
    proxy_set_header Host $host;
    proxy_set_header X-Auth-Request-User $user;
    proxy_set_header X-Auth-Request-Groups $groups;
    proxy_pass http://gateway:8080;
  }
}`;
    }
    
    const nginxConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-conf
  namespace: ${config.namespace}
data:
  gw.conf: |
${nginxConfig.split('\n').map(line => '    ' + line).join('\n')}
`;
    
    // Dex config - provider-specific. A Secret: it holds the oauth2-proxy client secret and the
    // GitHub client secret or LDAP bind password.
    let dexConfig = await this.generateDexConfig(config);
    
    const dexConfigSecret = `apiVersion: v1
kind: Secret
metadata:
  name: dex-config
  namespace: ${config.namespace}
  labels:
    app.kubernetes.io/part-of: sail-proxy
type: Opaque
stringData:
  config.yaml: |
${dexConfig.split('\n').map(line => '    ' + line).join('\n')}
`;
    
    // Write ConfigMaps
    fs.writeFileSync(path.join(this.configmapsDir, 'nginx-conf.yaml'), nginxConfigMap);
    fs.mkdirSync(this.secretsDir, { recursive: true });
    writeSecret(path.join(this.secretsDir, 'dex-config.yaml'), dexConfigSecret);
    // Renders before the Dex config became a Secret wrote it here, secrets included; deploy-kyma.js
    // applies every file in configmaps/, so it must not stay.
    fs.rmSync(path.join(this.configmapsDir, 'dex-config.yaml'), { force: true });
    
    // Create SAML certificate ConfigMap for Okta provider
    if (config.provider === 'okta' && config.OKTA_SAML_CA_DATA) {
      const samlCertConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: dex-saml-cert
  namespace: ${config.namespace}
data:
  saml-ca.pem: |
${config.OKTA_SAML_CA_DATA.split('\n').map(line => '    ' + line).join('\n')}
`;
      fs.writeFileSync(path.join(this.configmapsDir, 'dex-saml-cert.yaml'), samlCertConfigMap);
      console.log('✅ SAML certificate ConfigMap created for Okta');
    }
    
    console.log('✅ ConfigMap manifests created');
  }

  async generateDexConfig(config) {
    console.log(`🔧 Generating Dex configuration for ${config.provider} provider...`);
    
    // Try to read Docker-generated provider configuration
    let dockerDexConfig = null;
    const providerConfigPath = path.join(this.projectRoot, 'docker', 'configs', 'providers', config.provider, 'dex.config.yaml');
    
    // For LDAP, check for external config first (Kyma only supports external LDAP)
    let ldapConfigPath = providerConfigPath;
    if (config.provider === 'ldap') {
      const externalLdapPath = path.join(this.projectRoot, 'docker', 'configs', 'providers', 'ldap', 'dex.config.external.yaml');
      if (fs.existsSync(externalLdapPath)) {
        ldapConfigPath = externalLdapPath;
      }
    }
    
    const configToUse = config.provider === 'ldap' ? ldapConfigPath : providerConfigPath;
    
    if (fs.existsSync(configToUse)) {
      try {
        const dockerConfigContent = fs.readFileSync(configToUse, 'utf8');
        dockerDexConfig = yaml.load(dockerConfigContent);
        console.log(`✅ Loaded Docker config from ${path.relative(this.projectRoot, configToUse)}`);
      } catch (error) {
        console.warn(`⚠️  Failed to parse Docker config: ${error.message}`);
        console.warn('   Falling back to basic configuration...');
      }
    } else {
      console.warn(`⚠️  Docker config not found at ${path.relative(this.projectRoot, configToUse)}`);
      console.warn('   Falling back to basic configuration...');
    }
    
    // Start with base Kyma-specific configuration
    const kymaBaseConfig = {
      issuer: `${config.baseUrl}/dex`,
      storage: {
        type: 'kubernetes',
        config: {
          inCluster: true
        }
      },
      web: {
        http: '0.0.0.0:5556'
      },
      logger: {
        level: 'debug',
        format: 'text'
      },
      oauth2: {
        skipApprovalScreen: true
      },
      staticClients: [{
        id: 'oauth2-proxy',
        redirectURIs: [`${config.baseUrl}/oauth2/callback`],
        name: 'OAuth2 Proxy',
        secret: this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET
      }]
    };
    
    // Add provider-specific configuration
    if (dockerDexConfig && dockerDexConfig.connectors && dockerDexConfig.connectors.length > 0) {
      // Use Docker-generated connectors with Kyma adaptations
      kymaBaseConfig.connectors = dockerDexConfig.connectors.map(connector => {
        const adaptedConnector = JSON.parse(JSON.stringify(connector)); // Deep clone
        
        // Replace Docker URLs and placeholders with Kyma values in connector config
        if (adaptedConnector.config) {
          // Start with URL replacements using string-based approach (safe for simple values)
          let configStr = JSON.stringify(adaptedConnector.config)
            .replace(/BASE_URL/g, config.baseUrl)
            .replace(/http:\/\/localhost:8080/g, config.baseUrl);
          
          // Parse back to object for safe manipulation
          let configObj = JSON.parse(configStr);
          
          // Replace provider-specific placeholders safely using object manipulation
          if (config.provider === 'github') {
            configObj = this.replaceInObject(configObj, {
              'GITHUB_CLIENT_ID': config.GITHUB_CLIENT_ID || '',
              'GITHUB_CLIENT_SECRET': config.GITHUB_CLIENT_SECRET || '',
              'GITHUB_ORG': config.GITHUB_ORG || '',
              'GITHUB_ADMIN_TEAM': config.GITHUB_ADMIN_TEAM || 'admins',
              'GITHUB_USER_TEAM': config.GITHUB_USER_TEAM || 'users'
            });
          } else if (config.provider === 'okta') {
            configObj = this.replaceInObject(configObj, {
              'OKTA_SSO_URL': config.OKTA_SSO_URL || '',
              'OKTA_SAML_CA_DATA': config.OKTA_SAML_CA_DATA || ''
            });
          } else if (config.provider === 'ldap') {
            configObj = this.replaceInObject(configObj, {
              'LDAP_HOST': config.LDAP_HOST || '',
              'LDAP_INSECURE_NO_SSL': config.LDAP_INSECURE_NO_SSL || 'false',
              'LDAP_BIND_DN': config.LDAP_BIND_DN || '',
              'LDAP_BIND_PASSWORD': config.LDAP_BIND_PASSWORD || '',
              'LDAP_USER_BASE_DN': config.LDAP_USER_BASE_DN || '',
              'LDAP_USER_FILTER': config.LDAP_USER_FILTER || '',
              'LDAP_USERNAME_ATTR': config.LDAP_USERNAME_ATTR || '',
              'LDAP_ID_ATTR': config.LDAP_ID_ATTR || '',
              'LDAP_EMAIL_ATTR': config.LDAP_EMAIL_ATTR || '',
              'LDAP_NAME_ATTR': config.LDAP_NAME_ATTR || '',
              'LDAP_PREFERRED_USERNAME_ATTR': config.LDAP_PREFERRED_USERNAME_ATTR || '',
              'LDAP_GROUP_BASE_DN': config.LDAP_GROUP_BASE_DN || '',
              'LDAP_GROUP_FILTER': config.LDAP_GROUP_FILTER || '',
              'LDAP_GROUP_NAME_ATTR': config.LDAP_GROUP_NAME_ATTR || '',
              'LDAP_GROUP_MEMBER_ATTR': config.LDAP_GROUP_MEMBER_ATTR || ''
            });
          }
          
          adaptedConnector.config = configObj;
          
          // Ensure redirectURI is properly set (critical for GitHub and SAML providers)
          if (config.provider === 'github' || config.provider === 'okta') {
            adaptedConnector.config.redirectURI = `${config.baseUrl}/dex/callback`;
          }
          
          console.log(`✅ Replaced placeholders for ${config.provider} provider`);
        }
        
        return adaptedConnector;
      });
      
      kymaBaseConfig.enablePasswordDB = false;
      console.log(`✅ Adapted ${kymaBaseConfig.connectors.length} connector(s) for Kyma deployment`);
    } else if (config.provider === 'local') {
      // Local provider uses static passwords from Docker config or fallback
      if (dockerDexConfig && dockerDexConfig.staticPasswords) {
        kymaBaseConfig.staticPasswords = dockerDexConfig.staticPasswords;
        console.log('✅ Using Docker-generated static passwords for local provider');
      } else {
        // Fallback static passwords
        kymaBaseConfig.staticPasswords = [
          {
            email: 'admin@example.com',
            hash: '$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W',
            username: 'admin'
          },
          {
            email: 'user@example.com', 
            hash: '$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W',
            username: 'user'
          }
        ];
        console.log('⚠️  Using fallback static passwords for local provider');
      }
      kymaBaseConfig.enablePasswordDB = true;
    }
    
    // Convert to YAML string
    const dexConfigYaml = yaml.dump(kymaBaseConfig, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    });
    
    console.log('✅ Dex configuration generated successfully');
    return dexConfigYaml;
  }

  async createCoreManifests(config) {
    console.log('📝 Processing core service manifests from templates...');
    console.log(`   useDigests: ${config.useDigests}`);
    console.log(`   imageDigests: ${config.imageDigests ? Object.keys(config.imageDigests).length + ' digests' : 'none'}`);
    
    const coreTemplatesDir = path.join(this.templatesDir, 'manifests', 'core');
    const coreManifestsDir = path.join(this.manifestsDir, 'core');
    
    if (!fs.existsSync(coreTemplatesDir)) {
      console.log('⏭️  No core templates directory found, skipping...');
      return;
    }

    // Create output directory
    fs.mkdirSync(coreManifestsDir, { recursive: true });
    
    const coreManifests = [
      'postgres.yaml',
      'valkey.yaml', 
      'gateway.yaml',
      'admin.yaml',
      'nginx.yaml',
      // The migration Jobs `sail-proxy upgrade kyma` runs: rendered into manifests/upgrade/,
      // a folder deploy-kyma.js never applies.
      'migrate-jobs.yaml'
    ];
    const upgradeManifestsDir = path.join(this.manifestsDir, 'upgrade');
    
    for (const manifestFile of coreManifests) {
      const templatePath = path.join(coreTemplatesDir, manifestFile);
      const outputDir = manifestFile === 'migrate-jobs.yaml' ? upgradeManifestsDir : coreManifestsDir;
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, manifestFile);
      
      if (!fs.existsSync(templatePath)) {
        console.log(`⏭️  ${manifestFile} template not found, skipping...`);
        continue;
      }
      
      console.log(`📝 Processing ${manifestFile} from template...`);
      let content = fs.readFileSync(templatePath, 'utf8');
        
        // Replace container registry placeholders
        content = content.replace(/__CONTAINER_REGISTRY__/g, config.containerRegistry);
        content = content.replace(/__CONTAINER_ORGANIZATION__/g, config.containerOrganization);  
        content = content.replace(/__NAMESPACE__/g, config.namespace);
        
        // Handle image references with digests or tags
        if (config.useDigests && config.imageDigests) {
          console.log(`  Using digests for ${manifestFile}`);
          // Map manifest file to image names
          const imageMap = {
            'admin.yaml': ['sail-proxy-admin'],
            'gateway.yaml': ['sail-proxy-gateway'],
            'nginx.yaml': ['sail-proxy-nginx'],
            'migrate-jobs.yaml': ['sail-proxy-admin', 'sail-proxy-gateway']
          };
          
          for (const imageName of imageMap[manifestFile] || [undefined]) {
            if (imageName && config.imageDigests[imageName]) {
              console.log(`  Found digest for ${imageName}: ${config.imageDigests[imageName]}`);
            } else {
              console.log(`  No digest found for ${imageName}`);
            }
            if (imageName && config.imageDigests[imageName]) {
              // Replace with digest reference
              const imageRef = `${config.containerRegistry}/${config.containerOrganization}/${imageName}@${config.imageDigests[imageName]}`;
              
              // Create patterns to match both placeholder and actual tag formats
              // Pattern 1: With placeholders (e.g., __CONTAINER_REGISTRY__/__CONTAINER_ORGANIZATION__/image:__CONTAINER_TAG__)
              const placeholderPattern = new RegExp(
                `__CONTAINER_REGISTRY__/__CONTAINER_ORGANIZATION__/${imageName}:__CONTAINER_TAG__`,
                'g'
              );
              
              // Pattern 2: With actual values (e.g., ghcr.io/st-gr/image:0.0.1 or any tag)
              const actualPattern = new RegExp(
                `${config.containerRegistry}/${config.containerOrganization}/${imageName}:[^\\s]+`,
                'g'
              );
              
              // Replace both patterns
              content = content.replace(placeholderPattern, imageRef);
              content = content.replace(actualPattern, imageRef);
            }
          }
          // Still replace any remaining __CONTAINER_TAG__ placeholders
          content = content.replace(/__CONTAINER_TAG__/g, config.containerTag);
        } else {
          // Use tag reference
          content = content.replace(/__CONTAINER_TAG__/g, config.containerTag);
        }
        
        // For nginx.yaml, update BASE_URL for public deployments
        if (manifestFile === 'nginx.yaml' && config.deploymentType === 'public') {
          const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
          const baseUrl = `https://${fullDomain}`;
          
          // Replace BASE_URL
          content = content.replace(/- name: BASE_URL\s*\n\s*value: ".*"/g, 
            `- name: BASE_URL\n          value: "${baseUrl}"`);
        }
        
        // Add image pull secrets if needed (per SAP research best practice)
        if (config.imagePullSecrets && (manifestFile === 'gateway.yaml' || manifestFile === 'admin.yaml' || manifestFile === 'nginx.yaml')) {
          // Only add if not already present
          if (!content.includes('imagePullSecrets:')) {
            // Insert imagePullSecrets section at template spec level - use first match only
            content = content.replace(
              /(template:\s*\n\s+metadata:[\s\S]*?\n\s+spec:\s*\n)(\s+)/,
              `$1$2imagePullSecrets:\n$2- name: registry-secret\n$2`
            );
          }
        }
        
        // Write processed manifest
        fs.writeFileSync(outputPath, content);
        console.log(`✅ ${manifestFile} generated from template`);
    }
    
    console.log('✅ Core service manifests processed from templates');
  }

  async createAuthManifests(config) {
    console.log('📝 Processing auth service manifests from templates...');
    
    const authTemplatesDir = path.join(this.templatesDir, 'manifests', 'auth');
    const authManifestsDir = path.join(this.manifestsDir, 'auth');
    
    if (!fs.existsSync(authTemplatesDir)) {
      console.log('⏭️  No auth templates directory found, skipping...');
      return;
    }

    // Create output directory
    fs.mkdirSync(authManifestsDir, { recursive: true });

    const authManifests = ['oauth2-proxy.yaml', 'dex.yaml', 'dex-rbac.yaml'];

    for (const manifestFile of authManifests) {
      const templatePath = path.join(authTemplatesDir, manifestFile);
      const outputPath = path.join(authManifestsDir, manifestFile);
      
      if (!fs.existsSync(templatePath)) {
        console.log(`⏭️  ${manifestFile} template not found, skipping...`);
        continue;
      }
      
      console.log(`📝 Processing ${manifestFile} from template...`);
      let content = fs.readFileSync(templatePath, 'utf8');

      // Replace standard placeholders
      content = this.replacePlaceholders(content, config);

      // Dex: pin the Kubernetes API host to the kubernetes.default ClusterIP.
      // Dex's storage client builds "https://[host]:443" (bracketed authority);
      // Gardener's apiserver-proxy rejects that with 421 Misdirected Request on
      // the DNS-name path but tolerates it on the ClusterIP path.
      if (manifestFile === 'dex.yaml') {
        const apiClusterIp = this.getKubernetesApiClusterIp();
        if (apiClusterIp) {
          content = content.replace(/__KUBERNETES_API_CLUSTER_IP__/g, apiClusterIp);
          console.log(`✅ Dex API access pinned to kubernetes.default ClusterIP ${apiClusterIp} (Gardener 421 workaround)`);
        } else {
          // Strip the override block; dex falls back to the injected API host
          content = content.replace(
            /[ \t]*# __DEX_K8S_HOST_OVERRIDE_START__[\s\S]*?# __DEX_K8S_HOST_OVERRIDE_END__\n/,
            ''
          );
          console.warn('⚠️  Could not resolve kubernetes.default ClusterIP — dex keeps the injected API host (may hit 421 on Gardener)');
        }
      }
      
      // Process OAuth2-proxy configuration for public deployments
      if (manifestFile === 'oauth2-proxy.yaml' && config.deploymentType === 'public') {
        const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
        
        // Template contains hybrid endpoint configuration (Pattern A) to resolve circular dependency:
        // - External issuer and login URL for browser redirects
        // - Internal redeem and JWKS URLs for server-to-server communication  
        // - OIDC discovery disabled to prevent startup TLS handshake timeouts
        // - Dex sidecar disabled to prevent Istio proxy interference
        console.log(`✅ OAuth2-proxy configured with hybrid endpoints:`);
        console.log(`   External login: https://${fullDomain}/dex/auth`);
        console.log(`   External callback: https://${fullDomain}/oauth2/callback`);
        console.log(`   Internal token/JWKS: http://dex:5556/dex/*`);
        console.log(`   OIDC discovery: disabled (avoids startup circular dependency)`);
      }
      
      // Write processed manifest
      fs.writeFileSync(outputPath, content);
      console.log(`✅ ${manifestFile} generated from template`);
    }
    
    console.log('✅ Auth service manifests processed from templates');
  }

  // Helper method to replace standard placeholders in content
  /**
   * ClusterIP of the kubernetes.default Service (lazily cached).
   * Used to pin dex's API access — see the dex.yaml handling above.
   */
  getKubernetesApiClusterIp() {
    if (this._k8sApiClusterIp !== undefined) return this._k8sApiClusterIp;
    try {
      this._k8sApiClusterIp = execSync(
        `kubectl get service kubernetes -n default -o jsonpath='{.spec.clusterIP}'`,
        { encoding: 'utf8' }
      ).trim();
      if (!/^[0-9a-fA-F.:]+$/.test(this._k8sApiClusterIp)) {
        this._k8sApiClusterIp = '';
      }
    } catch (error) {
      this._k8sApiClusterIp = '';
    }
    return this._k8sApiClusterIp;
  }

  replacePlaceholders(content, config) {
    const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
    
    return content
      .replace(/__FULL_DOMAIN__/g, fullDomain)
      .replace(/__BASE_URL__/g, config.baseUrl)
      .replace(/__CONTAINER_REGISTRY__/g, config.containerRegistry)
      .replace(/__CONTAINER_ORGANIZATION__/g, config.containerOrganization)
      .replace(/__CONTAINER_TAG__/g, config.containerTag)
      .replace(/__NAMESPACE__/g, config.namespace)
      .replace(/__ISTIO_SYSTEM_PREFIX__/g, istioSystemPrefix(config.namespace))
      // The ownership label line of an istio-system object: gone for the default namespace
      .replace(/^([ \t]*)__ISTIO_SYSTEM_NAMESPACE_LABEL__\n/gm, (_line, indent) =>
        Object.entries(namespaceLabels(config.namespace)).map(([k, v]) => `${indent}${k}: ${v}\n`).join(''));
  }

  // Helper method to safely replace placeholders in nested objects
  replaceInObject(obj, replacements) {
    if (typeof obj === 'string') {
      // Replace all placeholders in the string
      let result = obj;
      for (const [placeholder, value] of Object.entries(replacements)) {
        result = result.replace(new RegExp(placeholder, 'g'), value);
      }
      return result;
    } else if (Array.isArray(obj)) {
      // Recursively process array elements
      return obj.map(item => this.replaceInObject(item, replacements));
    } else if (obj !== null && typeof obj === 'object') {
      // Recursively process object properties
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.replaceInObject(value, replacements);
      }
      return result;
    }
    // Return primitive values unchanged
    return obj;
  }

  async createNetworkingManifests(config) {
    console.log('📝 Processing networking manifests from templates...');
    
    // Always clean up istio-system manifests for internal-only deployments
    if (config.deploymentType !== 'public') {
      console.log('⏭️  Skipping networking manifests (internal-only deployment)');
      
      // Clean up any existing istio-system directory from previous deployments
      const istioSystemDir = path.join(this.manifestsDir, 'istio-system');
      if (fs.existsSync(istioSystemDir)) {
        fs.rmSync(istioSystemDir, { recursive: true, force: true });
        console.log('✅ Cleaned up istio-system manifests (not needed for internal-only deployment)');
      }
      return;
    }
    
    const networkingTemplatesDir = path.join(this.templatesDir, 'manifests', 'networking');
    const networkingManifestsDir = path.join(this.manifestsDir, 'networking');
    
    if (!fs.existsSync(networkingTemplatesDir)) {
      console.log('⏭️  No networking templates directory found, skipping...');
      return;
    }

    // Create output directory
    fs.mkdirSync(networkingManifestsDir, { recursive: true });
    
    // CRITICAL: Remove old authorization-policy.yaml if it exists
    // This prevents the old template from overriding the new istio-system policy
    const oldAuthPolicyPath = path.join(networkingManifestsDir, 'authorization-policy.yaml');
    if (fs.existsSync(oldAuthPolicyPath)) {
      fs.unlinkSync(oldAuthPolicyPath);
      console.log('✅ Removed old authorization-policy.yaml from previous setup');
    }
    
    // Process all networking template files
    const templateFiles = fs.readdirSync(networkingTemplatesDir).filter(file => file.endsWith('.yaml'));
    const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
    
    // Validate the generated full domain for RFC 1123 compliance
    const domainValidation = validateRFC1123Domain(fullDomain);
    if (domainValidation !== true) {
      console.error(`❌ Generated domain "${fullDomain}" is not RFC 1123 compliant: ${domainValidation}`);
      throw new Error(`Invalid domain: ${domainValidation}`);
    }
    
    // Check if streaming VirtualService exists - if so, skip APIRule to prevent conflicts
    const hasStreamingVirtualService = templateFiles.includes('streaming-virtualservice.yaml');
    
    for (const templateFile of templateFiles) {
      const templatePath = path.join(networkingTemplatesDir, templateFile);
      const outputPath = path.join(networkingManifestsDir, templateFile);
      
      // Always process templates to generate manifests
      if (fs.existsSync(templatePath)) {
        let content = fs.readFileSync(templatePath, 'utf8');
        
        // Replace standard placeholders
        content = content.replace(/<%= domain %>/g, fullDomain);
        content = content.replace(/sail-proxy\.YOUR-CLUSTER-ID\.kyma\.ondemand\.com/g, fullDomain);
        // Also handle cases where YOUR-CLUSTER-ID appears with different patterns
        content = content.replace(/YOUR-CLUSTER-ID/g, config.clusterSubdomain || 'c-XXXXX');
        
        // Apply common replacements using helper method
        content = this.replacePlaceholders(content, config);
        
        // Write processed manifest
        fs.writeFileSync(outputPath, content);
        console.log(`✅ ${templateFile} generated from template`);
      }
      
      // If streaming VirtualService exists, remove APIRule to prevent conflicts
      if (hasStreamingVirtualService && templateFile.startsWith('apirule')) {
        const apiRuleOutputPath = path.join(networkingManifestsDir, templateFile);
        if (fs.existsSync(apiRuleOutputPath)) {
          fs.unlinkSync(apiRuleOutputPath);
          console.log(`🗑️  Removed ${templateFile} - streaming VirtualService will handle all traffic`);
        }
      }
    }
    
    // Create istio-system AuthorizationPolicy if IP allowlist is configured and allowed
    if (config.ipAllowlist && config.ipAllowlist.length > 0 && config.allowIstioSystemChanges) {
      this.generateIstioSystemAuthPolicy(config);
    } else {
      // Clean up any existing istio-system directory if no IP allowlist or permission denied
      const istioSystemDir = path.join(this.manifestsDir, 'istio-system');
      if (fs.existsSync(istioSystemDir)) {
        fs.rmSync(istioSystemDir, { recursive: true, force: true });
        console.log('✅ Cleaned up existing istio-system manifests (no IP allowlist configured)');
      }
    }
    
    console.log('✅ Networking manifests processed from templates');
  }
  
  generateIstioSystemAuthPolicy(config) {
    // Clean up and create istio-system directory in manifests
    const istioSystemDir = path.join(this.manifestsDir, 'istio-system');
    
    // Remove existing istio-system directory to ensure clean state
    if (fs.existsSync(istioSystemDir)) {
      fs.rmSync(istioSystemDir, { recursive: true, force: true });
    }
    
    // Create fresh istio-system directory
    fs.mkdirSync(istioSystemDir, { recursive: true });
    
    // Generate AuthorizationPolicy for istio-system namespace
    const authPolicyObj = {
      apiVersion: 'security.istio.io/v1',
      kind: 'AuthorizationPolicy',
      metadata: {
        name: istioSystemName(config.namespace, `allowlist-${config.domain || 'sail-proxy'}`),
        namespace: 'istio-system',
        // Only a non-default namespace gets the ownership label; the default
        // keeps its policy exactly as it always was.
        ...(isDefaultNamespace(config.namespace) ? {} : { labels: namespaceLabels(config.namespace) })
      },
      spec: {
        action: 'ALLOW',
        rules: [{
          to: [{
            operation: {
              hosts: [config.baseUrl ? new URL(config.baseUrl).hostname : `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`],
              methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
            }
          }],
          when: [{
            key: 'source.ip',
            values: config.ipAllowlist
          }]
        }],
        selector: {
          matchLabels: {
            istio: 'ingressgateway'
          }
        }
      }
    };
    
    const authPolicyContent = yaml.dump(authPolicyObj, {
      indent: 2,
      lineWidth: -1,
      noRefs: true
    });
    
    const authPolicyPath = path.join(istioSystemDir, 'authorization-policy.yaml');
    fs.writeFileSync(authPolicyPath, authPolicyContent);
    console.log(`✅ manifests/istio-system/authorization-policy.yaml created with IP allowlist (${entriesLabel(config.ipAllowlist.length)}): ${config.ipAllowlist.join(', ')}`);

    this.generateConnectivityProxyAllowlist(istioSystemDir, config);
  }

  // Emit ALLOW policies for the SAP Connectivity Proxy (SCC tunnel) hosts so they are not
  // stranded by the deny-by-default that the app's own IP allowlist creates on the shared
  // ingress gateway. SAFE to call here only because this runs alongside
  // generateIstioSystemAuthPolicy (scenario 1: the app itself creates that deny-by-default).
  // Hosts derive from the CLUSTER SUBDOMAIN, never the app domain.
  //
  // SECURITY: these ALLOW policies are host-scoped, so they only ever grant access to the
  // dedicated cp.* / healthcheck.cp.* hosts (which route to the Connectivity Proxy, NOT to
  // sail-proxy). We additionally validate every derived host against CP_HOST and assert it
  // differs from the app's own host, so these policies can never widen access to the app.
  generateConnectivityProxyAllowlist(istioSystemDir, config) {
    if (config.sccTunnel === false) return;            // explicit opt-out
    if (!config.clusterSubdomain) return;              // cannot derive host without it

    // Fail-closed boundary: only unambiguous cp.* / healthcheck.cp.* hosts are ever allowed.
    const CP_HOST = /^(healthcheck\.)?cp\.[a-z0-9-]+\.kyma\.ondemand\.com$/;
    const shoot  = `${config.clusterSubdomain}.kyma.ondemand.com`;
    const cpHost = `cp.${shoot}`;
    const hcHost = `healthcheck.${cpHost}`;

    // The app's own host must stay IP-restricted: never emit a cp ALLOW that collides with it,
    // and never emit one for anything that is not a recognizable cp host.
    const appHost = config.baseUrl
      ? new URL(config.baseUrl).hostname
      : `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
    if (!CP_HOST.test(cpHost) || !CP_HOST.test(hcHost) || cpHost === appHost || hcHost === appHost) {
      console.log('⚠️  Skipping SCC tunnel ALLOW: derived cp host failed validation (would not be safe)');
      return;
    }

    const sel = { matchLabels: { istio: 'ingressgateway' } };
    const docs = [
      { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy',
        metadata: { name: istioSystemName(config.namespace, 'allowlist-cp-tunnel'), namespace: 'istio-system', labels: { app: 'connectivity-proxy', ...namespaceLabels(config.namespace) } },
        spec: { selector: sel, action: 'ALLOW',
          rules: [{ to: [{ operation: { hosts: [cpHost, `${cpHost}:443`] } }] }] } },
      { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy',
        metadata: { name: istioSystemName(config.namespace, 'allowlist-cp-healthcheck'), namespace: 'istio-system', labels: { app: 'connectivity-proxy', ...namespaceLabels(config.namespace) } },
        spec: { selector: sel, action: 'ALLOW',
          rules: [{ to: [{ operation: {
            hosts: [hcHost, `${hcHost}:443`], methods: ['GET', 'HEAD'], paths: ['/healthcheck', '/'] } }] }] } },
    ];
    const content = docs.map(d => yaml.dump(d, { indent: 2, lineWidth: -1, noRefs: true })).join('---\n');
    fs.writeFileSync(path.join(istioSystemDir, 'connectivity-proxy-allow.yaml'), content);
    console.log(`✅ manifests/istio-system/connectivity-proxy-allow.yaml created for SCC tunnel (${cpHost})`);
  }

  /**
   * Remove the service .env files so setup-docker.js builds them from their
   * .env.sample plus the configuration and shared secrets setup-kyma.js
   * passes. setup-docker.js keeps an existing .env (and adopts its secrets),
   * which would carry a developer's local values into the Kyma ConfigMaps.
   * Only ever called inside withLocalConfigRestored, after the snapshot.
   */
  removeServiceEnvFiles() {
    for (const rel of ['services/gateway/.env', 'services/admin/.env', 'services/ollama/.env']) {
      const full = path.join(this.projectRoot, rel);
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        console.log(`   Moved aside ${rel} (restored when setup finishes)`);
      }
    }
  }

  /**
   * Run fn, then restore every file docker/setup-docker.js may have written or
   * deleted in the checkout (the services' .env files, docker/.env*, dex.config.yaml,
   * docker-compose files, the Okta certificate) to its state before — also
   * when fn fails. setup-docker.js is only needed for the .env files
   * postProcessEnvFiles turns into ConfigMaps; left in place they would switch
   * local development to Postgres and replace the Docker stack's passwords.
   */
  async withLocalConfigRestored(fn) {
    const snapshot = snapshotFiles(this.projectRoot, dockerSetupOutputs(this.projectRoot));
    console.log(`🔒 Local .env and docker configuration backed up to ${snapshot.backupDir}`);
    console.log('   (restored automatically when setup finishes; copy back from there if setup is killed)');

    // Ctrl-C reaches setup-docker.js (inherited stdio) and this process
    // alike, and node's default would exit without the restore below.
    const onSignal = this.signalRestorer(snapshot);
    let signalHandling = null;
    const signalListener = (signal) => {
      if (!signalHandling) signalHandling = onSignal(signal);
    };
    process.on('SIGINT', signalListener);
    process.on('SIGTERM', signalListener);

    let result;
    let failure;
    try {
      result = await fn();
    } catch (error) {
      failure = error;
    }
    if (signalHandling) {
      // The signal handler restores and exits; do not restore twice.
      await signalHandling;
    }
    process.removeListener('SIGINT', signalListener);
    process.removeListener('SIGTERM', signalListener);

    let restoreError;
    try {
      this.logRestore(restoreFiles(snapshot));
    } catch (error) {
      restoreError = error;
    }

    // Neither error may hide the other: the setup error says what went wrong,
    // the restore error says where the original files still are.
    if (failure && restoreError) {
      console.error(`❌ Restoring the local configuration also failed: ${restoreError.message}`);
      throw new AggregateError(
        [failure, restoreError],
        `${failure.message} (restoring the local configuration also failed: ${restoreError.message})`
      );
    }
    if (failure) throw failure;
    if (restoreError) throw restoreError;
    return result;
  }

  /**
   * Signal handler for withLocalConfigRestored: stop setup-docker.js if it is
   * still running (so it cannot write after the restore), restore the
   * snapshot, then exit with the signal's conventional code (128 + number).
   */
  signalRestorer(snapshot, exit = (code) => process.exit(code)) {
    return async (signal) => {
      console.log(`\n⚠️  ${signal} received - restoring the local configuration before exiting...`);
      await this.stopDockerSetupProcess(signal);
      try {
        this.logRestore(restoreFiles(snapshot));
      } catch (error) {
        console.error(`❌ ${error.message}`);
      }
      exit(128 + (os.constants.signals[signal] || 0));
    };
  }

  stopDockerSetupProcess(signal) {
    const child = this.dockerSetupProcess;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill(signal);
    });
  }

  logRestore(changed) {
    console.log(changed.length > 0
      ? `🔒 Restored local configuration: ${changed.join(', ')}`
      : '🔒 Local configuration unchanged');
  }

  async runDockerSetup(config) {
    console.log('\n🔧 Preparing Docker configuration for nginx build...');
    
    const dockerSetupPath = path.join(this.projectRoot, 'docker', 'setup-docker.js');
    
    // Check if setup-docker.js exists
    if (!fs.existsSync(dockerSetupPath)) {
      console.error('❌ docker/setup-docker.js not found!');
      console.error('   Please ensure you are running from the correct directory');
      return;
    }
    
    // Prepare configuration to pass to docker setup
    const dockerConfig = {
      provider: config.provider,
      providerConfig: config.providerConfig,
      baseUrl: config.baseUrl,
      sharedSecrets: this.sharedSecrets,
      // Its local files are restored afterwards (withLocalConfigRestored), so
      // the old Postgres password stays in use: deleting the local Docker
      // volumes, as its unattended mode otherwise does, would only lose data.
      keepDockerVolumes: true,
      // Pass database credentials to ensure Docker script uses the correct user
      POSTGRES_USER: config.POSTGRES_USER,
      POSTGRES_PASSWORD: config.POSTGRES_PASSWORD,
      sapConfig: {
        SAP_AI_CORE_URL: config.SAP_AI_CORE_URL,
        AUTH_URL: config.AUTH_URL,
        CLIENT_ID: config.CLIENT_ID,
        CLIENT_SECRET: config.CLIENT_SECRET,
        SAP_AI_REGION: config.SAP_AI_REGION,
        SAP_AI_RESOURCE_GROUP: config.SAP_AI_RESOURCE_GROUP
      }
    };
    
    // Remove undefined SAP config values
    Object.keys(dockerConfig.sapConfig).forEach(key => {
      if (dockerConfig.sapConfig[key] === undefined) {
        delete dockerConfig.sapConfig[key];
      }
    });
    
    // No SAP config (skipped) stays an empty object: null would make
    // setup-docker.js, now always starting without a gateway .env, ask again.
    
    console.log('   Running: node docker/setup-docker.js --config <configuration>');
    const code = await this.spawnDockerSetup(dockerSetupPath, dockerConfig);
    if (code !== 0) {
      console.error(`❌ Docker setup failed with code ${code}`);
      throw new Error('Docker setup failed');
    }

    console.log('✅ Docker setup completed successfully');
    console.log('   Using matching configuration from Kyma setup');
    console.log('   The nginx image will work with both Docker and Kyma deployments');

    // Post-process: read generated .env files and create additional ConfigMaps
    try {
      await this.postProcessEnvFiles(config);
    } catch (error) {
      console.error('❌ Failed to post-process environment files:', error);
      throw error;
    }
  }

  /** Run setup-docker.js with --config; resolves with its exit code. */
  spawnDockerSetup(dockerSetupPath, dockerConfig) {
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
      // An upgrade (temporary render) needs only the .env files: the child's Docker instructions
      // (docker-compose build/up, test users) do not apply, so its output is shown on failure only.
      const quiet = this.outputIsTemporary;
      const setupProcess = spawn('node', [dockerSetupPath, '--config', JSON.stringify(dockerConfig)], {
        cwd: this.projectRoot,
        stdio: quiet ? ['inherit', 'pipe', 'pipe'] : 'inherit'
      });
      // Tracked so a signal handler can stop it before restoring files.
      this.dockerSetupProcess = setupProcess;
      const captured = [];
      if (quiet) {
        setupProcess.stdout.on('data', (chunk) => captured.push(chunk));
        setupProcess.stderr.on('data', (chunk) => captured.push(chunk));
      }

      setupProcess.on('close', (code) => {
        if (quiet && code !== 0) process.stderr.write(Buffer.concat(captured));
        resolve(code);
      });

      setupProcess.on('error', (err) => {
        console.error('❌ Failed to run docker setup:', err);
        reject(err);
      });
    });
  }

  /**
   * Post-process environment files after docker setup
   * Reads .env files and creates additional ConfigMaps
   */
  async postProcessEnvFiles(config) {
    console.log('\n📋 Post-processing environment files for Kyma deployment...\n');
    
    // Read .env files generated by setup-docker.js
    const gatewayEnvPath = path.join(this.projectRoot, 'services/gateway/.env');
    const adminEnvPath = path.join(this.projectRoot, 'services/admin/.env');
    const apiConfigPath = path.join(this.projectRoot, 'services/admin/api_config.json');
    
    // Parse environment files
    const gatewayEnv = await this.parseEnvFile(gatewayEnvPath);
    const adminEnv = await this.parseEnvFile(adminEnvPath);
    
    // Create additional ConfigMaps for environment variables not in secrets
    await this.createEnvConfigMaps(gatewayEnv, adminEnv, config);
    
    // Create ConfigMap for api_config.json
    if (fs.existsSync(apiConfigPath)) {
      await this.createApiConfigMap(apiConfigPath, config);
    }
    
    // Update deployment manifests to use ConfigMaps
    await this.updateDeploymentManifests(config);
    
    console.log('✅ Post-processing completed successfully');
  }

  /**
   * Create ConfigMaps for environment variables from .env files
   */
  async createEnvConfigMaps(gatewayEnv, adminEnv, config) {
    console.log('📝 Creating environment ConfigMaps...');
    
    // Filter out sensitive values that are already in Secrets
    const secretKeys = [
      'VALIDATION_TOKEN_SECRET', 'METADATA_ENCRYPTION_KEY', 'AWS_SECRET_ENCRYPTION_KEY',
      'CLIENT_SECRET', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'CLIENT_ID', 'AUTH_URL',
      'VALKEY_URL', 'REDIS_URL', 'ADMIN_SERVICE_URL', 'FILE_SEARCH_DATABASE_URL',  // Connection URLs should come from Secrets with K8s service names
      'PORT',  // PORT is already set in the Secret and should not be duplicated in ConfigMap
      'ROLE_MAPPING',  // ROLE_MAPPING is already set in the Secret and must not be overridden by ConfigMap
      'SIEM_CREDENTIAL_KEY',  // in the admin-env Secret; a ConfigMap copy would override it (envFrom order)
      'CONNECTION_CREDENTIAL_KEY'  // likewise
    ];
    
    // Gateway ConfigMap - non-sensitive environment variables
    const gatewayConfigData = {};
    Object.keys(gatewayEnv).forEach(key => {
      if (!secretKeys.includes(key) && !key.includes('SECRET') && !key.includes('PASSWORD')) {
        // Skip CAP-specific database config as it's handled differently
        if (!key.startsWith('cds.requires.db.')) {
          gatewayConfigData[key] = gatewayEnv[key];
        }
      }
    });
    
    // Override any localhost or Docker-specific URLs with Kubernetes service names
    if (gatewayConfigData.ADMIN_URL) {
      gatewayConfigData.ADMIN_URL = 'http://admin:4004';
    }
    
    if (Object.keys(gatewayConfigData).length > 0) {
      const gatewayConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: gateway-config
  namespace: ${config.namespace}
data:
${Object.entries(gatewayConfigData).map(([key, value]) => {
  // Escape quotes in the value and wrap in quotes
  const escapedValue = String(value).replace(/"/g, '\\"');
  return `  ${key}: "${escapedValue}"`;
}).join('\n')}
`;
      
      fs.writeFileSync(path.join(this.configmapsDir, 'gateway-config.yaml'), gatewayConfigMap);
      console.log('✅ gateway-config.yaml created');
    }
    
    // Admin ConfigMap - non-sensitive environment variables and CAP database config
    const adminConfigData = {};
    const capDbConfig = {};
    
    Object.keys(adminEnv).forEach(key => {
      if (key.startsWith('cds.requires.db.')) {
        // Handle CAP database configuration separately
        if (!key.includes('password') && !key.includes('credentials.password')) {
          // CRITICAL FIX: Use the new database username from config, not from old .env file
          if (key === 'cds.requires.db.credentials.user' && config.POSTGRES_USER) {
            capDbConfig[key] = config.POSTGRES_USER;
          } else {
            capDbConfig[key] = adminEnv[key];
          }
        }
      } else if (!secretKeys.includes(key) && !key.includes('SECRET') && !key.includes('PASSWORD')) {
        // The billing answers are in the admin-env Secret; a ConfigMap copy would override them.
        if (this.billing && BILLING_KEYS.includes(key)) return;
        // The plugin install answer lives only there: a copy from the local .env (a Docker
        // setup's answer) would win over the Secret in envFrom, even over a yes.
        if (key === INSTALL_KEY) return;
        adminConfigData[key] = adminEnv[key];
      }
    });
    
    // Add important environment variables from .env file
    if (adminEnv.DEPLOY_TARGET) {
      adminConfigData.DEPLOY_TARGET = adminEnv.DEPLOY_TARGET;
    }
    if (adminEnv.NODE_ENV) {
      adminConfigData.NODE_ENV = adminEnv.NODE_ENV;
    }
    if (adminEnv.LOG_LEVEL) {
      adminConfigData.LOG_LEVEL = adminEnv.LOG_LEVEL;
    }
    if (adminEnv.GATEWAY_URL) {
      adminConfigData.GATEWAY_URL = adminEnv.GATEWAY_URL;
    }
    
    // Override with Kubernetes-specific values
    adminConfigData.DEPLOY_TARGET = 'docker'; // For Kyma deployment
    adminConfigData.GATEWAY_URL = 'http://gateway:8080';
    adminConfigData.CDS_ENV = 'pg'; // Use PostgreSQL profile for CAP
    
    const adminConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: admin-config
  namespace: ${config.namespace}
data:
${Object.entries(adminConfigData).map(([key, value]) => {
  // Escape quotes in the value and wrap in quotes
  const escapedValue = String(value).replace(/"/g, '\\"');
  return `  ${key}: "${escapedValue}"`;
}).join('\n')}
${Object.keys(capDbConfig).length > 0 ? '\n  # CAP Database Configuration\n' + Object.entries(capDbConfig).map(([key, value]) => {
  const escapedValue = String(value).replace(/"/g, '\\"');
  return `  ${key}: "${escapedValue}"`;
}).join('\n') : ''}
`;
    
    fs.writeFileSync(path.join(this.configmapsDir, 'admin-config.yaml'), adminConfigMap);
    console.log('✅ admin-config.yaml created');
  }

  /**
   * Create ConfigMap for api_config.json
   */
  async createApiConfigMap(apiConfigPath, config) {
    console.log('📝 Creating api_config.json ConfigMap...');
    
    const apiConfigContent = fs.readFileSync(apiConfigPath, 'utf8');
    
    const apiConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: admin-api-config
  namespace: ${config.namespace}
data:
  api_config.json: |
${apiConfigContent.split('\n').map(line => '    ' + line).join('\n')}
`;
    
    fs.writeFileSync(path.join(this.configmapsDir, 'admin-api-config.yaml'), apiConfigMap);
    console.log('✅ admin-api-config.yaml created');
  }

  /**
   * Update deployment manifests to use ConfigMaps
   */
  async updateDeploymentManifests(config) {
    console.log('📝 Updating deployment manifests to use ConfigMaps...');
    
    try {
      // Update admin.yaml to mount api_config.json and use environment ConfigMap
      const adminManifestPath = path.join(this.manifestsDir, 'core', 'admin.yaml');
      if (fs.existsSync(adminManifestPath)) {
        let adminContent = fs.readFileSync(adminManifestPath, 'utf8');
        
        // Check if modifications already exist to avoid duplicates
        const hasConfigMapRef = adminContent.includes('configMapRef:') && adminContent.includes('name: admin-config');
        const hasApiConfigVolume = adminContent.includes('name: api-config') && adminContent.includes('configMap:');
        const hasApiConfigMount = adminContent.includes('mountPath: /app/services/admin/api_config.json');
        
        if (hasConfigMapRef && hasApiConfigVolume && hasApiConfigMount) {
          console.log('✅ admin.yaml already has ConfigMap references, skipping update');
          return;
        }
        
        // Parse YAML into lines for easier manipulation
        const lines = adminContent.split('\n');
        const newLines = [];
        let inDeploymentSpec = false;
        let inContainerSpec = false;
        let indentLevel = 0;
        let volumesAdded = hasApiConfigVolume;
        let volumeMountsAdded = hasApiConfigMount;
        let configMapAdded = hasConfigMapRef;
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmedLine = line.trim();
          
          // Track where we are in the YAML structure
          if (trimmedLine === 'kind: Deployment') {
            inDeploymentSpec = true;
          }
          
          if (inDeploymentSpec && line.match(/^\s+spec:\s*$/)) {
            indentLevel = line.indexOf('spec:');
          }
          
          if (inDeploymentSpec && line.match(/^\s+containers:\s*$/)) {
            inContainerSpec = true;
            
            // Add volumes section before containers if not already added
            if (!volumesAdded && !adminContent.includes('volumes:')) {
              newLines.push(' '.repeat(indentLevel + 2) + 'volumes:');
              newLines.push(' '.repeat(indentLevel + 2) + '- name: api-config');
              newLines.push(' '.repeat(indentLevel + 4) + 'configMap:');
              newLines.push(' '.repeat(indentLevel + 6) + 'name: admin-api-config');
              volumesAdded = true;
            }
          }
          
          // Add to envFrom if we find the secretRef
          if (line.includes('secretRef:') && lines[i+1] && lines[i+1].includes('name: admin-env') && !configMapAdded && !adminContent.includes('name: admin-config')) {
            newLines.push(line); // Push '- secretRef:'
            newLines.push(lines[i+1]); // Push '    name: admin-env'
            i++; // Skip the next line since we already processed it
            
            // Get the correct indentation from both lines
            const secretRefIndent = line.indexOf('-'); // indent of "- secretRef:"
            const childIndent = lines[i].search(/\S/); // indent of "name: admin-env" (we already incremented i)
            
            // Add ConfigMap reference with proper nesting
            newLines.push(' '.repeat(secretRefIndent) + '- configMapRef:');
            newLines.push(' '.repeat(childIndent) + 'name: admin-config');
            configMapAdded = true;
            continue;
          }
          
          // Add volumeMounts before ports section if not already present
          if (inContainerSpec && trimmedLine.startsWith('ports:') && !volumeMountsAdded) {
            // Get the indentation of the ports line
            const portsIndent = line.search(/\S/);
            
            // Add volumeMounts with same indentation as ports
            newLines.push(' '.repeat(portsIndent) + 'volumeMounts:');
            newLines.push(' '.repeat(portsIndent) + '- name: api-config');
            newLines.push(' '.repeat(portsIndent + 2) + 'mountPath: /app/services/admin/api_config.json');
            newLines.push(' '.repeat(portsIndent + 2) + 'subPath: api_config.json');
            volumeMountsAdded = true;
          }
          
          newLines.push(line);
        }
        
        // Write the updated content
        fs.writeFileSync(adminManifestPath, newLines.join('\n'));
        console.log('✅ admin.yaml updated with ConfigMap references');
      }
      
      // Update gateway.yaml to use environment ConfigMap
      const gatewayManifestPath = path.join(this.manifestsDir, 'core', 'gateway.yaml');
      if (fs.existsSync(gatewayManifestPath)) {
        let gatewayContent = fs.readFileSync(gatewayManifestPath, 'utf8');
        
        // Simple replacement for gateway since it's simpler
        if (gatewayContent.includes('name: gateway-env') && !gatewayContent.includes('name: gateway-config')) {
          // Find the envFrom section and add ConfigMap
          const lines = gatewayContent.split('\n');
          const newLines = [];
          
          for (let i = 0; i < lines.length; i++) {
            newLines.push(lines[i]);
            if (lines[i].includes('name: gateway-env')) {
              // Get the indentation from the secretRef line
              const secretRefIndent = lines[i - 1].indexOf('-');
              newLines.push(' '.repeat(secretRefIndent) + '- configMapRef:');
              newLines.push(' '.repeat(secretRefIndent + 4) + 'name: gateway-config');
            }
          }
          
          fs.writeFileSync(gatewayManifestPath, newLines.join('\n'));
        }
        
        console.log('✅ gateway.yaml updated with ConfigMap references');
      }
    } catch (error) {
      console.error('❌ Error updating deployment manifests:', error);
      throw error;
    }
  }

  async showCompletion(config) {
    console.log('\n' + '='.repeat(60));
    console.log('   Setup Complete! 🎉');
    console.log('='.repeat(60));
    
    console.log(`\n✅ Configured for: ${PROVIDERS[config.provider].name}`);
    console.log(`✅ Deployment Type: ${config.deploymentType === 'public' ? 'Public HTTPS' : 'Internal-only'}`);
    console.log(`✅ Container Registry: ${config.containerRegistry}/${config.containerOrganization}`);
    console.log(`✅ Image Version: ${config.containerTag}${config.useDigests ? ' (using digests)' : ''}`);
    if (config.useDigests && config.imageDigests) {
      console.log('✅ Image Digests:');
      Object.entries(config.imageDigests).forEach(([image, digest]) => {
        console.log(`   - ${image}: ${digest.substring(0, 19)}...`);
      });
    }
    if (config.deploymentType === 'public') {
      console.log(`✅ Domain: ${config.domain}`);
      if (config.ipAllowlist && config.ipAllowlist.length > 0) {
        console.log(`✅ IP Allowlist (${entriesLabel(config.ipAllowlist.length)}): ${config.ipAllowlist.join(', ')}`);
      }
    }
    
    // Display generated credentials for user reference
    console.log('\n🔑 Generated Credentials:');
    console.log('   Save these credentials for future access:');
    console.log('');
    
    // Only show database credentials if password was auto-generated
    if (config.passwordWasGenerated) {
      console.log('   📊 Database Credentials:');
      console.log(`   - Username: ${config.POSTGRES_USER}`);
      console.log(`   - Password: ${mask(this.sharedSecrets.POSTGRES_PASSWORD)}`);
      console.log('');
    } else {
      console.log('   📊 Database Configuration:');
      console.log(`   - Username: ${config.POSTGRES_USER} (user-provided)`);
      console.log('   - Password: ******** (user-provided, not displayed for security)');
      console.log('');
    }
    
    console.log('   🔐 Security Secrets:');
    console.log(`   - Validation Token: ${mask(this.sharedSecrets.VALIDATION_TOKEN_SECRET)}`);
    console.log(`   - Metadata Encryption Key: ${mask(this.sharedSecrets.METADATA_ENCRYPTION_KEY)}`);
    console.log(`   - AWS Secret Encryption Key: ${mask(this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY)}`);
    console.log(`   - OAuth2 Client Secret: ${mask(this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET)}`);
    console.log(`   - OAuth2 Cookie Secret: ${mask(this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET)}`);
    console.log('');
    console.log('   These credentials are stored in Kubernetes Secrets and used by the services.');
    if (config.passwordWasGenerated) {
      console.log('   All secrets are randomly generated for maximum security.');
    } else {
      console.log('   System secrets are randomly generated. Database password was user-provided.');
    }
    
    // An upgrade renders into a temporary folder and deploys it itself: the file list and the
    // deploy instructions would point at files that are gone when the run ends.
    const imageBase = `${config.containerRegistry}/${config.containerOrganization}`;
    if (!this.outputIsTemporary) {
      console.log('\nGenerated files:');
      console.log('  Kubernetes Manifests:');
      console.log('  - manifests/core/namespace.yaml');
      console.log('  - templates/secrets/*.yaml (PostgreSQL, Gateway, Admin, OAuth2-Proxy secrets)');
      if (config.imagePullSecrets && config.dockerUsername && config.dockerPassword) {
        console.log(`  - templates/secrets/${REGISTRY_SECRET_FILE} (image pull secret, applied by deploy-kyma.js)`);
      } else if (config.imagePullSecrets) {
        console.log('  - templates/secrets/registry-secret.yaml.template (Manual creation required)');
      }
      console.log('  - templates/configmaps/*.yaml (NGINX, Dex, Gateway, Admin, API configs)');
      console.log('  - manifests/core/*.yaml (Service deployments with ConfigMap integration)');
      if (config.deploymentType === 'public') {
        console.log('  - manifests/networking/*.yaml (APIRule, AuthorizationPolicy)');
      }
    
      console.log('\n💡 Next steps:');
    
      // A build is asked for only when the registry listing showed the tag missing; when the
      // listing failed the build commands are given as a condition.
      const published = config.imagesPublished;


      // deploy-kyma.js defaults to the default namespace; any other must be named.
      const namespaceFlag = isDefaultNamespace(config.namespace) ? '' : ` --namespace ${config.namespace}`;
    
      if (published === true) {
        console.log(`✨ The ${config.containerTag} images are published in ${imageBase} - no Docker build required!`);
        console.log('');
        console.log('1. Deploy directly to Kyma:');
      
        // Determine the relative path to deploy-kyma.js based on CWD
        const cwd = process.cwd();
        const deployScriptPath = path.join(__dirname, 'deploy-kyma.js');
        const relativeDeployPath = path.relative(cwd, deployScriptPath).replace(/\\/g, '/');
        // The registry token is in the rendered pull secret file, never in this command.
        console.log(`   node ${relativeDeployPath}${namespaceFlag}`);
        console.log('');
      } else {
        if (published === null) {
          console.log(`⚠️  Whether the ${config.containerTag} images exist in ${imageBase} could not be checked.`);
          console.log('1. If they are not published yet, build and push them:');
        } else {
          console.log('1. Build and push Docker images:');
        }
        console.log('   # From project root');
        console.log(`   docker build -t ${config.containerRegistry}/${config.containerOrganization}/sail-proxy-gateway:${config.containerTag} -f docker/gateway.Dockerfile .`);
        console.log(`   docker build -t ${config.containerRegistry}/${config.containerOrganization}/sail-proxy-admin:${config.containerTag} -f docker/admin.Dockerfile .`);
        console.log(`   docker build -t ${config.containerRegistry}/${config.containerOrganization}/sail-proxy-nginx:${config.containerTag} -f docker/nginx/Dockerfile docker`);
        console.log('   ');
        console.log(`   docker push ${config.containerRegistry}/${config.containerOrganization}/sail-proxy-gateway:${config.containerTag}`);  
        console.log(`   docker push ${config.containerRegistry}/${config.containerOrganization}/sail-proxy-admin:${config.containerTag}`);
        console.log(`   docker push ${config.containerRegistry}/${config.containerOrganization}/sail-proxy-nginx:${config.containerTag}`);
        console.log('');
        console.log('2. Deploy to Kyma:');
      
        // Use the same relative path calculated above (it's in the parent scope)
        const deployPath = path.relative(process.cwd(), path.join(__dirname, 'deploy-kyma.js')).replace(/\\/g, '/');
        console.log(`   node ${deployPath}${namespaceFlag}`);
        console.log('');
      }
    
      // Manual steps section removed - everything is handled by deploy-kyma.js now
      console.log('\n📝 Manual steps (if needed):');
    
      if (config.imagePullSecrets && !config.dockerUsername) {
        console.log('- Create image pull secret manually:');
        console.log(`   kubectl create secret docker-registry registry-secret \\`);
        console.log(`     --docker-server=${config.containerRegistry} \\`);
        console.log(`     --docker-username=<your-username> \\`);
        console.log(`     --docker-password=<your-token> \\`);
        console.log(`     --namespace=${config.namespace}`);
        console.log('');
      }
    
    }

    if (config.deploymentType === 'public') {
      const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
      console.log(`\n🌐 Your application will be available at:`);
      console.log(`   Gateway API: https://${fullDomain}/gateway`);
      console.log(`   Admin OData: https://${fullDomain}/admin/odata/v4/admin`);
      console.log(`   Adm.Cockpit: https://${fullDomain}/admin/app/shell/`);
    } else {
      console.log(`\n🔌 Access via Cloud Connector:`);
      console.log('   - Target: nginx:8080');
      console.log('   - Local port: 22001');
      console.log('   - Access: http://localhost:22001/admin/');
    }
    
    console.log('\n🔒 Security Notes:');
    console.log('   - Secrets are stored in Kubernetes Secret objects');
    console.log('   - ConfigMaps contain non-sensitive configuration only');
    if (config.deploymentType === 'public' && config.ipAllowlist && config.ipAllowlist.length > 0) {
      console.log('   - IP allowlisting is configured via Istio AuthorizationPolicy in istio-system namespace');
    }
    console.log(config.imagePullSecrets
      ? `   - Images come from ${imageBase}/sail-proxy-* (private, pulled with the registry-secret pull secret)`
      : `   - Images come from ${imageBase}/sail-proxy-* (public, no pull secret)`);
    
    console.log('');
  }

  /** The stringData of a Secret this script rendered (templates/secrets/<name>.yaml), or null. */
  readRenderedSecret(root, name) {
    const file = path.join(root, 'templates', 'secrets', `${name}.yaml`);
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const start = lines.indexOf('stringData:');
    if (start < 0) return null;
    const data = {};
    for (const line of lines.slice(start + 1)) {
      const match = line.match(/^ {2}([^\s:#][^:]*): (.*)$/);
      if (!match) continue;
      let value = match[2];
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          continue;
        }
      }
      data[match[1]] = value;
    }
    return data;
  }

  /** A YAML file (or a ConfigMap's `key: |` block of one) this script rendered, parsed; null when absent or unreadable. */
  readRenderedYaml(file, blockKey) {
    if (!fs.existsSync(file)) return null;
    let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (blockKey) {
      const lines = text.split('\n');
      const start = lines.indexOf(`  ${blockKey}: |`);
      if (start < 0) return null;
      const block = [];
      for (const line of lines.slice(start + 1)) {
        if (line !== '' && !line.startsWith('    ')) break;
        block.push(line.slice(4));
      }
      text = block.join('\n');
    }
    try {
      return yaml.load(text);
    } catch {
      return null;
    }
  }

  /**
   * Answers derivable from the admin-env, gateway-env and postgres-env Secret data - the same
   * keys whether the data comes from the rendered files or from the live namespace.
   */
  valuesFromSecretData({ admin, gateway, postgres }) {
    const values = {};
    if (admin) {
      const provider = admin.IDENTITY_PROVIDER;
      values.provider = provider;
      if (admin.BASE_URL === 'http://localhost:22001') {
        values.deploymentType = 'internal';
      } else {
        const host = /^https:\/\/([^.]+)\.([^.]+)\.kyma\.ondemand\.com$/.exec(admin.BASE_URL || '');
        if (host) {
          values.deploymentType = 'public';
          values.domain = host[1];
          values.clusterSubdomain = host[2];
        }
      }
      const groups = {};
      try {
        for (const [group, role] of Object.entries(JSON.parse(admin.ROLE_MAPPING || '{}'))) {
          if (!groups[role]) groups[role] = group;
        }
      } catch {
        // An unreadable mapping leaves the group questions at their defaults.
      }
      if (provider === 'github') {
        // "<org>:<team>" (collectProviderConfig builds it that way).
        const team = (group) => (group && group.includes(':') ? group.split(':') : [undefined, group]);
        const [adminOrg, adminTeam] = team(groups.admin);
        const [userOrg, userTeam] = team(groups.user);
        values.GITHUB_ORG = adminOrg || userOrg;
        values.GITHUB_ADMIN_TEAM = adminTeam;
        values.GITHUB_USER_TEAM = userTeam;
      } else if (provider === 'ldap' || provider === 'okta') {
        const prefix = provider.toUpperCase();
        values[`${prefix}_ADMIN_GROUP`] = groups.admin;
        values[`${prefix}_USER_GROUP`] = groups.user;
      }
    }
    if (admin) Object.assign(values, billingFromEnv(admin), pluginInstallFromEnv(admin));
    // The render writes the resolved URL; <BASE_URL>/admin/app/shell/ is what the answer auto-shell resolves to.
    if (admin && admin.LOGOUT_REDIRECT_URL) {
      values.LOGOUT_REDIRECT_URL = admin.LOGOUT_REDIRECT_URL === `${admin.BASE_URL}/admin/app/shell/` ? 'auto-shell' : admin.LOGOUT_REDIRECT_URL;
    }
    if (postgres) values.POSTGRES_USER = postgres.POSTGRES_USER;
    if (gateway) {
      if (gateway.SAP_AI_CORE_URL) {
        values.configMethod = 'manual';
        for (const key of ['SAP_AI_CORE_URL', 'AUTH_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'SAP_AI_REGION', 'SAP_AI_RESOURCE_GROUP']) {
          values[key] = gateway[key];
        }
      } else {
        values.configMethod = 'skip';
      }
    }
    return values;
  }

  /**
   * Kyma values from the namespace's rendered output: its Secrets (above), the Dex config (provider
   * settings; a ConfigMap in older renders), the core manifests (images) and the istio-system
   * policies (IP allowlist).
   */
  valuesFromRenderedFiles(root) {
    const values = this.valuesFromSecretData({
      admin: this.readRenderedSecret(root, 'admin-env'),
      gateway: this.readRenderedSecret(root, 'gateway-env'),
      postgres: this.readRenderedSecret(root, 'postgres-env')
    });
    // The pull-secret login itself is offered by getContainerConfig, for its own registry only.
    if (readRegistrySecret(path.join(root, 'templates', 'secrets'))) values.imagePullSecrets = true;

    // The Dex config Secret, or the ConfigMap a render made before it became a Secret.
    const dex = this.readRenderedYaml(path.join(root, 'templates', 'secrets', 'dex-config.yaml'), 'config.yaml') ||
      this.readRenderedYaml(path.join(root, 'templates', 'configmaps', 'dex-config.yaml'), 'config.yaml');
    Object.assign(values, valuesFromDexConfig(dex));

    // Images (live-values.js parses the Deployments' images the same way).
    const images = {};
    for (const name of ['admin', 'gateway', 'nginx']) {
      const file = path.join(root, 'manifests', 'core', `${name}.yaml`);
      const image = fs.existsSync(file) && new RegExp(`image: (\\S*sail-proxy-${name}[:@]\\S+)`).exec(fs.readFileSync(file, 'utf8'));
      if (image) images[name] = image[1];
    }
    Object.assign(values, valuesFromImages(images));

    // Public deployments: the IP allowlist lives in the istio-system policy, which exists only
    // when istio-system changes were allowed; the SCC tunnel policy goes with it.
    const istioDir = path.join(root, 'manifests', 'istio-system');
    const policy = this.readRenderedYaml(path.join(istioDir, 'authorization-policy.yaml'));
    Object.assign(values, valuesFromAllowlistPolicy(policy, fs.existsSync(path.join(istioDir, 'connectivity-proxy-allow.yaml'))));
    return values;
  }

  /** The registry question's answers for a registry host. */
  registryAnswers(registry) {
    return registryAnswers(registry);
  }

  /**
   * Values shared with the Docker setup, from the files docker/setup-docker.js wrote (read by the
   * same reader as its own re-run); they only fill what the Kyma files and the cluster do not
   * hold (loadCurrentValues): database user, identity provider and its settings, and the
   * image registry when Docker pulls from one (local builds always record ghcr.io/st-gr, which
   * is not a choice). The logout URL is not taken: it only reaches Docker's own files.
   */
  valuesFromDockerFiles() {
    const docker = readDockerConfigValues(path.join(this.projectRoot, 'docker'));
    const groups = docker.groups;
    const provider = docker.IDENTITY_PROVIDER;
    const values = { POSTGRES_USER: docker.POSTGRES_USER, provider };
    if (provider === 'github') {
      values.GITHUB_CLIENT_ID = docker.GITHUB_CLIENT_ID;
      values.GITHUB_CLIENT_SECRET = docker.GITHUB_CLIENT_SECRET;
      if (docker.GITHUB_ORG !== undefined) {
        values.GITHUB_ORG = docker.GITHUB_ORG;
        values.GITHUB_ADMIN_TEAM = githubTeam(docker.GITHUB_ORG, groups.admin);
        values.GITHUB_USER_TEAM = githubTeam(docker.GITHUB_ORG, groups.user);
      }
    } else if (provider === 'ldap') {
      values.LDAP_ADMIN_GROUP = groups.admin;
      values.LDAP_USER_GROUP = groups.user;
      if (isExternalLdap(docker)) {
        for (const key of ['LDAP_HOST', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_USER_BASE_DN', 'LDAP_GROUP_BASE_DN']) {
          values[key] = docker[key];
        }
      }
    } else if (provider === 'okta') {
      if (docker.OKTA_SSO_URL !== 'OKTA_SSO_URL') values.OKTA_SSO_URL = docker.OKTA_SSO_URL;
      values.OKTA_ADMIN_GROUP = groups.admin;
      values.OKTA_USER_GROUP = groups.user;
    }
    if (docker.DOCKER_REGISTRY && usesImageRegistry(docker)) {
      Object.assign(values, this.registryAnswers(docker.DOCKER_REGISTRY));
      values.organization = docker.DOCKER_ORGANIZATION;
    }
    return values;
  }

  /** Whether a current value would pass its question (choices, validate); invalid ones are dropped. */
  isValidCurrentValue(id, value) {
    const booleans = ['allowIstioSystemChanges', 'sccTunnel', 'imagePullSecrets', INSTALL_KEY];
    if (booleans.includes(id)) return typeof value === 'boolean';
    if (typeof value !== 'string') return false;
    const required = (v) => v.trim() !== '';
    const publicQuestion = (name) => (v) => this.publicConfigQuestions().find((q) => q.name === name).validate(v) === true;
    const checks = {
      deploymentType: (v) => ['public', 'internal'].includes(v),
      provider: (v) => Object.keys(PROVIDERS).includes(v),
      domain: publicQuestion('domain'),
      clusterSubdomain: publicQuestion('clusterSubdomain'),
      ipAllowlist: publicQuestion('ipAllowlist'),
      registry: (v) => ['ghcr.io', 'docker.io', 'custom-acr', 'custom'].includes(v),
      customRegistry: required,
      organization: required,
      imageTag: (v) => this.isValidDockerTag(v),
      imageDigest: (v) => /^sail-proxy-(admin|gateway|nginx)@sha256:[0-9a-f]{64}$/.test(v),
      POSTGRES_USER: (v) => validateDatabaseUsername(v) === true,
      ...Object.fromEntries(BILLING_KEYS.map((key) => [key, (v) => isValidBillingValue(key, v)])),
      configMethod: (v) => ['json', 'manual', 'skip'].includes(v),
      SAP_AI_CORE_URL: required,
      AUTH_URL: required,
      CLIENT_ID: required,
      CLIENT_SECRET: required,
      SAP_AI_REGION: required,
      SAP_AI_RESOURCE_GROUP: required
    };
    if (checks[id]) return checks[id](value);
    const prompt = Object.values(PROVIDER_PROMPTS).flat().find((p) => p.key === id);
    if (!prompt) return false;
    if (prompt.options && !prompt.options.includes(value)) return false;
    if (prompt.required && !required(value)) return false;
    return true;
  }

  /**
   * The current configuration's answers for this namespace, keyed by question id (plus imageTag
   * for the version question). Per value, the first source holding a valid one wins (the
   * maintainer's ruling: Kyma files win, the Docker .env only fills the gaps):
   * 1. the answers of the live install record (install-record.js), which the installation keeps
   *    of itself on every deploy;
   * 2. the namespace's rendered output (valuesFromRenderedFiles);
   * 3. the live objects the rendered output was applied as (live-values.js): Dex config, images,
   *    pull secret, istio-system policies - for a run without the rendered files (an upgrade);
   * 4. the live namespace's Secrets, as loadExistingKeys already read them;
   * 5. values shared with Docker, from the Docker files (valuesFromDockerFiles);
   * else the question keeps today's default. An existing namespace's database user is never
   * offered from here: its volume only accepts the live user, which the question defaults to.
   * Secrets among them (provider client secrets, bind password, SAP client secret) are only
   * ever given to password questions, which never show them. {} with --force.
   * Held only by the record: the Okta metadata URL and the tag of images pinned by digest; the
   * certificate choice is held nowhere. The registry login is read by getContainerConfig.
   */
  async loadCurrentValues(namespace) {
    if (this.forceOverwrite) return {};
    const live = await this.once(`existing-keys:${namespace}`, () => this.readExistingKeys());
    const exists = live.state === 'exists';
    const liveSecrets = exists ? live.secrets || {} : {};
    const kubectl = (args) => this.runKubectl(args);
    const record = exists ? await readInstallRecord(kubectl, namespace) : null;
    const rendered = this.valuesFromRenderedFiles(outputRoot(this.outputBaseDir, namespace));
    const unread = [];
    const liveValues = exists ? await readLiveValues(kubectl, namespace, {
      yaml,
      adminEnv: liveSecrets['admin-env'] || null,
      rendered: Object.keys(rendered).length > 0,
      record: record !== null,
      onWarning: (message) => unread.push(message)
    }) : {};
    if (unread.length > 0) {
      console.warn(`⚠️  Not read from the cluster (the rendered files or the install record answer instead): ${unread.join(' ')}`);
    }
    const sources = [
      record ? record.answers : {},
      rendered,
      liveValues,
      this.valuesFromSecretData({
        admin: liveSecrets['admin-env'],
        gateway: liveSecrets['gateway-env'],
        postgres: liveSecrets['postgres-env']
      }),
      this.valuesFromDockerFiles()
    ];
    const current = {};
    for (const values of sources) {
      for (const [id, value] of Object.entries(values)) {
        if (id in current || value === undefined || value === null) continue;
        if (id === 'POSTGRES_USER' && live.db) continue;
        if (this.isValidCurrentValue(id, value)) current[id] = value;
      }
    }
    this.preferLiveAllowlist(current, liveValues.ipAllowlist);
    return current;
  }

  /**
   * The live allowlist policy is what the cluster enforces: when it differs from the record or the
   * rendered file (an entry added or removed by hand), its list is the default, and setup names the
   * difference. Otherwise the re-run would offer the stale list, and the deploy, which deletes and
   * re-applies the policy, would drop the live-only entries without a word (2026-10-29).
   */
  preferLiveAllowlist(current, liveAllowlist) {
    if (!liveAllowlist || current.ipAllowlist === undefined || current.ipAllowlist === liveAllowlist) return;
    if (!this.isValidCurrentValue('ipAllowlist', liveAllowlist)) return;
    const list = (value) => String(value).split(',').map((s) => s.trim()).filter(Boolean);
    const offered = list(current.ipAllowlist);
    const enforced = list(liveAllowlist);
    const onlyLive = enforced.filter((ip) => !offered.includes(ip));
    const onlyOffered = offered.filter((ip) => !enforced.includes(ip));
    if (onlyLive.length === 0 && onlyOffered.length === 0) return;
    current.ipAllowlist = enforced.join(',');
    console.log([
      'ℹ️  The IP allowlist on the cluster differs from the install record or the rendered files; its entries are the default:',
      ...(onlyLive.length > 0 ? [`   only on the cluster: ${onlyLive.join(', ')}`] : []),
      ...(onlyOffered.length > 0 ? [`   not on the cluster (left out): ${onlyOffered.join(', ')}`] : [])
    ].join('\n'));
  }

  /**
   * Generated secrets of the namespace's earlier render that a re-run keeps unless they are
   * regenerated: the OAuth2 proxy client and cookie secrets (templates/secrets/
   * oauth2-proxy-secrets.yaml, else the live Secret: a new cookie secret signs everyone out). The
   * encryption keys and database credentials are carried from the live namespace instead
   * (loadExistingKeys). {} with --force.
   */
  async loadCurrentSecrets(namespace) {
    if (this.forceOverwrite) return {};
    let data = this.readRenderedSecret(outputRoot(this.outputBaseDir, namespace), 'oauth2-proxy-secrets');
    if (!data) {
      const live = await this.once(`existing-keys:${namespace}`, () => this.readExistingKeys());
      const oauth2 = live.state === 'exists'
        ? await this.once(`live-oauth2:${namespace}`, () => readLiveOauth2Secrets((args) => this.runKubectl(args), namespace))
        : null;
      data = oauth2 ? { 'client-secret': oauth2.clientSecret, 'cookie-secret': oauth2.cookieSecret } : {};
    }
    const secrets = {};
    if (data['client-secret']) secrets.OAUTH2_PROXY_CLIENT_SECRET = data['client-secret'];
    if (data['cookie-secret']) secrets.OAUTH2_PROXY_COOKIE_SECRET = data['cookie-secret'];
    return secrets;
  }

  /**
   * Interactive: every question, the deploy question included, is asked inside the prompt
   * session (Back, review screen); nothing is rendered, applied or deployed before the review's
   * "Write configuration". Only read-only work runs while asking (cluster reads, registry
   * lookups, metadata fetches), once per session.
   * @returns {Promise<KymaAnswers>}
   */
  async collectAnswers(session) {
    this.session = session;
    // State the questions derive (keys carried from the cluster, the database password) is
    // rebuilt on every replay, so a namespace changed after Back keeps nothing of the old one.
    this.sharedSecrets = {};
    this.currentSecrets = {};
    this.liveDbCredentials = undefined;
    this.liveS3Env = undefined;
    return this.askQuestions();
  }

  /** --ci: the same steps, each deciding without a prompt as before. */
  async unattendedAnswers() {
    this.session = null;
    this.currentSecrets = {};
    return this.askQuestions();
  }

  /**
   * The questions in today's order. Interactive runs also ask, at the end, which carried keys to
   * regenerate and whether to deploy now (only offered for the default images).
   * @typedef {object} KymaAnswers
   * @property {string} namespace
   * @property {string} deploymentType
   * @property {string} provider
   * @property {object} providerConfig
   * @property {object|null} publicConfig
   * @property {object} containerConfig
   * @property {object} dbConfig
   * @property {object|null} sapConfig
   * @property {boolean|null} autoDeploy  null when not asked (--ci, or not the default images)
   * @property {string[]} regenerateKeys
   * @property {{from: string, to: string}|null} providerChange  set when the provider changed and the cookie key is regenerated for it
   * @property {object|null} billing  SAP_BILLING_CURRENCY and optional CU prices; null when not asked
   * @property {boolean|null} pluginInstall  INSTALLED_PLUGINS_ENABLED to write; null when not asked or yes changes nothing
   */
  async askQuestions() {
    const namespace = await this.selectNamespace();
    if (this.session) {
      // Answers given for another namespace (before Back or a review jump changed it) are not
      // this namespace's: forget them, so its current values are offered and marked against.
      // Before loadExistingKeys, whose confirmations for this namespace must stay remembered.
      if (this.answersNamespace !== undefined && this.answersNamespace !== namespace) {
        this.session.resetExcept(['namespace']);
      }
      this.answersNamespace = namespace;
    }
    const { carried } = await this.loadExistingKeys();

    if (this.session) {
      // A re-run's defaults: the configuration this namespace already has (none with --force).
      this.session.current = await this.once(`current-values:${namespace}`, () => this.loadCurrentValues(namespace));
      this.currentSecrets = await this.loadCurrentSecrets(namespace);
      // Kept as they are, so generateSecrets makes no new ones (regenerated in applyAnswers).
      Object.assign(this.sharedSecrets, this.currentSecrets);
    }

    const deploymentType = await this.selectDeploymentType();
    const provider = await this.selectProvider();
    const providerConfig = await this.collectProviderConfig(provider);

    let publicConfig = null;
    if (deploymentType === 'public') {
      publicConfig = await this.getPublicConfig();
    }

    const containerConfig = await this.getContainerConfig();
    const dbConfig = await this.promptForDatabaseCredentials();
    const sapConfig = await this.promptForServiceKey();
    // Asked on interactive runs only; --ci and the setup-docker child run write no billing values.
    const billing = this.session
      ? billingToWrite(await askBilling(this.session, this.session.current), this.session.current)
      : null;
    const pluginInstall = this.session
      ? pluginInstallToWrite(await askPluginInstall(this.session, this.session.current), this.session.current)
      : null;

    let regenerateKeys = [];
    let providerChange = null;
    let autoDeploy = null;
    if (this.session) {
      // The generated keys this namespace already has (read from the cluster, the OAuth2 proxy
      // secrets from its earlier render): kept unless regenerated here, each behind its warning.
      const existing = [...carried];
      if (this.sharedSecrets.FILE_SEARCH_RUNTIME_PASSWORD) existing.push('FILE_SEARCH_RUNTIME_PASSWORD');
      existing.push(...Object.keys(this.currentSecrets));
      if (existing.length > 0) {
        regenerateKeys = await askKeyRegeneration(this.session, existing);
      }
      const previousProvider = this.session.current.provider;
      const withCookie = keysForProviderChange(regenerateKeys, { previous: previousProvider, provider, carried: existing });
      if (withCookie !== regenerateKeys) providerChange = { from: previousProvider, to: provider };
      regenerateKeys = withCookie;

      // Auto-deployment is only available in interactive mode with default images
      const usingDefaultImages = containerConfig.registry === 'ghcr.io' &&
                                 containerConfig.organization === 'st-gr';
      if (usingDefaultImages) {
        ({ autoDeploy } = await this.prompt([
          {
            type: 'confirm',
            name: 'autoDeploy',
            message: '\nWould you like to deploy to Kyma now?',
            reviewLabel: 'Deploy to Kyma now',
            default: true
          }
        ]));
      }
    }

    return {
      namespace,
      deploymentType,
      provider,
      providerConfig,
      publicConfig,
      containerConfig,
      dbConfig,
      sapConfig,
      autoDeploy,
      regenerateKeys,
      providerChange,
      billing,
      pluginInstall
    };
  }

  /** Renders the manifests, shows the summary, then deploys or not as answered. */
  async applyAnswers(answers) {
    // Regenerate means "do not carry over": generateSecrets makes a new value for each.
    for (const key of answers.regenerateKeys) {
      delete this.sharedSecrets[key];
      delete this.currentSecrets[key];
    }
    if (answers.providerChange) {
      console.log(`\n🔑 The login provider changed from ${answers.providerChange.from} to ${answers.providerChange.to}: ` +
        'a new cookie key signs everyone out, so no session made through the old provider stays valid.');
    }

    this.billing = answers.billing;
    this.pluginInstall = answers.pluginInstall;
    const config = await this.generateManifests(
      answers.deploymentType,
      answers.provider,
      answers.providerConfig,
      answers.publicConfig,
      answers.containerConfig,
      answers.dbConfig,
      answers.sapConfig
    );

    await this.showCompletion(config);

    if (answers.autoDeploy === null) return;

    if (answers.autoDeploy) {
      // Final safety check: never deploy in CI mode
      if (this.ciMode) {
        console.log('❌ Deployment is disabled in CI mode');
        return;
      }
      console.log('\n🚀 Starting deployment...\n');

      // Set environment variable with config (including user-selected tag). The
      // registry credentials are not handed over: deploy applies the rendered
      // pull secret file.
      const deployConfig = {
        namespace: config.namespace,
        imagePullSecrets: config.imagePullSecrets,
        containerRegistry: config.containerRegistry,
        containerOrganization: config.containerOrganization,
        containerTag: config.containerTag
      };

      process.env.KYMA_DEPLOY_CONFIG = Buffer.from(JSON.stringify(deployConfig)).toString('base64');

      // Run deploy script with proper path
      const { spawn } = require('child_process');
      const deployScriptAbsPath = path.join(__dirname, 'deploy-kyma.js');
      const deployProcess = spawn('node', [deployScriptAbsPath, '--namespace', config.namespace], {
        stdio: 'inherit',
        env: process.env
      });

      deployProcess.on('close', (code) => {
        // Clear environment variable
        delete process.env.KYMA_DEPLOY_CONFIG;

        if (code === 0) {
          console.log('\n✅ Deployment completed successfully!');
          process.exit(0);
        } else {
          console.log('\n❌ Deployment failed with code:', code);
          process.exit(code);
        }
      });
    } else {
      // User opted out - clear any sensitive data
      console.log('\n📌 You can deploy later using the command shown above.');
      process.exit(0);
    }
  }

  async run() {
    try {
      await this.showWelcome();

      let answers;
      if (this.ciMode) {
        answers = await this.unattendedAnswers();
      } else {
        // An abort or error before "Write configuration" ends here with nothing written.
        const session = this.createSession();
        this.answersNamespace = undefined;
        answers = await session.run((s) => this.collectAnswers(s));
      }
      await this.applyAnswers(answers);
    } catch (error) {
      console.error('\n❌ Setup failed:', error.message);
      process.exit(1);
    }
  }
}

// Main execution
if (require.main === module) {
  // Only run if inquirer is loaded
  if (inquirer) {
    let setup;
    try {
      setup = new KymaSetup({ forceOverwrite, ciMode, namespace: parseNamespaceArg(args) });
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    setup.run()
      .then(() => {
        // If we get here and haven't exited yet, it means setup completed without deployment
        if (!process.env.KYMA_DEPLOY_CONFIG) {
          process.exit(0);
        }
      })
      .catch(error => {
        console.error(error);
        process.exit(1);
      });
  }
  // Otherwise, the script will exit after prompting to install inquirer
}

// Tests cannot rely on js-yaml being installed (setup installs it on demand)
// and hand in a stand-in instead.
KymaSetup.useYaml = (yamlLib) => {
  yaml = yamlLib;
};
// Likewise for scripted prompt answers.
KymaSetup.useInquirer = (inquirerLib) => {
  inquirer = inquirerLib;
};
// The provider questions, for the test that keeps their secrets out of the install record.
KymaSetup.PROVIDER_PROMPTS = PROVIDER_PROMPTS;

module.exports = KymaSetup;
