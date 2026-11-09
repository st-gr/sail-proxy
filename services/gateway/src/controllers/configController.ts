/**
 * Controller for managing API configuration
 */
import { Request, Response, NextFunction } from 'express';

// Use require for CommonJS module
import configService from '../services/configService';
import { legacyShapeError } from '../utils/legacyConfigShape';
import { DEFAULT_CONFIG } from '../services/defaultConfig';

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

    // Reject a pre-restructure body outright: deep-merging it would answer 200
    // while changing nothing the gateway reads.
    const legacyError = legacyShapeError(newConfig.api_config);
    if (legacyError) {
      res.status(400).json(legacyError);
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

    // Same diagnostic as PUT. A PATCH is where this bites hardest: the merge is
    // partial by design, so an old-shape body looks exactly like a successful
    // narrow update until the caller notices the setting never applied.
    const legacyError = legacyShapeError(patchData.api_config);
    if (legacyError) {
      res.status(400).json(legacyError);
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
    // The same object the service falls back to, imported rather than repeated:
    // an inline third copy is invisible to the fallback-schema test, which is
    // exactly how the lowercase `defaultLevel: "info"` defect was born.
    const updatedConfig = await configService.updateConfig(DEFAULT_CONFIG);
    res.json(updatedConfig);
  } catch (err) {
    next(err);
  }
};