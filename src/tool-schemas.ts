import { isObject } from './config.ts';
import type { JsonObject, Provider } from './config.ts';

const SCHEMA_CHILDREN = new Set([
  'additionalProperties', 'unevaluatedProperties', 'propertyNames',
  'items', 'additionalItems', 'unevaluatedItems', 'contains',
  'allOf', 'anyOf', 'oneOf', 'prefixItems', 'not', 'if', 'then', 'else',
  'contentSchema',
]);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!isObject(schema)) return schema;
  const normalized = { ...schema };
  for (const [name, value] of Object.entries(schema)) {
    if (name === 'pattern' && typeof value === 'string') {
      // DeepSeek rejects JS's NUL escape in Claude's interactive Artifact tool.
      // Keep escaped backslashes and legacy octal escapes unchanged.
      normalized[name] = value.replace(/\\(?:\\|0(?![0-9]))/g, escape => escape === '\\0' ? '\\u0000' : escape);
    } else if (SCHEMA_CHILDREN.has(name)) {
      normalized[name] = normalizeSchema(value);
    } else if (SCHEMA_MAPS.has(name) && isObject(value)) {
      normalized[name] = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeSchema(child)]));
    }
  }
  return normalized;
}

export function applyToolSchemaCompatibility(body: JsonObject, provider: Provider): JsonObject {
  if (provider.id !== 'deepseek' || !Array.isArray(body.tools)) return body;
  return {
    ...body,
    tools: body.tools.map(tool => isObject(tool) && isObject(tool.input_schema)
      ? { ...tool, input_schema: normalizeSchema(tool.input_schema) }
      : tool),
  };
}
