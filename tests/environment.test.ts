import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT, loadRegistry } from '../src/config.ts';
import { environmentFiles, loadProviderEnvironment } from '../src/environment.ts';
import { createRouterServer } from '../src/proxy.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-sub-env-'));
  mkdirSync(join(root, 'envs'));
  return root;
}

test('discovers sorted envs/*.env files and imports only registered provider keys', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'envs/USA.env'), 'MINIMAX_API_KEY=FAKE_MINIMAX\nUNREGISTERED_API_KEY=FAKE_UNUSED\nPATH=FAKE_PATH\n');
    writeFileSync(join(root, 'envs/CHINA.env'), 'export MOONSHOT_API_KEY="FAKE_KIMI"\nDEEPSEEK_API_KEY=FAKE_DEEPSEEK # comment\n');
    for (const name of ['.env.example', 'old.env.bak', 'notes.txt']) writeFileSync(join(root, 'envs', name), 'DEEPSEEK_API_KEY=FAKE_IGNORED');
    mkdirSync(join(root, 'envs/nested.env'));
    writeFileSync(join(root, 'envs/nested.env/inside.env'), 'DEEPSEEK_API_KEY=FAKE_IGNORED');
    writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=FAKE_LEGACY');
    const inherited = { PATH: '/original/path', MOONSHOT_API_KEY: 'FAKE_INHERITED', DEEPSEEK_API_KEY: '' };
    const { environment, files } = loadProviderEnvironment(loadRegistry(), { root, environment: inherited });
    assert.deepEqual(files, ['CHINA.env', 'USA.env'].map(name => join(root, 'envs', name)));
    assert.deepEqual(environment, { PATH: '/original/path', MOONSHOT_API_KEY: 'FAKE_INHERITED', DEEPSEEK_API_KEY: 'FAKE_DEEPSEEK', MINIMAX_API_KEY: 'FAKE_MINIMAX' });
    assert.equal(inherited.DEEPSEEK_API_KEY, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('allows matching or blank duplicates but rejects conflicting keys without leaking values', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'envs/CHINA.env'), 'DEEPSEEK_API_KEY=FAKE_FIRST_SECRET\n');
    writeFileSync(join(root, 'envs/USA.env'), 'DEEPSEEK_API_KEY=FAKE_FIRST_SECRET\n');
    writeFileSync(join(root, 'envs/blank.env'), 'DEEPSEEK_API_KEY=\n');
    assert.equal(loadProviderEnvironment(loadRegistry(), { root, environment: {} }).environment.DEEPSEEK_API_KEY, 'FAKE_FIRST_SECRET');
    writeFileSync(join(root, 'envs/USA.env'), 'DEEPSEEK_API_KEY=FAKE_SECOND_SECRET\n');
    assert.throws(() => loadProviderEnvironment(loadRegistry(), { root, environment: { DEEPSEEK_API_KEY: 'FAKE_OVERRIDE' } }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Conflicting DEEPSEEK_API_KEY/);
      assert.ok(error.message.includes('CHINA.env') && error.message.includes('USA.env'));
      assert.equal(error.message.includes('FAKE_'), false);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('supports a single file, legacy root .env and explicit file isolation with missing keys', () => {
  const root = fixture();
  try {
    const registry = loadRegistry();
    assert.deepEqual(loadProviderEnvironment(registry, { root, environment: {} }), { environment: {}, files: [] });
    writeFileSync(join(root, '.env'), 'MOONSHOT_API_KEY=FAKE_LEGACY');
    assert.equal(loadProviderEnvironment(registry, { root, environment: {} }).environment.MOONSHOT_API_KEY, 'FAKE_LEGACY');
    writeFileSync(join(root, 'envs/.env'), 'DEEPSEEK_API_KEY=FAKE_SINGLE');
    assert.deepEqual(loadProviderEnvironment(registry, { root, environment: {} }).environment, { DEEPSEEK_API_KEY: 'FAKE_SINGLE' });
    const explicit = join(root, 'external.env');
    writeFileSync(explicit, 'MINIMAX_API_KEY=FAKE_EXPLICIT');
    assert.deepEqual(loadProviderEnvironment(registry, { root, envFile: explicit, environment: {} }).environment, { MINIMAX_API_KEY: 'FAKE_EXPLICIT' });
    assert.deepEqual(loadProviderEnvironment(registry, { root, envFile: join(root, 'missing.env'), environment: {} }), { environment: {}, files: [] });
    rmSync(join(root, 'envs'), { recursive: true });
    assert.deepEqual(environmentFiles(root), [join(root, '.env')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dotenv parsing and the systemd shell wrapper never execute key-file commands', () => {
  const root = fixture();
  try {
    const marker = join(root, 'must-not-exist');
    const envFile = join(root, 'envs/keys.env');
    writeFileSync(envFile, `MOONSHOT_API_KEY=$(touch ${marker})\n`);
    const { environment } = loadProviderEnvironment(loadRegistry(), { root, environment: {} });
    assert.equal(environment.MOONSHOT_API_KEY, `$(touch ${marker})`);
    assert.equal(existsSync(marker), false);
    const node = join(root, 'fake-node');
    writeFileSync(node, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 });
    const wrapper = join(ROOT, 'scripts/run-router.sh');
    const expected = join(ROOT, 'dist/cli.js');
    assert.deepEqual(execFileSync('bash', [wrapper, '--auto', node], { encoding: 'utf8' }).trim().split('\n'), [expected, 'serve']);
    assert.deepEqual(execFileSync('bash', [wrapper, envFile, node], { encoding: 'utf8' }).trim().split('\n'), [expected, 'serve', '--env-file', envFile]);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses symlinks and non-regular explicit environment paths', () => {
  const root = fixture();
  try {
    const target = join(root, 'target'); writeFileSync(target, 'MOONSHOT_API_KEY=FAKE_SECRET');
    symlinkSync(target, join(root, 'envs/link.env'));
    assert.throws(() => environmentFiles(root), /regular file/);
    assert.throws(() => environmentFiles(root, join(root, 'envs')), /regular file/);
    rmSync(join(root, 'envs/link.env'));
    symlinkSync(join(root, 'missing'), join(root, 'envs/broken.env'));
    assert.throws(() => environmentFiles(root), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keys discovered in separate files authenticate the matching provider HTTP requests', async () => {
  const root = fixture();
  const registry = loadRegistry();
  writeFileSync(join(root, 'envs/CHINA.env'), 'MOONSHOT_API_KEY=FAKE_KIMI\nDEEPSEEK_API_KEY=FAKE_DEEPSEEK');
  writeFileSync(join(root, 'envs/USA.env'), 'MINIMAX_API_KEY=FAKE_MINIMAX\nOPENROUTER_API_KEY=FAKE_OPENROUTER');
  const { environment } = loadProviderEnvironment(registry, { root, environment: {} });
  const received: string[] = [];
  const server = createRouterServer(registry, { environment, fetch: async (_input, init) => {
    const headers = new Headers(init?.headers);
    received.push(headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  } });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    for (const [model, { provider }] of registry) {
      if (!provider.api_key_env) continue;
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: JSON.stringify({ model }) });
      assert.equal(response.status, 200); await response.text();
      assert.equal(received.at(-1), environment[provider.api_key_env]);
    }
    assert.equal(received.length, [...registry.values()].filter(({ provider }) => provider.api_key_env).length);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});
