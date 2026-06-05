/**
 * Controller for managing API configuration
 */
import { Request, Response, NextFunction } from 'express';

// Use require for CommonJS module
import configService from '../services/configService';

interface ConfigRequest extends Request {
  query: {
    refresh?: string;
  };
}

interface UpdateConfigRequest extends Request {
  body: {
    api_config?: any;
    [key: string]: any;
  };
}

interface PatchConfigRequest extends Request {
  body: {
    [key: string]: any;
  };
}

/**
 * Get the current API configuration
 */
export const getConfig = async (req: ConfigRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Check for cache bypass in query string
    const forceRefresh = req.query.refresh === 'true';
    const config = await configService.getConfigAsync(forceRefresh);
    res.json(config);
  } catch (err) {
    next(err);
  }
};

/**
 * Update the API configuration
 */
export const updateConfig = async (req: UpdateConfigRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const newConfig = req.body;
    
    // Validate the request body
    if (!newConfig || !newConfig.api_config) {
      res.status(400).json({ 
        error: 'Invalid configuration format: missing api_config'
      });
      return;
    }
    
    // Update the configuration
    const updatedConfig = await configService.updateConfig(newConfig as any);
    res.json(updatedConfig);
  } catch (err) {
    next(err);
  }
};

/**
 * Patch parts of the API configuration
 */
export const patchConfig = async (req: PatchConfigRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const patchData = req.body;
    
    // Validate the request body
    if (!patchData) {
      res.status(400).json({ 
        error: 'Invalid patch data: empty request body' 
      });
      return;
    }
    
    // Patch the configuration
    const updatedConfig = await configService.patchConfig(patchData);
    res.json(updatedConfig);
  } catch (err) {
    next(err);
  }
};

/**
 * Reset the API configuration to defaults
 */
export const resetConfig = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Use the default configuration from the service
    const defaultConfig = {
      api_config: {
        openai: {
          substitute_models: [
            { from: "GPT-4", to: "o1" },
            { from: "GPT-3.5", to: "GPT-4" }
          ],
          emulate_streaming_for_models: []
        },
        anthropic: {
          substitute_models: [
            { from: "claude-3-5-haiku-20241022", to: "anthropic--claude-3-haiku" },
            { from: "claude-3-7-sonnet-20250219", to: "anthropic--claude-3.7-sonnet" }
          ],
          emulate_streaming_for_models: ["anthropic--claude-3.7-sonnet"]
        }
      }
    };
    
    // Update with the default config
    const updatedConfig = await configService.updateConfig(defaultConfig);
    res.json(updatedConfig);
  } catch (err) {
    next(err);
  }
};