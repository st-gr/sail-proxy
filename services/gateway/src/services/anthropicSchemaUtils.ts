// Utilities for JSON schema validation and manipulation for Anthropic services
import { getDefaultLogger } from '@libs/logger';
const logger = getDefaultLogger();

// Type definitions for JSON Schema structures
interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  description?: string;
  default?: any;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  not?: JSONSchema;
  const?: any;
  enum?: any[];
  $schema?: string;
  [key: string]: any;
}

/**
 * Removes unsupported JSON Schema keywords from a schema, particularly for strict mode.
 * @param schema - The JSON schema to clean.
 * @param toolName - The name of the tool the schema belongs to (for logging).
 * @param propertyPath - The current path in the schema (for nested logging).
 */
export function removeUnsupportedSchemaKeywords(
  schema: JSONSchema, 
  toolName: string, 
  propertyPath: string = ''
): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  // Process properties of an object schema
  if (schema.properties) {
    Object.keys(schema.properties).forEach(propName => {
      const propDef = schema.properties![propName];
      const currentPath = propertyPath ? `${propertyPath}.${propName}` : propName;

      // Remove default keyword (applies to all types)
      if (propDef && propDef.default !== undefined) {
        logger.debug('AnthropicSchemaUtils', `Removing 'default' value ${propDef.default} from property '${currentPath}' in tool '${toolName}'`);
        delete propDef.default;
      }

      // Remove unsupported keywords for string type
      if (propDef && propDef.type === 'string') {
        if (propDef.minLength !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'minLength' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.minLength;
        }
        if (propDef.maxLength !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'maxLength' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.maxLength;
        }
        if (propDef.pattern !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'pattern' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.pattern;
        }
        if (propDef.format !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'format' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.format;
        }
      }

      // Remove unsupported keywords for number/integer types
      if (propDef && (propDef.type === 'number' || propDef.type === 'integer')) {
        if (propDef.minimum !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'minimum' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.minimum;
        }
        if (propDef.maximum !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'maximum' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.maximum;
        }
        if (propDef.exclusiveMinimum !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'exclusiveMinimum' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.exclusiveMinimum;
        }
        if (propDef.exclusiveMaximum !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'exclusiveMaximum' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.exclusiveMaximum;
        }
        if (propDef.multipleOf !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'multipleOf' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.multipleOf;
        }
      }

      // Remove unsupported keywords for array types
      if (propDef && propDef.type === 'array') {
        if (propDef.minItems !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'minItems' value ${propDef.minItems} from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.minItems;
        }
        if (propDef.maxItems !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'maxItems' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.maxItems;
        }
        if (propDef.uniqueItems !== undefined) {
          logger.debug('AnthropicSchemaUtils', `Removing 'uniqueItems' from property '${currentPath}' in tool '${toolName}'`);
          delete propDef.uniqueItems;
        }

        // Recursively clean items schema for arrays
        if (propDef && propDef.items && typeof propDef.items === 'object') {
          removeUnsupportedSchemaKeywords(propDef.items, toolName, `${currentPath}.items`);
           // Fix additionalProperties=false + required in items schema
           if (propDef.items.additionalProperties === false && propDef.items.properties) {
            const itemPropertyKeys = Object.keys(propDef.items.properties || {});
            propDef.items.required = itemPropertyKeys;
            logger.info('AnthropicSchemaUtils', `Updated required array in items schema for array property '${currentPath}' to include all keys: ${itemPropertyKeys.join(', ')}`);
          }
        }
      }
      // Recursively clean nested object properties
      if (propDef && propDef.type === 'object' && propDef.properties) {
        removeUnsupportedSchemaKeywords(propDef, toolName, currentPath); // Pass propDef as it is the nested schema object
         if (propDef.additionalProperties === false) {
            const nestedPropertyKeys = Object.keys(propDef.properties);
            propDef.required = nestedPropertyKeys;
            logger.info('AnthropicSchemaUtils', `Updated required array in nested object '${currentPath}' to include all keys: ${nestedPropertyKeys.join(', ')}`);
        }
      }
    });
  }
}

/**
 * Validates and potentially sanitizes a tool's parameter schema.
 * @param paramsSchema - The original parameters schema for a tool.
 * @param toolName - The name of the tool.
 * @returns The validated and potentially modified schema.
 */
export function validateAndCleanSchema(paramsSchema: JSONSchema, toolName: string): JSONSchema {
  let modifiedSchema = { ...paramsSchema }; // Create a copy

  // Check for schema properties that might be misinterpreted as actual properties
  // or for values that are not proper schema objects
  if (modifiedSchema.properties) {
    const schemaKeywords = ['type', 'additionalProperties', 'properties', 'required',
                            'items', 'oneOf', 'anyOf', 'allOf', 'not', 'const', 'enum'];
    const suspiciousProps = Object.keys(modifiedSchema.properties).filter(prop =>
      schemaKeywords.includes(prop)
    );
    const invalidSchemas = Object.entries(modifiedSchema.properties).filter(([_, schema]) =>
      typeof schema !== 'object' && typeof schema !== 'boolean' // booleans are valid (e.g. additionalProperties: false)
    );

    if (suspiciousProps.length > 0 || invalidSchemas.length > 0) {
      logger.warn('AnthropicSchemaUtils', `⚠️ Tool '${toolName}' has potentially invalid schema structure!`);
      if (suspiciousProps.length > 0) {
        logger.warn('AnthropicSchemaUtils', `Found property names that match schema keywords: ${suspiciousProps.join(', ')}`);
      }
      if (invalidSchemas.length > 0) {
        logger.warn('AnthropicSchemaUtils', `Found properties with invalid schema types: ${invalidSchemas.map(([prop]) => prop).join(', ')}`);
        invalidSchemas.forEach(([prop, val]) => {
          logger.warn('AnthropicSchemaUtils', `Property '${prop}' has invalid schema: ${JSON.stringify(val)} (type: ${typeof val})`);
        });
      }
      logger.warn('AnthropicSchemaUtils', `This might be a misinterpreted schema. Attempting to use as-is but review is advised. Forcing a clean empty schema if it's completely malformed.`);
      // Decide if we need to fallback to an empty schema
      // This is a judgment call. If `type` is missing at top level, or properties is not an object, it's likely bad.
      if (typeof modifiedSchema.type !== 'string' || (modifiedSchema.properties && typeof modifiedSchema.properties !== 'object')) {
          logger.warn('AnthropicSchemaUtils', `Schema for '${toolName}' is critically malformed. Creating a clean empty schema.`);
          modifiedSchema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "description": modifiedSchema.description || `Parameters for ${toolName}`,
            "type": "object",
            "properties": {},
            "additionalProperties": false,
            "required": []
          };
      }
    }
  }

  // Special handling: If additionalProperties is false, include all property keys in required array
  if (modifiedSchema.additionalProperties === false && modifiedSchema.properties && typeof modifiedSchema.properties === 'object') {
    const allPropertyKeys = Object.keys(modifiedSchema.properties);
    if (!Array.isArray(modifiedSchema.required) || !modifiedSchema.required.every(r => allPropertyKeys.includes(r))) {
        logger.info('AnthropicSchemaUtils', `Modifying required array for tool '${toolName}' due to additionalProperties=false. Setting required to include all defined properties: ${allPropertyKeys.join(', ')}`);
        modifiedSchema.required = allPropertyKeys;
    }
  }
  return modifiedSchema;
}

/**
 * Recursively traverses a schema and changes 'additionalProperties: {}' to 'additionalProperties: true'.
 * @param schemaNode - The current node in the schema to process.
 * @param currentPath - The path to the current node, for logging.
 */
export function fixEmptyAdditionalProperties(schemaNode: any, currentPath: string = 'root'): void {
  if (typeof schemaNode !== 'object' || schemaNode === null) {
    return;
  }

  if (schemaNode.hasOwnProperty('additionalProperties') &&
      typeof schemaNode.additionalProperties === 'object' &&
      Object.keys(schemaNode.additionalProperties).length === 0) {
    logger.info('AnthropicSchemaUtils', `[SCHEMA_FIX] Path: '${currentPath}', Changing 'additionalProperties: {}' to 'additionalProperties: true'.`);
    schemaNode.additionalProperties = true;
  }

  // Iterate over own properties of the schemaNode
  for (const key in schemaNode) {
    if (Object.prototype.hasOwnProperty.call(schemaNode, key)) {
      // Recurse for object properties, avoiding cycles or excessive depth if necessary
      if (typeof schemaNode[key] === 'object' && schemaNode[key] !== null) {
         // Add a depth check or visited set if circular schemas are a concern
         fixEmptyAdditionalProperties(schemaNode[key], `${currentPath}.${key}`);
      }
    }
  }
}

export default {
  removeUnsupportedSchemaKeywords,
  validateAndCleanSchema,
  fixEmptyAdditionalProperties, // Export the new helper
};