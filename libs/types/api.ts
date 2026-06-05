// Core API types shared across services
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string;
  maxTokens?: number;
  pricing?: {
    input: number;
    output: number;
  };
}

export interface AuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface TokenCache {
  token: string;
  expiryTime: number;
}

export interface ModelsCache {
  models: ModelInfo[];
  lastUpdated: number;
  ttl: number;
}

export interface ModelDetails {
  id: string;
  name: string;
  provider: string;
  version?: string;
  capabilities?: string[];
  contextLength?: number;
  description?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Embedding API types
export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface EmbeddingObject {
  object: 'embedding';
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// SAP AI Core embedding API types
export interface SAPEmbeddingRequest {
  config: {
    modules: {
      embeddings: {
        model: {
          name: string;
        };
      };
    };
  };
  input: {
    text: string;
    type?: string;
  };
}

export interface SAPEmbeddingResponse {
  request_id: string;
  final_result: {
    object: 'list';
    data: Array<{
      object: 'embedding';
      embedding: number[];
      index: number;
    }>;
    model: string;
    usage: {
      prompt_tokens: number;
      total_tokens: number;
    };
  };
}