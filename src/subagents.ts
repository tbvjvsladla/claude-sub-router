import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { ConfigError, isObject, ROOT } from './config.ts';
import type { Registry } from './config.ts';

export interface SubagentConfig { model: string; force: boolean }

export function loadSubagentConfig(registry: Registry, options: { root?: string; path?: string } = {}): SubagentConfig {
  const path = options.path ? resolve(options.path) : join(options.root ?? ROOT, 'config/subagents.yaml');
  let source: string;
  try { source = readFileSync(path, 'utf8'); }
  catch (error) {
    // Older installations without this optional file keep Claude's selection rules.
    if (!options.path && (error as NodeJS.ErrnoException).code === 'ENOENT') return { model: 'inherit', force: false };
    throw new ConfigError(`${path}: could not read subagent configuration`);
  }
  let value: unknown;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw new Error('Invalid YAML');
    value = document.toJS({ maxAliasCount: 100 });
  } catch { throw new ConfigError(`${path}: could not read valid YAML`); }
  if (!isObject(value) || Object.keys(value).some(key => !['model', 'force'].includes(key)) ||
      typeof value.model !== 'string' || !value.model.trim() || typeof value.force !== 'boolean') {
    throw new ConfigError(`${path}: expected only model (string) and force (boolean)`);
  }
  if (value.model !== 'inherit' && !registry.has(value.model)) {
    throw new ConfigError(`${path}: subagent model must be inherit or a registered model ID (${[...registry.keys()].join(', ')})`);
  }
  return { model: value.model, force: value.force };
}

export function applySubagentConfig(environment: NodeJS.ProcessEnv, config: SubagentConfig): void {
  delete environment.CLAUDE_SUB_SUBAGENT_CONFIG;
  delete environment.CLAUDE_CODE_SUBAGENT_MODEL;
  delete environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  if (config.model !== 'inherit') {
    environment.CLAUDE_CODE_SUBAGENT_MODEL = config.model;
    environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = config.force ? '1' : '0';
  }
}

export function assertSubagentVersion(version: string, config: SubagentConfig): void {
  if (config.model === 'inherit' || !config.force) return;
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version.trim());
  const parts = match?.slice(1).map(Number);
  if (!parts || parts[0]! < 2 || (parts[0] === 2 && (parts[1]! < 1 || (parts[1] === 1 && parts[2]! < 257)))) {
    throw new ConfigError('Forced subagent models require Claude Code >= 2.1.257; update Claude Code or set force: false');
  }
}
