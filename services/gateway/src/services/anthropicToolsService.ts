// Service for Anthropic tool handling
import { removeUnsupportedSchemaKeywords, validateAndCleanSchema, fixEmptyAdditionalProperties } from './anthropicSchemaUtils';
import { logToolInfo } from './anthropicUtils';
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Type definitions for tool formats
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: JSONSchema;
  strict?: boolean;
}

interface JSONSchema {
  $schema?: string;
  description?: string;
  type?: string;
  properties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  required?: string[];
  items?: JSONSchema;
  [key: string]: any;
}

interface SAPTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    strict: boolean;
    parameters: JSONSchema;
  };
}

interface AnthropicToolChoice {
  type: 'function' | 'tool';
  function?: {
    name: string;
  };
  name?: string;
}

type ToolChoiceValue = string | AnthropicToolChoice;

interface SAPToolChoice {
  type: 'function';
  function: {
    name: string;
  };
}

/**
 * Creates a standardized empty schema for tools that take no parameters.
 * @param description - The description for the tool.
 * @returns An empty JSON schema.
 */
function createEmptySchema(description?: string): JSONSchema {
  return {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "description": description || "No input is required.",
    "type": "object",
    "properties": {},
    "additionalProperties": false,
    "required": []
  };
}

/**
 * Determines if a tool's schema indicates it takes no parameters.
 * @param schema - The tool's parameter schema.
 * @returns True if the tool appears to take no parameters.
 */
function isEmptyToolSchema(schema: JSONSchema | null | undefined): boolean {
  if (!schema) return true; // No schema means no parameters
  return (
    (schema.description &&
     (schema.description.includes("No input is required") ||
      schema.description.includes("leave this field blank") ||
      schema.description.includes("LEAVE IT BLANK"))) ||
    (schema.properties && Object.keys(schema.properties).length === 0) ||
    (Object.keys(schema).length === 0) || // Completely empty schema object
    (schema.type === "object" && !schema.properties && !schema.required) // e.g. type:object only
  );
}

/**
 * Transforms Anthropic tool definitions to SAP AI Core Orchestration format.
 * @param anthropicTools - Array of tools in Anthropic format.
 * @returns Array of tools in SAP AI Core format, or null if no tools.
 */
export function transformToolsToSAPFormat(anthropicTools?: AnthropicTool[]): SAPTool[] | null {
  if (!anthropicTools || anthropicTools.length === 0) {
    return null;
  }

  const templatingToolsConfig: SAPTool[] = [];

  for (const tool of anthropicTools) {
    const toolName = tool.name;
    const originalSchema = tool.input_schema || {}; // Ensure originalSchema is an object
    const toolDescription = tool.description || '';
    const isStrictFunctionTool = tool.strict === true; // Check for explicit strict flag from Anthropic

    logToolInfo(toolName, originalSchema, toolDescription);

    let modifiedSchema: JSONSchema = JSON.parse(JSON.stringify(originalSchema)); // Deep clone

    if (toolName === 'TodoRead') {
      logger.info('AnthropicToolsService', `Detected TodoRead tool ('${toolName}') - using special empty schema handling`);
      modifiedSchema = createEmptySchema(originalSchema.description || "Reads todos. No input is required.");
    } else if (isEmptyToolSchema(modifiedSchema)) {
      logger.info('AnthropicToolsService', `Tool '${toolName}' takes no parameters based on its schema. Using empty schema.`);
      modifiedSchema = createEmptySchema(originalSchema.description || "No input is required for this tool.");
    } else {
      modifiedSchema = validateAndCleanSchema(modifiedSchema, toolName);
    }

    // General fix for any remaining 'additionalProperties: {}'
    fixEmptyAdditionalProperties(modifiedSchema, toolName);

    // **** START: Specific fix for 'Batch' tool's 'input' field ****
    if (toolName === 'Batch' &&
        modifiedSchema.properties &&
        modifiedSchema.properties.invocations &&
        modifiedSchema.properties.invocations.type === 'array' &&
        modifiedSchema.properties.invocations.items &&
        modifiedSchema.properties.invocations.items.properties &&
        modifiedSchema.properties.invocations.items.properties.input &&
        modifiedSchema.properties.invocations.items.properties.input.type === 'object') {

      const inputSchemaNode = modifiedSchema.properties.invocations.items.properties.input;
      logger.debug('AnthropicToolsService', `[SCHEMA_FIX_BATCH_INPUT] For Batch tool, path '...invocations.items.properties.input', ensuring 'additionalProperties: false'. Original: ${JSON.stringify(inputSchemaNode.additionalProperties)}`);
      inputSchemaNode.additionalProperties = false;

      // If SAP AI Core requires additionalProperties: false, it might also expect 'properties: {}'
      // and 'required: []' if no specific properties are defined for the input,
      // to explicitly state that no *undefined* properties are allowed and no specific ones are defined/required.
      // This matches the structure of your "older implementation" payload that didn't cause a 400.
      if (!inputSchemaNode.properties) {
        inputSchemaNode.properties = {};
        logger.debug('AnthropicToolsService', `[SCHEMA_FIX_BATCH_INPUT] Added 'properties: {}' to Batch tool's input schema.`);
      }
      if (!inputSchemaNode.required) {
        inputSchemaNode.required = [];
        logger.debug('AnthropicToolsService', `[SCHEMA_FIX_BATCH_INPUT] Added 'required: []' to Batch tool's input schema.`);
      }
    }
    // **** END: Specific fix for 'Batch' tool's 'input' field ****

    if (isStrictFunctionTool || (tool.name && tool.input_schema)) {
      logger.info('AnthropicToolsService', `Applying strict schema modifications for tool '${toolName}'.`);
      removeUnsupportedSchemaKeywords(modifiedSchema, toolName);
    }
    
    // Final check on additionalProperties and required fields
    // This block might conflict if fixEmptyAdditionalProperties sets it to true.
    // If additionalProperties becomes true, this block shouldn't run or should be smarter.
    if (modifiedSchema.additionalProperties === false && modifiedSchema.properties && typeof modifiedSchema.properties === 'object') {
        const allPropertyKeys = Object.keys(modifiedSchema.properties);
        if (!modifiedSchema.required || !arraysEqual(modifiedSchema.required.sort(), allPropertyKeys.sort())) {
            logger.info('AnthropicToolsService', `Ensuring 'required' array for '${toolName}' includes all properties due to additionalProperties=false. Properties: ${allPropertyKeys.join(', ')}`);
            modifiedSchema.required = allPropertyKeys;
        }
    }

    templatingToolsConfig.push({
      type: "function",
      function: {
        name: toolName,
        description: toolDescription,
        strict: true, // SAP AI Core tools are generally strict
        parameters: modifiedSchema
      }
    });
  }

  return templatingToolsConfig.length > 0 ? templatingToolsConfig : null;
}

/**
 * Transforms Anthropic tool_choice to SAP AI Core format.
 * @param anthropicToolChoice - The tool_choice from Anthropic request.
 * @returns tool_choice in SAP AI Core format, or null.
 */
export function transformToolChoiceToSAPFormat(anthropicToolChoice?: ToolChoiceValue): string | SAPToolChoice | null {
  if (!anthropicToolChoice) {
    return null;
  }
  logger.debug('AnthropicToolsService', `Found tool_choice in the request: ${JSON.stringify(anthropicToolChoice)}`);
  let toolChoiceConfig: string | SAPToolChoice | null = null;

  if (typeof anthropicToolChoice === 'string') {
    if (anthropicToolChoice === 'auto' || anthropicToolChoice === 'any') { // 'any' is like 'auto'
      toolChoiceConfig = 'auto';
    } else if (anthropicToolChoice === 'none') {
      toolChoiceConfig = 'none';
    } else if (anthropicToolChoice === 'required') { // Anthropic specific
        // SAP AI Core doesn't have a direct 'required' equivalent like OpenAI.
        // 'auto' is the closest, or a specific function if one must be called.
        // For now, map to 'auto' and let the model decide.
        // If a specific tool is required, it should be specified by name.
        logger.warn('AnthropicToolsService', "Anthropic 'tool_choice: required' is mapped to 'auto' for SAP AI Core.");
        toolChoiceConfig = 'auto';
    }
  } else if (typeof anthropicToolChoice === 'object' && anthropicToolChoice.type === 'function' && anthropicToolChoice.function?.name) {
    toolChoiceConfig = {
      "type": "function",
      "function": {
        "name": anthropicToolChoice.function.name
      }
    };
  } else if (typeof anthropicToolChoice === 'object' && anthropicToolChoice.type === 'tool' && anthropicToolChoice.name) {
     // This is for Claude's specific tool choice by name
     toolChoiceConfig = {
      "type": "function", // Still "function" for SAP AI Core
      "function": {
        "name": anthropicToolChoice.name
      }
    };
  }


  if (toolChoiceConfig) {
    logger.info('AnthropicToolsService', `Transformed tool_choice for SAP AI Core format: ${JSON.stringify(toolChoiceConfig)}`);
  } else {
    logger.warn('AnthropicToolsService', `Unsupported tool_choice format: ${JSON.stringify(anthropicToolChoice)}`);
  }
  return toolChoiceConfig;
}

// Helper to compare arrays (for 'required' field check)
function arraysEqual(a: string[], b: string[]): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export default {
  transformToolsToSAPFormat,
  transformToolChoiceToSAPFormat,
};