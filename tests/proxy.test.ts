import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { loadRegistry } from '../src/config.ts';
import { createRouterServer } from '../src/proxy.ts';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

test('real loopback HTTP preserves routing, auth, JSON, SSE, gzip and provider errors for every model', async () => {
  const registry = loadRegistry();
  const calls: { headers: Record<string, unknown>; body: Record<string, unknown>; url: string }[] = [];
  let status = 200;
  let compressed = false;
  let content = '';
  let contentType = 'application/json';
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()), url: request.url ?? '' });
    const bytes = compressed ? gzipSync(content) : Buffer.from(content);
    response.writeHead(status, { 'content-type': contentType, 'retry-after': '7', 'x-should-retry': 'false', 'anthropic-ratelimit-unified-status': 'rejected', 'request-id': 'fake-id', 'set-cookie': 'FAKE_SECRET', 'authorization': 'FAKE_SECRET', ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
    response.end(bytes);
  });
  const upstreamUrl = await listen(upstream);
  const environment: NodeJS.ProcessEnv = {};
  for (const { provider } of registry.values()) if (provider.api_key_env) environment[provider.api_key_env] = 'FAKE_PROVIDER_KEY';
  const proxy = createRouterServer(registry, { environment, fetch: (input, init) => {
    const url = new URL(String(input)); return fetch(`${upstreamUrl}${url.pathname}${url.search}`, init);
  } });
  const base = await listen(proxy);
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await (await fetch(`${base}/health`)).json() as { runtime: string }).runtime, 'typescript');
    assert.equal((await (await fetch(`${base}/v1/models`)).json() as { data: unknown[] }).data.length, registry.size);
    for (const [modelId, { model, provider }] of registry) {
      for (const [path, code, stream, gzip] of [
        ['/v1/messages', 200, false, false], ['/v1/messages', 200, true, false],
        ['/v1/messages', 401, false, false], ['/v1/messages', 403, true, false], ['/v1/messages', 429, false, false],
        ['/v1/messages/count_tokens', 200, false, false], ['/v1/messages/count_tokens', 401, false, false], ['/v1/messages/count_tokens', 429, false, false],
        ['/v1/messages', 200, false, true], ['/v1/messages', 200, true, true],
      ] as const) {
        status = code; compressed = gzip;
        contentType = stream && code === 200 ? 'text/event-stream' : 'application/json';
        content = code >= 400 ? JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'FAKE_ERROR' } }) : stream ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : JSON.stringify({ input_tokens: 12 });
        const before = calls.length;
        const response = await fetch(`${base}${path}?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer FAKE_OAUTH', 'x-router-token': 'FAKE_LOCAL', 'anthropic-beta': 'oauth-2025-04-20,test-feature' }, body: JSON.stringify({ model: modelId, stream, messages: [{ role: 'user', content: 'FAKE_PROMPT' }], output_config: { effort: 'xhigh' } }) });
        assert.equal(response.status, code);
        assert.equal(await response.text(), content);
        assert.equal(calls.length, before + 1);
        assert.equal(response.headers.get('retry-after'), '7');
        assert.equal(response.headers.get('request-id'), 'fake-id');
        for (const name of ['set-cookie', 'authorization', 'content-encoding']) assert.equal(response.headers.has(name), false);
        const call = calls.at(-1)!;
        assert.equal(call.url.endsWith(`${path}?beta=true`), true);
        assert.equal(call.body.model, model.upstream_model);
        assert.equal(call.headers['x-router-token'], undefined);
        if (provider.auth === 'claude_subscription') {
          assert.equal(call.headers.authorization, 'Bearer FAKE_OAUTH'); assert.equal(call.headers['x-api-key'], undefined);
        } else {
          if (provider.api_key_header === 'authorization') {
            assert.equal(call.headers.authorization, 'Bearer FAKE_PROVIDER_KEY'); assert.equal(call.headers['x-api-key'], undefined);
          } else {
            assert.equal(call.headers.authorization, undefined); assert.equal(call.headers['x-api-key'], 'FAKE_PROVIDER_KEY');
          }
          assert.equal(call.headers['anthropic-beta'], 'test-feature');
        }
        if (model.reasoning?.mode === 'omit') assert.equal(call.body.output_config, undefined);
        else if (path === '/v1/messages') assert.equal((call.body.output_config as Record<string, string>).effort, model.reasoning?.mode === 'map' ? model.reasoning.mapping?.xhigh : 'xhigh');
      }
    }
    assert.equal(calls.length, registry.size * 10);
    const before = calls.length;
    for (const [body, expected] of [[{ model: 'unknown' }, 400], [{ model: 3 }, 400], [[], 400]] as const) {
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, expected); await response.body?.cancel();
    }
    for (const [modelId, { provider }] of registry) {
      if (provider.api_key_env) delete environment[provider.api_key_env];
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: modelId }) });
      assert.equal(response.status, provider.auth === 'claude_subscription' ? 401 : 503); await response.body?.cancel();
    }
    assert.equal(calls.length, before);
    assert.equal((await fetch(`${base}/api/hello`, { method: 'HEAD' })).status, 404);
  } finally { await close(proxy); await close(upstream); }
});

test('SSE streams immediately with backpressure and cancels upstream on disconnect', async () => {
  const registry = loadRegistry();
  let cancelled = false;
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    const timer = setTimeout(() => response.end('data: final\n\n'), 2000);
    response.once('close', () => { clearTimeout(timer); cancelled = true; });
  });
  const address = await listen(upstream);
  const proxy = createRouterServer(registry, { environment: { MOONSHOT_API_KEY: 'FAKE' }, fetch: (_input, init) => fetch(address, init) });
  const base = await listen(proxy);
  try {
    const started = performance.now();
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ model: 'kimi-k3', stream: true }) });
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
    assert.ok(performance.now() - started < 1500);
    controller.abort(); await reader.cancel().catch(() => {});
    for (let attempt = 0; attempt < 50 && !cancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
  } finally { await close(proxy); await close(upstream); }
});

test('invalid JSON, body limits and upstream failures are bounded', async () => {
  const proxy = createRouterServer(loadRegistry(), { environment: { MOONSHOT_API_KEY: 'FAKE' }, bodyLimit: 100, fetch: async () => { throw new TypeError('FAKE_PRIVATE_DETAIL'); } });
  const base = await listen(proxy);
  try {
    for (const [body, status] of [['{', 400], ['x'.repeat(101), 413], ['{"model":"kimi-k3"}', 502]] as const) {
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', body });
      assert.equal(response.status, status); assert.equal((await response.text()).includes('FAKE_PRIVATE_DETAIL'), false);
    }
  } finally { await close(proxy); }
});

test('upstream timeouts abort the connection and redirects never forward credentials', async () => {
  const registry = loadRegistry();
  let disconnected = false;
  let redirectCalls = 0;
  const target = createServer((_request, response) => { redirectCalls++; response.end('unexpected'); });
  const targetUrl = await listen(target);
  const upstream = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(307, { location: targetUrl }); response.end('redirect'); }
    else response.once('close', () => { disconnected = true; });
  });
  const address = await listen(upstream);
  let redirect = false;
  const proxy = createRouterServer(registry, { environment: { MOONSHOT_API_KEY: 'FAKE' }, timeoutMs: 50, fetch: (_input, init) => fetch(`${address}/${redirect ? 'redirect' : 'timeout'}`, init) });
  const base = await listen(proxy);
  try {
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"model":"kimi-k3"}' });
    assert.equal(response.status, 502); await response.text();
    for (let attempt = 0; attempt < 50 && !disconnected; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(disconnected, true);
    redirect = true;
    const redirected = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"model":"kimi-k3"}', redirect: 'manual' });
    assert.equal(redirected.status, 307); assert.equal(await redirected.text(), 'redirect');
    assert.equal(redirectCalls, 0); assert.equal(redirected.headers.has('location'), false);
  } finally { await close(proxy); await close(upstream); await close(target); }
});
