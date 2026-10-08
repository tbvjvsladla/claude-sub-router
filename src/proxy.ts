import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isObject } from './config.ts';
import type { JsonObject, Model, Provider, Registry } from './config.ts';

export class RouterError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function applyReasoning(body: JsonObject, model: Model): JsonObject {
  const payload = { ...body };
  const reasoning = model.reasoning;
  if (!reasoning || reasoning.mode === 'observe') return payload;
  const output = body.output_config;
  if (output == null) return payload;
  if (!isObject(output)) throw new RouterError(400, 'output_config must be an object');
  if (reasoning.mode === 'omit') {
    const preserved = { ...output };
    delete preserved.effort;
    if (Object.keys(preserved).length) payload.output_config = preserved;
    else delete payload.output_config;
    return payload;
  }
  if (output.effort == null) return payload;
  if (typeof output.effort !== 'string') throw new RouterError(400, 'output_config.effort must be a string');
  const effort = reasoning.mapping && Object.hasOwn(reasoning.mapping, output.effort) ? reasoning.mapping[output.effort] : undefined;
  if (effort === undefined) throw new RouterError(400, `No reasoning mapping for effort: ${output.effort}`);
  payload.output_config = { ...output, effort };
  return payload;
}

export function upstreamHeaders(incoming: Headers, provider: Provider, environment: NodeJS.ProcessEnv): Headers {
  const headers = new Headers({ 'content-type': 'application/json', 'anthropic-version': incoming.get('anthropic-version') ?? '2023-06-01' });
  if (provider.auth === 'claude_subscription') {
    if (provider.base_url.replace(/\/+$/, '') !== 'https://api.anthropic.com') throw new RouterError(500, 'Invalid subscription upstream');
    const authorization = incoming.get('authorization') ?? '';
    if (!/^Bearer [\x21-\x7e]+$/i.test(authorization)) throw new RouterError(401, 'Claude subscription bearer authorization is required');
    for (const [name, value] of incoming) {
      if (['anthropic-', 'x-claude-code-', 'x-stainless-'].some(prefix => name.startsWith(prefix)) || ['user-agent', 'x-app'].includes(name)) headers.set(name, value);
    }
    headers.set('authorization', authorization);
    return headers;
  }
  if (provider.auth && provider.auth !== 'api_key') throw new RouterError(500, 'Unsupported upstream auth');
  const key = environment[provider.api_key_env ?? ''] ?? '';
  if (!key.trim()) throw new RouterError(503, 'Provider API key is not configured');
  if (!/^[\x20-\x7e]+$/.test(key)) throw new RouterError(503, 'Provider API key contains invalid header characters');
  headers.set('x-api-key', key);
  const betas = (incoming.get('anthropic-beta') ?? '').split(',').map(value => value.trim()).filter(value => value && !value.toLowerCase().startsWith('oauth-'));
  if (betas.length) headers.set('anthropic-beta', betas.join(','));
  return headers;
}

export function responseHeaders(incoming: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of incoming) {
    if (name.startsWith('anthropic-') || name.startsWith('x-ratelimit-') || ['content-type', 'request-id', 'x-request-id', 'retry-after', 'x-should-retry'].includes(name)) headers[name] = value;
  }
  return headers;
}

function readBody(request: IncomingMessage, limit: number): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', error);
      request.off('aborted', aborted);
    };
    const error = () => { cleanup(); reject(new RouterError(400, 'Request body could not be read')); };
    const aborted = () => { cleanup(); reject(new RouterError(400, 'Request aborted')); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        request.resume();
        reject(new RouterError(413, 'Request body is too large'));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObject(body)) throw new Error('Not an object');
        resolve(body);
      } catch { reject(new RouterError(400, 'Request body must be a JSON object')); }
    };
    request.on('data', data).once('end', end).once('error', error).once('aborted', aborted);
  });
}

export interface ProxyOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  bodyLimit?: number;
  timeoutMs?: number;
  log?: (event: string, metadata: JsonObject) => void;
}

export function createRouterServer(registry: Registry, options: ProxyOptions = {}) {
  const environment = options.environment ?? process.env;
  const upstreamFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof RouterError ? error.status : 502;
      const detail = error instanceof RouterError ? error.message : 'Upstream connection failed';
      if (!(error instanceof RouterError)) log('UPSTREAM_CONNECTION_ERROR', { type: error instanceof Error ? error.name : 'Unknown' });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail }));
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', runtime: 'typescript', providers: [...new Set([...registry.values()].map(entry => entry.provider.id))].sort(), models: [...registry.keys()] }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [...registry.keys()].map(id => ({ id, object: 'model' })) }));
      return;
    }
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) throw new RouterError(404, 'Not Found');
    const body = await readBody(request, options.bodyLimit ?? 32 * 1024 * 1024);
    if (typeof body.model !== 'string') throw new RouterError(400, 'model must be a string');
    const entry = registry.get(body.model);
    if (!entry) throw new RouterError(400, 'Unknown model');
    const counting = url.pathname.endsWith('/count_tokens');
    const payload = counting && entry.model.reasoning?.mode !== 'omit' ? { ...body } : applyReasoning(body, entry.model);
    const incoming = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) incoming.set(name, Array.isArray(value) ? value.join(',') : value);
    }
    const headers = upstreamHeaders(incoming, entry.provider, environment);
    log('REQUEST', { provider: entry.provider.id, model: body.model, upstream_model: entry.model.upstream_model, mode: entry.model.reasoning?.mode ?? 'observe', effort_in: isObject(body.output_config) ? body.output_config.effort ?? null : null, effort_out: isObject(payload.output_config) ? payload.output_config.effort ?? null : null, stream: body.stream === true, messages: Array.isArray(body.messages) ? body.messages.length : 0, tools: Array.isArray(body.tools) ? body.tools.length : 0 });
    payload.model = entry.model.upstream_model;
    const controller = new AbortController();
    const aborted = () => controller.abort();
    const closed = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', aborted);
    response.once('close', closed);
    try {
      const upstream = await upstreamFetch(`${entry.provider.base_url.replace(/\/+$/, '')}${url.pathname}${url.search}`, {
        method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? (counting ? 60_000 : 300_000))]),
      });
      log('UPSTREAM_STATUS', { provider: entry.provider.id, model: entry.model.id, status: upstream.status });
      const selectedHeaders = responseHeaders(upstream.headers);
      if (body.stream === true && !counting && upstream.status < 400 && upstream.body) {
        selectedHeaders['content-type'] ??= 'text/event-stream';
        response.writeHead(upstream.status, selectedHeaders);
        response.flushHeaders();
        await pipeline(Readable.fromWeb(upstream.body), response);
      } else {
        const content = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, selectedHeaders);
        response.end(content);
      }
    } finally {
      request.off('aborted', aborted);
      response.off('close', closed);
    }
  }
  return server;
}
