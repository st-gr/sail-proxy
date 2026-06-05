using { cuid, managed, temporal } from '@sap/cds/common';

namespace sap.llm.gateway.admin;

/**
 * API Configuration management
 * Stores the complete API configuration including provider settings, model substitutions, and plugin rules
 */
entity ApiConfiguration : cuid, managed {
  // Configuration identity
  name            : String(100) not null;
  version         : String(20) default '1.0.0';
  description     : String(500);
  environment     : String(20) default 'development'; // development, staging, production
  
  // Configuration data (JSON)
  configData      : LargeString;              // Complete JSON configuration
  
  // Status and lifecycle
  isActive        : Boolean default false;
  isDefault       : Boolean default false;
  
  // Validation
  isValid         : Boolean default false;
  validationErrors : String(2000);
  lastValidated   : Timestamp;
  
  // Configuration components
  providers       : Composition of many ConfigProviders on providers.configuration = $self;
  models          : Composition of many ConfigModels on models.configuration = $self;
  timeouts        : Composition of one ConfigTimeouts on timeouts.configuration = $self;
  logging         : Composition of one ConfigLogging on logging.configuration = $self;
  plugins         : Composition of many ConfigPlugins on plugins.configuration = $self;
  hooks           : Composition of many ConfigHooks on hooks.configuration = $self;
  
  // Change tracking
  changeHistory   : Composition of many ConfigurationChanges on changeHistory.configuration = $self;
}

/**
 * Provider configurations (OpenAI, Anthropic, AWS Bedrock, etc.)
 */
entity ConfigProviders : cuid, managed {
  configuration     : Association to ApiConfiguration;
  providerName      : String(50) not null;     // openai, anthropic, aws-bedrock, openrouter
  isEnabled         : Boolean default true;
  
  // Provider-specific settings
  baseUrl           : String(200);
  apiVersion        : String(20);
  timeout           : Integer default 60000;
  retries           : Integer default 3;
  
  // Authentication (reference to credentials, not storing actual keys)
  authType          : String(20);              // api_key, oauth, sigv4, none
  authConfigId      : String(100);             // Reference to credential store
  
  // Rate limiting
  rateLimitRpm      : Integer;                 // Requests per minute
  rateLimitRps      : Integer;                 // Requests per second
  
  // Headers and customization
  defaultHeaders    : LargeString;             // JSON object of default headers
  customSettings    : LargeString;             // Provider-specific JSON settings
  
  // Model substitutions for this provider
  modelSubstitutions : Composition of many ConfigModelSubstitutions on modelSubstitutions.provider = $self;
}

/**
 * Model configurations and metadata
 */
entity ConfigModels : cuid, managed {
  configuration     : Association to ApiConfiguration;
  modelId           : String(200) not null;
  displayName       : String(200);
  description       : String(1000);
  
  // Model categorization
  provider          : String(50);
  category          : String(50);              // chat, completion, embedding, image, etc.
  isDeprecated      : Boolean default false;
  isEnabled         : Boolean default true;
  
  // Model capabilities
  supportsStreaming : Boolean default true;
  maxTokens         : Integer;
  contextWindow     : Integer;
  
  // Model-specific settings
  defaultParameters : LargeString;             // JSON object of default parameters
  supportedParameters : LargeString;           // JSON array of supported parameters
  
  // Cost and billing
  inputCostPer1K    : Decimal(10,6);          // Cost per 1K input tokens
  outputCostPer1K   : Decimal(10,6);          // Cost per 1K output tokens
  currency          : String(3) default 'USD';
  
  // Subpath configurations
  subpaths          : Composition of many ConfigModelSubpaths on subpaths.model = $self;
}

/**
 * Model substitution rules
 */
entity ConfigModelSubstitutions : cuid, managed {
  provider          : Association to ConfigProviders;
  fromModel         : String(200);
  toModel           : String(200);
  reason            : String(200);
  isActive          : Boolean default true;
  priority          : Integer default 100;
  
  // Conditions for substitution
  conditions        : LargeString;             // JSON conditions
}

/**
 * Model subpath configurations (native vs emulated)
 */
entity ConfigModelSubpaths : cuid, managed {
  model             : Association to ConfigModels;
  subpath           : String(200);
  type              : String(20);              // native, emulated
  isEnabled         : Boolean default true;
  
  // Subpath-specific settings
  settings          : LargeString;             // JSON configuration
}

/**
 * Timeout configurations
 */
entity ConfigTimeouts : cuid, managed {
  configuration     : Association to ApiConfiguration;
  defaultTimeout    : Integer default 60000;  // Default timeout in milliseconds
  streamingTimeout  : Integer default 300000; // Streaming timeout in milliseconds
  
  // Per-provider timeouts
  providerTimeouts  : Composition of many ConfigProviderTimeouts on providerTimeouts.timeoutConfig = $self;
}

/**
 * Provider-specific timeout overrides
 */
entity ConfigProviderTimeouts : cuid {
  timeoutConfig     : Association to ConfigTimeouts;
  provider          : String(50);
  timeout           : Integer;
  streamingTimeout  : Integer;
}

/**
 * Logging configuration
 */
entity ConfigLogging : cuid, managed {
  configuration     : Association to ApiConfiguration;
  defaultLevel      : String(10) default 'INFO';
  logFolderPath     : String(200) default './logs';
  payloadLoggingEnabled : Boolean default false;
  
  // Component-specific log levels
  componentLevels   : Composition of many ConfigLogLevels on componentLevels.loggingConfig = $self;
}

/**
 * Component-specific log levels
 */
entity ConfigLogLevels : cuid {
  loggingConfig     : Association to ConfigLogging;
  componentName     : String(100);
  logLevel          : String(10);              // DEBUG, INFO, WARN, ERROR
}

/**
 * Plugin configurations
 */
entity ConfigPlugins : cuid, managed {
  configuration     : Association to ApiConfiguration;
  pluginName        : String(100);
  isEnabled         : Boolean default true;
  priority          : Integer default 100;
  
  // Plugin settings
  settings          : LargeString;             // JSON plugin configuration
  
  // Plugin rules
  rules             : Composition of many ConfigPluginRules on rules.plugin = $self;
}

/**
 * Plugin rules and conditions
 */
entity ConfigPluginRules : cuid, managed {
  plugin            : Association to ConfigPlugins;
  ruleName          : String(100);
  description       : String(500);
  isEnabled         : Boolean default true;
  priority          : Integer default 100;
  
  // Rule definition
  conditions        : LargeString;             // JSON conditions
  actions           : LargeString;             // JSON actions
}

/**
 * Hook definitions for model behavior customization
 */
entity ConfigHooks : cuid, managed {
  configuration     : Association to ApiConfiguration;
  hookName          : String(100);
  hookType          : String(50);              // url-regex, header, json-path, size
  description       : String(500);
  isEnabled         : Boolean default true;
  
  // Hook definition
  definition        : LargeString;             // JSON hook definition
}

/**
 * Configuration change history and audit trail
 */
entity ConfigurationChanges : cuid, managed {
  configuration     : Association to ApiConfiguration;
  changeType        : String(50);              // create, update, delete, patch, reset
  changeDescription : String(1000);
  
  // Change details
  fieldChanged      : String(200);
  oldValue          : LargeString;
  newValue          : LargeString;
  
  // Change context
  changeReason      : String(500);
  approvedBy        : String(100);
  rollbackId        : String(100);             // For linking rollback changes
  
  // Validation
  validationPassed  : Boolean;
  validationErrors  : String(2000);
}

/**
 * Configuration templates for different environments
 */
entity ConfigurationTemplates : cuid, managed {
  name              : String(100) not null;
  description       : String(500);
  category          : String(50);              // development, staging, production, custom
  
  // Template data
  templateData      : LargeString;             // JSON template
  
  // Usage tracking
  usageCount        : Integer default 0;
  lastUsed          : Timestamp;
  
  // Template metadata
  tags              : String(500);             // Comma-separated tags
  isPublic          : Boolean default false;
}

// Views for common queries
view ActiveConfigurations as select from ApiConfiguration 
  where isActive = true;

view DefaultConfiguration as select from ApiConfiguration 
  where isActive = true and isDefault = true;

view ConfigurationSummary as select from ApiConfiguration {
  key ID,
  name,
  version,
  environment,
  isActive,
  isDefault,
  modifiedAt,
  modifiedBy,
  providers.providerName,
  models.modelId
} excluding { configData };

view ProviderSummary as select from ConfigProviders {
  key configuration.name as configName,
  key providerName,
  isEnabled,
  count(modelSubstitutions.ID) as substitutionCount : Integer
} group by configuration.name, providerName, isEnabled;