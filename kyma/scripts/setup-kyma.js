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

Examples:
  From kyma directory:
    node scripts/setup-kyma.js
    node scripts/setup-kyma.js --force
    node scripts/setup-kyma.js --ci
    node scripts/setup-kyma.js --ci --force

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
  return null;
}

inquirer = tryLoadPackage('inquirer');
yaml = tryLoadPackage('js-yaml');

if (!inquirer || !yaml) {
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
        const child = spawn(process.argv[0], [__filename], {
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
    { key: 'GITHUB_ORG', prompt: 'GitHub Organization name', required: true },
    { key: 'GITHUB_ADMIN_TEAM', prompt: 'Admin team name', default: 'admins' },
    { key: 'GITHUB_USER_TEAM', prompt: 'User team name', default: 'users' },
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

class KymaSetup {
  constructor(options = {}) {
    this.kymaDir = path.resolve(__dirname, '..');
    this.scriptsDir = path.join(this.kymaDir, 'scripts');
    this.configsDir = path.join(this.kymaDir, 'configs');
    this.manifestsDir = path.join(this.kymaDir, 'manifests');
    this.templatesDir = path.join(this.kymaDir, 'templates');
    this.projectRoot = path.resolve(this.kymaDir, '..');
    this.sharedSecrets = {};
    this.forceOverwrite = options.forceOverwrite || false;
    this.ciMode = options.ciMode || false;
    this.namespace = 'sail-proxy';
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

  /**
   * Fetch available image tags from registry
   */
  async fetchImageTags(config) {
    const { registry, organization, dockerUsername, dockerPassword } = config;
    
    console.log('\n🔍 Fetching available versions...');
    
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
            const checkUrl = `https://api.github.com/users/${organization}`;
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
            const url = `https://api.github.com/${urlPath}/${organization}/packages/container/sail-proxy-gateway/versions`;

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
              .flatMap(v => v.metadata.container.tags)
              .filter(tag => this.isValidSemver(tag));
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
        const url = `https://registry.hub.docker.com/v2/repositories/${organization}/sail-proxy-gateway/tags/?page_size=100`;
        
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
          .map(r => r.name)
          .filter(tag => this.isValidSemver(tag));
          
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
        tags = (data.tags || []).filter(tag => this.isValidSemver(tag));
      }
      
      // Remove duplicates and sort
      tags = [...new Set(tags)].sort((a, b) => -this.compareSemver(a, b));
      
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
    return (data.tags || []).filter(tag => this.isValidSemver(tag));
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
    const { registry, organization, dockerUsername, dockerPassword } = config;

    try {
      let authToken = '';
      let registryUrl = '';
      let authHeader = '';

      // Registry-specific setup
      if (registry === 'ghcr.io') {
        if (dockerUsername && dockerPassword) {
          authToken = await this.getGhcrToken(organization, imageName, dockerUsername, dockerPassword);
        }
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
      const digest = await this.fetchManifestAndResolve(
        registryUrl,
        authToken,
        authHeader,
        platform
      );

      return digest;

    } catch (error) {
      console.warn(`⚠️  Could not fetch digest for ${imageName}:${tag}:`, error.message);
      return null;
    }
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
          reject(new Error(`Failed to get manifest: HTTP ${res.statusCode}`));
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

  /**
   * Select image version with digest support
   */
  async selectImageVersion(config) {
    const availableTags = await this.fetchImageTags(config);
    
    let selectedVersion;
    let useDigests = false;
    const imageDigests = {};
    
    if (availableTags.length > 0) {
      console.log('\nChoose image version:');
      
      const choices = availableTags.map((tag, index) => ({
        name: index === 0 ? `${tag} (latest)` : tag,
        value: tag
      }));
      
      choices.push({ name: 'Enter custom version...', value: 'custom' });
      
      const { version } = await inquirer.prompt([
        {
          type: 'list',
          name: 'version',
          message: 'Select version:',
          choices: choices
        }
      ]);
      
      if (version === 'custom') {
        const { customVersion } = await inquirer.prompt([
          {
            type: 'input',
            name: 'customVersion',
            message: 'Enter version (e.g., 1.2.3):',
            validate: (input) => {
              if (!this.isValidSemver(input)) {
                return 'Please enter a valid semantic version (e.g., 1.2.3)';
              }
              
              // Check if version is lower than lowest available
              if (availableTags.length > 0) {
                const lowestAvailable = availableTags[availableTags.length - 1];
                if (this.compareSemver(input, lowestAvailable) < 0) {
                  return `Version must be ${lowestAvailable} or higher`;
                }
              }
              
              return true;
            }
          }
        ]);
        selectedVersion = customVersion;
      } else {
        selectedVersion = version;
        useDigests = true; // Use digests for available versions
      }
      
    } else {
      // No tags found, ask for manual version
      const { customVersion } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customVersion',
          message: 'Enter image version (e.g., 1.0.0):',
          default: '1.0.0',
          validate: (input) => {
            if (!this.isValidSemver(input)) {
              return 'Please enter a valid semantic version (e.g., 1.0.0)';
            }
            return true;
          }
        }
      ]);
      selectedVersion = customVersion;
    }
    
    // If using digests, fetch them for all three images
    if (useDigests) {
      console.log('\n🔐 Fetching image digests...');
      const images = ['sail-proxy-admin', 'sail-proxy-gateway', 'sail-proxy-nginx'];
      
      for (const image of images) {
        const digest = await this.fetchImageDigest(config, image, selectedVersion);
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
      imageDigests: imageDigests
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

  generateSecrets() {
    if (!this.sharedSecrets.VALIDATION_TOKEN_SECRET) {
      // Core service secrets (64 chars hex each)
      this.sharedSecrets.VALIDATION_TOKEN_SECRET = this.generateSecureToken();
      this.sharedSecrets.METADATA_ENCRYPTION_KEY = this.generateSecureToken();
      this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY = this.generateSecureToken();
      
      // OAuth2 Proxy secrets (matching current hardcoded lengths)
      this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET = this.generateOAuth2ClientSecret(); // 64 chars
      this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET = this.generateOAuth2CookieSecret(); // 32 chars
    }
    
    // Database password: only generate if not already set by user
    if (!this.sharedSecrets.POSTGRES_PASSWORD) {
      this.sharedSecrets.POSTGRES_PASSWORD = this.generateDatabasePassword();
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
        
        const { useExisting } = await inquirer.prompt([
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
          console.log('\n⚠️  WARNING: Providing new configuration will delete existing .env files!');
          console.log('   This ensures docker/setup-docker.js creates fresh configuration.');
          
          const { confirmDelete } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirmDelete',
              message: 'Delete services/gateway/.env and services/admin/.env files?',
              default: false
            }
          ]);
          
          if (confirmDelete) {
            // Delete existing .env files
            const adminEnvPath = path.join(this.projectRoot, 'services/admin/.env');
            if (fs.existsSync(gatewayEnvPath)) {
              fs.unlinkSync(gatewayEnvPath);
              console.log('   ✅ Deleted services/gateway/.env');
            }
            if (fs.existsSync(adminEnvPath)) {
              fs.unlinkSync(adminEnvPath);
              console.log('   ✅ Deleted services/admin/.env');
            }
            console.log('');
          } else {
            console.log('\n❌ Cannot proceed without deleting existing .env files.');
            console.log('   Please manually delete them and run setup again.');
            process.exit(1);
          }
        }
      }
    }
    
    // Check for environment variable
    const envConfig = this.checkEnvServiceKey();
    if (envConfig) {
      console.log('\n🚀 Using SAP AI Core service key from environment variable');
      console.log('   Skipping interactive configuration...\n');
      return envConfig;
    }
    
    const { configMethod } = await inquirer.prompt([
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
      const { serviceKeyJson } = await inquirer.prompt([
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
      const sapConfig = await inquirer.prompt([
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
    if (this.ciMode) {
      // CI mode: use secure generated defaults
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
    const usernameConfig = await inquirer.prompt([
      {
        type: 'input',
        name: 'POSTGRES_USER',
        message: 'Database username:',
        default: 'admin_user',
        validate: (input) => {
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
      }
    ]);

    // Then, handle password with confirmation for manual entry
    let passwordConfig = {};
    let passwordConfirmed = false;
    
    while (!passwordConfirmed) {
      passwordConfig = await inquirer.prompt([
        {
          type: 'password',
          name: 'POSTGRES_PASSWORD',
          message: 'Database password (leave empty for auto-generated):',
          mask: '*',
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
      const confirmConfig = await inquirer.prompt([
        {
          type: 'password',
          name: 'POSTGRES_PASSWORD_CONFIRM',
          message: 'Confirm database password:',
          mask: '*'
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

    // Use generated password if user didn't provide one
    if (!dbConfig.POSTGRES_PASSWORD || dbConfig.POSTGRES_PASSWORD.trim().length === 0) {
      dbConfig.POSTGRES_PASSWORD = this.generateDatabasePassword();
      dbConfig.useGeneratedSecrets = true;
      dbConfig.passwordWasGenerated = true;
      console.log(`   ✅ Using auto-generated secure password: ${dbConfig.POSTGRES_PASSWORD}`);
    } else {
      dbConfig.useGeneratedSecrets = false;
      dbConfig.passwordWasGenerated = false;
      console.log('   ✅ Using provided password');
    }
    
    // Always update sharedSecrets with the final password (generated or provided)
    this.sharedSecrets.POSTGRES_PASSWORD = dbConfig.POSTGRES_PASSWORD;

    return dbConfig;
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
    
    const { deploymentType } = await inquirer.prompt([
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

    const { provider } = await inquirer.prompt([
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
    const answers = await inquirer.prompt(inquirerPrompts);
    
    // Process answers (similar to Docker setup)
    for (const [key, value] of Object.entries(answers)) {
      if (key === 'OKTA_SAML_CA_DATA' && value === 'auto-fetch-from-metadata') {
        // Handle auto-fetch
        if (answers.OKTA_METADATA_URL) {
          try {
            console.log('Auto-fetching SAML certificate from metadata...');
            const metadataInfo = await this.fetchSamlCertificateFromMetadata(answers.OKTA_METADATA_URL);
            config[key] = metadataInfo.certificate;
            
            // Auto-populate SSO URL
            if (metadataInfo.ssoUrl) {
              config.OKTA_SSO_URL = metadataInfo.ssoUrl;
              console.log(`✅ SSO URL auto-populated: ${metadataInfo.ssoUrl}`);
            }
          } catch (error) {
            console.log(`❌ Auto-fetch failed: ${error.message}`);
            // Ask for manual input
            const { manualCert } = await inquirer.prompt([
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
          const { manualCert } = await inquirer.prompt([
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
        const { manualCert } = await inquirer.prompt([
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
      const externalAnswers = await inquirer.prompt(inquirerExternalPrompts);
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
    
    const config = await inquirer.prompt([
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
      const { customRegistry } = await inquirer.prompt([
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
    
    const orgAndAuthConfig = await inquirer.prompt([
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
    
    // If image pull secrets are required, collect the credentials
    let registryCredentials = {};
    if (config.imagePullSecrets) {
      console.log('\nDocker Registry Authentication:');
      registryCredentials = await inquirer.prompt([
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

  async getPublicConfig() {
    if (this.ciMode) {
      console.log('🤖 CI Mode: Using localhost for development\n');
      return {
        domain: 'sail-proxy',
        clusterSubdomain: 'c-XXXXX',
        ipAllowlist: [],
        sccTunnel: true
        // allowIstioSystemChanges not set - will skip IP restrictions in CI mode
      };
    }
    
    console.log('\nPublic HTTPS Configuration:');
    
    const config = await inquirer.prompt([
      {
        type: 'input',
        name: 'domain',
        message: 'APIRule host name (e.g., sail-proxy):',
        default: 'sail-proxy',
        validate: (input) => {
          if (!input.trim()) return 'Domain is required';
          const validation = validateRFC1123Label(input.trim());
          return validation === true ? true : validation;
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
        message: 'IP allowlist (comma-separated CIDRs, e.g., 198.51.100.0/24,203.0.113.12/32):',
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
    ]);
    
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
    
    // Create auth manifests
    await this.createAuthManifests(config);
    
    // Create networking manifests
    if (deploymentType === 'public') {
      await this.createNetworkingManifests(config);
    }
    
    // Run setup-docker.js with matching configuration to prepare nginx build
    await this.runDockerSetup(config);
    
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
    
    // Gateway secret  
    let gatewayEnvData = `VALKEY_URL: redis://valkey:6379
PORT: "8080"
DEPLOY_TARGET: docker
ADMIN_SERVICE_URL: http://admin:4004
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
    
    // Admin secret
    const adminEnvData = `DATABASE_URL: ${this.yamlQuote(`postgres://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@postgres:5432/sap_llm_gateway`)}
VALKEY_URL: redis://valkey:6379
PORT: "4004"
VALIDATION_TOKEN_SECRET: ${this.yamlQuote(this.sharedSecrets.VALIDATION_TOKEN_SECRET)}
METADATA_ENCRYPTION_KEY: ${this.yamlQuote(this.sharedSecrets.METADATA_ENCRYPTION_KEY)}
AWS_SECRET_ENCRYPTION_KEY: ${this.yamlQuote(this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY)}
cds.requires.db.credentials.password: ${this.yamlQuote(config.POSTGRES_PASSWORD)}
ROLE_MAPPING: ${this.yamlQuote(config.ROLE_MAPPING || '{}')}
IDENTITY_PROVIDER: ${this.yamlQuote(config.provider || 'github')}
JWT_ISSUER: ${this.yamlQuote(`${config.baseUrl}/dex`)}
BASE_URL: ${this.yamlQuote(config.baseUrl)}
LOGOUT_REDIRECT_URL: ${this.yamlQuote(`${config.baseUrl}/admin/app/shell/`)}`;
    
    const adminSecret = `apiVersion: v1
kind: Secret
metadata:
  name: admin-env
  namespace: ${config.namespace}
type: Opaque
stringData:
${adminEnvData.split('\n').map(line => '  ' + line).join('\n')}
`;
    
    // OAuth2-Proxy secret - cookie-secret must be exactly 32 bytes for AES-256
    const cookieSecret = this.generateSecureToken().substring(0, 32);
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
    fs.mkdirSync(path.join(this.templatesDir, 'secrets'), { recursive: true });
    fs.mkdirSync(path.join(this.templatesDir, 'configmaps'), { recursive: true });
    
    // Write secrets
    fs.writeFileSync(path.join(this.templatesDir, 'secrets', 'postgres-env.yaml'), postgresSecret);
    fs.writeFileSync(path.join(this.templatesDir, 'secrets', 'gateway-env.yaml'), gatewaySecret);
    fs.writeFileSync(path.join(this.templatesDir, 'secrets', 'admin-env.yaml'), adminSecret);
    fs.writeFileSync(path.join(this.templatesDir, 'secrets', 'oauth2-proxy-secrets.yaml'), oauth2ProxySecret);
    
    // Create image pull secret if needed
    if (config.imagePullSecrets) {
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
      
      fs.writeFileSync(path.join(this.templatesDir, 'secrets', 'registry-secret.yaml.template'), imagePullSecret);
      console.log('✅ Image pull secret template created as registry-secret.yaml.template (requires manual configuration)');
    }
    
    console.log('✅ Secret manifests created');
  }

  async createConfigMapManifests(config) {
    // NGINX ConfigMap - different config per auth provider
    let nginxConfig;
    if (config.provider === 'local') {
      nginxConfig = `server {
  listen 8080;
  location / {
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_pass http://gateway:8080;
  }
}`;
    } else {
      nginxConfig = `server {
  listen 8080;
  location /auth {
    proxy_set_header Host $host;
    proxy_pass http://oauth2-proxy:4180;
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
    
    // Dex ConfigMap - provider-specific
    let dexConfig = await this.generateDexConfig(config);
    
    const dexConfigMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: dex-config
  namespace: ${config.namespace}
data:
  config.yaml: |
${dexConfig.split('\n').map(line => '    ' + line).join('\n')}
`;
    
    // Write ConfigMaps
    fs.writeFileSync(path.join(this.templatesDir, 'configmaps', 'nginx-conf.yaml'), nginxConfigMap);
    fs.writeFileSync(path.join(this.templatesDir, 'configmaps', 'dex-config.yaml'), dexConfigMap);
    
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
      fs.writeFileSync(path.join(this.templatesDir, 'configmaps', 'dex-saml-cert.yaml'), samlCertConfigMap);
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
      'nginx.yaml'
    ];
    
    for (const manifestFile of coreManifests) {
      const templatePath = path.join(coreTemplatesDir, manifestFile);
      const outputPath = path.join(coreManifestsDir, manifestFile);
      
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
          // Map manifest file to image name
          const imageMap = {
            'admin.yaml': 'sail-proxy-admin',
            'gateway.yaml': 'sail-proxy-gateway',
            'nginx.yaml': 'sail-proxy-nginx'
          };
          
          const imageName = imageMap[manifestFile];
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
          // Still replace any remaining __CONTAINER_TAG__ placeholders
          content = content.replace(/__CONTAINER_TAG__/g, config.containerTag);
        } else {
          // Use tag reference
          content = content.replace(/__CONTAINER_TAG__/g, config.containerTag);
        }
        
        // For nginx.yaml, update BASE_URL and JWT_ISSUER_URL for public deployments
        if (manifestFile === 'nginx.yaml' && config.deploymentType === 'public') {
          const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
          const baseUrl = `https://${fullDomain}`;
          
          // Replace BASE_URL
          content = content.replace(/- name: BASE_URL\s*\n\s*value: ".*"/g, 
            `- name: BASE_URL\n          value: "${baseUrl}"`);
          
          // Replace JWT_ISSUER_URL
          content = content.replace(/- name: JWT_ISSUER_URL\s*\n\s*value: ".*"/g, 
            `- name: JWT_ISSUER_URL\n          value: "${baseUrl}/dex"`);
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
  replacePlaceholders(content, config) {
    const fullDomain = `${config.domain}.${config.clusterSubdomain}.kyma.ondemand.com`;
    
    return content
      .replace(/__FULL_DOMAIN__/g, fullDomain)
      .replace(/__BASE_URL__/g, config.baseUrl)
      .replace(/__CONTAINER_REGISTRY__/g, config.containerRegistry)
      .replace(/__CONTAINER_ORGANIZATION__/g, config.containerOrganization)
      .replace(/__CONTAINER_TAG__/g, config.containerTag)
      .replace(/__NAMESPACE__/g, config.namespace);
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
      const istioSystemDir = path.join(this.kymaDir, 'manifests', 'istio-system');
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
      const istioSystemDir = path.join(this.kymaDir, 'manifests', 'istio-system');
      if (fs.existsSync(istioSystemDir)) {
        fs.rmSync(istioSystemDir, { recursive: true, force: true });
        console.log('✅ Cleaned up existing istio-system manifests (no IP allowlist configured)');
      }
    }
    
    console.log('✅ Networking manifests processed from templates');
  }
  
  generateIstioSystemAuthPolicy(config) {
    // Clean up and create istio-system directory in manifests
    const istioSystemDir = path.join(this.kymaDir, 'manifests', 'istio-system');
    
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
        name: `allowlist-${config.domain || 'sail-proxy'}`,
        namespace: 'istio-system'
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
    console.log(`✅ manifests/istio-system/authorization-policy.yaml created with IP allowlist: ${config.ipAllowlist.join(', ')}`);

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
        metadata: { name: 'allowlist-cp-tunnel', namespace: 'istio-system', labels: { app: 'connectivity-proxy' } },
        spec: { selector: sel, action: 'ALLOW',
          rules: [{ to: [{ operation: { hosts: [cpHost, `${cpHost}:443`] } }] }] } },
      { apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy',
        metadata: { name: 'allowlist-cp-healthcheck', namespace: 'istio-system', labels: { app: 'connectivity-proxy' } },
        spec: { selector: sel, action: 'ALLOW',
          rules: [{ to: [{ operation: {
            hosts: [hcHost, `${hcHost}:443`], methods: ['GET', 'HEAD'], paths: ['/healthcheck', '/'] } }] }] } },
    ];
    const content = docs.map(d => yaml.dump(d, { indent: 2, lineWidth: -1, noRefs: true })).join('---\n');
    fs.writeFileSync(path.join(istioSystemDir, 'connectivity-proxy-allow.yaml'), content);
    console.log(`✅ manifests/istio-system/connectivity-proxy-allow.yaml created for SCC tunnel (${cpHost})`);
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
    
    // If no SAP config provided, set to null
    if (Object.keys(dockerConfig.sapConfig).length === 0) {
      dockerConfig.sapConfig = null;
    }
    
    // Run setup-docker.js with --config flag
    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
      console.log('   Running: node docker/setup-docker.js --config <configuration>');
      
      const setupProcess = spawn('node', [dockerSetupPath, '--config', JSON.stringify(dockerConfig)], {
        cwd: this.projectRoot,
        stdio: 'inherit'
      });
      
      setupProcess.on('close', async (code) => {
        if (code === 0) {
          console.log('✅ Docker setup completed successfully');
          console.log('   Using matching configuration from Kyma setup');
          console.log('   The nginx image will work with both Docker and Kyma deployments');
          
          // Post-process: read generated .env files and create additional ConfigMaps
          try {
            await this.postProcessEnvFiles(config);
            resolve();
          } catch (error) {
            console.error('❌ Failed to post-process environment files:', error);
            reject(error);
          }
        } else {
          console.error(`❌ Docker setup failed with code ${code}`);
          reject(new Error('Docker setup failed'));
        }
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
      'VALKEY_URL', 'REDIS_URL', 'ADMIN_SERVICE_URL',  // Connection URLs should come from Secrets with K8s service names
      'PORT',  // PORT is already set in the Secret and should not be duplicated in ConfigMap
      'ROLE_MAPPING'  // ROLE_MAPPING is already set in the Secret and must not be overridden by ConfigMap
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
      
      fs.writeFileSync(path.join(this.templatesDir, 'configmaps', 'gateway-config.yaml'), gatewayConfigMap);
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
    
    fs.writeFileSync(path.join(this.templatesDir, 'configmaps', 'admin-config.yaml'), adminConfigMap);
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
    
    fs.writeFileSync(path.join(this.templatesDir, 'configmaps', 'admin-api-config.yaml'), apiConfigMap);
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
        console.log(`✅ IP Allowlist: ${config.ipAllowlist.join(', ')}`);
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
      console.log(`   - Password: ${this.sharedSecrets.POSTGRES_PASSWORD}`);
      console.log('');
    } else {
      console.log('   📊 Database Configuration:');
      console.log(`   - Username: ${config.POSTGRES_USER} (user-provided)`);
      console.log('   - Password: ******** (user-provided, not displayed for security)');
      console.log('');
    }
    
    console.log('   🔐 Security Secrets:');
    console.log(`   - Validation Token: ${this.sharedSecrets.VALIDATION_TOKEN_SECRET}`);
    console.log(`   - Metadata Encryption Key: ${this.sharedSecrets.METADATA_ENCRYPTION_KEY}`);
    console.log(`   - AWS Secret Encryption Key: ${this.sharedSecrets.AWS_SECRET_ENCRYPTION_KEY}`);
    console.log(`   - OAuth2 Client Secret: ${this.sharedSecrets.OAUTH2_PROXY_CLIENT_SECRET}`);
    console.log(`   - OAuth2 Cookie Secret: ${this.sharedSecrets.OAUTH2_PROXY_COOKIE_SECRET}`);
    console.log('');
    console.log('   These credentials are stored in Kubernetes Secrets and used by the services.');
    if (config.passwordWasGenerated) {
      console.log('   All secrets are randomly generated for maximum security.');
    } else {
      console.log('   System secrets are randomly generated. Database password was user-provided.');
    }
    
    console.log('\nGenerated files:');
    console.log('  Kubernetes Manifests:');
    console.log('  - manifests/core/namespace.yaml');
    console.log('  - templates/secrets/*.yaml (PostgreSQL, Gateway, Admin, OAuth2-Proxy secrets)');
    if (config.imagePullSecrets) {
      console.log('  - templates/secrets/registry-secret.yaml.template (Manual creation required)');
    }
    console.log('  - templates/configmaps/*.yaml (NGINX, Dex, Gateway, Admin, API configs)');
    console.log('  - manifests/core/*.yaml (Service deployments with ConfigMap integration)');
    if (config.deploymentType === 'public') {
      console.log('  - manifests/networking/*.yaml (APIRule, AuthorizationPolicy)');
    }
    
    console.log('\n💡 Next steps:');
    
    // Check if we're using default images that don't need building
    const usingDefaultImages = config.containerRegistry === 'ghcr.io' && 
                              config.containerOrganization === 'st-gr' && 
                              config.containerTag === '0.0.1';
    
    // Create deployment config with minimal necessary fields
    const deployConfig = {
      imagePullSecrets: config.imagePullSecrets,
      containerRegistry: config.containerRegistry,
      dockerUsername: config.dockerUsername,
      dockerPassword: config.dockerPassword
    };
    
    // Encode deployment config as base64
    const encodedConfig = Buffer.from(JSON.stringify(deployConfig)).toString('base64');
    
    if (usingDefaultImages) {
      console.log('✨ Using pre-built images - no Docker build required!');
      console.log('');
      console.log('1. Deploy directly to Kyma:');
      
      // Determine the relative path to deploy-kyma.js based on CWD
      const cwd = process.cwd();
      const deployScriptPath = path.join(__dirname, 'deploy-kyma.js');
      const relativeDeployPath = path.relative(cwd, deployScriptPath).replace(/\\/g, '/');
      
      if (config.imagePullSecrets && config.dockerUsername && config.dockerPassword) {
        // Windows PowerShell
        console.log('   # Windows PowerShell:');
        console.log(`   $env:KYMA_DEPLOY_CONFIG="${encodedConfig}"; node ${relativeDeployPath}; Remove-Item Env:\\KYMA_DEPLOY_CONFIG`);
        console.log('');
        console.log('   # Linux/Mac:');
        console.log(`   KYMA_DEPLOY_CONFIG="${encodedConfig}" node ${relativeDeployPath}`);
      } else {
        console.log(`   node ${relativeDeployPath}`);
      }
      console.log('');
    } else {
      console.log('1. Build and push Docker images:');
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
      
      if (config.imagePullSecrets && config.dockerUsername && config.dockerPassword) {
        // Windows PowerShell
        console.log('   # Windows PowerShell:');
        console.log(`   $env:KYMA_DEPLOY_CONFIG="${encodedConfig}"; node ${deployPath}; Remove-Item Env:\\KYMA_DEPLOY_CONFIG`);
        console.log('');
        console.log('   # Linux/Mac:');
        console.log(`   KYMA_DEPLOY_CONFIG="${encodedConfig}" node ${deployPath}`);
      } else {
        console.log(`   node ${deployPath}`);
      }
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
    console.log('   - Images use public GitHub container registry (ghcr.io/st-gr/sail-proxy-*)');
    
    console.log('');
  }

  async run() {
    try {
      await this.showWelcome();
      
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
      
      const config = await this.generateManifests(deploymentType, provider, providerConfig, publicConfig, containerConfig, dbConfig, sapConfig);
      
      await this.showCompletion(config);
      
      // Check if we can auto-deploy (using default registry and organization)
      const usingDefaultImages = config.containerRegistry === 'ghcr.io' && 
                                config.containerOrganization === 'st-gr';
                                
      // Auto-deployment is only available in interactive mode with default images
      if (usingDefaultImages && !this.ciMode) {
        const { autoDeploy } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'autoDeploy',
            message: '\nWould you like to deploy to Kyma now?',
            default: true
          }
        ]);
        
        if (autoDeploy) {
          // Final safety check: never deploy in CI mode
          if (this.ciMode) {
            console.log('❌ Deployment is disabled in CI mode');
            return;
          }
          console.log('\n🚀 Starting deployment...\n');
          
          // Set environment variable with config (including user-selected tag)
          const deployConfig = {
            imagePullSecrets: config.imagePullSecrets,
            containerRegistry: config.containerRegistry,
            containerOrganization: config.containerOrganization,
            containerTag: config.containerTag,
            dockerUsername: config.dockerUsername,
            dockerPassword: config.dockerPassword
          };
          
          process.env.KYMA_DEPLOY_CONFIG = Buffer.from(JSON.stringify(deployConfig)).toString('base64');
          
          // Run deploy script with proper path
          const { spawn } = require('child_process');
          const deployScriptAbsPath = path.join(__dirname, 'deploy-kyma.js');
          const deployProcess = spawn('node', [deployScriptAbsPath], {
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
    const setup = new KymaSetup({ forceOverwrite, ciMode });
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

module.exports = KymaSetup;
