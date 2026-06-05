import axios, { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';
import configService from './configService';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

dotenv.config();

// Type definitions
interface TokenCache {
  token: string | null;
  expiresAt: number;
}

interface ModelsCache {
  data: { object: string; data: ModelInfo[] } | null;
  expiresAt: number;
}

interface ModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  accessType?: string;
  streamingSupported?: boolean;
  [key: string]: any;
}

// Removed unused SAPFoundationModel interface - using any[] instead

interface AuthTokenResponse {
  access_token: string;
  expires_in: number;
}

// Configuration from environment variables
const authUrl = process.env.AUTH_URL;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const aiRegion = process.env.SAP_AI_REGION || 'us-east-1';
const aiCoreUrl = configService.getSAPAICoreConfig().url || `https://api.ai.${aiRegion}.aws.ml.hana.ondemand.com`;
const aiCoreBaseUrl = `${aiCoreUrl}/v2`;
const aiResourceGroup = process.env.SAP_AI_RESOURCE_GROUP || 'default';
const includeExtendedAttributes = process.env.SAP_INCLUDE_EXTENDED_MODEL_ATTRIBUTES === 'true';

// Cache settings
const modelCacheDurationSeconds = parseInt(process.env.SAP_MODEL_CACHE_DURATION_SECONDS || '300', 10);
const streamingSupportCache = new Map<string, boolean>();

// Default timestamp (corresponds to November 11, 1975)
const defaultTimestamp = 184978800;

// Caches
let tokenCache: TokenCache = {
  token: null,
  expiresAt: 0
};

let modelsCache: ModelsCache = {
  data: null,
  expiresAt: 0
};


/**
 * Get authentication token for SAP AI Core API
 * @returns The authentication token
 */
export async function getAuthToken(): Promise<string> {
  // Check if we have a valid cached token
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60000) {
    return tokenCache.token;
  }

  try {
    // Request new token
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId!);
    params.append('client_secret', clientSecret!);

    const response: AxiosResponse<AuthTokenResponse> = await axios.post(authUrl!, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // Cache the token with expiration time
    const { access_token, expires_in } = response.data;
    tokenCache.token = access_token;
    tokenCache.expiresAt = now + (expires_in * 1000);

    return access_token;
  } catch (error: any) {
    logger.error('ModelService', `Error obtaining SAP AI Core auth token: ${error.message}`);
    
    // Create structured error
    const enhancedError = new Error('Failed to authenticate with SAP AI Core') as any;
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = {
      message: error.message,
      response: error.response?.data || {}
    };
    enhancedError.originalError = error;
    
    throw enhancedError;
  }
}

/**
 * Fetch deployments from SAP AI Core
 * @param token - Authentication token
 * @returns Filtered list of deployment resources
 */
async function _fetchDeployments(token: string): Promise<any[]> {
  try {
    const url = `${aiCoreBaseUrl}/lm/deployments`;
    logger.debug('ModelService', 'Fetching deployments from SAP AI Core');
    const response: AxiosResponse = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'AI-Resource-Group': aiResourceGroup,
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.resources) {
      const filtered = response.data.resources.filter((dep: any) =>
        dep.scenarioId === "foundation-models" && dep.status === "RUNNING"
      );
      logger.info('ModelService', `Fetched ${response.data.resources.length} deployments, ${filtered.length} remaining after filtering for foundation-models and RUNNING status.`);
      return filtered;
    }
    return [];
  } catch (error: any) {
    logger.error('ModelService', `Error fetching deployments from SAP AI Core: ${error.message}`);
    if (error.response) {
      logger.error('ModelService', `Deployment fetch error - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    // Don't let this error stop the getModels function, return empty array
    return [];
  }
}

/**
 * Mark a model as not supporting streaming in our streaming support cache
 * @param modelId - Model ID to mark as not supporting streaming
 */
export function markModelAsNonStreaming(modelId: string): void {
  if (!modelId) return;
  logger.warn('ModelService', `⚠️ Marking model ${modelId} as not supporting streaming based on API error`);
  streamingSupportCache.set(modelId, false);
  logger.debug('ModelService', `Runtime cache updated: streamingSupportCache.get(${modelId}) = ${streamingSupportCache.get(modelId)}`);

  if (modelsCache.data && modelsCache.data.data) {
    const modelInCache = modelsCache.data.data.find(m => m.id === modelId);
    if (modelInCache) {
      if (modelInCache.streamingSupported !== false) {
        modelInCache.streamingSupported = false; // Directly update the flag
        logger.info('ModelService', `✅ Updated in-memory model cache for ${modelId} - model will no longer use streaming`);
      } else {
        logger.debug('ModelService', `Model ${modelId} was already marked as non-streaming in cache`);
      }
      // Consistently update versions array if it exists
      if ((modelInCache as any).versions && Array.isArray((modelInCache as any).versions)) {
        (modelInCache as any).versions.forEach((version: any) => {
          if (version.streamingSupported === true) {
            version.streamingSupported = false;
          }
        });
      }
    } else {
      logger.warn('ModelService', `⚠️ Model ${modelId} not found in modelsCache.data by ID during markModelAsNonStreaming`);
    }
  }
}

/**
 * Check if a model supports streaming
 * @param modelId - The model ID to check
 * @returns Whether the model supports streaming
 */
export function modelSupportsStreaming(modelId: string): boolean {
  if (!modelId) return false;
  
  logger.debug('ModelService', `Checking streaming support for model: ${modelId}`);
  
  if (streamingSupportCache.has(modelId)) {
    const supportsStreaming = streamingSupportCache.get(modelId)!;
    logger.debug('ModelService', `Using cached streaming status for ${modelId}: ${supportsStreaming}`);
    return supportsStreaming;
  }

  // If not in runtime cache, check the main modelsCache (populated by getModels)
  const modelsData = modelsCache.data?.data;
  if (modelsData) {
    const model = modelsData.find(m => m.id === modelId);
    if (model && model.hasOwnProperty('streamingSupported')) {
      logger.debug('ModelService', `Found model ${modelId} in main modelsCache. Streaming: ${model.streamingSupported}`);
      streamingSupportCache.set(modelId, model.streamingSupported || false); // Populate runtime cache
      return model.streamingSupported || false;
    }
  }
  
  logger.warn('ModelService', `No definitive streaming information for ${modelId} in any cache, defaulting to false. Ensure getModels() has run and processed this model.`);
  streamingSupportCache.set(modelId, false); // Cache this default
  return false;
}

/**
 * Get all available models
 * @param forceRefresh - Whether to bypass cache
 * @returns List of models in OpenAI format
 */
export async function getModels(forceRefresh: boolean = false): Promise<{ object: string; data: ModelInfo[] }> {
  try {
    const now = Date.now();
    const cacheValid = !forceRefresh && modelsCache.data && modelsCache.expiresAt > now;

    if (cacheValid) {
      logger.debug('ModelService', 'Using cached models response');
      return modelsCache.data!;
    }

    const token = await getAuthToken();
    const foundationModelsUrl = `${aiCoreBaseUrl}/lm/scenarios/foundation-models/models`;

    logger.debug('ModelService', 'Fetching foundation models from SAP AI Core');
    const foundationModelsResponse: AxiosResponse = await axios.get(foundationModelsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'AI-Resource-Group': aiResourceGroup
      }
    });

    const rawFoundationModels: any[] = foundationModelsResponse.data.resources || [];

    // Process Perplexity models to add orchestration scenario if missing
    rawFoundationModels.forEach(fm => {
      if (fm.executableId === 'perplexity-ai') {
        const hasOrchestration = fm.allowedScenarios?.some(
          (scenario: any) => scenario.scenarioId === 'orchestration'
        );

        if (!hasOrchestration) {
          logger.debug('ModelService',
            `Adding orchestration scenario for Perplexity model: ${fm.model}`);

          if (!fm.allowedScenarios) {
            fm.allowedScenarios = [];
          }

          fm.allowedScenarios.push({
            executableId: 'orchestration',
            scenarioId: 'orchestration'
          });
        }
      }
    });

    const processedModels: any[] = [];

    // Process and filter foundation models
    rawFoundationModels.forEach(fm => {
      const supportsOrchestration = fm.allowedScenarios &&
        fm.allowedScenarios.some((scenario: any) => scenario.scenarioId === "orchestration");

      if (!supportsOrchestration) {
        return; // Skip if not supporting orchestration
      }


      const isTopLevelDeprecated = fm.deprecated === true;
      const areAllVersionsDeprecated = fm.versions &&
        fm.versions.length > 0 &&
        fm.versions.every((version: any) => version.deprecated === true);

      if (isTopLevelDeprecated || areAllVersionsDeprecated) {
        return; // Skip if deprecated
      }

      // Ensure initial streamingSupported is set, e.g.:
      const initialStreamingSupport = fm.versions ? fm.versions.some((v: any) => v.streamingSupported === true) : false;
      processedModels.push({
        // Keep original SAP AI Core fields needed for later processing or extended attributes
        ...fm, // Spread original fields
        // Define standardized fields for internal consistency before OpenAI transformation
        internal_id: fm.model, // This will be the base for the OpenAI 'id'
        internal_provider: fm.provider,
        internal_createdAt: fm.createdAt,
        accessType: "foundation",
        streamingSupported: initialStreamingSupport,
        subpaths_native: [], // Initialize if not present
        subpaths_emulated: [],  // Initialize if not present
      });
    });
    logger.info('ModelService', `Initial foundation models: ${rawFoundationModels.length}. After filtering for orchestration & deprecation: ${processedModels.length} models remaining.`);

    // Now fetch and process deployed models
    const deployments = await _fetchDeployments(token);
    const deploymentDerivedModels: any[] = [];

    deployments.forEach(dep => {
      const modelNameFromDeployment = dep.details?.resources?.backendDetails?.model?.name;
      const deployedVersionIdentifier = dep.details?.resources?.backendDetails?.model?.version;

      if (!modelNameFromDeployment) {
        logger.warn('ModelService', `Skipping deployment ${dep.id} due to missing model name in details.`);
        return;
      }

      const deployedModelId = `${modelNameFromDeployment}--deployed`;
      const baseModel = rawFoundationModels.find(fm => fm.model === modelNameFromDeployment);

      // Clean up details object by removing redundant snake_case keys
      const cleanedDetails = JSON.parse(JSON.stringify(dep.details));
      if (cleanedDetails?.resources?.backend_details) {
        delete cleanedDetails.resources.backend_details;
      }
      if (cleanedDetails?.scaling?.backend_details) {
        delete cleanedDetails.scaling.backend_details;
      }

      let newModelEntry: any;
      if (baseModel) {
        let activeVersion = null;
        if (baseModel.versions && baseModel.versions.length > 0 && deployedVersionIdentifier) {
          if (deployedVersionIdentifier.toLowerCase() === "latest") {
            activeVersion = baseModel.versions.find((v: any) => v.isLatest === true);
          } else {
            activeVersion = baseModel.versions.find((v: any) => v.name === deployedVersionIdentifier);
          }
        }

        let finalActiveVersionForDeployment = null;
        if (activeVersion) {
          finalActiveVersionForDeployment = { ...activeVersion, streamingSupported: false };
        } else if (baseModel.versions && baseModel.versions.length === 1) {
          finalActiveVersionForDeployment = { ...baseModel.versions[0], streamingSupported: false };
        }

        newModelEntry = {
          ...baseModel,
          internal_id: deployedModelId,
          internal_provider: baseModel.provider || 'unknown',
          internal_createdAt: baseModel.createdAt,
          accessType: "deployment",
          streamingSupported: false,
          details: cleanedDetails,
          scenarioId: dep.scenarioId,
          configurationId: dep.configurationId,
          configurationName: dep.configurationName,
          deploymentUrl: dep.deploymentUrl,
          model: modelNameFromDeployment,
          provider: baseModel.provider || 'unknown',
          versions: finalActiveVersionForDeployment ? [finalActiveVersionForDeployment] : []
        };
        delete newModelEntry.allowedScenarios;

        if (finalActiveVersionForDeployment) {
          logger.debug('ModelService', `Deployment ${deployedModelId} using version: ${finalActiveVersionForDeployment.name} (isLatest: ${finalActiveVersionForDeployment.isLatest}, streamingOverridden: ${finalActiveVersionForDeployment.streamingSupported}) based on deployment detail: ${deployedVersionIdentifier}`);
        } else if (deployedVersionIdentifier) {
          logger.warn('ModelService', `Could not determine specific active version for deployment ${deployedModelId} using identifier '${deployedVersionIdentifier}'. Versions array will be empty.`);
        }
      } else {
        newModelEntry = {
          internal_id: deployedModelId,
          internal_provider: "unknown",
          internal_createdAt: new Date(defaultTimestamp * 1000).toISOString(),
          accessType: "deployment",
          streamingSupported: false,
          details: cleanedDetails,
          scenarioId: dep.scenarioId,
          configurationId: dep.configurationId,
          configurationName: dep.configurationName,
          deploymentUrl: dep.deploymentUrl,
          model: modelNameFromDeployment,
          provider: "unknown",
          versions: []
        };
      }
      deploymentDerivedModels.push(newModelEntry);
    });

    logger.info('ModelService', `Processed ${deploymentDerivedModels.length} deployment-derived models.`);

    // Combine foundation models and deployment-derived models
    processedModels.push(...deploymentDerivedModels);

    // Update streaming support flags based on cache
    processedModels.forEach(model => {
      if (model.accessType === "deployment") {
        model.streamingSupported = false;
        return;
      }
      let finalStreamingSupport = model.streamingSupported;

      if (streamingSupportCache.has(model.internal_id)) {
        finalStreamingSupport = streamingSupportCache.get(model.internal_id);
      }

      if (model.streamingSupported !== finalStreamingSupport) {
        logger.debug('ModelService', `Updating streaming support for model ${model.internal_id} from ${model.streamingSupported} to ${finalStreamingSupport} based on known status/cache.`);
        model.streamingSupported = finalStreamingSupport;
      }

      if (model.versions) {
        model.versions.forEach((version: any) => {
          version.streamingSupported = finalStreamingSupport;
        });
      }
    });

    // --- Apply model_list_changes from api_config.json ---
    const modelListChanges = configService.getModelListChanges();
    const modelListChangesCount = Object.keys(modelListChanges).length;
    if (modelListChangesCount > 0) {
      logger.info('ModelService', `Applying ${modelListChangesCount} changes from api_config.json to model list.`);
    }

    processedModels.forEach(model => {
      const changeEntry = modelListChanges[model.internal_id];
      if (changeEntry) {
        logger.debug('ModelService', `Applying config for model: ${model.internal_id}`);
        if (changeEntry.subpaths_native) {
          model.subpaths_native = changeEntry.subpaths_native;
        }
        if (changeEntry.subpaths_emulated) {
          model.subpaths_emulated = changeEntry.subpaths_emulated;
        }

        Object.keys(changeEntry).forEach(key => {
          if (!['subpaths_native', 'subpaths_emulated', 'streamingSupported'].includes(key)) {
            model[key] = changeEntry[key];
          }
        });

        if (typeof changeEntry.streamingSupported === 'boolean') {
          model.streamingSupported = changeEntry.streamingSupported;
          logger.debug('ModelService', `Model ${model.internal_id} - Explicit streamingSupported from config: ${model.streamingSupported}`);
        } else if (changeEntry.subpaths_native && changeEntry.subpaths_native.some((p: string) => p.endsWith('-stream'))) {
          if (model.streamingSupported !== false) {
            model.streamingSupported = true;
            logger.debug('ModelService', `Model ${model.internal_id} - Inferred streamingSupported=true from native subpaths.`);
          }
        } else if (model.accessType === "deployment" && typeof changeEntry.streamingSupported !== 'boolean') {
            // If it's a deployment and config has an entry but no explicit streamingSupported, default to false.
            model.streamingSupported = false;
            logger.debug('ModelService', `Model ${model.internal_id} (deployment) - Defaulting streamingSupported to false (config entry exists but no explicit boolean).`);
        }
        // If it's a foundation model and the config entry for it doesn't specify streamingSupported,
        // its initial value (derived from fm.versions) is retained.
      }
      // If no changeEntry, model.streamingSupported retains its initial value.

      // Update runtime streamingSupportCache with the final determined value for this model
      streamingSupportCache.set(model.internal_id, model.streamingSupported);
      if (model.versions && Array.isArray(model.versions)) {
        model.versions.forEach((version: any) => {
            version.streamingSupported = model.streamingSupported; // Ensure version flags are consistent
        });
      }

      // Apply cache pricing from config to version cost arrays
      if (changeEntry && changeEntry.cachePricing && model.versions && Array.isArray(model.versions)) {
        const cachePricing = changeEntry.cachePricing;
        model.versions.forEach((version: any) => {
          // Ensure cost array exists
          version.cost = version.cost || [];
          // Add cache pricing to cost array
          if (cachePricing.cacheReadInputCostPer1K) {
            version.cost.push({ cacheReadInputCost: cachePricing.cacheReadInputCostPer1K });
          }
          if (cachePricing.cacheCreationInputCostPer1K) {
            version.cost.push({ cacheCreationInputCost: cachePricing.cacheCreationInputCostPer1K });
          }
        });
        logger.debug('ModelService', `Applied cache pricing to model ${model.internal_id}`);
      }
    });
    // --- End of applying model_list_changes ---

    const transformedData = transformModelsToOpenAIFormat(processedModels);

    modelsCache.data = transformedData;
    modelsCache.expiresAt = now + (modelCacheDurationSeconds * 1000);

    logger.info('ModelService', `Retrieved ${transformedData.data.length} total models (${processedModels.length - deploymentDerivedModels.length} foundation + ${deploymentDerivedModels.length} deployed)`);
    return transformedData;
  } catch (error: any) {
    logger.error('ModelService', `Error fetching or processing models from SAP AI Core: ${error.message}`);
    const enhancedError = new Error(error.message) as any;
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = error.response?.data || {};
    enhancedError.originalError = error;
    throw enhancedError;
  }
}

/**
 * Get a specific model by ID from SAP AI Core
 * @param modelId - The ID of the model to retrieve (this is the OpenAI formatted ID)
 * @param forceRefresh - Force refresh the cache
 * @returns The model details in OpenAI format
 */
export async function getModelById(modelId: string, forceRefresh: boolean = false): Promise<ModelInfo | null> {
  if (!modelId) {
    logger.warn('ModelService', "Called getModelById with no modelId.");
    return null;
  }

  let attemptCount = 0;
  let currentForceRefresh = forceRefresh;
  let modelDetail: ModelInfo | null = null;

  while (attemptCount < 2 && !modelDetail) {
    attemptCount++;
    if (attemptCount > 1) { // If this is a retry
        logger.warn('ModelService', `Model '${modelId}' not found on attempt ${attemptCount-1}. Retrying with cache refresh.`);
        currentForceRefresh = true;
    }

    const modelsResponse = await getModels(currentForceRefresh);
    if (modelsResponse && modelsResponse.data) {
      // Try exact match first
      modelDetail = modelsResponse.data.find(m => m.id === modelId) || null;
      
      if (modelDetail) {
        if (attemptCount > 1) logger.info('ModelService', `Found model '${modelId}' after cache refresh.`);
        return modelDetail;
      }

      // If exact match fails, try to match by base name if the modelId appears versioned
      const versioningPattern = /-\d{8}$|-\d{4}-\d{2}-\d{2}$|-v\d+(\.\d+)*$/;
      if (versioningPattern.test(modelId)) {
        const baseModelId = modelId.replace(versioningPattern, '');
        if (baseModelId && baseModelId !== modelId) {
          if (attemptCount === 1 && !forceRefresh) { // Only log "Attempting lookup" on the first pass if not already forcing refresh
            logger.warn('ModelService', `Model with ID '${modelId}' not found. Attempting lookup with base name '${baseModelId}'.`);
          }
          modelDetail = modelsResponse.data.find(m => m.id === baseModelId) || null;
          if (modelDetail) {
            logger.info('ModelService', `Found model by base name '${baseModelId}' for requested '${modelId}' (attempt ${attemptCount}).`);
            return modelDetail;
          }
        }
      }
    }
    // If we are already forcing refresh and still not found, no need to loop again.
    if (currentForceRefresh) break;
  }

  // If model still not found after potential retry with refresh
  if (!modelDetail) {
    // console.warn(`[getModelById] Model with ID '${modelId}' not found even after potential cache refresh.`); // This log might be too noisy if model genuinely doesn't exist
  }
  return modelDetail; // Returns null if not found
}

/**
 * Get model details by name
 * @param modelId - The model ID
 * @param forceRefresh - Whether to bypass cache
 * @returns The model details or null if not found
 */
export async function getModelDetails(modelId: string, forceRefresh: boolean = false): Promise<ModelInfo | null> {
  if (!modelId) {
    logger.warn('ModelService', "Called getModelDetails with no modelId");
    return null;
  }
  try {
    const model = await getModelById(modelId, forceRefresh);
    if (model) {
      return model;
    }
    logger.warn('ModelService', `Model details not found for '${modelId}' (neither exact nor base name match).`);
    return null;
  } catch (error: any) {
    // Catch errors from getModelById if it throws (e.g., if getModels failed)
    logger.error('ModelService', `Error resolving details for model '${modelId}': ${error.message}`);
    return null;
  }
}

/**
 * Clear the models cache
 */
export function clearModelsCache(): void {
  modelsCache.data = null;
  modelsCache.expiresAt = 0;
  logger.info('ModelService', 'Models cache cleared');
}

/**
 * Clear all caches (models, tokens, streaming support)
 * Used when configuration is updated to ensure fresh data with new config
 */
export function clearAllCaches(): void {
  // Clear models cache
  modelsCache.data = null;
  modelsCache.expiresAt = 0;
  
  // Clear token cache
  tokenCache.token = null;
  tokenCache.expiresAt = 0;
  
  // Clear streaming support cache
  streamingSupportCache.clear();
  
  logger.info('ModelService', 'All caches cleared (models, tokens, streaming support)');
}

/**
 * Transform internal processed models list to OpenAI format
 * @param processedModelsList - The list of processed model objects
 * @returns Response in OpenAI API format
 */
function transformModelsToOpenAIFormat(processedModelsList: any[]): any {
  const models = processedModelsList.map(model => {
    const openAIModel: any = {
      id: model.internal_id, // Use the standardized internal_id
      object: 'model',
      created: model.internal_createdAt ? new Date(model.internal_createdAt).getTime() / 1000 : defaultTimestamp,
      owned_by: model.internal_provider || 'SAP AI Core'
    };

    if (includeExtendedAttributes) {
      // Add all other properties from the model object
      for (const key in model) {
        if (!['internal_id', 'internal_provider', 'internal_createdAt', 'object'].includes(key) &&
            !openAIModel.hasOwnProperty(key)) {
          if (key === 'allowedScenarios' && model.accessType === 'deployment') {
            continue; // Skip allowedScenarios for deployments
          }
          openAIModel[key] = model[key];
        }
      }
      // Ensure these specific attributes are correctly set from the processed model
      if (model.accessType !== undefined) openAIModel.accessType = model.accessType;
      if (model.streamingSupported !== undefined) openAIModel.streamingSupported = model.streamingSupported;
      if (model.subpaths_native !== undefined) openAIModel.subpaths_native = model.subpaths_native;
      if (model.subpaths_emulated !== undefined) openAIModel.subpaths_emulated = model.subpaths_emulated;
      // ... (other extended attributes like details, scenarioId, etc.)
    }
    return openAIModel;
  });

  return {
    object: 'list',
    data: models
  };
}

class ModelService {
  async getModels(forceRefresh?: boolean): Promise<{ object: string; data: ModelInfo[] }> {
    return getModels(forceRefresh);
  }

  async getModelById(modelId: string, forceRefresh?: boolean): Promise<ModelInfo | null> {
    return getModelById(modelId, forceRefresh);
  }

  async getModelDetails(modelName: string, forceRefresh?: boolean): Promise<ModelInfo | null> {
    return getModelDetails(modelName, forceRefresh);
  }

  clearModelsCache(): void {
    clearModelsCache();
  }

  clearAllCaches(): void {
    clearAllCaches();
  }

  markModelAsNonStreaming(modelId: string): void {
    markModelAsNonStreaming(modelId);
  }

  modelSupportsStreaming(modelId: string): boolean {
    return modelSupportsStreaming(modelId);
  }

  async getAuthToken(): Promise<string> {
    return getAuthToken();
  }

}

export default new ModelService();