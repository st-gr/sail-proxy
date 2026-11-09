import { ParsedConfig } from './types';
import * as crypto from 'crypto';

/**
 * Format configuration as .env file content
 */
export function formatAsEnvFile(config: ParsedConfig): string {
  // Generate secure random keys
  const validationTokenSecret = crypto.randomBytes(32).toString('hex');
  const metadataEncryptionKey = crypto.randomBytes(32).toString('hex');
  
  return `# SAP AI Core Configuration
SAP_AI_CORE_URL=${config.SAP_AI_CORE_URL}
SAP_AI_RESOURCE_GROUP=${config.SAP_AI_RESOURCE_GROUP}
SAP_AI_REGION=${config.SAP_AI_REGION}
# Auto-discover an available deployment instead of requiring SAP_AI_DEPLOYMENT_ID.
# Set SAP_AI_DEPLOYMENT_ID and remove this line to pin a specific deployment.
SAP_AI_AUTO_DISCOVER_DEPLOYMENT=true

# SAP Authentication (OAuth2)
AUTH_URL=${config.AUTH_URL}
CLIENT_ID=${config.CLIENT_ID}
CLIENT_SECRET=${config.CLIENT_SECRET}

# Gateway Configuration
PORT=${config.PORT}
GATEWAY_STANDALONE=${config.GATEWAY_STANDALONE}

# Ollama Configuration
OLLAMA_AUTOSTART=${config.OLLAMA_AUTOSTART}

# Additional Gateway Settings
NODE_ENV=production
LOG_LEVEL=INFO
CONFIG_FILE_PATH=./api_config.json
DEBUG=false
PAYLOAD_LOGGING_ENABLED=false
SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES=true
SAP_MODEL_CACHE_DURATION_SECONDS=3600

# Security Configuration
VALIDATION_TOKEN_SECRET=${validationTokenSecret}
METADATA_ENCRYPTION_KEY=${metadataEncryptionKey}
`;
}