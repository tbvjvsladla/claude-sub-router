import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, ROOT, getDefaultModel, isObject } from './config.ts';
import type { JsonObject, Registry } from './config.ts';

export function readSettings(root = ROOT): JsonObject {
  const legacy = join(root, 'config/claude-test.json');
  const path = existsSync(legacy) ? legacy : join(root, 'config/claude-settings.json');
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObject(value)) throw new ConfigError('Claude settings must be a JSON object');
  return value;
}

export function buildSettings(existing: JsonObject, registry: Registry): JsonObject {
  if (!registry.size) throw new ConfigError('Model registry must not be empty');
  const settings = structuredClone(existing);
  const picker = settings.modelPicker ?? {};
  const modelSettings = settings.modelSettings ?? {};
  if (!isObject(picker) || !isObject(modelSettings)) throw new ConfigError('modelPicker and modelSettings must be objects');
  const selected = settings.model;
  settings.model = getDefaultModel(registry) ?? (typeof selected === 'string' && registry.has(selected) ? selected : registry.keys().next().value);
  settings.availableModels = [...registry.keys()];
  picker.replaceBuiltInOptions = true;
  picker.options = [...registry.entries()].map(([model, entry]) => ({
    model, label: entry.model.display_name, description: entry.model.description ?? entry.provider.name,
  }));
  settings.modelPicker = picker;
  for (const [modelId, entry] of registry) {
    const options = modelSettings[modelId] ?? {};
    if (!isObject(options)) throw new ConfigError(`modelSettings.${modelId} must be an object`);
    const threshold = entry.model.context?.auto_compact_threshold;
    if (threshold === undefined) delete options.autoCompactWindow;
    else {
      if (threshold < 100_000 || threshold > 1_000_000) throw new ConfigError(`${modelId}: auto_compact_threshold must be 100000 to 1000000`);
      options.autoCompactWindow = threshold;
    }
    if (Object.keys(options).length) modelSettings[modelId] = options;
    else delete modelSettings[modelId];
  }
  settings.modelSettings = modelSettings;
  return settings;
}
