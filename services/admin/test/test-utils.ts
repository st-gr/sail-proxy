import { join } from 'path';

export async function setupTestEnvironment() {
  const cds = require('@sap/cds');
  
  // Configure CDS for testing
  cds.env.requires.db = {
    kind: 'sqlite',
    credentials: { url: ':memory:' }
  };
  
  // Disable authentication for tests
  cds.env.requires.auth = { kind: 'mocked' };
  
  // Set test-specific configurations
  cds.env.log.levels = { cds: 'ERROR' }; // Reduce log noise
  
  // Connect to in-memory database
  const db = await cds.connect.to('db');
  
  // Deploy schema to test database
  await cds.deploy(join(__dirname, '../src/db/schema')).to(db);
  
  return { db, cds };
}

export async function teardownTestEnvironment() {
  const cds = require('@sap/cds');
  // Disconnect from database
  await cds.disconnect();
}

export async function clearTestData() {
  const cds = require('@sap/cds');
  const db = cds.db;
  if (db) {
    // Clear all tables in reverse order to handle foreign key constraints
    const tables = [
      'sap_llm_gateway_admin_ConfigurationChanges',
      'sap_llm_gateway_admin_ConfigHooks',
      'sap_llm_gateway_admin_ConfigPluginRules',
      'sap_llm_gateway_admin_ConfigPlugins',
      'sap_llm_gateway_admin_ConfigLogLevels',
      'sap_llm_gateway_admin_ConfigLogging',
      'sap_llm_gateway_admin_ConfigProviderTimeouts',
      'sap_llm_gateway_admin_ConfigTimeouts',
      'sap_llm_gateway_admin_ConfigModelSubpaths',
      'sap_llm_gateway_admin_ConfigModelSubstitutions',
      'sap_llm_gateway_admin_ConfigModels',
      'sap_llm_gateway_admin_ConfigProviders',
      'sap_llm_gateway_admin_ApiConfiguration',
      'sap_llm_gateway_admin_AwsCredentialRotations',
      'sap_llm_gateway_admin_AwsCredentialSecurityEvents',
      'sap_llm_gateway_admin_AwsCredentialUsage',
      'sap_llm_gateway_admin_AwsCredentialPermissions',
      'sap_llm_gateway_admin_AwsCredentialIPRestrictions',
      'sap_llm_gateway_admin_AwsCredentials',
      'sap_llm_gateway_admin_ApiKeyUsage',
      'sap_llm_gateway_admin_ApiKeyBlacklist',
      'sap_llm_gateway_admin_ApiKeyPermissions',
      'sap_llm_gateway_admin_RateLimitWindows',
      'sap_llm_gateway_admin_RateLimits',
      'sap_llm_gateway_admin_ApiKeys'
    ];
    
    for (const table of tables) {
      try {
        await db.run(`DELETE FROM ${table}`);
      } catch (error) {
        // Table might not exist, ignore
      }
    }
  }
}