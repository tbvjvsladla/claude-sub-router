import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export type JsonObject = Record<string, unknown>;
export interface Reasoning {
  mode: 'observe' | 'map' | 'omit';
  source?: { effort: string; thinking?: string };
  mapping?: Record<string, string>;
  unsupported_level?: string;
}
export interface Model {
  id: string;
  upstream_model: string;
  display_name: string;
  description?: string;
  default?: boolean;
  context?: { window: number; auto_compact_threshold?: number };
  reasoning?: Reasoning;
}
export interface Provider {
  id: string;
  name: string;
  protocol: 'anthropic';
  base_url: string;
  auth?: 'api_key' | 'claude_subscription';
  api_key_env?: string;
  api_key_header?: 'x-api-key' | 'authorization';
}
export type Registry = Map<string, { provider: Provider; model: Model }>;
export class ConfigError extends Error {}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: unknown, required: Record<string, string>, optional: Record<string, string>, location: string): asserts value is JsonObject {
  if (!isObject(value)) throw new ConfigError(`${location}: expected an object`);
  for (const name of Object.keys(required)) {
    if (!Object.hasOwn(value, name)) throw new ConfigError(`${location}: missing field ${name}`);
  }
  const schema = { ...required, ...optional };
  for (const [name, field] of Object.entries(value)) {
    const expected = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!expected) throw new ConfigError(`${location}: unknown field ${name}`);
    const valid = expected === 'object' ? isObject(field)
      : expected === 'array' ? Array.isArray(field)
      : expected === 'integer' ? Number.isSafeInteger(field) && Number(field) > 0
      : typeof field === expected;
    if (!valid || (typeof field === 'string' && !field.trim())) {
      throw new ConfigError(`${location}.${name}: expected non-empty ${expected}`);
    }
  }
}

export function validateReasoning(value: unknown, location: string): asserts value is Reasoning {
  fields(value, { mode: 'string' }, { source: 'object', mapping: 'object', unsupported_level: 'string' }, location);
  if (value.mode === 'observe') return;
  if (value.mode !== 'map' && value.mode !== 'omit') throw new ConfigError(`${location}: mode must be observe, map or omit`);
  if (value.unsupported_level !== undefined && value.unsupported_level !== 'error') {
    throw new ConfigError(`${location}: only unsupported_level: error is supported`);
  }
  fields(value.source, { effort: 'string' }, { thinking: 'string' }, `${location}.source`);
  if (value.source.effort !== 'output_config.effort' || (value.source.thinking ?? 'thinking') !== 'thinking') {
    throw new ConfigError(`${location}: unsupported reasoning source`);
  }
  if (value.mode === 'omit') {
    if (value.mapping !== undefined || value.unsupported_level !== undefined) throw new ConfigError(`${location}: omit must not define mapping or unsupported_level`);
    return;
  }
  if (!isObject(value.mapping)) throw new ConfigError(`${location}: mapping must be an object`);
  for (const level of ['low', 'medium', 'high', 'xhigh']) {
    if (!Object.hasOwn(value.mapping, level)) throw new ConfigError(`${location}.mapping: missing level ${level}`);
  }
  for (const [level, effort] of Object.entries(value.mapping)) {
    if (!level.trim() || typeof effort !== 'string' || !effort.trim()) {
      throw new ConfigError(`${location}.mapping.${level}: expected a non-empty string`);
    }
  }
}

export function getDefaultModel(registry: Registry): string | undefined {
  const defaults = [...registry.values()].filter(entry => entry.model.default).map(entry => entry.model.id);
  if (defaults.length > 1) throw new ConfigError(`Multiple default models: ${defaults.join(', ')}`);
  return defaults[0];
}

export function loadRegistry(directory = join(ROOT, 'config/providers')): Registry {
  const paths = readdirSync(directory).filter(name => name.endsWith('.yaml')).sort();
  if (!paths.length) throw new ConfigError('No provider YAML files found');
  const registry: Registry = new Map();
  const providers = new Set<string>();
  for (const name of paths) {
    let config: unknown;
    try {
      const document = parseDocument(readFileSync(join(directory, name), 'utf8'), { uniqueKeys: true });
      if (document.errors.length) throw new Error('Invalid YAML');
      config = document.toJS({ maxAliasCount: 100 });
    } catch {
      throw new ConfigError(`${name}: could not read valid YAML`);
    }
    fields(config, { provider: 'object', models: 'array' }, {}, name);
    const provider = config.provider;
    fields(provider, { id: 'string', name: 'string', protocol: 'string', base_url: 'string' }, { auth: 'string', api_key_env: 'string', api_key_header: 'string' }, `${name}.provider`);
    if (provider.protocol !== 'anthropic') throw new ConfigError(`${name}: only anthropic protocol is supported`);
    const auth = provider.auth ?? 'api_key';
    if (auth === 'api_key') {
      if (typeof provider.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.api_key_env)) {
        throw new ConfigError(`${name}: api_key_env is required for api_key auth`);
      }
      if (provider.api_key_header !== undefined && !['x-api-key', 'authorization'].includes(String(provider.api_key_header))) {
        throw new ConfigError(`${name}: api_key_header must be x-api-key or authorization`);
      }
    } else if (auth === 'claude_subscription') {
      if ('api_key_env' in provider || 'api_key_header' in provider || String(provider.base_url).replace(/\/+$/, '') !== 'https://api.anthropic.com') {
        throw new ConfigError(`${name}: subscription auth requires the official Anthropic URL and no api_key_env or api_key_header`);
      }
    } else throw new ConfigError(`${name}: unsupported auth type`);
    let url: URL;
    try { url = new URL(String(provider.base_url)); } catch { throw new ConfigError(`${name}: invalid base_url`); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError(`${name}: base_url must be an HTTP(S) URL without credentials, query or fragment`);
    }
    const providerId = String(provider.id);
    if (providers.has(providerId)) throw new ConfigError(`${name}: duplicate provider ID ${providerId}`);
    providers.add(providerId);
    const models = config.models as unknown[];
    if (!models.length) throw new ConfigError(`${name}: models must not be empty`);
    for (const [index, model] of models.entries()) {
      const location = `${name}.models[${index}]`;
      fields(model, { id: 'string', upstream_model: 'string', display_name: 'string' }, { description: 'string', default: 'boolean', context: 'object', reasoning: 'object' }, location);
      if (model.context !== undefined) {
        fields(model.context, { window: 'integer' }, { auto_compact_threshold: 'integer' }, `${location}.context`);
        if (Number(model.context.auto_compact_threshold ?? model.context.window) > Number(model.context.window)) {
          throw new ConfigError(`${location}: auto_compact_threshold exceeds window`);
        }
      }
      if (model.reasoning !== undefined) validateReasoning(model.reasoning, `${location}.reasoning`);
      const modelId = String(model.id);
      if (registry.has(modelId)) throw new ConfigError(`${location}: duplicate model ID ${modelId}`);
      registry.set(modelId, { provider: provider as unknown as Provider, model: model as unknown as Model });
    }
  }
  getDefaultModel(registry);
  return registry;
}
