import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigError, loadRegistry, ROOT } from '../src/config.ts';
import { buildLaunchConfig } from '../src/launcher.ts';
import { assertModelPolicyVersion, assertSubagentVersion, COMPACTION_MODEL_HEADER, defaultModelPolicy, loadModelPolicy, loadSubagentConfig } from '../src/subagents.ts';

test('subagent YAML rejects mistakes and missing explicit paths, with backward compatible defaults', () => {
  const registry = loadRegistry();
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-agents-'));
  const path = join(root, 'agents.yaml');
  try {
    assert.deepEqual(loadSubagentConfig(registry, { root }), { model: 'inherit', force: false });
    assert.throws(() => loadSubagentConfig(registry, { path }), /could not read/);
    for (const source of ['model: missing\nforce: true', 'model: deepseek-flash\nforce: "true"', 'model: deepseek-flash\nforce: true\nextra: true', 'model: deepseek-flash\nmodel: kimi-k3.1-pro\nforce: true', 'model: [', 'model: ""\nforce: true', 'model: deepseek-flash']) {
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
    const { environment, settings } = buildLaunchConfig(registry, {}, inherited, { ...defaultModelPolicy(), subagents: { model, force } });
    assert.equal(settings.model, 'claude-sonnet-5-5');
    assert.equal(environment.ANTHROPIC_DEFAULT_MODEL, 'claude-sonnet-5-5');
    assert.equal(environment.CLAUDE_CONFIG_DIR, '/native-profile');
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, model);
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, force ? '1' : '0');
    assert.equal(environment.CLAUDE_SUB_SUBAGENT_CONFIG, undefined);
    assert.equal(settings.env, undefined);
  }
  const { environment } = buildLaunchConfig(registry, {}, inherited, { ...defaultModelPolicy(), subagents: { model: 'inherit', force: true } });
  assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, inherited.CLAUDE_CODE_SUBAGENT_MODEL);
  assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, inherited.CLAUDE_CODE_SUBAGENT_MODEL_FORCE);
  assert.deepEqual(inherited, original);
});

test('shared feature defaults are inherit and explicit policy files retain legacy compatibility', () => {
  const registry = loadRegistry();
  assert.deepEqual(loadModelPolicy(registry, { path: join(ROOT, 'config/subagents.yaml') }), defaultModelPolicy());
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-policy-'));
  const path = join(root, 'policy.yaml');
  try {
    assert.deepEqual(loadModelPolicy(registry, { root }), defaultModelPolicy());
    writeFileSync(path, 'model: deepseek-flash\nforce: true\n');
    assert.deepEqual(loadModelPolicy(registry, { path }), { ...defaultModelPolicy(), subagents: { model: 'deepseek-flash', force: true } });
    writeFileSync(path, 'subagents:\n  model: deepseek-flash\n  force: false\ncompaction:\n  model: gpt-6-luna\nouroboros:\n  model: gpt-6.1-sol\n');
    assert.deepEqual(loadModelPolicy(registry, { path }), { subagents: { model: 'deepseek-flash', force: false }, compaction: { model: 'gpt-6-luna' }, ouroboros: { model: 'gpt-6.1-sol' } });
    for (const section of ['compaction', 'ouroboros'] as const) for (const model of registry.keys()) {
      writeFileSync(path, `${section}:\n  model: ${model}\n`);
      assert.deepEqual(loadModelPolicy(registry, { path }), { ...defaultModelPolicy(), [section]: { model } });
    }
    for (const source of [
      '{}', '[]', 'compact:\n  model: inherit', 'compaction: null', 'compaction:\n  model: missing',
      'compaction:\n  model: inherit\n  force: true', 'ouroboros:\n  model: 3', 'ouroboros:\n  model: inherit\n  extra: true',
      'subagents:\n  model: inherit\n  force: "false"', 'subagents:\n  model: inherit',
      'model: inherit\nforce: false\ncompaction:\n  model: inherit',
      'compaction:\n  model: inherit\ncompaction:\n  model: gpt-6-luna',
    ]) {
      writeFileSync(path, source);
      assert.throws(() => loadModelPolicy(registry, { path }), ConfigError, source);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local policy overrides individual keys, including false and inherit, while shared changes remain visible', () => {
  const registry = loadRegistry();
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-local-policy-'));
  const directory = join(root, 'config');
  const shared = join(directory, 'subagents.yaml');
  const local = join(directory, 'subagents.local.yaml');
  mkdirSync(directory);
  const source = 'subagents:\n  model: deepseek-flash\n  force: true\ncompaction:\n  model: gpt-6-luna\nouroboros:\n  model: claude-sonnet-5-5\n';
  try {
    writeFileSync(shared, source);
    const baseline = loadModelPolicy(registry, { root });
    writeFileSync(local, 'subagents:\n  force: false\n');
    assert.deepEqual(loadModelPolicy(registry, { root }), { ...baseline, subagents: { model: 'deepseek-flash', force: false } });
    writeFileSync(local, 'subagents:\n  model: inherit\ncompaction:\n  model: inherit\nouroboros:\n  model: inherit\n');
    assert.deepEqual(loadModelPolicy(registry, { root }), { ...defaultModelPolicy(), subagents: { model: 'inherit', force: true } });
    const override = 'subagents:\n  model: gpt-6.1-sol\n';
    writeFileSync(local, override);
    assert.deepEqual(loadModelPolicy(registry, { root }), { ...baseline, subagents: { model: 'gpt-6.1-sol', force: true } });
    writeFileSync(shared, source.replace('gpt-6-luna', 'deepseek-pro').replace('force: true', 'force: false'));
    assert.deepEqual(loadModelPolicy(registry, { root }), {
      subagents: { model: 'gpt-6.1-sol', force: false }, compaction: { model: 'deepseek-pro' }, ouroboros: baseline.ouroboros,
    });
    assert.equal(readFileSync(local, 'utf8'), override);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing and empty local policies keep shared defaults and local-only installations use code defaults', () => {
  const registry = loadRegistry();
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-empty-policy-'));
  const directory = join(root, 'config');
  const local = join(directory, 'subagents.local.yaml');
  mkdirSync(directory);
  try {
    writeFileSync(local, 'ouroboros:\n  model: claude-sonnet-5-5\n');
    assert.deepEqual(loadModelPolicy(registry, { root }), { ...defaultModelPolicy(), ouroboros: { model: 'claude-sonnet-5-5' } });
    writeFileSync(join(directory, 'subagents.yaml'), 'compaction:\n  model: gpt-6-luna\n');
    const expected = { ...defaultModelPolicy(), compaction: { model: 'gpt-6-luna' } };
    for (const source of ['', '# No overrides\n', '{}', 'subagents: {}\ncompaction: {}\nouroboros: {}\n']) {
      writeFileSync(local, source);
      assert.deepEqual(loadModelPolicy(registry, { root }), expected, source);
    }
    rmSync(local);
    assert.deepEqual(loadModelPolicy(registry, { root }), expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid local policies fail with their own path and cannot hide invalid shared policies', () => {
  const registry = loadRegistry();
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-invalid-local-'));
  const directory = join(root, 'config');
  const shared = join(directory, 'subagents.yaml');
  const local = join(directory, 'subagents.local.yaml');
  mkdirSync(directory);
  try {
    writeFileSync(shared, 'ouroboros:\n  model: inherit\n');
    for (const source of [
      'null', '[]', 'unknown: {}', 'subagents: null', 'subagents: []', 'subagents: false',
      'subagents:\n  model: missing', 'subagents:\n  model: ""', 'subagents:\n  model: 3',
      'subagents:\n  force: "false"', 'subagents:\n  force: null', 'subagents:\n  force: true\n  force: false',
      'subagents:\n  extra: true', 'compaction:\n  force: false', 'ouroboros:\n  model: missing',
      'ouroboros:\n  model: inherit\nouroboros:\n  model: gpt-6-luna', 'model: inherit\nforce: false', 'subagents: [',
    ]) {
      writeFileSync(local, source);
      assert.throws(() => loadModelPolicy(registry, { root }), error => error instanceof ConfigError && error.message.startsWith(local), source);
    }
    writeFileSync(local, 'ouroboros:\n  model: claude-sonnet-5-5\n');
    writeFileSync(shared, 'ouroboros:\n  model: missing\n');
    assert.throws(() => loadModelPolicy(registry, { root }), error => error instanceof ConfigError && error.message.startsWith(shared));
    writeFileSync(shared, 'ouroboros:\n  model: inherit\n');
    rmSync(local); mkdirSync(local);
    assert.throws(() => loadModelPolicy(registry, { root }), /subagents\.local\.yaml: could not read model policy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit policy paths select one file without applying shared or per-PC files', () => {
  const registry = loadRegistry();
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-explicit-policy-'));
  const directory = join(root, 'config');
  const path = join(root, 'selected.yaml');
  mkdirSync(directory);
  try {
    writeFileSync(join(directory, 'subagents.yaml'), 'invalid: true');
    writeFileSync(join(directory, 'subagents.local.yaml'), 'invalid: true');
    writeFileSync(path, 'compaction:\n  model: gpt-6-luna\n');
    assert.deepEqual(loadModelPolicy(registry, { root, path }), { ...defaultModelPolicy(), compaction: { model: 'gpt-6-luna' } });
    assert.throws(() => loadModelPolicy(registry, { root, path: join(root, 'missing.yaml') }), /could not read model policy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inherit leaves native model choices intact; selecting each knob only overrides its own function', () => {
  const registry = loadRegistry();
  const inherited = {
    CLAUDE_CONFIG_DIR: '/native-profile', CLAUDE_CODE_SUBAGENT_MODEL: 'native-agent', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '0', OUROBOROS_CLARIFICATION_MODEL: 'native-interview', OUROBOROS_PIN_MODELS: '0',
    OUROBOROS_QA_MODEL: 'native-qa', OUROBOROS_EXECUTION_MODEL: 'native-worker', OUROBOROS_LLM_BACKEND: 'claude_code',
  };
  const original = structuredClone(inherited);
  const baseline = buildLaunchConfig(registry, {}, inherited);
  for (const [name, value] of Object.entries(inherited)) assert.equal(baseline.environment[name], value);
  assert.equal(baseline.environment.ANTHROPIC_CUSTOM_HEADERS, undefined);
  for (const feature of ['subagents', 'compaction', 'ouroboros'] as const) {
    const policy = defaultModelPolicy();
    policy[feature].model = 'gpt-6.1-sol';
    const { environment, settings } = buildLaunchConfig(registry, {}, inherited, policy);
    assert.deepEqual(settings, baseline.settings);
    assert.equal(environment.CLAUDE_CONFIG_DIR, '/native-profile');
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, feature === 'subagents' ? 'gpt-6.1-sol' : 'native-agent');
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, feature === 'subagents' ? '0' : '1');
    assert.equal(environment.ANTHROPIC_CUSTOM_HEADERS, feature === 'compaction' ? `${COMPACTION_MODEL_HEADER}: gpt-6.1-sol` : undefined);
    assert.equal(environment.CLAUDE_CODE_GATEWAY_HINT_HEADERS, feature === 'compaction' ? '1' : '0');
    assert.equal(environment.OUROBOROS_CLARIFICATION_MODEL, feature === 'ouroboros' ? 'gpt-6.1-sol' : 'native-interview');
    assert.equal(environment.OUROBOROS_PIN_MODELS, feature === 'ouroboros' ? '1' : '0');
    assert.equal(environment.OUROBOROS_QA_MODEL, 'native-qa');
    assert.equal(environment.OUROBOROS_EXECUTION_MODEL, 'native-worker');
    assert.equal(environment.OUROBOROS_LLM_BACKEND, 'claude_code');
  }
  assert.deepEqual(inherited, original);
});

test('compaction selection checks the version needed for official request hints, while inherit needs no hints', () => {
  const policy = { ...defaultModelPolicy(), compaction: { model: 'gpt-6-luna' } };
  for (const version of ['2.1.272', '2.0.999', 'unknown']) assert.throws(() => assertModelPolicyVersion(version, policy), /2.1.273/);
  for (const version of ['2.1.273 (Claude Code)', '2.1.294', '2.2.0', '3.0.0']) assert.doesNotThrow(() => assertModelPolicyVersion(version, policy));
  assert.doesNotThrow(() => assertModelPolicyVersion('unknown', defaultModelPolicy()));
});

test('force refuses unsupported or unknown Claude versions instead of silently using another model', () => {
  const forced = { model: 'deepseek-flash', force: true };
  for (const version of ['2.1.256 (Claude Code)', '2.0.999', '1.99.999', 'unknown']) assert.throws(() => assertSubagentVersion(version, forced), /2.1.257/);
  for (const version of ['2.1.257 (Claude Code)', '2.1.294', '2.2.0', '3.0.0']) assert.doesNotThrow(() => assertSubagentVersion(version, forced));
  assert.doesNotThrow(() => assertSubagentVersion('old', { model: 'inherit', force: true }));
  assert.doesNotThrow(() => assertSubagentVersion('old', { model: 'deepseek-flash', force: false }));
});
