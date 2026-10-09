import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRegistry } from '../src/config.ts';
import { buildLaunchConfig } from '../src/launcher.ts';
import { assertSubagentVersion, loadSubagentConfig } from '../src/subagents.ts';

test('subagent YAML rejects mistakes and missing explicit paths, with backward compatible defaults', () => {
  const registry = loadRegistry();
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-agents-'));
  const path = join(root, 'agents.yaml');
  try {
    assert.deepEqual(loadSubagentConfig(registry, { root }), { model: 'inherit', force: false });
    assert.throws(() => loadSubagentConfig(registry, { path }), /could not read/);
    for (const source of ['model: missing\nforce: true', 'model: deepseek-flash\nforce: "true"', 'model: deepseek-flash\nforce: true\nextra: true', 'model: deepseek-flash\nmodel: kimi-k3\nforce: true', 'model: [', 'model: ""\nforce: true', 'model: deepseek-flash']) {
      writeFileSync(path, source);
      assert.throws(() => loadSubagentConfig(registry, { path }));
    }
    for (const model of ['inherit', ...registry.keys()]) {
      writeFileSync(path, `model: ${model}\nforce: true\n`);
      assert.deepEqual(loadSubagentConfig(registry, { path }), { model, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('subagent overrides keep main model, profile, caller environment and settings separate', () => {
  const registry = loadRegistry();
  const inherited = { CLAUDE_CODE_SUBAGENT_MODEL: 'old', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_SUB_SUBAGENT_CONFIG: '/temporary.yaml', CLAUDE_CONFIG_DIR: '/native-profile' };
  const original = structuredClone(inherited);
  for (const model of registry.keys()) for (const force of [true, false]) {
    const { environment, settings } = buildLaunchConfig(registry, {}, inherited, { model, force });
    assert.equal(settings.model, 'claude-sonnet-5-5');
    assert.equal(environment.ANTHROPIC_DEFAULT_MODEL, 'claude-sonnet-5-5');
    assert.equal(environment.CLAUDE_CONFIG_DIR, '/native-profile');
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, model);
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, force ? '1' : '0');
    assert.equal(environment.CLAUDE_SUB_SUBAGENT_CONFIG, undefined);
    assert.equal(settings.env, undefined);
  }
  const { environment } = buildLaunchConfig(registry, {}, inherited, { model: 'inherit', force: true });
  assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
  assert.deepEqual(inherited, original);
});

test('force refuses unsupported or unknown Claude versions instead of silently using another model', () => {
  const forced = { model: 'deepseek-flash', force: true };
  for (const version of ['2.1.256 (Claude Code)', '2.0.999', '1.99.999', 'unknown']) assert.throws(() => assertSubagentVersion(version, forced), /2.1.257/);
  for (const version of ['2.1.257 (Claude Code)', '2.1.294', '2.2.0', '3.0.0']) assert.doesNotThrow(() => assertSubagentVersion(version, forced));
  assert.doesNotThrow(() => assertSubagentVersion('old', { model: 'inherit', force: true }));
  assert.doesNotThrow(() => assertSubagentVersion('old', { model: 'deepseek-flash', force: false }));
});
