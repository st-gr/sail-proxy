/**
 * Enhanced AWS SigV4 debugging helper
 * This tool helps diagnose signature mismatches by analyzing header values and canonical request construction
 */
import crypto from 'crypto';
import { getDefaultLogger } from '@libs/logger';
import { secretLabel } from '../utils/secretLabel';
const logger = getDefaultLogger();

// Header names that carry credential material and must never be logged raw,
// even in this verbose debug tool.
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-stainless-key',
  'cookie',
  'x-amz-security-token'
]);

/** Redact a header value for logging if its name carries credential material. */
function redactHeaderValue(name: string, value: any): any {
  if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) return value;
  if (typeof value !== 'string' || value.length === 0) return value;
  return `[redacted:${secretLabel(value)}]`;
}

interface AuthInfo {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

interface Credential {
  id: string;
  accessKeyId: string;
  reconstructedSecret: string;
  userId: string;
  createdAt: Date;
  isActive: boolean;
}

/**
 * Analyze a request to help diagnose signature mismatches
 */
export function analyzeRequest(req: any, authInfo: AuthInfo, originalUrl: URL, payloadHash: string, canonicalRequest: string, expectedSignature: string): void {
  logger.debug('AwsDebug', '\n🔍 ENHANCED AWS SIGNATURE DEBUG INFO 🔍');
  logger.debug('AwsDebug', '================================================');
  
  // Log request details
  logger.debug('AwsDebug', `Request Method: ${req.method}`);
  logger.debug('AwsDebug', `URL Path: ${originalUrl.pathname}`);
  logger.debug('AwsDebug', `Query String: ${originalUrl.search.slice(1) || '(none)'}`);  
  
  // Check for common issues
  logger.debug('AwsDebug', '\n🔎 COMMON SIGNATURE MISMATCH ISSUES:');

  // 1. Check for header formatting discrepancies
  const headerIssues = checkHeaderFormatting(req.headers, authInfo.signedHeaders);
  if (headerIssues.length > 0) {
    logger.warn('AwsDebug', '⚠️ HEADER FORMATTING ISSUES DETECTED:');
    headerIssues.forEach(issue => logger.warn('AwsDebug', `  - ${issue}`));
  } else {
    logger.debug('AwsDebug', '✅ No header formatting issues detected');
  }

  // 2. Check signature calculation components
  logger.debug('AwsDebug', '\n📝 SIGNATURE CALCULATION COMPONENTS:');
  logger.debug('AwsDebug', `Date from Auth: ${authInfo.date}`);
  logger.debug('AwsDebug', `Region from Auth: ${authInfo.region}`);
  logger.debug('AwsDebug', `Service from Auth: ${authInfo.service}`);

  // 3. Check payload hash
  logger.debug('AwsDebug', `Content-SHA256 in header: ${req.headers['x-amz-content-sha256'] || 'none'}`);
  logger.debug('AwsDebug', `Payload hash used for signing: ${payloadHash}`);
  if (req.headers['x-amz-content-sha256'] && req.headers['x-amz-content-sha256'] !== payloadHash) {
    logger.warn('AwsDebug', '⚠️ PAYLOAD HASH MISMATCH DETECTED!');
  }

  // 4. Check for missing headers
  const missingHeaders = checkMissingHeaders(req.headers, authInfo.signedHeaders);
  if (missingHeaders.length > 0) {
    logger.warn('AwsDebug', '\n⚠️ MISSING HEADERS DETECTED:');
    missingHeaders.forEach(header => logger.warn('AwsDebug', `  - ${header}`));
  } else {
    logger.debug('AwsDebug', '\n✅ All signed headers present in request');
  }

  // 5. Log all headers for detailed inspection
  logger.debug('AwsDebug', '\n📋 ALL REQUEST HEADERS:');
  Object.keys(req.headers).sort().forEach(key => {
    let value = req.headers[key];
    // Format array values for better readability
    if (Array.isArray(value)) {
      value = value.map((v: any) => String(v)).join(', ');
    }
    const inSignedHeaders = authInfo.signedHeaders.includes(key) ? '✅' : '❌';
    logger.debug('AwsDebug', `  ${inSignedHeaders} ${key}: "${redactHeaderValue(key, value)}"`);
  });

  // 6. Signed headers from auth vs actual
  logger.debug('AwsDebug', '\n📋 SIGNED HEADERS FROM AUTH:');
  authInfo.signedHeaders.forEach(header => {
    const value = req.headers[header.toLowerCase()];
    const status = value !== undefined ? '✅' : '⚠️';
    logger.debug('AwsDebug', `  ${status} ${header}: "${value ? redactHeaderValue(header, value) : 'MISSING'}"`);
  });

  // 7. Canonical request analysis
  logger.debug('AwsDebug', '\n🔍 CANONICAL REQUEST ANALYSIS:');
  const canonicalLines = canonicalRequest.split('\n');
  
  // Method
  logger.debug('AwsDebug', `Method: ${canonicalLines[0]}`);
  
  // Path
  logger.debug('AwsDebug', `Path: ${canonicalLines[1]}`);
  
  // Query
  logger.debug('AwsDebug', `Query: ${canonicalLines[2] || '(empty)'}`);
  
  // Headers
  logger.debug('AwsDebug', 'Canonical Headers:');
  let lineIndex = 3;
  while (lineIndex < canonicalLines.length && canonicalLines[lineIndex] !== '') {
    logger.debug('AwsDebug', `  ${canonicalLines[lineIndex]}`);
    lineIndex++;
  }
  
  // Empty line (should be present)
  lineIndex++; // Skip empty line
  
  // Signed headers
  if (lineIndex < canonicalLines.length) {
    logger.debug('AwsDebug', `Signed Headers: ${canonicalLines[lineIndex]}`);
    lineIndex++;
  }
  
  // Payload hash
  if (lineIndex < canonicalLines.length) {
    logger.debug('AwsDebug', `Payload Hash: ${canonicalLines[lineIndex]}`);
  }

  // 8. Generate a request for testing with curl (for further debugging)
  logger.debug('AwsDebug', '\n🧪 TEST CURL COMMAND:');
  const curlCommand = generateCurlCommand(req, authInfo, payloadHash);
  logger.debug('AwsDebug', curlCommand);

  logger.debug('AwsDebug', '\n📝 SIGNATURE INFORMATION:');
  logger.debug('AwsDebug', `Calculated Signature: ${expectedSignature}`);
  logger.debug('AwsDebug', `Provided Signature: ${authInfo.signature}`);
  
  logger.debug('AwsDebug', '================================================\n');
}

/**
 * Perform comprehensive signature analysis including secret validation
 */
export function performComprehensiveAnalysis(_req: any, authInfo: AuthInfo, secretAccessKey: string, credential: Credential, canonicalRequest: string, stringToSign: string, expectedSignature: string): void {
  logger.debug('AwsDebug', '=== COMPREHENSIVE SIGNATURE ANALYSIS ===');
  logger.debug('AwsDebug', `Our calculated signature: ${expectedSignature}`);
  logger.debug('AwsDebug', `Client provided signature: ${authInfo.signature}`);
  
  // Check exact secret value being used - label lets us confirm equality/inequality
  // across log lines (invisible-char / whitespace bugs) without ever printing the secret.
  logger.debug('AwsDebug', `Secret label being used: ${secretLabel(secretAccessKey)}`);
  logger.debug('AwsDebug', `Secret length: ${secretAccessKey.length}`);
  logger.debug('AwsDebug', `Secret type: ${typeof secretAccessKey}`);

  // Test with the exact stored secret from credentials
  const storedSecret = credential.reconstructedSecret;
  logger.debug('AwsDebug', `Stored secret label: ${secretLabel(storedSecret)}`);
  logger.debug('AwsDebug', `Stored secret length: ${storedSecret.length}`);
  
  if (secretAccessKey !== storedSecret) {
    logger.debug('AwsDebug', 'WARNING: Secret from service differs from stored secret!');
    const correctSigningKey = getSigningKey(storedSecret, authInfo.date, authInfo.region, authInfo.service);
    const correctSignature = calculateSignature(correctSigningKey, stringToSign);
    logger.debug('AwsDebug', `Signature with stored secret: ${correctSignature}`);
  } else {
    logger.debug('AwsDebug', 'Secrets match exactly');
  }
  
  // Check signature format to detect potential algorithm mismatches
  if (authInfo.signature.length === 64) {
    logger.debug('AwsDebug', 'Signature length suggests HMAC-SHA256 (correct)');
  } else {
    logger.debug('AwsDebug', `Unexpected signature length: ${authInfo.signature.length}`);
  }
  
  // Check raw string to sign hash
  const rawStringToSignHash = crypto.createHash('sha256').update(stringToSign).digest('hex');
  logger.debug('AwsDebug', `String to sign hash: ${rawStringToSignHash}`);
  
  // Compare canonical request with expected client format
  logger.debug('AwsDebug', 'Canonical request hex representation:');
  logger.debug('AwsDebug', Buffer.from(canonicalRequest, 'utf8').toString('hex'));
  
  // Compare string to sign with expected format
  logger.debug('AwsDebug', 'String to sign hex representation:');
  logger.debug('AwsDebug', Buffer.from(stringToSign, 'utf8').toString('hex'));
  
  // Let's also check if there are any non-printable characters
  const nonPrintableInCanonical = canonicalRequest.split('').some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code > 126;
  });
  const nonPrintableInStringToSign = stringToSign.split('').some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code > 126;
  });
  
  logger.debug('AwsDebug', `Non-printable chars in canonical request: ${nonPrintableInCanonical}`);
  logger.debug('AwsDebug', `Non-printable chars in string to sign: ${nonPrintableInStringToSign}`);
  
  // Only run manual signing key verification for failed signatures to avoid confusion
  performManualSigningKeyVerification(secretAccessKey, authInfo, stringToSign, expectedSignature);
  
  logger.debug('AwsDebug', '=== END COMPREHENSIVE ANALYSIS ===');
}

/**
 * Perform manual signing key verification step by step
 */
function performManualSigningKeyVerification(secretAccessKey: string, authInfo: AuthInfo, stringToSign: string, expectedSignature: string): void {
  // Test the exact same calculation that our signing key derivation uses
  logger.debug('AwsDebug', '--- MANUAL SIGNING KEY VERIFICATION ---');
  const testSecret = secretAccessKey;
  const testDate = authInfo.date; 
  const testRegion = authInfo.region;
  const testService = authInfo.service;
  
  logger.debug('AwsDebug', `Using: secretLabel=${secretLabel(testSecret)}, date="${testDate}", region="${testRegion}", service="${testService}"`);
  
  const step1 = crypto.createHmac('sha256', 'AWS4' + testSecret).update(testDate).digest();
  logger.debug('AwsDebug', `Step 1 (kDate): ${step1.toString('hex')}`);
  
  const step2 = crypto.createHmac('sha256', step1).update(testRegion).digest();
  logger.debug('AwsDebug', `Step 2 (kRegion): ${step2.toString('hex')}`);
  
  const step3 = crypto.createHmac('sha256', step2).update(testService).digest();
  logger.debug('AwsDebug', `Step 3 (kService): ${step3.toString('hex')}`);
  
  const step4 = crypto.createHmac('sha256', step3).update('aws4_request').digest();
  logger.debug('AwsDebug', `Step 4 (kSigning): ${step4.toString('hex')}`);
  
  const finalSignature = crypto.createHmac('sha256', step4).update(stringToSign).digest('hex');
  logger.debug('AwsDebug', `Final signature: ${finalSignature}`);
  logger.debug('AwsDebug', `Matches expected: ${finalSignature === expectedSignature}`);
}

/**
 * Helper functions for signing key derivation (needed for comprehensive analysis)
 */
function getSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(date).digest();
  
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

function calculateSignature(signingKey: Buffer, stringToSign: string): string {
  return crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

/**
 * Log detailed signature verification failure information
 */
export function logSignatureVerificationFailure(req: any, authInfo: AuthInfo, originalUrl: URL, payloadHash: string, canonicalRequest: string, stringToSign: string, expectedSignature: string): void {
  const requestId = req.id || 'unknown';
  logger.warn('AwsDebug', `[${requestId}] Signature validation: FAILED`);
  logger.debug('AwsDebug', `[${requestId}] === SIGNATURE VERIFICATION FAILED - DEBUG INFO ===`);
  logger.debug('AwsDebug', `[${requestId}] Request method: ${req.method}`);
  logger.debug('AwsDebug', `[${requestId}] Original URL: ${req.originalUrl}`);
  logger.debug('AwsDebug', `[${requestId}] Path used: ${originalUrl.pathname}`);
  logger.debug('AwsDebug', `[${requestId}] Query string: ${originalUrl.search.slice(1) || '(none)'}`);
  
  // Log ALL request headers in detail (this is crucial for debugging)
  logger.debug('AwsDebug', `[${requestId}] === ALL REQUEST HEADERS ===`);
  
  const formattedHeaders: { [key: string]: string } = {};
  Object.entries(req.headers).forEach(([key, value]) => {
    // Format array values for better readability
    if (Array.isArray(value)) {
      formattedHeaders[key] = value.map((v: any) => String(v)).join(', ');
    } else {
      formattedHeaders[key] = value as string;
    }
    logger.debug('AwsDebug', `Header [${key}]: "${redactHeaderValue(key, formattedHeaders[key])}"`);
  });
  logger.debug('AwsDebug', '=== END HEADERS ===');

  // Log specific headers used in signature verification
  logger.debug('AwsDebug', `Host header: ${req.headers.host}`);
  logger.debug('AwsDebug', `Content-Type: ${req.headers['content-type']}`);
  logger.debug('AwsDebug', `X-Amz-Date: ${req.headers['x-amz-date']}`);
  logger.debug('AwsDebug', `X-Amz-Content-Sha256: ${req.headers['x-amz-content-sha256']}`);
  logger.debug('AwsDebug', `Authorization header: ${redactHeaderValue('authorization', req.headers.authorization)}`);

  // Compare signed headers with actual headers
  logger.debug('AwsDebug', '=== SIGNED HEADERS CHECK ===');
  logger.debug('AwsDebug', `Signed headers from auth: ${authInfo.signedHeaders.join(';')}`);
  authInfo.signedHeaders.forEach(header => {
    logger.debug('AwsDebug', `SignedHeader [${header}] found in request: ${req.headers[header.toLowerCase()] !== undefined ? 'Yes' : 'No'}, Value: "${redactHeaderValue(header, req.headers[header.toLowerCase()])}"`);
  });
  logger.debug('AwsDebug', '=== END SIGNED HEADERS CHECK ===');
  
  logger.debug('AwsDebug', `Payload hash used: ${payloadHash}`);
  logger.debug('AwsDebug', `Raw request body: ${req.body ? JSON.stringify(req.body).substring(0, 200) + '...' : '(empty)'}`);
  logger.debug('AwsDebug', '--- CANONICAL REQUEST ---');
  logger.debug('AwsDebug', canonicalRequest);
  logger.debug('AwsDebug', '--- STRING TO SIGN ---');
  logger.debug('AwsDebug', stringToSign);
  logger.debug('AwsDebug', `Expected signature (full): ${expectedSignature}`);
  logger.debug('AwsDebug', `Provided signature (full): ${authInfo.signature}`);
  logger.debug('AwsDebug', '================================================');
}

/**
 * Log successful signature verification information
 */
export function logSuccessfulSignatureVerification(req: any, authInfo: AuthInfo, originalUrl: URL): void {
  const requestId = req.id || 'unknown';
  logger.info('AwsDebug', `[${requestId}] Signature validation: PASSED`);
  logger.debug('AwsDebug', `[${requestId}] === SUCCESSFUL SIGNATURE VERIFICATION - DEBUG INFO ===`);
  logger.debug('AwsDebug', `[${requestId}] Request method: ${req.method}`);
  logger.debug('AwsDebug', `[${requestId}] Original URL: ${req.originalUrl}`);
  logger.debug('AwsDebug', `[${requestId}] Path used: ${originalUrl.pathname}`);
  logger.debug('AwsDebug', `[${requestId}] Query string: ${originalUrl.search.slice(1) || '(none)'}`);
  logger.debug('AwsDebug', `[${requestId}] Signed headers: ${authInfo.signedHeaders.join(';')}`);
  logger.debug('AwsDebug', `[${requestId}] ====================================================`);
}

/**
 * Check for header formatting issues
 */
function checkHeaderFormatting(headers: { [key: string]: any }, signedHeaders: string[]): string[] {
  const issues: string[] = [];
  
  // Check for trailing spaces in header values
  signedHeaders.forEach(headerName => {
    const headerValue = headers[headerName.toLowerCase()];
    if (headerValue) {
      const trimmed = headerValue.trim();
      if (headerValue !== trimmed) {
        issues.push(`Header "${headerName}" has leading/trailing whitespace`);
      }
    }
  });
  
  // Check for case sensitivity issues
  const lowerCaseHeaders = Object.keys(headers).map(h => h.toLowerCase());
  signedHeaders.forEach(header => {
    const lowerHeader = header.toLowerCase();
    if (!lowerCaseHeaders.includes(lowerHeader)) {
      issues.push(`Header "${header}" might have case sensitivity issues`);
    }
  });
  
  return issues;
}

/**
 * Check for missing signed headers
 */
function checkMissingHeaders(headers: { [key: string]: any }, signedHeaders: string[]): string[] {
  const missing: string[] = [];
  const lowerCaseHeaders = Object.keys(headers).map(h => h.toLowerCase());
  
  signedHeaders.forEach(header => {
    const lowerHeader = header.toLowerCase();
    if (!lowerCaseHeaders.includes(lowerHeader)) {
      missing.push(header);
    }
  });
  
  return missing;
}

/**
 * Generate a curl command to test the request
 */
function generateCurlCommand(req: any, _authInfo: AuthInfo, _payloadHash: string): string {
  const cmd = ['curl -v'];
  
  // Method
  if (req.method !== 'GET') {
    cmd.push(`-X ${req.method}`);
  }
  
  // Headers
  Object.keys(req.headers).forEach(header => {
    // Skip content-length as curl adds it
    if (header.toLowerCase() !== 'content-length') {
      cmd.push(`-H "${header}: ${redactHeaderValue(header, req.headers[header])}"`);
    }
  });
  
  // Body
  if (req.body && Object.keys(req.body).length > 0) {
    const jsonBody = JSON.stringify(req.body).replace(/"/g, '\\"');
    cmd.push(`-d "${jsonBody}"`);
  }
  
  // URL (use only host + path for clarity)
  const host = req.headers.host;
  const scheme = 'http'; // Assume http for local testing
  const url = `${scheme}://${host}${req.originalUrl}`;
  cmd.push(url);
  
  return cmd.join(' \\\n  ');
}