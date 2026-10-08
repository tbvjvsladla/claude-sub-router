import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT } from '../src/config.ts';
import type { Registry } from '../src/config.ts';
import { chooseBackend, installationPath, readInstallation, stateDirectory } from '../src/installation.ts';
import { install, uninstall } from '../src/lifecycle.ts';
import { BASE_URL, SERVICE, context } from '../src/platform.ts';
import { routerReport, startRouter, stopRouter, waitForRouter } from '../src/service.ts';
import { logPath, standaloneProcess, withStandaloneLock } from '../src/standalone.ts';

test('backend selection supports root containers and unavailable systemd without weakening host defaults', async () => {
  const offline = context({ uid: 1000, run: async () => ({ code: 1, stdout: '', stderr: 'No medium found' }) });
  const online = context({ uid: 1000, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  assert.equal(await chooseBackend(online, 'auto', false), 'systemd');
  assert.equal(await chooseBackend(offline, 'auto', false), 'standalone');
  assert.equal(await chooseBackend({ ...offline, uid: 0 }, 'auto', true), 'standalone');
  assert.equal(await chooseBackend({ ...offline, uid: 0 }, 'standalone', false), 'standalone');
  await assert.rejects(() => chooseBackend({ ...offline, uid: 0 }, 'auto', false), /normal user/);
  await assert.rejects(() => chooseBackend(offline, 'systemd', true), /systemd is unavailable/);
  await assert.rejects(() => chooseBackend(online, 'invalid', false), /--service must/);
});

test('root standalone install and uninstall preserve Claude data and never invoke systemd', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-container-install-'));
  const root = join(directory, 'project'); const home = join(directory, 'home');
  const calls: string[][] = [];
  const ctx = context({ root, home, uid: 0, claude: '/fake/claude', run: async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: '', stderr: '' }; } });
  try {
    cpSync(join(ROOT, 'config'), join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'envs')); cpSync(join(ROOT, 'envs/.env.example'), join(root, 'envs/.env.example'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude/settings.json'), '{"statusLine":{"command":"FAKE_DASHBOARD"}}');
    writeFileSync(join(home, '.claude/.credentials.json'), 'FAKE_PRESERVED_CREDENTIALS');
    await install({ ...ctx, service: 'standalone' });
    const original = readFileSync(join(home, '.bashrc'), 'utf8');
    assert.equal(readInstallation(ctx)?.backend, 'standalone');
    assert.equal(existsSync(join(home, '.config/systemd/user', SERVICE)), false);
    assert.equal(lstatSync(installationPath(ctx)).mode & 0o777, 0o600);
    await install(ctx);
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), original);
    await assert.rejects(() => install({ ...ctx, uid: 1000, service: 'systemd' }), /switching service backends/);
    calls.length = 0;
    await uninstall({ ...ctx, dryRun: true });
    assert.equal(calls.length, 0);
    await uninstall(ctx);
    await uninstall(ctx);
    assert.equal(existsSync(join(home, '.local/bin/claude-sub')), false);
    assert.equal(readFileSync(join(home, '.claude/.credentials.json'), 'utf8'), 'FAKE_PRESERVED_CREDENTIALS');
    assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), '{"statusLine":{"command":"FAKE_DASHBOARD"}}');
    assert.equal(calls.some(call => ['systemctl', 'journalctl'].includes(call[0]!)), false);
    assert.throws(() => readInstallation({ ...ctx, root: '/another/project' }), /another installation/);
    await install({ ...ctx, uid: 1000, service: 'systemd' });
    assert.equal(readInstallation(ctx)?.backend, 'systemd');
    await uninstall({ ...ctx, uid: 1000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function fixture(registry: Registry) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-standalone-'));
  const root = join(directory, "project with ' spaces"); const home = join(directory, 'home');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const envFile = join(root, 'explicit keys.env');
  writeFileSync(envFile, 'TEST_ROUTER_API_KEY=FAKE_FROM_EXPLICIT_FILE\n', { mode: 0o600 });
  writeFileSync(join(root, '.env'), 'TEST_ROUTER_API_KEY=FAKE_WRONG_FILE\n', { mode: 0o600 });
  const proxyModule = pathToFileURL(join(ROOT, 'src/proxy.ts')).href;
  const environmentModule = pathToFileURL(join(ROOT, 'src/environment.ts')).href;
  writeFileSync(join(root, 'dist/cli.js'), `
    import { createRouterServer } from ${JSON.stringify(proxyModule)};
    import { loadProviderEnvironment } from ${JSON.stringify(environmentModule)};
    const registry = new Map(${JSON.stringify([...registry])});
    const index = process.argv.indexOf('--env-file');
    const { environment } = loadProviderEnvironment(registry, { root: ${JSON.stringify(root)}, envFile: index < 0 ? undefined : process.argv[index + 1] });
    const server = createRouterServer(registry, { environment });
    server.listen(${port}, '127.0.0.1', () => console.log('Fixture router ready'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  const ctx = context({ root, home, node: process.execPath, run: async () => { throw new Error('systemd must not be invoked'); } });
  mkdirSync(stateDirectory(ctx), { recursive: true, mode: 0o700 });
  writeFileSync(installationPath(ctx), JSON.stringify({ backend: 'standalone', root, node: process.execPath, envFile }), { mode: 0o600 });
  const base = `http://127.0.0.1:${port}`;
  const wait = (models: Registry) => waitForRouter(models, { active: async () => !!standaloneProcess(ctx), fetch: (url, init) => fetch(String(url).replace(BASE_URL, base), init) });
  return { ctx, directory, base, options: { ctx, busy: async () => false, wait } };
}

const registry: Registry = new Map([['fixture-model', { provider: { id: 'fixture', name: 'Fixture', protocol: 'anthropic', base_url: 'https://example.invalid', api_key_env: 'TEST_ROUTER_API_KEY' }, model: { id: 'fixture-model', upstream_model: 'upstream', display_name: 'Fixture', default: true } }]]);

test('standalone launches once under concurrency, routes with explicit keys, restarts and stops', async () => {
  let key: string | undefined;
  const upstream = createServer((request, response) => { key = request.headers['x-api-key'] as string; request.resume(); response.setHeader('content-type', 'application/json'); response.end('{}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const models = structuredClone(registry);
  models.get('fixture-model')!.provider.base_url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const item = await fixture(models);
  try {
    // An abandoned lock cannot block startup or trigger a second router.
    writeFileSync(join(stateDirectory(item.ctx), 'control.lock'), JSON.stringify({ pid: process.pid, started: '0' }));
    await Promise.all([startRouter(models, false, item.options), startRouter(models, false, item.options), startRouter(models, false, item.options)]);
    const original = standaloneProcess(item.ctx)!;
    assert.ok(original);
    assert.equal(readFileSync(logPath(item.ctx), 'utf8').match(/Fixture router ready/g)?.length, 1);
    const response = await fetch(`${item.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer FAKE_SUBSCRIPTION' }, body: JSON.stringify({ model: 'fixture-model', messages: [] }) });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(key, 'FAKE_FROM_EXPLICIT_FILE');
    assert.equal(lstatSync(logPath(item.ctx)).mode & 0o777, 0o600);
    const report = await routerReport('status', item.ctx);
    assert.equal(report.code, 0);
    assert.equal(JSON.parse(report.stdout).pid, original.pid);
    await startRouter(models, true, item.options);
    assert.notEqual(standaloneProcess(item.ctx)?.pid, original.pid);
    assert.match((await routerReport('logs', item.ctx)).stdout, /Fixture router ready/);
    await stopRouter(item.ctx);
    assert.equal(standaloneProcess(item.ctx), undefined);
    assert.equal((await routerReport('status', item.ctx)).code, 3);
    await stopRouter(item.ctx);
    await assert.rejects(() => startRouter(models, false, { ...item.options, busy: async () => true }), /already in use/);
    assert.equal(standaloneProcess(item.ctx), undefined);
  } finally {
    await stopRouter(item.ctx);
    rmSync(item.directory, { recursive: true, force: true });
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('standalone refuses an unrelated process even when its PID and start time match metadata', async () => {
  const item = await fixture(registry);
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(other, 'spawn');
  try {
    const stat = readFileSync(`/proc/${other.pid}/stat`, 'utf8');
    const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    writeFileSync(join(stateDirectory(item.ctx), 'router.pid.json'), JSON.stringify({ pid: other.pid, started }));
    await assert.rejects(() => stopRouter(item.ctx), /another process/);
    assert.equal(other.exitCode, null);
    writeFileSync(join(stateDirectory(item.ctx), 'router.pid.json'), JSON.stringify({ pid: other.pid, started: '0' }));
    await stopRouter(item.ctx);
    assert.equal(other.exitCode, null);
  } finally {
    const closed = once(other, 'close'); other.kill('SIGTERM'); await closed;
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test('standalone startup failure leaves no tracked process and exposes its logs', async () => {
  const item = await fixture(registry);
  try {
    writeFileSync(join(item.ctx.root, 'dist/cli.js'), 'console.error("FAKE_STARTUP_FAILURE"); process.exitCode = 1;');
    await assert.rejects(() => startRouter(registry, false, item.options), /stopped|exited/);
    assert.equal(standaloneProcess(item.ctx), undefined);
    assert.equal(existsSync(join(stateDirectory(item.ctx), 'router.pid.json')), false);
    assert.match((await routerReport('logs', item.ctx)).stdout, /FAKE_STARTUP_FAILURE/);
    await withStandaloneLock(item.ctx, async () => {});
  } finally { await stopRouter(item.ctx); rmSync(item.directory, { recursive: true, force: true }); }
});
