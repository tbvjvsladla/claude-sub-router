import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { ConfigError, getDefaultModel, loadRegistry, validateReasoning } from '../src/config.ts';
import { buildSettings } from '../src/settings.ts';
import { buildLaunchConfig } from '../src/launcher.ts';
import { applyReasoning, responseHeaders, upstreamHeaders } from '../src/proxy.ts';

const fixture = () => ({ provider: { id: 'test', name: 'Test', protocol: 'anthropic', base_url: 'https://example.test', api_key_env: 'TEST_API_KEY' }, models: [{ id: 'test-model', upstream_model: 'upstream', display_name: 'Test', default: true }] });
function registryFor(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-config-'));
  try { writeFileSync(join(directory, 'test.yaml'), stringify(value)); return loadRegistry(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('registry preserves the existing providers, defaults and YAML aliases', () => {
  const registry = loadRegistry();
  assert.equal(getDefaultModel(registry), 'claude-sonnet-5-5');
  assert.equal(registry.get('kimi-k3')?.model.upstream_model, 'k3');
  assert.deepEqual(registry.get('deepseek-pro')?.model.reasoning, registry.get('deepseek-flash')?.model.reasoning);
  assert.equal(registry.get('deepseek-pro')?.model.reasoning?.mapping?.xhigh, 'high');
  assert.equal(registry.get('kimi-k3')?.model.reasoning?.mapping?.xhigh, 'max');
  const minimax = registry.get('minimax-m3')!;
  assert.equal(minimax.provider.base_url, 'https://api.minimax.io/anthropic');
  assert.equal(minimax.provider.api_key_env, 'MINIMAX_API_KEY');
  assert.equal(minimax.model.upstream_model, 'MiniMax-M3');
  assert.deepEqual(minimax.model.context, { window: 1000000, auto_compact_threshold: 800000 });
  assert.equal(minimax.model.reasoning?.mode, 'omit');
});

test('registry rejects duplicates, unknown fields and invalid types', () => {
  for (const modify of [
    (value: ReturnType<typeof fixture>) => value.models.push(value.models[0]!),
    (value: ReturnType<typeof fixture>) => Object.assign(value.models[0]!, { default: 'true' }),
    (value: ReturnType<typeof fixture>) => Object.assign(value.provider, { unexpected: true }),
    (value: ReturnType<typeof fixture>) => Object.assign(value.models[0]!, { context: { window: 10, auto_compact_threshold: 11 } }),
    (value: ReturnType<typeof fixture>) => Object.assign(value.provider, { base_url: 'https://secret@example.test' }),
  ]) {
    const value = fixture(); modify(value); assert.throws(() => registryFor(value), ConfigError);
  }
  const multiple = fixture(); multiple.models.push({ ...multiple.models[0]!, id: 'another' });
  assert.throws(() => registryFor(multiple), /Multiple default/);
});

test('YAML duplicate keys, malformed input, empty directories and duplicate provider IDs fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-yaml-'));
  try {
    assert.throws(() => loadRegistry(directory), /No provider/);
    writeFileSync(join(directory, 'bad.yaml'), 'provider: 1\nprovider: 2\nmodels: []');
    assert.throws(() => loadRegistry(directory), /valid YAML/);
    writeFileSync(join(directory, 'bad.yaml'), stringify(fixture()));
    writeFileSync(join(directory, 'other.yaml'), stringify(fixture()));
    assert.throws(() => loadRegistry(directory), /duplicate provider/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('subscription configuration cannot use provider keys or another upstream', () => {
  const value = fixture();
  Object.assign(value.provider, { auth: 'claude_subscription', base_url: 'https://api.anthropic.com' });
  assert.throws(() => registryFor(value), /subscription auth/);
  delete (value.provider as { api_key_env?: string }).api_key_env;
  assert.equal(registryFor(value).size, 1);
  value.provider.base_url = 'https://example.test';
  assert.throws(() => registryFor(value), /subscription auth/);
});

test('reasoning maps every configured effort without mutating other fields', () => {
  for (const entry of loadRegistry().values()) {
    for (const [effort, expected] of Object.entries(entry.model.reasoning?.mapping ?? {})) {
      const body = { output_config: { effort, format: { type: 'json_schema' } }, thinking: { type: 'adaptive' }, tools: [{ name: 'Read' }] };
      const original = structuredClone(body);
      assert.deepEqual(applyReasoning(body, entry.model), { ...original, output_config: { ...original.output_config, effort: expected } });
      assert.deepEqual(body, original);
    }
    if (entry.model.reasoning?.mode === 'map') {
      assert.throws(() => applyReasoning({ output_config: { effort: 'invalid' } }, entry.model), /No reasoning mapping/);
      for (const effort of ['toString', 'constructor', '__proto__']) assert.throws(() => applyReasoning({ output_config: { effort } }, entry.model), /No reasoning mapping/);
      assert.throws(() => applyReasoning({ output_config: [] }, entry.model), /must be an object/);
      assert.throws(() => applyReasoning({ output_config: { effort: 4 } }, entry.model), /must be a string/);
      const invalid = structuredClone(entry.model.reasoning);
      Object.assign(invalid.mapping!, { low: null });
      assert.throws(() => validateReasoning(invalid, 'test'), /non-empty string/);
    }
  }
});

test('settings and launcher preserve unrelated values and isolate native login', () => {
  const registry = loadRegistry();
  const existing = { unrelated: true, model: 'kimi-k3', modelSettings: { 'kimi-k3': { unrelated: 'keep' } } };
  const inherited = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'FAKE', ANTHROPIC_AUTH_TOKEN: 'FAKE', CLAUDE_CODE_OAUTH_TOKEN: 'FAKE', ANTHROPIC_CUSTOM_HEADERS: 'FAKE', LOCAL_ROUTER_TOKEN: 'FAKE', DEEPSEEK_API_KEY: 'FAKE', MINIMAX_API_KEY: 'FAKE' };
  const original = structuredClone({ existing, inherited });
  const { environment, settings } = buildLaunchConfig(registry, existing, inherited, '/fake-home');
  assert.equal(settings.model, 'claude-sonnet-5-5');
  assert.equal(environment.CLAUDE_CONFIG_DIR, '/fake-home/.claude-sub');
  assert.equal(environment.ANTHROPIC_DEFAULT_MODEL, settings.model);
  assert.equal(environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  for (const name of Object.keys(inherited).filter(name => name !== 'PATH')) assert.equal(environment[name], undefined);
  assert.deepEqual({ existing, inherited }, original);
  const modelSettings = settings.modelSettings as Record<string, Record<string, unknown>>;
  assert.equal(modelSettings['kimi-k3']?.autoCompactWindow, 800000);
  assert.equal(modelSettings['kimi-k3']?.unrelated, 'keep');
  assert.equal(modelSettings['minimax-m3']?.autoCompactWindow, 800000);
  assert.equal(modelSettings['claude-sonnet-5-5'], undefined);
  assert.throws(() => buildLaunchConfig(registry, { env: {} }, {}), /must not contain/);
  assert.throws(() => buildSettings({ modelPicker: [] }, registry), /must be objects/);
});

test('M3 strips unsupported effort without mutating thinking, tools, history or structured output', () => {
  const model = loadRegistry().get('minimax-m3')!.model;
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', null]) {
    for (const thinking of [{ type: 'adaptive', display: 'updates' }, { type: 'disabled' }]) {
      const body = { output_config: { effort, format: { type: 'json_schema' } }, thinking, messages: [{ role: 'user', content: 'FAKE' }], tools: [{ name: 'Read' }] };
      const original = structuredClone(body);
      assert.deepEqual(applyReasoning(body, model), { ...original, output_config: { format: { type: 'json_schema' } } });
      assert.deepEqual(body, original);
      assert.deepEqual(applyReasoning({ output_config: { effort }, thinking }, model), { thinking });
    }
  }
  assert.deepEqual(applyReasoning({ thinking: { type: 'adaptive' } }, model), { thinking: { type: 'adaptive' } });
  assert.deepEqual(applyReasoning({}, model), {});
  assert.throws(() => applyReasoning({ output_config: [] }, model), /must be an object/);
  for (const extra of [{ mapping: { low: 'low' } }, { unsupported_level: 'error' }]) assert.throws(() => validateReasoning({ ...model.reasoning, ...extra }, 'test'), /omit must not define/);
});

test('authentication headers are split and response secrets are excluded', () => {
  const incoming = new Headers({ authorization: 'Bearer FAKE_OAUTH', 'x-router-token': 'FAKE_LOCAL', 'x-api-key': 'FAKE_LOCAL', 'anthropic-beta': 'oauth-2025-04-20,test-feature', 'x-stainless-runtime': 'node' });
  for (const { provider } of loadRegistry().values()) {
    const headers = upstreamHeaders(incoming, provider, { [provider.api_key_env ?? '']: 'FAKE_PROVIDER_KEY' });
    assert.equal(headers.has('x-router-token'), false);
    if (provider.auth === 'claude_subscription') {
      assert.equal(headers.get('authorization'), 'Bearer FAKE_OAUTH');
      assert.equal(headers.has('x-api-key'), false);
      assert.equal(headers.get('x-stainless-runtime'), 'node');
      assert.throws(() => upstreamHeaders(new Headers(), provider, {}), /bearer authorization/);
    } else {
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.get('x-api-key'), 'FAKE_PROVIDER_KEY');
      assert.equal(headers.get('anthropic-beta'), 'test-feature');
      assert.throws(() => upstreamHeaders(incoming, provider, {}), /not configured/);
    }
  }
  const headers = responseHeaders(new Headers({ 'content-type': 'application/json', 'retry-after': '7', 'request-id': 'fake-id', 'anthropic-ratelimit-unified-status': 'rejected', 'authorization': 'FAKE', 'set-cookie': 'FAKE', 'content-encoding': 'gzip', 'content-length': '999' }));
  assert.deepEqual(Object.keys(headers).sort(), ['anthropic-ratelimit-unified-status', 'content-type', 'request-id', 'retry-after']);
});
