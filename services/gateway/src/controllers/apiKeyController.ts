import { Request, Response, NextFunction } from 'express';

// Use require for CommonJS module
import apiKeyService from '../services/apiKeyService';
import { secretLabel } from '../utils/secretLabel';


interface CreateApiKeyRequest extends Request {
  body: {
    createdBy?: string;
    email?: string;
  };
}

interface RevokeApiKeysByEmailRequest extends Request {
  body: {
    email: string;
  };
}

interface SetApiKeyRequest extends Request {
  body: {
    key?: string;
    isActive?: boolean;
  };
  params: {
    id: string;
  };
}

export const createApiKey = async (req: CreateApiKeyRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const createdBy = req.body.createdBy || 'unknown';
    const email = req.body.email || '';
    const keyRecord = await apiKeyService.createApiKey(createdBy, email);
    // Return the key (only once) along with metadata
    res.status(201).json({ 
      id: keyRecord.id,
      apiKey: keyRecord.key, 
      createdBy: keyRecord.createdBy, 
      email: keyRecord.email,
      createdAt: keyRecord.createdAt 
    });
  } catch (err) {
    next(err);
  }
};

export const revokeApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const key = req.params.key;
    if (!key) {
      res.status(400).json({ error: 'Key parameter is required' });
      return;
    }
    const keyRecord = await apiKeyService.revokeApiKey(key);
    if (!keyRecord) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    res.json({ 
      message: 'API key revoked',
      id: keyRecord.id,
      key: keyRecord.key, // Return the full key in the revocation response
      createdBy: keyRecord.createdBy,
      email: keyRecord.email,
      createdAt: keyRecord.createdAt,
      isActive: keyRecord.isActive
    });
  } catch (err) {
    next(err);
  }
};

export const revokeApiKeysByEmail = async (req: RevokeApiKeysByEmailRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = req.body;
    
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    
    const revokedKeys = await apiKeyService.revokeApiKeysByEmail(email);
    
    if (revokedKeys.length === 0) {
      res.status(404).json({ error: 'No active API keys found for this email' });
      return;
    }
    
    // Return the full details of all revoked keys
    res.json({
      message: `${revokedKeys.length} API key(s) revoked for ${email}`,
      revokedKeys: revokedKeys.map((k: any) => ({
        id: k.id,
        key: k.key, // Return the full key in the revocation response
        createdBy: k.createdBy,
        email: k.email,
        createdAt: k.createdAt,
        isActive: k.isActive
      }))
    });
  } catch (err) {
    next(err);
  }
};

export const getApiKeyById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'ID parameter is required' });
      return;
    }
    const keyRecord = await apiKeyService.getApiKeyById(id);
    
    if (!keyRecord) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    
    res.json({
      id: keyRecord.id,
      key: keyRecord.key, // Return the full key
      createdBy: keyRecord.createdBy,
      email: keyRecord.email,
      createdAt: keyRecord.createdAt,
      isActive: keyRecord.isActive
    });
  } catch (err) {
    next(err);
  }
};

export const setApiKey = async (req: SetApiKeyRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id;
    const { key, isActive } = req.body;
    
    // Make sure at least one field to update is provided
    if (!key && isActive === undefined) {
      res.status(400).json({ error: 'Please provide at least one field to update (key or isActive)' });
      return;
    }
    
    // Make sure key is properly formatted if provided
    if (key && !key.startsWith('sk-')) {
      res.status(400).json({ error: 'API key must start with sk-' });
      return;
    }
    
    const keyRecord = await apiKeyService.setApiKey(id, key, isActive);
    
    if (!keyRecord) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    
    res.json({
      id: keyRecord.id,
      key: keyRecord.key, // Return the full key
      createdBy: keyRecord.createdBy,
      email: keyRecord.email,
      createdAt: keyRecord.createdAt,
      isActive: keyRecord.isActive,
      message: 'API key updated successfully'
    });
  } catch (err) {
    next(err);
  }
};

export const listApiKeys = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const keys = await apiKeyService.listApiKeys();
    // Do not expose the key, not even a prefix of it - a prefix is still key
    // material. A non-reversible label is enough to tell entries apart.
    res.json(keys.map((k: any) => ({
      id: k.id, // Use the UUID as the identifier
      createdBy: k.createdBy,
      email: k.email,
      createdAt: k.createdAt,
      isActive: k.isActive,
      key: secretLabel(k.key)
    })));
  } catch (err) {
    next(err);
  }
};