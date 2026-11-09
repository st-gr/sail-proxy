// Provider-specific types for different LLM services

// Anthropic types
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

export interface AnthropicContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  system?: string;
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContent[];
  model: string;
  stop_reason?: string;
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// OpenRouter types
export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  pricing: {
    prompt: number;
    completion: number;
  };
  context_length: number;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    name: string;
    max_completion_tokens?: number;
  };
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export interface OpenRouterEndpoint {
  url: string;
  name: string;
}

export interface OpenRouterEndpointsResponse {
  data: OpenRouterEndpoint[];
}

// SAP AI Core types
export interface SAPPayload {
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string[];
  stream?: boolean;
}

export interface SAPModel {
  id: string;
  name: string;
  version: string;
  url: string;
  scenarioId: string;
  executionId: string;
  deploymentId: string;
  status: string;
  capabilities: string[];
}

export interface SAPModelsResponse {
  models: SAPModel[];
  count: number;
}

// AWS Bedrock types
export interface BedrockModelDetails {
  modelId: string;
  modelName: string;
  providerName: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedInferenceTypes: string[];
  responseStreamingSupported: boolean;
  customizationsSupported: string[];
  inferenceTypesSupported: string[];
}

export interface BedrockRequest {
  modelId: string;
  body: any;
  accept?: string;
  contentType?: string;
}

export interface BedrockResponse {
  body: any;
  contentType: string;
}

// Message streaming types
export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: string;
    role: string;
    content: any[];
    model: string;
    stop_reason?: string;
    stop_sequence?: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta';
    text: string;
  };
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason?: string;
    stop_sequence?: string;
  };
  usage: {
    output_tokens: number;
  };
}

export type StreamEvent = MessageStartEvent | ContentBlockDeltaEvent | MessageDeltaEvent;