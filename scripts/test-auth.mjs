// Offline integration test using the installed Claude CLI and a fake upstream.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../dist/config.js';
import { buildLaunchConfig, loadLaunchEnvironment } from '../dist/launcher.js';
import { context, findExecutable } from '../dist/platform.js';
import { createRouterServer } from '../dist/proxy.js';

const binary = findExecutable('claude');
assert.ok(binary, 'Install Claude Code before running test:auth');
const root = mkdtempSync(join(tmpdir(), 'claude-sub-native-auth-'));
const registry = loadRegistry();
const requests = [];
let status = 200;
const router = createRouterServer(registry, { environment: { ANTHROPIC_API_KEY: 'FAKE_UNUSED_SERVER_KEY' }, fetch: async (input, init) => {
  assert.equal(new URL(String(input)).origin, 'https://api.anthropic.com');
  const headers = new Headers(init.headers);
  const body = JSON.parse(init.body);
  requests.push({ key: headers.get('x-api-key'), authorization: headers.get('authorization') });
  if (status !== 200) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Offline test rejects this key' } }, { status });
  if (String(input).includes('/count_tokens')) return Response.json({ input_tokens: 10 });
  const message = { id: 'msg_offline_auth', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ROUTER_AUTH_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
  if (!body.stream) return Response.json(message);
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ROUTER_AUTH_OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });

async function invoke(environment, settings) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--settings', JSON.stringify(settings), '--model', String(settings.model), '-p', 'Return ROUTER_AUTH_OK.', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--effort', 'low'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(stdout); } catch {}
      resolve({ code, result });
    });
  });
}

try {
  mkdirSync(join(root, 'envs'));
  router.listen(0, '127.0.0.1'); await once(router, 'listening');
  const base = `http://127.0.0.1:${router.address().port}`;
  const inherited = { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'profile'), CLAUDE_CODE_OAUTH_TOKEN: 'FAKE_NATIVE_OAUTH_TOKEN', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
  const original = structuredClone(inherited);
  const ctx = context({ root, home: root });
  writeFileSync(join(root, 'envs/keys.env'), 'ANTHROPIC_API_KEY=FAKE_PROJECT_ANTHROPIC_KEY\n', { mode: 0o600 });
  let launch = buildLaunchConfig(registry, {}, loadLaunchEnvironment(registry, ctx, inherited));
  launch.environment.ANTHROPIC_BASE_URL = base;
  let result = await invoke(launch.environment, launch.settings);
  assert.equal(result.code, 0, 'Claude -p should accept the child-scoped key without interactive approval');
  assert.equal(result.result?.result?.trim(), 'ROUTER_AUTH_OK');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.key === 'FAKE_PROJECT_ANTHROPIC_KEY' && request.authorization === null));
  assert.deepEqual(inherited, original);
  console.log('PASS: installed Claude -p uses the project key through the router; parent environment stays unchanged');

  requests.length = 0;
  status = 401;
  result = await invoke(launch.environment, launch.settings);
  assert.notEqual(result.code, 0);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.key === 'FAKE_PROJECT_ANTHROPIC_KEY' && request.authorization === null));
  console.log('PASS: rejected API key fails without falling back to OAuth');

  requests.length = 0;
  status = 200;
  writeFileSync(join(root, 'envs/keys.env'), 'ANTHROPIC_API_KEY=\n');
  launch = buildLaunchConfig(registry, {}, loadLaunchEnvironment(registry, ctx, inherited));
  launch.environment.ANTHROPIC_BASE_URL = base;
  result = await invoke(launch.environment, launch.settings);
  assert.equal(result.code, 0, 'Claude -p should keep native OAuth when the project key is blank');
  assert.equal(result.result?.result?.trim(), 'ROUTER_AUTH_OK');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.key === null && request.authorization === 'Bearer FAKE_NATIVE_OAUTH_TOKEN'));
  console.log('PASS: blank project key preserves native OAuth; server key does not override it');
} finally {
  await new Promise(resolve => { router.close(resolve); router.closeAllConnections(); });
  rmSync(root, { recursive: true, force: true });
}
