#!/usr/bin/env node

/**
 * SAP AI Core Foundation Model Deployment Manager
 * 
 * A zero-dependency CLI tool for managing SAP AI Core foundation model deployments.
 * 
 * Usage:
 *   node sail-model-deploy.js --models
 *   node sail-model-deploy.js --status <model>
 *   node sail-model-deploy.js --create <model>
 *   node sail-model-deploy.js --help
 * 
 * Configuration:
 *   Reads SAP AI Core credentials from:
 *   - services/gateway/.env
 *   - ~/.sail-proxy/.env (Linux/macOS)
 *   - %APPDATA%/sail-proxy/.env (Windows)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const querystring = require('querystring');

// ============================================================================
// Token Cache Management
// ============================================================================

/**
 * Get the token cache file path
 */
function getTokenCachePath() {
  const cacheDir = os.tmpdir();
  return path.join(cacheDir, '.sap-ai-core-token-cache.json');
}

/**
 * Get cached token if still valid
 */
function getCachedToken() {
  const cachePath = getTokenCachePath();
  
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  
  try {
    const cacheData = fs.readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(cacheData);
    
    const now = Math.floor(Date.now() / 1000);
    
    // Add 60 second buffer to avoid using token right at expiration
    if (cache.token && cache.expiry && now < cache.expiry - 60) {
      return cache.token;
    }
  } catch (error) {
    // Invalid cache file, ignore
  }
  
  return null;
}

/**
 * Cache token with expiration
 */
function cacheToken(token, expiresIn) {
  const cachePath = getTokenCachePath();
  const expiry = Math.floor(Date.now() / 1000) + expiresIn;
  
  const cache = {
    token: token,
    expiry: expiry,
    cachedAt: new Date().toISOString()
  };
  
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch (error) {
    // Ignore cache write errors
    console.warn('⚠️  Warning: Failed to cache token');
  }
}

/**
 * Clear cached token
 */
function clearCachedToken() {
  const cachePath = getTokenCachePath();
  
  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch (error) {
    // Ignore errors when clearing cache
  }
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Get the sail-proxy configuration directory based on platform
 */
function getSailProxyConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'sail-proxy');
  } else {
    return path.join(os.homedir(), '.sail-proxy');
  }
}

/**
 * Parse .env file content into an object
 */
function parseEnvFile(content) {
  const config = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Parse KEY=VALUE or KEY='VALUE' or KEY="VALUE"
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      let [, key, value] = match;
      
      // Remove surrounding quotes if present
      value = value.trim();
      if ((value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      
      config[key] = value;
    }
  }
  
  return config;
}

/**
 * Load SAP AI Core configuration from available sources
 * Priority: services/gateway/.env > sail-proxy config
 */
function loadConfig() {
  // Get the script's directory and navigate to project root
  const scriptDir = __dirname;
  const projectRoot = path.join(scriptDir, '..');
  
  const configPaths = [
    // Project root services/gateway/.env (relative to script location)
    path.join(projectRoot, 'services', 'gateway', '.env'),
    // Also try from current working directory (in case script is run from project root)
    path.join(process.cwd(), 'services', 'gateway', '.env'),
    // Sail-proxy config directory
    path.join(getSailProxyConfigDir(), '.env')
  ];
  
  let config = null;
  let configSource = null;
  
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        config = parseEnvFile(content);
        configSource = configPath;
        break;
      } catch (error) {
        // Continue to next path
      }
    }
  }
  
  if (!config) {
    console.error('❌ Error: No SAP AI Core configuration found.');
    console.error('');
    console.error('Configuration files are stored in:');
    console.error('  - services/gateway/.env (project root)');
    console.error('  - Linux/macOS: ~/.sail-proxy/.env');
    console.error('  - Windows: %APPDATA%/sail-proxy/.env');
    console.error('');
    console.error('Please run one of the following to set up configuration:');
    console.error('  1. Install and configure sail-proxy: npm install -g @st-gr/sail-proxy && sail-proxy configure');
    console.error('  2. Run the Docker setup script: node docker/setup-docker.js');
    console.error('');
    process.exit(1);
  }
  
  // Validate required configuration
  const required = [
    'SAP_AI_CORE_URL',
    'AUTH_URL',
    'CLIENT_ID',
    'CLIENT_SECRET',
    'SAP_AI_RESOURCE_GROUP'
  ];
  
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    console.error(`❌ Error: Missing required configuration keys: ${missing.join(', ')}`);
    console.error(`   Configuration file: ${configSource}`);
    console.error('');
    process.exit(1);
  }
  
  return { config, configSource };
}

// ============================================================================
// HTTP Request Utilities
// ============================================================================

/**
 * Make an HTTPS request and return a promise
 */
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        
        // Handle non-2xx status codes
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
          error.statusCode = res.statusCode;
          error.body = body;
          error.isAuthError = res.statusCode === 401 || res.statusCode === 403;
          reject(error);
          return;
        }
        
        try {
          const data = JSON.parse(body);
          resolve({ statusCode: res.statusCode, headers: res.headers, data });
        } catch (error) {
          reject(new Error(`Failed to parse JSON response: ${error.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

// ============================================================================
// SAP AI Core API Functions
// ============================================================================

/**
 * Get OAuth2 access token from SAP AI Core (fetches new token)
 */
async function fetchNewAccessToken(config) {
  const authUrl = new URL(config.AUTH_URL);
  
  const options = {
    method: 'POST',
    hostname: authUrl.hostname,
    port: authUrl.port || 443,
    path: authUrl.pathname,
    headers: {
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json',
      'content-type': 'application/x-www-form-urlencoded'
    }
  };
  
  const postData = querystring.stringify({
    grant_type: 'client_credentials',
    client_id: config.CLIENT_ID,
    client_secret: config.CLIENT_SECRET
  });
  
  try {
    const response = await httpsRequest(options, postData);
    const accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600; // Default to 1 hour if not provided
    
    // Cache the token
    cacheToken(accessToken, expiresIn);
    
    return accessToken;
  } catch (error) {
    console.error('❌ Error: Failed to obtain access token');
    console.error(`   ${error.message}`);
    if (error.body) {
      try {
        const errorData = JSON.parse(error.body);
        console.error(`   ${errorData.error_description || errorData.error || ''}`);
      } catch (e) {
        // Ignore parse errors
      }
    }
    process.exit(1);
  }
}

/**
 * Get OAuth2 access token from SAP AI Core (with caching)
 */
async function getAccessToken(config, forceRefresh = false) {
  // Check cache first unless force refresh
  if (!forceRefresh) {
    const cachedToken = getCachedToken();
    if (cachedToken) {
      console.log('🔑 Using cached access token\n');
      return cachedToken;
    }
  }
  
  // Fetch new token
  console.log('🔑 Fetching new access token...\n');
  return await fetchNewAccessToken(config);
}

/**
 * Get list of available foundation models
 */
async function getModelList(config, accessToken) {
  const apiUrl = new URL(config.SAP_AI_CORE_URL);
  
  const options = {
    method: 'GET',
    hostname: apiUrl.hostname,
    port: apiUrl.port || 443,
    path: '/v2/lm/scenarios/foundation-models/models',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json'
    }
  };
  
  const response = await httpsRequest(options);
  return response.data;
}

/**
 * Get list of configurations
 */
async function getConfigurations(config, accessToken) {
  const apiUrl = new URL(config.SAP_AI_CORE_URL);
  
  const options = {
    method: 'GET',
    hostname: apiUrl.hostname,
    port: apiUrl.port || 443,
    path: '/v2/lm/configurations',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json'
    }
  };
  
  const response = await httpsRequest(options);
  return response.data;
}

/**
 * Create a new configuration
 */
async function createConfiguration(config, accessToken, modelName, executableId) {
  const apiUrl = new URL(config.SAP_AI_CORE_URL);
  
  const configName = `${modelName}_autogenerated`;
  
  const bodyData = {
    name: configName,
    executableId: executableId,
    scenarioId: 'foundation-models',
    versionId: '0.0.1',
    parameterBindings: [
      { key: 'modelName', value: modelName }
    ]
  };
  
  const body = JSON.stringify(bodyData);
  
  const options = {
    method: 'POST',
    hostname: apiUrl.hostname,
    port: apiUrl.port || 443,
    path: '/v2/lm/configurations',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  };
  
  const response = await httpsRequest(options, body);
  return response.data;
}

/**
 * Get list of deployments
 */
async function getDeployments(config, accessToken) {
  const apiUrl = new URL(config.SAP_AI_CORE_URL);
  
  const options = {
    method: 'GET',
    hostname: apiUrl.hostname,
    port: apiUrl.port || 443,
    path: '/v2/lm/deployments',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json'
    }
  };
  
  const response = await httpsRequest(options);
  return response.data;
}

/**
 * Create a new deployment
 */
async function createDeployment(config, accessToken, configurationId) {
  const apiUrl = new URL(config.SAP_AI_CORE_URL);
  
  const body = JSON.stringify({ configurationId });
  
  const options = {
    method: 'POST',
    hostname: apiUrl.hostname,
    port: apiUrl.port || 443,
    path: '/v2/lm/deployments',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  };
  
  const response = await httpsRequest(options, body);
  return response.data;
}

/**
 * Get a specific deployment by ID
 */
async function getDeployment(config, accessToken, deploymentId) {
  const apiUrl = new URL(config.SAP_AI_CORE_URL);
  
  const options = {
    method: 'GET',
    hostname: apiUrl.hostname,
    port: apiUrl.port || 443,
    path: `/v2/lm/deployments/${deploymentId}`,
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'ai-resource-group': config.SAP_AI_RESOURCE_GROUP,
      'accept': 'application/json'
    }
  };
  
  const response = await httpsRequest(options);
  return response.data;
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Handle --models command
 */
async function handleModels(config, accessToken, includeRetired = false) {
  console.log(`\n🌐 SAP AI Core Instance: ${config.SAP_AI_REGION || 'N/A'} | Resource Group: ${config.SAP_AI_RESOURCE_GROUP || 'default'}\n`);
  console.log('📋 Fetching available foundation models...\n');
  
  let modelList;
  try {
    modelList = await getModelList(config, accessToken);
  } catch (error) {
    if (error.isAuthError) {
      // Token might be expired, retry with fresh token
      console.log('⚠️  Token may be expired, fetching new token...\n');
      clearCachedToken();
      accessToken = await getAccessToken(config, true);
      modelList = await getModelList(config, accessToken);
    } else {
      throw error;
    }
  }
  
  if (!modelList.resources || modelList.resources.length === 0) {
    console.log('No models available.');
    return;
  }
  
  // Fetch deployments to check which models are deployed
  console.log('📋 Fetching deployments...\n');
  const deployments = await getDeployments(config, accessToken);
  
  // Create a map of deployed models
  const deployedModels = new Map();
  if (deployments.resources) {
    for (const deployment of deployments.resources) {
      const modelName = deployment.details?.resources?.backendDetails?.model?.name;
      if (modelName) {
        const status = deployment.status || 'UNKNOWN';
        // Store the deployment info (if multiple deployments, keep track)
        if (!deployedModels.has(modelName)) {
          deployedModels.set(modelName, []);
        }
        deployedModels.get(modelName).push({
          id: deployment.id,
          status: status
        });
      }
    }
  }
  
  // Filter and process models
  const processedModels = [];
  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  
  for (const resource of modelList.resources) {
    const provider = resource.provider || 'N/A';
    const model = resource.model || 'N/A';
    const executableId = resource.executableId || 'N/A';
    
    // Check retirement status from the latest version
    let retirementStatus = 'Available';
    let isRetired = false;
    
    if (resource.versions && resource.versions.length > 0) {
      // Find the latest version
      const latestVersion = resource.versions.find(v => v.isLatest) || resource.versions[0];
      const retirementDate = latestVersion.retirementDate;
      
      if (retirementDate && retirementDate.trim()) {
        try {
          // Parse date in UTC to avoid timezone conversion
          const retireDate = new Date(retirementDate);
          const retireDateUTC = Date.UTC(retireDate.getUTCFullYear(), retireDate.getUTCMonth(), retireDate.getUTCDate());
          
          // Format date as "Mon DD, YYYY"
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const formattedDate = `${months[retireDate.getUTCMonth()]} ${retireDate.getUTCDate()}, ${retireDate.getUTCFullYear()}`;
          
          if (retireDateUTC > todayUTC) {
            retirementStatus = `Planned (${formattedDate})`;
          } else {
            retirementStatus = `Retired (${formattedDate})`;
            isRetired = true;
          }
        } catch (error) {
          // Invalid date format, show as available
          retirementStatus = 'Available';
        }
      }
    }
    
    // Skip retired models unless includeRetired is true
    if (isRetired && !includeRetired) {
      continue;
    }
    
    // Check if model has deployments
    let deploymentStatus = 'No';
    if (deployedModels.has(model)) {
      const deploys = deployedModels.get(model);
      const runningCount = deploys.filter(d => d.status === 'RUNNING').length;
      const totalCount = deploys.length;
      
      if (runningCount > 0) {
        deploymentStatus = totalCount > 1 ? `Yes (${runningCount}/${totalCount} running)` : 'Yes (RUNNING)';
      } else {
        const statuses = deploys.map(d => d.status).join(', ');
        deploymentStatus = `Yes (${statuses})`;
      }
    }
    
    processedModels.push({ provider, model, executableId, deploymentStatus, retirementStatus });
  }
  
  if (processedModels.length === 0) {
    console.log('No models available (all models are retired).');
    if (!includeRetired) {
      console.log('Use --include-retired to see retired models.');
    }
    return;
  }
  
  console.log(`Found ${processedModels.length} models${includeRetired ? ' (including retired)' : ''}:\n`);
  console.log('PROVIDER          MODEL                              EXECUTABLE ID      DEPLOYED            RETIRED');
  console.log('─'.repeat(115));
  
  for (const { provider, model, executableId, deploymentStatus, retirementStatus } of processedModels) {
    console.log(
      `${provider.padEnd(17)} ${model.padEnd(34)} ${executableId.padEnd(18)} ${deploymentStatus.padEnd(19)} ${retirementStatus}`
    );
  }
}

/**
 * Handle --status <model> command
 */
async function handleStatus(config, accessToken, modelName) {
  if (!modelName) {
    console.error('❌ Error: --status requires a model name');
    console.error('   Usage: node sail-model-deploy.js --status <model>');
    process.exit(1);
  }
  
  console.log(`\n🌐 SAP AI Core Instance: ${config.SAP_AI_REGION || 'N/A'} | Resource Group: ${config.SAP_AI_RESOURCE_GROUP || 'default'}\n`);
  console.log(`📊 Fetching deployment status for model: ${modelName}\n`);
  
  let deployments;
  try {
    deployments = await getDeployments(config, accessToken);
  } catch (error) {
    if (error.isAuthError) {
      // Token might be expired, retry with fresh token
      console.log('⚠️  Token may be expired, fetching new token...\n');
      clearCachedToken();
      accessToken = await getAccessToken(config, true);
      deployments = await getDeployments(config, accessToken);
    } else {
      throw error;
    }
  }
  
  if (!deployments.resources || deployments.resources.length === 0) {
    console.log('No deployments found.');
    return;
  }
  
  // Filter deployments by model name
  const matchingDeployments = deployments.resources.filter(deployment => {
    const backendModel = deployment.details?.resources?.backendDetails?.model?.name;
    return backendModel === modelName;
  });
  
  if (matchingDeployments.length === 0) {
    console.log(`No deployments found for model: ${modelName}`);
    return;
  }
  
  console.log(`Found ${matchingDeployments.length} deployment(s):\n`);
  
  for (const deployment of matchingDeployments) {
    const model = deployment.details?.resources?.backendDetails?.model || {};
    const modelName = model.name || 'N/A';
    const version = model.version || 'N/A';
    const status = deployment.status || 'N/A';
    const configName = deployment.configurationName || 'N/A';
    const id = deployment.id || 'N/A';
    const url = deployment.deploymentUrl || 'N/A';
    
    console.log(`Deployment ID:    ${id}`);
    console.log(`Model:            ${modelName}`);
    console.log(`Version:          ${version}`);
    console.log(`Status:           ${status}`);
    console.log(`Configuration:    ${configName}`);
    console.log(`URL:              ${url}`);
    console.log('');
  }
}

/**
 * Handle --create <model> command
 */
async function handleCreate(config, accessToken, modelName) {
  if (!modelName) {
    console.error('❌ Error: --create requires a model name');
    console.error('   Usage: node sail-model-deploy.js --create <model>');
    process.exit(1);
  }
  
  console.log(`\n🌐 SAP AI Core Instance: ${config.SAP_AI_REGION || 'N/A'} | Resource Group: ${config.SAP_AI_RESOURCE_GROUP || 'default'}\n`);
  console.log(`🚀 Creating deployment for model: ${modelName}\n`);
  
  // Step 1: Check if model exists
  console.log('Step 1: Validating model...');
  let modelList;
  try {
    modelList = await getModelList(config, accessToken);
  } catch (error) {
    if (error.isAuthError) {
      // Token might be expired, retry with fresh token
      console.log('⚠️  Token may be expired, fetching new token...\n');
      clearCachedToken();
      accessToken = await getAccessToken(config, true);
      modelList = await getModelList(config, accessToken);
    } else {
      throw error;
    }
  }
  const modelInfo = modelList.resources.find(r => r.model === modelName);
  
  if (!modelInfo) {
    console.error(`❌ Error: Model '${modelName}' not found`);
    console.error('   Run with --models to see available models');
    process.exit(1);
  }
  
  console.log(`✓ Model found: ${modelInfo.displayName}`);
  console.log(`  Provider: ${modelInfo.provider}`);
  console.log(`  Executable ID: ${modelInfo.executableId}\n`);
  
  // Step 2: Check if deployment already exists with version "latest"
  console.log('Step 2: Checking existing deployments...');
  const deployments = await getDeployments(config, accessToken);
  
  const existingDeployment = deployments.resources?.find(d => {
    const backendModel = d.details?.resources?.backendDetails?.model;
    return backendModel?.name === modelName && 
           (backendModel?.version === 'latest' || d.status === 'RUNNING');
  });
  
  if (existingDeployment) {
    console.error(`❌ Error: Deployment already exists for model '${modelName}'`);
    console.error(`   Deployment ID: ${existingDeployment.id}`);
    console.error(`   Status: ${existingDeployment.status}`);
    console.error(`   Version: ${existingDeployment.details?.resources?.backendDetails?.model?.version || 'N/A'}`);
    process.exit(1);
  }
  
  console.log(`✓ No existing deployment found\n`);
  
  // Confirm with user before proceeding
  console.log('⚠️  You are about to create a new deployment.');
  console.log(`   Model: ${modelInfo.displayName}`);
  console.log(`   Provider: ${modelInfo.provider}`);
  console.log(`   Region: ${config.SAP_AI_REGION || 'N/A'}`);
  console.log(`   Resource Group: ${config.SAP_AI_RESOURCE_GROUP || 'default'}`);
  console.log('');
  
  // Read user input from stdin
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const confirmed = await new Promise((resolve) => {
    rl.question('   Do you want to continue? (yes/no): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim() === 'yes' || answer.toLowerCase().trim() === 'y');
    });
  });
  
  if (!confirmed) {
    console.log('\n❌ Deployment creation cancelled by user.');
    process.exit(0);
  }
  
  console.log('');
  
  // Step 3: Check if configuration exists
  console.log('Step 3: Checking configurations...');
  const configurations = await getConfigurations(config, accessToken);
  
  let configurationId;
  const existingConfig = configurations.resources?.find(c => {
    const modelParam = c.parameterBindings?.find(p => p.key === 'modelName');
    return modelParam?.value === modelName;
  });
  
  if (existingConfig) {
    console.log(`✓ Using existing configuration: ${existingConfig.name}`);
    console.log(`  Configuration ID: ${existingConfig.id}\n`);
    configurationId = existingConfig.id;
  } else {
    console.log('✓ No existing configuration found, creating new one...');
    const newConfig = await createConfiguration(
      config,
      accessToken,
      modelName,
      modelInfo.executableId
    );
    console.log(`✓ Configuration created: ${newConfig.name || `${modelName}_autogenerated`}`);
    console.log(`  Configuration ID: ${newConfig.id}\n`);
    configurationId = newConfig.id;
  }
  
  // Step 4: Create deployment
  console.log('Step 4: Creating deployment...');
  const deployment = await createDeployment(config, accessToken, configurationId);
  
  console.log(`✓ Deployment created successfully!`);
  console.log(`  Deployment ID: ${deployment.id}`);
  console.log(`  Status: ${deployment.status || 'UNKNOWN'}\n`);
  
  // Step 5: Poll deployment status
  console.log('Step 5: Waiting for deployment to be RUNNING...');
  const startTime = Date.now();
  const timeout = 300000; // 300 seconds (5 minutes)
  const pollInterval = 5000; // 5 seconds
  
  let currentStatus = deployment.status;
  let attempts = 0;
  
  while (Date.now() - startTime < timeout) {
    attempts++;
    
    // Wait before polling (except first iteration)
    if (attempts > 1) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    try {
      const currentDeployment = await getDeployment(config, accessToken, deployment.id);
      currentStatus = currentDeployment.status;
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}s] Status: ${currentStatus}`);
      
      if (currentStatus === 'RUNNING') {
        console.log('\n✅ Deployment is now RUNNING!');
        console.log(`   Deployment URL: ${currentDeployment.deploymentUrl || 'N/A'}`);
        return;
      }
      
      if (currentStatus === 'DEAD' || currentStatus === 'STOPPED') {
        console.error(`\n❌ Deployment failed with status: ${currentStatus}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`  ⚠️  Failed to poll status: ${error.message}`);
    }
  }
  
  console.log(`\n⏱️  Timeout reached after 300 seconds`);
  console.log(`   Last known status: ${currentStatus}`);
  console.log(`   Deployment ID: ${deployment.id}`);
  console.log(`   Use --status ${modelName} to check current status`);
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
SAP AI Core Foundation Model Deployment Manager

Usage:
  node sail-model-deploy.js --models
  node sail-model-deploy.js --status <model>
  node sail-model-deploy.js --create <model>
  node sail-model-deploy.js --clear-cache
  node sail-model-deploy.js --help

Commands:
  --models              List all available foundation models with their providers
                        and executable IDs (excludes retired models by default)
                        
  --models --include-retired
                        List all models including retired ones

  --status <model>      Show deployment status for a specific model
                        Displays model name, version, status, and configuration

  --create <model>      Create a new deployment for the specified model
                        - Checks if deployment already exists (errors if found)
                        - Uses existing configuration or creates a new one
                        - Creates deployment and polls until RUNNING (max 300s)

  --clear-cache         Clear the cached access token and force fresh authentication
                        on the next command execution

  --help                Show this help message

Configuration:
  This tool reads SAP AI Core credentials from:
    - services/gateway/.env (project root)
    - Linux/macOS: ~/.sail-proxy/.env
    - Windows: %APPDATA%/sail-proxy/.env

  Required environment variables:
    SAP_AI_CORE_URL          Base URL for SAP AI Core API
    AUTH_URL                 OAuth token endpoint URL
    CLIENT_ID                OAuth client ID
    CLIENT_SECRET            OAuth client secret
    SAP_AI_RESOURCE_GROUP    Resource group (usually 'default')

Setup:
  If no configuration file exists, run one of:
    1. npm install -g @st-gr/sail-proxy && sail-proxy configure
    2. node docker/setup-docker.js

Examples:
  # List all available models (excluding retired)
  node sail-model-deploy.js --models
  
  # List all models including retired ones
  node sail-model-deploy.js --models --include-retired

  # Check deployment status for GPT-5
  node sail-model-deploy.js --status gpt-5

  # Create a new deployment for Claude 3 Haiku
  node sail-model-deploy.js --create anthropic--claude-3-haiku
  
  # Clear cached access token
  node sail-model-deploy.js --clear-cache
`);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  // Handle help command (no auth needed)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }
  
  // Handle --clear-cache command
  if (args[0] === '--clear-cache') {
    clearCachedToken();
    console.log('✅ Cached access token cleared successfully.');
    const cachePath = getTokenCachePath();
    console.log(`   Cache file: ${cachePath}`);
    return;
  }
  
  // Load configuration
  const { config, configSource } = loadConfig();
  
  // Get access token (required for all operations except --help)
  let accessToken;
  try {
    accessToken = await getAccessToken(config);
  } catch (error) {
    console.error('❌ Error: Failed to authenticate with SAP AI Core');
    process.exit(1);
  }
  
  // Parse command
  const command = args[0];
  const parameter = args[1];
  
  try {
    switch (command) {
      case '--models':
        // Check for --include-retired flag
        const includeRetired = args.includes('--include-retired');
        await handleModels(config, accessToken, includeRetired);
        break;
        
      case '--status':
        await handleStatus(config, accessToken, parameter);
        break;
        
      case '--create':
        await handleCreate(config, accessToken, parameter);
        break;
        
      default:
        console.error(`❌ Error: Unknown command '${command}'`);
        console.error('   Run with --help to see available commands');
        process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.body) {
      console.error(`   Response: ${error.body}`);
    }
    process.exit(1);
  }
}

// Run main function
main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
