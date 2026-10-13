import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultModel, loadRegistry } from '../dist/config.js';
import { launchPreview } from '../dist/launcher.js';
import { routerReport } from '../dist/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = loadRegistry();
const models = process.argv.slice(2);
const authTest = models.length === 1 && models[0] === '--anthropic-auth';
if (models.some(model => model.startsWith('--')) && !authTest) throw new Error('Use model IDs or --anthropic-auth');
const defaultModel = getDefaultModel(registry);
if (authTest && (registry.get(defaultModel)?.provider.auth !== 'claude_native' || !launchPreview().anthropic_auth.api_key_configured)) {
  throw new Error('--anthropic-auth requires a native Anthropic default model and a configured ANTHROPIC_API_KEY; add the key to the installed env file (values omitted)');
}
const cases = authTest ? [['claude', 'sonnet'], ['claude-sub', defaultModel], ['claude-sub', 'sonnet'], ['claude-sub', null]] : models.length ? models.map(model => ['claude-sub', model]) : [
  ['claude', 'sonnet'], ...[...registry.keys()].map(model => ['claude-sub', model]),
];
const directory = mkdtempSync(join(tmpdir(), 'claude-sub-cli-'));
const reports = [];
async function logs() {
  const result = await routerReport('logs');
  if (result.code !== 0) throw new Error('Could not read router logs to verify authentication');
  return result.stdout.trim().split('\n');
}
function addedLines(before, after) {
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--) {
    if (before.slice(-overlap).every((line, index) => line === after[index])) return after.slice(overlap);
  }
  return after;
}
try {
  for (const [binary, model] of cases) {
    const environment = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
    // Native Claude keeps the caller's authentication/profile configuration.
    // Project keys are loaded by claude-sub only, never by this test driver.
    const args = ['-p', 'Reply with exactly ROUTER_E2E_OK and nothing else.', ...(model ? ['--model', model] : []),
      '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--effort', 'low',
      '--system-prompt', 'You are a connectivity test. Respond with the requested literal only.'];
    const before = authTest && binary === 'claude-sub' ? await logs() : [];
    const started = performance.now();
    const result = await new Promise(resolve => {
      const child = spawn(binary, args, { cwd: directory, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let timedOut = false;
      const terminate = signal => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
      child.stderr.resume();
      const timeout = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, 120000);
      const force = setTimeout(() => terminate('SIGKILL'), 125000);
      child.once('error', () => { clearTimeout(timeout); clearTimeout(force); resolve({ code: -1, stdout, timedOut }); });
      child.once('close', code => { clearTimeout(timeout); clearTimeout(force); resolve({ code, stdout, timedOut }); });
    });
    let response;
    try { response = JSON.parse(result.stdout); } catch {}
    let routerAuth;
    let authPassed = true;
    if (authTest && binary === 'claude-sub') {
      const routed = addedLines(before, await logs()).flatMap(line => {
        const match = /\b(REQUEST|UPSTREAM_STATUS) (\{.*\})$/.exec(line);
        try { return match ? [{ event: match[1], ...JSON.parse(match[2]) }] : []; } catch { return []; }
      }).filter(event => event.provider === 'anthropic' && event.model === defaultModel);
      routerAuth = [...new Set(routed.filter(event => event.event === 'REQUEST').map(event => event.auth))];
      authPassed = routerAuth.length === 1 && routerAuth[0] === 'api_key' && routed.some(event => event.event === 'UPSTREAM_STATUS' && event.status === 200);
    }
    const passed = result.code === 0 && !response?.is_error && response?.result?.trim() === 'ROUTER_E2E_OK' && authPassed;
    const report = { command: `${binary} -p`, model: model ?? '(default)', passed, exit_code: result.code, timed_out: result.timedOut, duration_ms: Math.round(performance.now() - started), cost_usd: response?.total_cost_usd ?? null, ...(routerAuth ? { router_auth: routerAuth } : {}), error_category: passed ? null : !authPassed ? 'authentication_not_verified' : response?.is_error ? 'provider_or_cli_error' : 'unexpected_output' };
    reports.push(report); console.log(JSON.stringify(report));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, 'artifacts/cli-e2e.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
