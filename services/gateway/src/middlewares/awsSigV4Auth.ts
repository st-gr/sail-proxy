import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { findAwsCredential, getSecretForSignature } from '../services/awsCredentialsService';
import * as awsDebug from './advancedAwsDebug';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

interface ParsedAuthHeader {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

interface AwsCredentialsExtended extends Request {
  awsCredentials?: {
    accessKeyId: string;
    userId: string;
  };
  isAwsAuthenticated?: boolean;
  id?: string;
  rawBody?: string;
}

interface ValidationVariation {
  name: string;
  headers: { [key: string]: any };
  service: string;
  region: string;
}

/**
 * Parse AWS4 Authorization header
 */
function parseAuthHeader(authHeader: string): ParsedAuthHeader | null {
  if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256 ')) {
    return null;
  }
  
  const authString = authHeader.substring('AWS4-HMAC-SHA256 '.length);
  const parts: { [key: string]: string } = {};
  
  // Parse Credential=..., SignedHeaders=..., Signature=...
  const regex = /(\w+)=([^,]+)/g;
  let match;
  while ((match = regex.exec(authString)) !== null) {
    if (match[1] && match[2]) {
      parts[match[1]] = match[2];
    }
  }
  
  if (!parts.Credential || !parts.SignedHeaders || !parts.Signature) {
    return null;
  }
  
  // Parse credential string: accessKeyId/yyyymmdd/region/service/aws4_request
  const credentialParts = parts.Credential.split('/');
  if (credentialParts.length !== 5) {
    return null;
  }
  
  return {
    accessKeyId: credentialParts[0]!,
    date: credentialParts[1]!,
    region: credentialParts[2]!,
    service: credentialParts[3]!,
    signedHeaders: parts.SignedHeaders.split(';'),
    signature: parts.Signature
  };
}

/**
 * Create canonical request string
 */
function createCanonicalRequest(
  method: string, 
  path: string, 
  query: string, 
  headers: { [key: string]: any }, 
  signedHeaders: string[], 
  payloadHash: string, 
  skipEncoding: boolean = false
): string {
  // Canonical headers: lowercase header names, sorted, with values
  logger.trace('AwsSigV4Auth', `Creating canonical request with signedHeaders: ${signedHeaders}`);
  logger.trace('AwsSigV4Auth', `Available headers: ${Object.keys(headers).join(', ')}`);

  const canonicalHeaders = signedHeaders
    .sort()
    .map(name => {
      const value = headers[name.toLowerCase()] || '';
      logger.trace('AwsSigV4Auth', `Header [${name.toLowerCase()}] value: "${value}"`);
      return `${name.toLowerCase()}:${value.trim()}`;
    })
    .join('\n');
  const signedHeadersString = signedHeaders.sort().join(';');

  // AWS SigV4 canonical URI: URI-encode every byte in the path, but not slashes.
  // This correctly encodes characters like ':' in path segments.
  const canonicalPath = skipEncoding ? path : path.split('/').map(segment => encodeURIComponent(segment)).join('/');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    query || '',
    canonicalHeaders,
    '', // Empty line after headers
    signedHeadersString,
    payloadHash
  ].join('\n');

  logger.trace('AwsSigV4Auth', `Built canonical request (unencoded):\n${canonicalRequest}`);

  return canonicalRequest;
}

/**
 * Create string to sign
 */
function createStringToSign(algorithm: string, timestamp: string, scope: string, canonicalRequest: string): string {
  const hashedCanonicalRequest = crypto.createHash('sha256')
    .update(canonicalRequest)
    .digest('hex');
  
  return [
    algorithm,
    timestamp,
    scope,
    hashedCanonicalRequest
  ].join('\n');
}

/**
 * Derive signing key
 */
function getSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  // Standard AWS SigV4 implementation
  const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(date).digest();
  
  // COMPATIBILITY FIX: Try alternative implementation
  let kRegion: Buffer;
  if (region === '*') {
    kRegion = kDate; // For SigV4a
  } else {
    kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  }
  
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  
  return kSigning;
}

/**
 * Calculate signature
 */
function calculateSignature(signingKey: Buffer, stringToSign: string): string {
  return crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

/**
 * AWS SigV4 authentication middleware
 * Falls back to existing API key auth if not AWS SigV4
 */
const awsSigV4Auth = async (req: AwsCredentialsExtended, res: Response, next: NextFunction): Promise<void> => {
  const requestId = req.id || `aws-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  
  try {
    const authHeader = req.headers.authorization;
    
    // Check if this is an AWS SigV4 request
    if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256 ')) {
      // Not AWS SigV4, continue to next middleware (existing API key auth)
      return next();
    }
    
    logger.trace('AwsSigV4Auth', `[${requestId}] Processing AWS SigV4 request`);
    logger.trace('AwsSigV4Auth', `[${requestId}] Authorization header: ${authHeader.substring(0, 50)}...`);
    
    // Parse authorization header
    const authInfo = parseAuthHeader(authHeader);
    if (!authInfo) {
      res.status(401).json({
        error: {
          message: 'Invalid AWS4 authorization header format',
          type: 'authentication_error'
        }
      });
      return;
    }
    
    // Get required headers
    const amzDate = req.headers['x-amz-date'] as string;
    if (!amzDate) {
      res.status(401).json({
        error: {
          message: 'Missing x-amz-date header',
          type: 'authentication_error'
        }
      });
      return;
    }
    
    // Get payload hash
    let payloadHash = req.headers['x-amz-content-sha256'] as string;
    if (!payloadHash) {
      // Calculate payload hash if not provided
      // IMPORTANT: Use raw body from req.rawBody if available, otherwise reconstruct from parsed body
      let body = '';
      if (req.rawBody) {
        body = req.rawBody;
      } else if (req.body) {
        body = JSON.stringify(req.body);
      }
      payloadHash = crypto.createHash('sha256').update(body).digest('hex');
      
      logger.trace('AwsSigV4Auth', `[${requestId}] Calculated payload hash: ${payloadHash}`);
      logger.trace('AwsSigV4Auth', `[${requestId}] Body source: ${req.rawBody ? 'rawBody' : 'reconstructed from parsed body'}`);
      logger.trace('AwsSigV4Auth', `[${requestId}] Body length: ${body.length}`);
    }
    
    // Find credentials by access key ID
    const credential = await findAwsCredential(authInfo.accessKeyId);
    
    if (!credential) {
      logger.trace('AwsSigV4Auth', `[${requestId}] Access key not found: ${authInfo.accessKeyId}`);
      res.status(401).json({
        error: {
          message: 'Invalid access key',
          type: 'authentication_error'
        }
      });
      return;
    }
    
    // Get secret for signature validation
    const secretAccessKey = await getSecretForSignature(authInfo.accessKeyId);
    
    if (!secretAccessKey) {
      logger.trace('AwsSigV4Auth', `[${requestId}] Could not retrieve secret for access key: ${authInfo.accessKeyId}`);
      res.status(401).json({
        error: {
          message: 'Invalid access key',
          type: 'authentication_error'
        }
      });
      return;
    }
    
    // Use originalUrl to get the full path including mount point
    const originalUrl = new URL(req.originalUrl, `http://${req.headers.host}`);

    let isValidSignature = false;
    let expectedSignature = '';
    let canonicalRequest = '';
    let stringToSign = '';

    // Define validation variations to test
    // This supports multiple AWS SigV4 signing scenarios including boto3 SDK variations
    const validationVariations: ValidationVariation[] = [];
    const currentHost = req.headers.host as string;
    
    // Create variations for different service names and host configurations
    const serviceVariations = [authInfo.service]; // Start with original service from auth header
    
    // Add common service name variations
    if (authInfo.service === 'bedrock') {
      serviceVariations.push('bedrock-runtime');
    } else if (authInfo.service === 'bedrock-runtime') {
      serviceVariations.push('bedrock');
    }
    
    // Create host variations
    const hostHeaders = [currentHost];
    
    // If host contains port, also test without port (for production HTTPS)
    if (currentHost && currentHost.includes(':')) {
      const hostWithoutPort = currentHost.split(':')[0];
      if (hostWithoutPort) {
        hostHeaders.push(hostWithoutPort);
      }
    }
    
    // Add original AWS endpoint hosts that boto3 might be signing against
    // AWS SigV4 spec: omit port 80 for HTTP and port 443 for HTTPS
    const originalAwsHosts = [
      `bedrock-runtime.${authInfo.region}.amazonaws.com`,
      `bedrock.${authInfo.region}.amazonaws.com`
    ];
    hostHeaders.push(...originalAwsHosts);
    
    // IMPORTANT: boto3 might be signing with localhost (no port) when using custom endpoint
    // This is a common behavior when the client redirects requests through a proxy
    if (currentHost && currentHost.includes(':3000')) {
      // Test signing with just the base hostname (no port)
      const baseHost = currentHost.split(':')[0];
      if (baseHost && !hostHeaders.includes(baseHost)) {
        hostHeaders.push(baseHost);
      }
    }
    
    // Generate all combinations of service and host variations
    for (const service of serviceVariations) {
      for (const host of hostHeaders) {
        const variationName = `${service}-${host.replace(/[.:]/g, '-')}`;
        validationVariations.push({
          name: variationName,
          headers: { ...req.headers, host },
          service,
          region: authInfo.region
        });
      }
    }

    logger.trace('AwsSigV4Auth', `[${requestId}] Testing ${validationVariations.length} signature variations:`);
    for (const variation of validationVariations) {
      logger.trace('AwsSigV4Auth', `[${requestId}] - ${variation.name}: service=${variation.service}, host=${variation.headers.host}`);
    }

    for (const variation of validationVariations) {
      logger.trace('AwsSigV4Auth', `[${requestId}] [Attempt: ${variation.name}] Trying signature validation...`);
      logger.trace('AwsSigV4Auth', `[${requestId}] [Attempt: ${variation.name}] Host: ${variation.headers.host}, Service: ${variation.service}`);

      // Calculate signing key for this variation's service
      const variationSigningKey = getSigningKey(
        secretAccessKey,
        authInfo.date,
        variation.region,
        variation.service
      );

      // Create scope for this variation
      const variationScope = `${authInfo.date}/${variation.region}/${variation.service}/aws4_request`;

      // Test both proxy path and original AWS API path formats
      const pathVariations = [
        originalUrl.pathname, // Current proxy path: /aws-bedrock/model/...
      ];

      // Add original AWS API path format: /model/... (without /aws-bedrock prefix)
      if (originalUrl.pathname.startsWith('/aws-bedrock/')) {
        const awsApiPath = originalUrl.pathname.replace('/aws-bedrock', '');
        pathVariations.push(awsApiPath);
      }

      for (const pathToTest of pathVariations) {
        const pathSuffix = pathVariations.length > 1 ? (pathToTest === originalUrl.pathname ? '-proxy-path' : '-aws-api-path') : '';
        const variationNameWithPath = `${variation.name}${pathSuffix}`;

        const currentCanonicalRequest = createCanonicalRequest(
          req.method,
          pathToTest,
          originalUrl.search.slice(1) || '',
          variation.headers,
          authInfo.signedHeaders,
          payloadHash
        );

        const currentStringToSign = createStringToSign(
          'AWS4-HMAC-SHA256',
          amzDate,
          variationScope,
          currentCanonicalRequest
        );

        const calculatedSignature = calculateSignature(variationSigningKey, currentStringToSign);

        logger.trace('AwsSigV4Auth', `[${requestId}] [Attempt: ${variationNameWithPath}] Path: ${pathToTest}, Calculated signature: ${calculatedSignature}`);

        if (calculatedSignature === authInfo.signature) {
          isValidSignature = true;
          expectedSignature = calculatedSignature;
          canonicalRequest = currentCanonicalRequest;
          stringToSign = currentStringToSign;
          logger.trace('AwsSigV4Auth', `[${requestId}] SUCCESS: Signature matched with variation: ${variationNameWithPath}`);
          break;
        } else if (!expectedSignature) {
          expectedSignature = calculatedSignature;
          canonicalRequest = currentCanonicalRequest;
          stringToSign = currentStringToSign;
        }
      }

      if (isValidSignature) {
        break;
      }
    }

    // Check if signature matches
    if (!isValidSignature) {
      logger.trace('AwsSigV4Auth', `[${requestId}] Signature verification failed - running detailed analysis`);
      awsDebug.logSignatureVerificationFailure(req, authInfo, originalUrl, payloadHash, canonicalRequest, stringToSign, expectedSignature);
      
      // Run comprehensive analysis for failed signatures
      awsDebug.performComprehensiveAnalysis(req, authInfo, secretAccessKey, credential, canonicalRequest, stringToSign, expectedSignature);
      
      // Use our advanced debugging tool to analyze the signature mismatch
      awsDebug.analyzeRequest(req, authInfo, originalUrl, payloadHash, canonicalRequest, expectedSignature);
      
      res.status(401).json({
        error: {
          message: 'Signature verification failed',
          type: 'authentication_error'
        }
      });
      return;
    }
    
    // Signature validation successful!
    logger.trace('AwsSigV4Auth', `[${requestId}] Signature validation successful`);
    logger.trace('AwsSigV4Auth', `[${requestId}] Expected signature: ${expectedSignature.substring(0, 10)}...`);
    logger.trace('AwsSigV4Auth', `[${requestId}] Provided signature: ${authInfo.signature.substring(0, 10)}...`);
    awsDebug.logSuccessfulSignatureVerification(req, authInfo, originalUrl);
    
    // Store credential info for downstream use
    req.awsCredentials = {
      accessKeyId: authInfo.accessKeyId,
      userId: credential.userId
    };
    
    // Mark as AWS authenticated
    req.isAwsAuthenticated = true;
    
    logger.info('AwsSigV4Auth', `[${requestId}] AWS SigV4 authentication successful`);
    
    next();
    
  } catch (error: any) {
    logger.error('AwsSigV4Auth', `Error during AWS SigV4 authentication: ${error}`);
    logger.trace('AwsSigV4Auth', 'Error details:', {
      message: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: {
        message: 'Authentication error',
        type: 'server_error'
      }
    });
  }
};

export default awsSigV4Auth;