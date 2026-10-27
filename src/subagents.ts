import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { ConfigError, isObject, ROOT } from './config.ts';
import type { Registry } from './config.ts';

export interface SubagentConfig { model: string; force: boolean }
export interface ModelPolicy {
  subagents: SubagentConfig;
  compaction: { model: string };
  ouroboros: { model: string };
}

export const COMPACTION_MODEL_HEADER = 'x-claude-sub-compaction-model';
export const COMPACTION_POLICY_FEATURE = 'compaction-model-policy';

export function defaultModelPolicy(): ModelPolicy {
  return { subagents: { model: 'inherit', force: false }, compaction: { model: 'inherit' }, ouroboros: { model: 'inherit' } };
}

/** Loads shared defaults and per-PC overrides, or one explicitly selected policy file. */
export function loadModelPolicy(registry: Registry, options: { root?: string; path?: string } = {}): ModelPolicy {
  const policy = defaultModelPolicy();
  if (options.path) {
    readPolicy(resolve(options.path), false, false);
  } else {
    const directory = join(options.root ?? ROOT, 'config');
    readPolicy(join(directory, 'subagents.yaml'), true, false);
    readPolicy(join(directory, 'subagents.local.yaml'), true, true);
  }
  return policy;

  function readPolicy(path: string, optional: boolean, partial: boolean): void {
    let source: string;
    try { source = readFileSync(path, 'utf8'); }
    catch (error) {
      if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw new ConfigError(`${path}: could not read model policy`);
    }
    let value: unknown;
    try {
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length) throw new Error('Invalid YAML');
      if (partial && document.contents === null) return;
      value = document.toJS({ maxAliasCount: 100 });
    } catch { throw new ConfigError(`${path}: could not read valid YAML`); }
    if (!isObject(value) || (!partial && !Object.keys(value).length)) throw new ConfigError(`${path}: expected model policy sections`);
    // Existing full policy files may use model/force; local overrides use sections only.
    if (!partial && ('model' in value || 'force' in value)) {
      readSelection(value, 'subagents');
    } else {
      if (Object.keys(value).some(key => !['subagents', 'compaction', 'ouroboros'].includes(key))) {
        throw new ConfigError(`${path}: expected only subagents, compaction and ouroboros sections`);
      }
      for (const section of ['subagents', 'compaction', 'ouroboros'] as const) {
        if (section in value) readSelection(value[section], section);
      }
    }

    function readSelection(selection: unknown, section: keyof ModelPolicy): void {
      const agent = section === 'subagents';
      if (!isObject(selection) || Object.keys(selection).some(key => !['model', ...(agent ? ['force'] : [])].includes(key))) {
        throw new ConfigError(`${path}.${section}: expected model (string)${agent ? ' and force (boolean)' : ''}`);
      }
      if (!partial || 'model' in selection) {
        const model = selection.model;
        if (typeof model !== 'string' || !/^[\x21-\x7e]+$/.test(model)) throw new ConfigError(`${path}.${section}: expected model (string)`);
        if (model !== 'inherit' && !registry.has(model)) {
          throw new ConfigError(`${path}.${section}: model must be inherit or a registered model ID (${[...registry.keys()].join(', ')})`);
        }
        policy[section].model = model;
      }
      if (agent && (!partial || 'force' in selection)) {
        if (typeof selection.force !== 'boolean') throw new ConfigError(`${path}.${section}: expected force (boolean)`);
        policy.subagents.force = selection.force;
      }
    }
  }
}

export function loadSubagentConfig(registry: Registry, options: { root?: string; path?: string } = {}): SubagentConfig {
  return loadModelPolicy(registry, options).subagents;
}

export function applySubagentConfig(environment: NodeJS.ProcessEnv, config: SubagentConfig): void {
  delete environment.CLAUDE_SUB_SUBAGENT_CONFIG;
  // inherit means no override, including the user's existing Claude environment.
  if (config.model !== 'inherit') {
    environment.CLAUDE_CODE_SUBAGENT_MODEL = config.model;
    environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = config.force ? '1' : '0';
  }
}

export function applyModelPolicy(environment: NodeJS.ProcessEnv, policy: ModelPolicy): void {
  applySubagentConfig(environment, policy.subagents);
  if (policy.compaction.model !== 'inherit') {
    environment.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1';
    // Per-client selection avoids changing other sessions on the shared router.
    environment.ANTHROPIC_CUSTOM_HEADERS = `${COMPACTION_MODEL_HEADER}: ${policy.compaction.model}`;
  }
  if (policy.ouroboros.model !== 'inherit') {
    // Ouroboros owns its own internal model resolution, outside Claude's Agent tool.
    environment.OUROBOROS_CLARIFICATION_MODEL = policy.ouroboros.model;
    environment.OUROBOROS_PIN_MODELS = '1';
  }
}

export function assertSubagentVersion(version: string, config: SubagentConfig): void {
  if (config.model === 'inherit' || !config.force) return;
  assertVersion(version, 257, 'Forced subagent models');
}

export function assertModelPolicyVersion(version: string, policy: ModelPolicy): void {
  assertSubagentVersion(version, policy.subagents);
  if (policy.compaction.model !== 'inherit') assertVersion(version, 273, 'Compaction model routing');
}

function assertVersion(version: string, patch: number, feature: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version.trim());
  const parts = match?.slice(1).map(Number);
  if (!parts || parts[0]! < 2 || (parts[0] === 2 && (parts[1]! < 1 || (parts[1] === 1 && parts[2]! < patch)))) {
    throw new ConfigError(`${feature} require Claude Code >= 2.1.${patch}; update Claude Code or disable this override`);
  }
}
