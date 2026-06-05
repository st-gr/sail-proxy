/**
 * Extract region from SAP AI Core URL
 * Example: https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com → prod.us-east-1
 */
export function extractRegion(aiApiUrl: string): string {
  const match = aiApiUrl.match(/https:\/\/api\.ai\.([^.]+\.[^.]+)\./);
  if (match && match[1]) {
    return match[1];
  }
  
  // Fallback to try extracting from a different pattern if needed
  const fallbackMatch = aiApiUrl.match(/\.([^.]+\.[^.]+)\.aws\./);
  if (fallbackMatch && fallbackMatch[1]) {
    return fallbackMatch[1];
  }
  
  return 'unknown';
}