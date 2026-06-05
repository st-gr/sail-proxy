/**
 * SAP AI Core Orchestration V2 wire types.
 *
 * Single source of truth for the orchestration request/response envelope.
 * Mirrors the V2 schema fragment that the gateway actually uses.
 *
 * Endpoint: POST {url}/v2/inference/deployments/{deploymentId}/v2/completion
 *
 * @see https://sap.github.io/ai-sdk/docs/js/orchestration/chat-completion
 * @see https://help.sap.com/doc/generative-ai-hub-sdk/CLOUD/en-US/_reference/orchestration-service2.html
 */

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

export interface SapV2Message {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string | any[];
  [key: string]: any;
}

export interface SapV2Template {
  template: SapV2Message[];
  tools?: any[];
  response_format?: any;
  defaults?: Record<string, string>;
}

export interface SapV2Model {
  name: string;
  version?: string;
  params?: Record<string, any>;
}

export interface SapV2PromptTemplating {
  prompt: SapV2Template;
  model: SapV2Model;
}

export interface SapV2Modules {
  prompt_templating: SapV2PromptTemplating;
  // Optional V2 modules — not used by this refactor but reserved here so
  // future enablement (native masking, grounding, translation) lives in the
  // same type without breaking changes.
  masking?: any;
  grounding?: any;
  translation?: any;
  filtering?: any;
}

export interface SapV2GlobalStreamOptions {
  enabled?: boolean;
  chunk_size?: number;
  delimiters?: string[];
}

export interface SapV2Config {
  modules: SapV2Modules;
  stream?: SapV2GlobalStreamOptions;
}

export interface SapV2CompletionRequest {
  config: SapV2Config;
  placeholder_values?: Record<string, any>;
  messages_history?: any[];
  /**
   * Internal-only: if present, sapAIService writes payload snapshots under
   * this id via payloadLogger. Stripped before HTTP POST so it never goes
   * over the wire.
   */
  debugRequestId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response (and streaming chunks share the same envelope)
// ─────────────────────────────────────────────────────────────────────────────

export interface SapV2Choice {
  index?: number;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: any[];
    refusal?: string;
  };
  delta?: {
    content?: string;
    tool_calls?: any[];
  };
  finish_reason?: string | null;
  logprobs?: any;
}

export interface SapV2Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface SapV2Citation {
  ref_id?: number;
  title?: string;
  url: string;
}

export interface SapV2LlmModuleResult {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  system_fingerprint?: string;
  choices?: SapV2Choice[];
  usage?: SapV2Usage;
  citations?: Array<SapV2Citation | string>;
  [key: string]: any;
}

export interface SapV2ModuleResults {
  templating?: any;
  llm?: SapV2LlmModuleResult;
  masking?: any;
  grounding?: any;
  translation?: any;
  filtering?: any;
  [key: string]: any;
}

export interface SapV2IntermediateFailure {
  message?: string;
  code?: string;
  location?: string;
}

export interface SapV2CompletionResponse {
  request_id?: string;
  intermediate_results?: SapV2ModuleResults;
  final_result?: SapV2LlmModuleResult;
  intermediate_failures?: SapV2IntermediateFailure[];
  [key: string]: any;
}
