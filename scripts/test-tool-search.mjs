// Live integration test: deferred MCP discovery, a local tool call and its reply.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../dist/config.js';
import { buildLaunchConfig, loadLaunchEnvironment } from '../dist/launcher.js';
import { findExecutable } from '../dist/platform.js';
import { createRouterServer } from '../dist/proxy.js';

if (process.argv[2] === '--mcp-server') {
  const directory = process.argv[3];
  const names = ['get_token', 'unused_alpha', 'unused_beta'];
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'router-probe', version: '1.0.0' } };
    else if (request.method === 'tools/list') result = { tools: names.map(name => ({ name, description: name === 'get_token' ? 'Get the unique router tool-search validation token.' : 'Unused negative-control tool. Never call.', inputSchema: { type: 'object', properties: {} } })) };
    else if (request.method === 'tools/call') {
      appendFileSync(join(directory, 'calls.jsonl'), `${JSON.stringify({ name: request.params.name })}\n`);
      result = { content: [{ type: 'text', text: request.params.name === 'get_token' ? readFileSync(join(directory, 'token'), 'utf8') : 'UNEXPECTED_TOOL' }] };
    } else if (request.method === 'ping') result = {};
    else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`); continue; }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  process.exit(0);
}

const binary = findExecutable('claude');
assert.ok(binary, 'Install Claude Code before running test:tool-search');
const registry = loadRegistry();
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['kimi-k3.1-pro'];
for (const model of models) assert.ok(registry.has(model), `Unknown model: ${model}`);
const root = mkdtempSync(join(tmpdir(), 'claude-sub-tool-search-'));
const token = `TOOL_SEARCH_OK_${randomUUID()}`;
writeFileSync(join(root, 'token'), token);
writeFileSync(join(root, 'calls.jsonl'), '');
const inherited = loadLaunchEnvironment(registry);
const requests = [];
const proxy = createRouterServer(registry, { environment: inherited, fetch: async (input, init) => {
  const body = JSON.parse(init.body);
  const response = await fetch(input, init);
  requests.push({ status: response.status, model: body.model, searchUsed: body.messages?.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.name === 'ToolSearch')) === true, exposed: body.tools?.map(tool => tool.name).filter(name => name?.startsWith('mcp__router_probe__')) ?? [] });
  return response;
} });
const reports = [];
try {
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  for (const model of models) {
    requests.length = 0;
    writeFileSync(join(root, 'calls.jsonl'), '');
    const launch = buildLaunchConfig(registry, {}, inherited);
    Object.assign(launch.environment, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, ENABLE_TOOL_SEARCH: 'true', MCP_CONNECTION_NONBLOCKING: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_RETRIES: '0' });
    delete launch.environment.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    launch.settings.disableAllHooks = true;
    const mcp = { mcpServers: { router_probe: { type: 'stdio', command: process.execPath, args: [fileURLToPath(import.meta.url), '--mcp-server', root] } } };
    const prompt = 'First use ToolSearch with query "select:mcp__router_probe__get_token" to discover the token tool. Then call that tool and reply with exactly its returned token. Do not call any unused tools.';
    const args = ['--settings', JSON.stringify(launch.settings), '--model', model, '-p', prompt, '--output-format', 'json', '--tools', 'ToolSearch', '--allowedTools', 'ToolSearch', 'mcp__router_probe__get_token', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--effort', 'low', '--system-prompt', 'Follow the user instructions. Discover and call the requested diagnostic tool.'];
    const started = performance.now();
    const result = await new Promise(resolve => {
      const child = spawn(binary, args, { cwd: root, env: launch.environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
      child.stderr.resume();
      const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const timeout = setTimeout(() => kill('SIGTERM'), 90000);
      const force = setTimeout(() => kill('SIGKILL'), 95000);
      child.once('error', () => { clearTimeout(timeout); clearTimeout(force); resolve({ code: -1 }); });
      child.once('close', code => { clearTimeout(timeout); clearTimeout(force); let response; try { response = JSON.parse(stdout); } catch {} resolve({ code, response }); });
    });
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const searchUsed = requests.some(request => request.searchUsed);
    const unusedLoaded = requests.some(request => request.exposed.some(name => name.includes('unused_')));
    const passed = result.code === 0 && !result.response?.is_error && result.response?.result?.trim() === token && searchUsed && !unusedLoaded && calls.length === 1 && calls[0].name === 'get_token' && requests.length >= 3 && requests.every(request => request.status === 200);
    const report = { model, passed, exit_code: result.code, duration_ms: Math.round(performance.now() - started), search_used: searchUsed, unused_tools_loaded: unusedLoaded, tool_calls: calls, requests: [...requests] };
    reports.push(report); console.log(JSON.stringify(report));
  }
} finally {
  await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  rmSync(root, { recursive: true, force: true });
}
const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });
writeFileSync(join(artifacts, 'tool-search-e2e.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
