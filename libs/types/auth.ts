// Authentication and security types
export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  lastUsed?: string;
  usageCount: number;
  rateLimits?: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
  permissions?: string[];
}

export interface ValidatedApiKey {
  isValid: boolean;
  keyRecord?: ApiKeyRecord;
  rateLimitExceeded?: boolean;
  error?: string;
}

export interface RateLimitEntry {
  count: number;
  resetTime: number;
  windowStart: number;
}

export interface RateLimitedRequest extends Request {
  apiKey?: string;
  keyRecord?: ApiKeyRecord;
  rateLimitInfo?: {
    remaining: number;
    resetTime: number;
    limit: number;
  };
}

export interface AuthContext {
  apiKey: string;
  keyRecord: ApiKeyRecord;
  permissions: string[];
  rateLimits: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
}

export interface JWTPayload {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  scope?: string[];
  permissions?: string[];
}