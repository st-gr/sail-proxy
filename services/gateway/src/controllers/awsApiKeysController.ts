import { Request, Response } from 'express';

import {
  createAwsCredentials as createAwsCredentialsService,
  listAwsCredentials as listAwsCredentialsService,
  revokeAwsCredentials as revokeAwsCredentialsService,
  findAwsCredentialByAccessKeyId,
  setAwsCredentialKeys as setAwsCredentialKeysService
} from '../services/awsCredentialsService';
import { getDefaultLogger } from '@libs/logger';
import { secretLabel } from '../utils/secretLabel';
const logger = getDefaultLogger();

interface CreateAwsCredentialsRequest extends Request {
  body: {
    userId?: string;
  };
}

interface RevokeAwsCredentialsRequest extends Request {
  params: {
    accessKeyId: string;
  };
}

interface SetAwsCredentialKeysRequest extends Request {
  body: {
    credentialId: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * Create new AWS credentials
 */
export const createAwsCredentials = async (req: CreateAwsCredentialsRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.body;
    
    const credentials = await createAwsCredentialsService(userId);
    
    logger.info('AwsApiKeysController', `Created AWS credentials for user: ${userId || 'default'}`);
    
    res.status(201).json(credentials);
  } catch (error: any) {
    logger.error('AwsApiKeysController', 'Error creating AWS credentials:', error);
    res.status(500).json({
      error: {
        message: 'Failed to create AWS credentials',
        type: 'server_error'
      }
    });
  }
};

/**
 * List AWS credentials
 */
export const listAwsCredentials = async (_req: Request, res: Response): Promise<void> => {
  try {
    const credentials = await listAwsCredentialsService();
    
    // Add AWS region information from SAP_AI_REGION for client configuration
    const sapAiRegion = process.env.SAP_AI_REGION || 'us-east-1';
    const awsRegion = sapAiRegion.includes('.') ? sapAiRegion.split('.')[1] : sapAiRegion;
    
    const response = {
      credentials,
      aws_region: awsRegion, // boto3 clients can use this region
      sap_ai_region: sapAiRegion // full SAP AI Core region identifier
    };
    
    res.json(response);
  } catch (error: any) {
    logger.error('AwsApiKeysController', 'Error listing AWS credentials:', error);
    res.status(500).json({
      error: {
        message: 'Failed to list AWS credentials',
        type: 'server_error'
      }
    });
  }
};

/**
 * Revoke AWS credentials
 */
export const revokeAwsCredentials = async (req: RevokeAwsCredentialsRequest, res: Response): Promise<void> => {
  try {
    const { accessKeyId } = req.params;

    const revoked = await revokeAwsCredentialsService(accessKeyId);

    if (revoked) {
      logger.info('AwsApiKeysController', `Revoked AWS credentials: ${secretLabel(accessKeyId)}`);
      res.json({ message: 'Credentials revoked successfully' });
    } else {
      res.status(404).json({
        error: {
          message: 'Credentials not found',
          type: 'not_found'
        }
      });
    }
  } catch (error: any) {
    logger.error('AwsApiKeysController', 'Error revoking AWS credentials:', error);
    res.status(500).json({
      error: {
        message: 'Failed to revoke AWS credentials',
        type: 'server_error'
      }
    });
  }
};

/**
 * Set AWS credential keys (for restoration)
 */
export const setAwsCredentialKeys = async (req: SetAwsCredentialKeysRequest, res: Response): Promise<void> => {
  try {
    const { credentialId, accessKeyId, secretAccessKey } = req.body;

    // Validate format
    if (!/^AKIA[A-Z0-9]{16}$/.test(accessKeyId)) {
      res.status(400).json({
        error: {
          message: 'Invalid accessKeyId format. Must start with AKIA followed by 16 alphanumeric characters.',
          type: 'validation_error'
        }
      });
      return;
    }

    if (secretAccessKey.length !== 40) {
      res.status(400).json({
        error: {
          message: 'Invalid secretAccessKey length. Must be exactly 40 characters.',
          type: 'validation_error'
        }
      });
      return;
    }

    // Check for duplicate accessKeyId
    const duplicate = await findAwsCredentialByAccessKeyId(accessKeyId, credentialId);
    if (duplicate) {
      res.status(400).json({
        error: {
          message: 'AccessKeyId already exists',
          type: 'duplicate_error'
        }
      });
      return;
    }

    // Update the credential keys
    const updated = await setAwsCredentialKeysService(credentialId, accessKeyId, secretAccessKey);

    if (updated) {
      logger.info('AwsApiKeysController', `Updated credential keys for ID: ${credentialId}`);
      res.json({ success: true, message: 'Credentials updated successfully' });
    } else {
      res.status(404).json({
        error: {
          message: 'Credential not found',
          type: 'not_found'
        }
      });
    }
  } catch (error: any) {
    logger.error('AwsApiKeysController', 'Error setting AWS credential keys:', error);
    res.status(500).json({
      error: {
        message: 'Failed to set AWS credential keys',
        type: 'server_error'
      }
    });
  }
};