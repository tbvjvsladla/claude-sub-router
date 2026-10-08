import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, isObject, loadRegistry } from './config.ts';
import type { Registry } from './config.ts';
import { readInstallation } from './installation.ts';
import { BASE_URL, HOST, PORT, SERVICE, checked, context, run } from './platform.ts';
import type { CommandResult, Context, Runner } from './platform.ts';
import { logPath, spawnStandalone, standaloneLogs, standaloneProcess, stopStandalone, withStandaloneLock } from './standalone.ts';

export async function serviceActive(runner: Runner = run): Promise<boolean> {
  return (await runner('systemctl', ['--user', 'is-active', '--quiet', SERVICE])).code === 0;
}
export function portBusy(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: HOST, port: PORT });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(new ConfigError('Could not inspect the local router port'));
    });
    socket.once('timeout', () => { socket.destroy(); reject(new ConfigError('Local router port probe timed out')); });
  });
}
export async function waitForRouter(registry: Registry, options: { fetch?: typeof fetch; active?: () => Promise<boolean>; timeout?: number } = {}): Promise<void> {
  const deadline = performance.now() + (options.timeout ?? 10_000);
  while (performance.now() < deadline) {
    if (!(await (options.active ?? serviceActive)())) throw new ConfigError('Router service stopped during startup. Run claude-sub-router logs.');
    let health: unknown;
    try {
      const response = await (options.fetch ?? fetch)(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Not ready'); }
      health = await response.json();
    } catch { await delay(100); continue; }
    if (!isObject(health) || health.status !== 'ok' || !Array.isArray(health.models) || !health.models.every(model => typeof model === 'string')) throw new ConfigError('Invalid local router health response');
    if (health.runtime !== 'typescript') throw new ConfigError('The installed router needs upgrading. Run bash install.sh.');
    if ([...registry.keys()].sort().join('\0') !== [...health.models].sort().join('\0')) throw new ConfigError('Router models differ from YAML. Run claude-sub-router restart.');
    return;
  }
  throw new ConfigError(`Router not ready at ${BASE_URL}. Run claude-sub-router logs.`);
}
export async function startRouter(registry = loadRegistry(), restart = false, options: { ctx?: Context; runner?: Runner; busy?: () => Promise<boolean>; wait?: (registry: Registry) => Promise<void> } = {}): Promise<void> {
  const ctx = options.ctx ?? context();
  const installation = readInstallation(ctx);
  const runner = options.runner ?? ctx.run;
  if (installation?.backend === 'standalone') {
    await withStandaloneLock(ctx, async () => {
      const active = () => Promise.resolve(!!standaloneProcess(ctx));
      if (restart) await stopStandalone(ctx);
      const alreadyRunning = await active();
      if (!alreadyRunning) {
        if (await (options.busy ?? portBusy)()) throw new ConfigError(`${HOST}:${PORT} is already in use. Stop the manually started server or conflicting application first.`);
        await spawnStandalone(ctx, installation);
      }
      try { await (options.wait ?? ((models: Registry) => waitForRouter(models, { active })))(registry); }
      catch (error) {
        if (!alreadyRunning) await stopStandalone(ctx);
        throw error;
      }
    });
    return;
  }
  const active = await serviceActive(runner);
  if (!active && await (options.busy ?? portBusy)()) throw new ConfigError(`${HOST}:${PORT} is already in use. Stop the manually started server or conflicting application first.`);
  if (restart) {
    await checked('systemctl', ['--user', 'reset-failed', SERVICE], runner);
    await checked('systemctl', ['--user', 'restart', SERVICE], runner);
  } else if (!active) await checked('systemctl', ['--user', 'start', SERVICE], runner);
  await (options.wait ?? waitForRouter)(registry);
}

export async function stopRouter(ctx = context()): Promise<void> {
  if (readInstallation(ctx)?.backend === 'standalone') {
    await withStandaloneLock(ctx, () => stopStandalone(ctx));
  } else await checked('systemctl', ['--user', 'stop', SERVICE], ctx.run);
}

export async function routerReport(action: 'status' | 'logs', ctx = context()): Promise<CommandResult> {
  if (readInstallation(ctx)?.backend === 'standalone') {
    const process = standaloneProcess(ctx);
    return { code: action === 'logs' || process ? 0 : 3, stderr: '', stdout: action === 'logs' ? standaloneLogs(ctx) : `${JSON.stringify({ backend: 'standalone', status: process ? 'running' : 'stopped', pid: process?.pid ?? null, base_url: BASE_URL, log_file: logPath(ctx) }, null, 2)}\n` };
  }
  return action === 'status' ? ctx.run('systemctl', ['--user', 'status', '--no-pager', SERVICE]) : ctx.run('journalctl', ['--user', '--unit', SERVICE, '--lines=100', '--no-pager']);
}
