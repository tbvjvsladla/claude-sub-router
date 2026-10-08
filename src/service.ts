import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, isObject, loadRegistry } from './config.ts';
import type { Registry } from './config.ts';
import { BASE_URL, HOST, PORT, SERVICE, checked, run } from './platform.ts';
import type { Runner } from './platform.ts';

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
export async function startRouter(registry = loadRegistry(), restart = false, options: { runner?: Runner; busy?: () => Promise<boolean>; wait?: (registry: Registry) => Promise<void> } = {}): Promise<void> {
  const runner = options.runner ?? run;
  const active = await serviceActive(runner);
  if (!active && await (options.busy ?? portBusy)()) throw new ConfigError(`${HOST}:${PORT} is already in use. Stop the manually started server or conflicting application first.`);
  if (restart) {
    await checked('systemctl', ['--user', 'reset-failed', SERVICE], runner);
    await checked('systemctl', ['--user', 'restart', SERVICE], runner);
  } else if (!active) await checked('systemctl', ['--user', 'start', SERVICE], runner);
  await (options.wait ?? waitForRouter)(registry);
}
