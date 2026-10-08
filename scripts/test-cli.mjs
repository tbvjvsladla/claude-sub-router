import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'claude-sub-cli-'));
const models = process.argv.slice(2);
const cases = models.length ? models.map(model => ['claude-sub', model]) : [
  ['claude', 'sonnet'], ...[...loadRegistry().keys()].map(model => ['claude-sub', model]),
];
const reports = [];
try {
  for (const [binary, model] of cases) {
    const environment = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
    if (binary === 'claude') {
      for (const name of Object.keys(environment)) if (name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_') || ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY'].includes(name)) delete environment[name];
    }
    const args = ['-p', 'Reply with exactly ROUTER_E2E_OK and nothing else.', '--model', model,
      '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--effort', 'low',
      '--system-prompt', 'You are a connectivity test. Respond with the requested literal only.'];
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
    const passed = result.code === 0 && !response?.is_error && response?.result?.trim() === 'ROUTER_E2E_OK';
    const report = { command: `${binary} -p`, model, passed, exit_code: result.code, timed_out: result.timedOut, duration_ms: Math.round(performance.now() - started), cost_usd: response?.total_cost_usd ?? null, error_category: passed ? null : response?.is_error ? 'provider_or_cli_error' : 'unexpected_output' };
    reports.push(report); console.log(JSON.stringify(report));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, 'artifacts/cli-e2e.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
