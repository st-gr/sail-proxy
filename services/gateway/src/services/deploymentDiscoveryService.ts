import axios, { AxiosResponse } from 'axios';
import configService from './configService';
import { getDefaultLogger } from '@libs/logger';

const logger = getDefaultLogger();

// Type definitions
interface DeploymentResource {
  id: string;
  createdAt: string;
  modifiedAt: string;
  status: string;
  scenarioId: string;
  configurationId: string;
  latestRunningConfigurationId: string;
  lastOperation: string;
  targetStatus: string;
  submissionTime: string;
  startTime: string;
  configurationName: string;
  deploymentUrl: string;
  details?: any;
}

interface DeploymentCache {
  deployments: DeploymentResource[];
  expiresAt: number;
  lastError?: string;
}

// Configuration
const CACHE_TTL_SECONDS = parseInt(process.env.SAP_AI_DEPLOYMENT_CACHE_TTL_SECONDS || '300', 10);
const AUTO_DISCOVER = process.env.SAP_AI_AUTO_DISCOVER_DEPLOYMENT?.toLowerCase() === 'true';
const FILTER_SCENARIO = process.env.SAP_AI_DEPLOYMENT_FILTER_SCENARIO || 'orchestration';

// Cache
let deploymentCache: DeploymentCache = {
  deployments: [],
  expiresAt: 0
};

/**
 * Fetch orchestration deployments from SAP AI Core
 * @returns Array of running orchestration deployments
 */
async function fetchOrchestrationDeployments(): Promise<DeploymentResource[]> {
  try {
    const sapConfig = configService.getSAPAICoreConfig();
    const accessToken = await configService.getAccessToken();
    
    const url = `${sapConfig.url}/v2/lm/deployments`;
    
    logger.debug('DeploymentDiscoveryService', 'Fetching deployments from SAP AI Core for orchestration discovery');
    
    const response: AxiosResponse = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Accept': 'application/json'
      }
    });

    if (response.data && response.data.resources) {
      // Filter for running orchestration deployments
      const filtered = response.data.resources.filter((dep: DeploymentResource) =>
        dep.status === 'RUNNING' && dep.scenarioId === FILTER_SCENARIO
      );

      logger.info('DeploymentDiscoveryService', 
        `Fetched ${response.data.resources.length} total deployments, ` +
        `${filtered.length} running ${FILTER_SCENARIO} deployments found`
      );

      // Sort by creation date (newest first) to prefer more recent deployments
      filtered.sort((a: DeploymentResource, b: DeploymentResource) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return filtered;
    }

    logger.warn('DeploymentDiscoveryService', 'No deployment resources found in API response');
    return [];

  } catch (error: any) {
    logger.error('DeploymentDiscoveryService', `Error fetching deployments: ${error.message}`);
    
    if (error.response) {
      logger.error('DeploymentDiscoveryService', 
        `API Error - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data, null, 2)}`
      );
    }

    // Store error in cache for debugging
    deploymentCache.lastError = error.message;
    throw error;
  }
}

/**
 * Get available orchestration deployments with caching
 * @param forceRefresh - Force refresh the cache
 * @returns Array of running orchestration deployments
 */
export async function getOrchestrationDeployments(forceRefresh = false): Promise<DeploymentResource[]> {
  const now = Date.now();

  // Return cached data if valid and not forcing refresh
  if (!forceRefresh && deploymentCache.expiresAt > now) {
    logger.debug('DeploymentDiscoveryService', 
      `Returning cached deployments (${deploymentCache.deployments.length} found)`
    );
    return deploymentCache.deployments;
  }

  try {
    const deployments = await fetchOrchestrationDeployments();
    
    // Update cache
    deploymentCache = {
      deployments,
      expiresAt: now + (CACHE_TTL_SECONDS * 1000),
      lastError: undefined
    };

    return deployments;

  } catch (error) {
    // If we have cached data, return it even if expired (fallback)
    if (deploymentCache.deployments.length > 0) {
      logger.warn('DeploymentDiscoveryService', 
        'Failed to refresh deployments, returning stale cached data'
      );
      return deploymentCache.deployments;
    }

    // No cached data available, re-throw error
    throw error;
  }
}

/**
 * Get the first available orchestration deployment ID
 * @param forceRefresh - Force refresh the cache
 * @returns Deployment ID or null if none available
 */
export async function getPreferredOrchestrationDeploymentId(forceRefresh = false): Promise<string | null> {
  try {
    const deployments = await getOrchestrationDeployments(forceRefresh);
    
    if (deployments.length === 0) {
      logger.warn('DeploymentDiscoveryService', 'No orchestration deployments available');
      return null;
    }

    const preferredDeployment = deployments[0]; // Already sorted by creation date
    logger.info('DeploymentDiscoveryService', 
      `Selected deployment: ${preferredDeployment.id} (${preferredDeployment.configurationName})`
    );

    return preferredDeployment.id;

  } catch (error: any) {
    logger.error('DeploymentDiscoveryService', 
      `Failed to get preferred deployment: ${error.message}`
    );
    return null;
  }
}

/**
 * Check if auto-discovery is enabled
 * @returns Whether auto-discovery is enabled
 */
export function isAutoDiscoveryEnabled(): boolean {
  return AUTO_DISCOVER;
}

/**
 * Get deployment cache status for debugging
 * @returns Cache status information
 */
export function getCacheStatus(): {
  deploymentCount: number;
  expiresAt: number;
  isExpired: boolean;
  lastError?: string;
} {
  const now = Date.now();
  return {
    deploymentCount: deploymentCache.deployments.length,
    expiresAt: deploymentCache.expiresAt,
    isExpired: deploymentCache.expiresAt <= now,
    lastError: deploymentCache.lastError
  };
}

// Separate cache for Perplexity direct deployments
let perplexityDeploymentCache: {
  deploymentId: string | null;
  expiresAt: number;
} = {
  deploymentId: null,
  expiresAt: 0
};

/**
 * Auto-discover a running Perplexity (sonar) direct deployment.
 * Looks for foundation-models deployments whose configurationName
 * matches sonar or perplexity (case-insensitive).
 * @param forceRefresh - Force refresh the cache
 * @returns Deployment ID or null if none available
 */
export async function getPerplexityDeploymentId(forceRefresh = false): Promise<string | null> {
  const now = Date.now();

  if (!forceRefresh && perplexityDeploymentCache.expiresAt > now) {
    logger.debug('DeploymentDiscoveryService',
      `Using cached Perplexity deployment ID: ${perplexityDeploymentCache.deploymentId}`);
    return perplexityDeploymentCache.deploymentId;
  }

  try {
    const sapConfig = configService.getSAPAICoreConfig();
    const accessToken = await configService.getAccessToken();

    const url = `${sapConfig.url}/v2/lm/deployments`;

    logger.debug('DeploymentDiscoveryService', 'Fetching deployments for Perplexity discovery');

    const response: AxiosResponse = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Accept': 'application/json'
      }
    });

    if (response.data?.resources) {
      const perplexityDep = response.data.resources.find((dep: DeploymentResource) =>
        dep.status === 'RUNNING' &&
        dep.scenarioId === 'foundation-models' &&
        dep.details?.resources?.backendDetails?.model?.name === 'sonar-pro'
      );

      const id = perplexityDep?.id || null;
      perplexityDeploymentCache = {
        deploymentId: id,
        expiresAt: now + (CACHE_TTL_SECONDS * 1000)
      };

      if (id) {
        logger.info('DeploymentDiscoveryService',
          `Found Perplexity deployment: ${id} (${perplexityDep.configurationName})`);
      } else {
        logger.debug('DeploymentDiscoveryService',
          'No running Perplexity foundation-models deployment found');
      }

      return id;
    }

    return null;
  } catch (error: any) {
    logger.error('DeploymentDiscoveryService',
      `Error discovering Perplexity deployment: ${error.message}`);

    // Short cache for failures to allow retry
    perplexityDeploymentCache = {
      deploymentId: null,
      expiresAt: now + (CACHE_TTL_SECONDS * 250) // ~25% of normal TTL
    };

    return null;
  }
}

// Separate cache for the reranker direct deployment
let rerankerDeploymentCache: {
  deploymentId: string | null;
  expiresAt: number;
} = {
  deploymentId: null,
  expiresAt: 0
};

/**
 * Auto-discover a running Cohere reranker direct deployment.
 * Looks for foundation-models deployments whose backend model name matches
 * the configured file_search.hybrid.rerank.model (defaults to 'cohere-reranker').
 * @param forceRefresh - Force refresh the cache
 * @returns Deployment ID or null if none available
 */
export async function getRerankerDeploymentId(forceRefresh = false): Promise<string | null> {
  const now = Date.now();

  if (!forceRefresh && rerankerDeploymentCache.expiresAt > now) {
    logger.debug('DeploymentDiscoveryService',
      `Using cached reranker deployment ID: ${rerankerDeploymentCache.deploymentId}`);
    return rerankerDeploymentCache.deploymentId;
  }

  try {
    const sapConfig = configService.getSAPAICoreConfig();
    const accessToken = await configService.getAccessToken();
    const rerankModel = configService.getFileSearchConfig().hybrid.rerank.model;

    const url = `${sapConfig.url}/v2/lm/deployments`;

    logger.debug('DeploymentDiscoveryService', 'Fetching deployments for reranker discovery');

    const response: AxiosResponse = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'AI-Resource-Group': sapConfig.resourceGroup || 'default',
        'Accept': 'application/json'
      }
    });

    if (response.data?.resources) {
      const rerankerDep = response.data.resources.find((dep: DeploymentResource) =>
        dep.status === 'RUNNING' &&
        dep.scenarioId === 'foundation-models' &&
        dep.details?.resources?.backendDetails?.model?.name === rerankModel
      );

      const id = rerankerDep?.id || null;
      rerankerDeploymentCache = {
        deploymentId: id,
        expiresAt: now + (CACHE_TTL_SECONDS * 1000)
      };

      if (id) {
        logger.info('DeploymentDiscoveryService',
          `Found reranker deployment: ${id} (${rerankerDep.configurationName})`);
      } else {
        logger.debug('DeploymentDiscoveryService',
          'No running reranker foundation-models deployment found');
      }

      return id;
    }

    return null;
  } catch (error: any) {
    logger.error('DeploymentDiscoveryService',
      `Error discovering reranker deployment: ${error.message}`);

    // Short cache for failures to allow retry
    rerankerDeploymentCache = {
      deploymentId: null,
      expiresAt: now + (CACHE_TTL_SECONDS * 250) // ~25% of normal TTL
    };

    return null;
  }
}

/**
 * Clear the deployment cache (useful for testing)
 */
export function clearCache(): void {
  deploymentCache = {
    deployments: [],
    expiresAt: 0
  };
  perplexityDeploymentCache = {
    deploymentId: null,
    expiresAt: 0
  };
  rerankerDeploymentCache = {
    deploymentId: null,
    expiresAt: 0
  };
  logger.debug('DeploymentDiscoveryService', 'Cache cleared');
}

export default {
  getOrchestrationDeployments,
  getPreferredOrchestrationDeploymentId,
  getPerplexityDeploymentId,
  getRerankerDeploymentId,
  isAutoDiscoveryEnabled,
  getCacheStatus,
  clearCache
};