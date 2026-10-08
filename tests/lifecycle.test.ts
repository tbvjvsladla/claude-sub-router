import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ROOT, ConfigError, loadRegistry } from '../src/config.ts';
import { bashrcContent, commandWrapper, install, removeBashrcBlock, serviceUnit, uninstall } from '../src/lifecycle.ts';
import { SERVICE, context, shellQuote, systemdQuote, writeManaged } from '../src/platform.ts';
import type { Runner } from '../src/platform.ts';
import { startRouter, waitForRouter } from '../src/service.ts';

test('bashrc registration is idempotent and incomplete markers fail safely', () => {
  const original = 'export KEEP=1\nlegacy-provider() { :; }\n';
  const managed = bashrcContent(original, "/tmp/project with ' quotes");
  assert.equal(bashrcContent(managed, "/tmp/project with ' quotes"), managed);
  assert.equal(bashrcContent(managed + managed, ROOT).match(/# >>> claude-sub >>>/g)?.length, 1);
  assert.ok(removeBashrcBlock(managed).includes('legacy-provider()'));
  assert.throws(() => removeBashrcBlock('# >>> claude-sub >>>\n'), /Incomplete/);
  execFileSync('bash', ['-n'], { input: managed });
});

test('atomic replacement backs up old files and does not duplicate unchanged backups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-files-'));
  try {
    const path = join(directory, 'file'); writeFileSync(path, 'old', { mode: 0o600 });
    assert.equal(writeManaged(path, 'new', 0o600), true);
    assert.equal(writeManaged(path, 'new', 0o600), false);
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    symlinkSync(path, join(directory, 'link'));
    assert.throws(() => writeManaged(join(directory, 'link'), 'unsafe', 0o600), /regular file/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('install/uninstall round trip preserves native Claude, credentials and user settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-life-'));
  const root = join(directory, "project with % $ ' spaces");
  const home = join(directory, 'home');
  const calls: string[][] = [];
  const runner: Runner = async (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: args.includes('show') ? 'LoadState=not-found\nActiveState=inactive\n' : '', stderr: '' }; };
  const ctx = context({ root, home, node: process.execPath, uid: 1000, run: runner, claude: '/fake/claude' });
  try {
    mkdirSync(root, { recursive: true }); mkdirSync(home);
    cpSync(join(ROOT, 'config/providers'), join(root, 'config/providers'), { recursive: true });
    writeFileSync(join(root, 'config/claude-settings.json'), '{}');
    cpSync(join(ROOT, '.env.example'), join(root, '.env.example'));
    mkdirSync(join(root, 'scripts')); cpSync(join(ROOT, 'scripts/run-router.sh'), join(root, 'scripts/run-router.sh'));
    writeFileSync(join(home, '.bashrc'), 'export KEEP=1\nlegacy-provider() { :; }\n', { mode: 0o600 });
    const preserved = ['.claude/.credentials.json', '.claude-sub/.credentials.json', '.claude-sub/projects/session.json', '.local/bin/claude', '.config/keys.env'];
    for (const path of preserved) { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), 'FAKE_PRESERVED_DATA'); }
    await install(ctx);
    assert.equal(lstatSync(join(root, '.env')).mode & 0o777, 0o600);
    const bashrc = readFileSync(join(home, '.bashrc'), 'utf8');
    await install(ctx);
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), bashrc);
    assert.equal(readFileSync(join(home, '.local/bin/claude-sub'), 'utf8'), commandWrapper('launch', ctx));
    const unit = join(home, '.config/systemd/user', SERVICE);
    const runtime = join(directory, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
    execFileSync('systemd-analyze', ['--user', 'verify', unit], { stdio: 'pipe', env: { ...process.env, XDG_RUNTIME_DIR: runtime } });
    const enabled = join(dirname(unit), 'default.target.wants', SERVICE);
    mkdirSync(dirname(enabled)); symlinkSync(unit, enabled);
    calls.length = 0;
    await uninstall({ ...ctx, dryRun: true });
    assert.equal(calls.length, 0); assert.ok(existsSync(unit));
    const wrapper = join(home, '.local/bin/claude-sub');
    writeFileSync(wrapper, 'MODIFIED_COMMAND');
    await assert.rejects(() => uninstall(ctx), /Refusing modified command/);
    assert.equal(calls.length, 0);
    writeFileSync(wrapper, commandWrapper('launch', ctx));
    await uninstall(ctx);
    assert.deepEqual(calls[0], ['systemctl', '--user', 'disable', '--now', SERVICE]);
    assert.equal(existsSync(unit), false); assert.equal(existsSync(wrapper), false);
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8').includes('# >>> claude-sub >>>'), false);
    assert.ok(readFileSync(join(home, '.bashrc'), 'utf8').includes('legacy-provider()'));
    for (const path of preserved) assert.equal(readFileSync(join(home, path), 'utf8'), 'FAKE_PRESERVED_DATA');
    await uninstall(ctx);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('service start reuses a healthy instance and refuses foreign port occupants', async () => {
  const registry = loadRegistry(); const calls: string[][] = [];
  let active = false; let waits = 0;
  const runner: Runner = async (_command, args) => { calls.push(args); return { code: args.includes('is-active') && !active ? 1 : 0, stdout: '', stderr: '' }; };
  await startRouter(registry, false, { runner, busy: async () => false, wait: async () => { waits++; } });
  assert.equal(calls.some(args => args.includes('start')), true); assert.equal(waits, 1);
  calls.length = 0; active = true;
  await startRouter(registry, false, { runner, busy: async () => { throw new Error('Must not probe active service'); }, wait: async () => {} });
  assert.equal(calls.length, 1);
  active = false;
  await assert.rejects(() => startRouter(registry, false, { runner, busy: async () => true }), /already in use/);
});

test('uninstall recognizes previous Python wrappers and user services', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-sub-legacy-'));
  const home = join(directory, 'home');
  const ctx = context({ root: join(directory, 'old project'), home, uid: 1000, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  try {
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const [name, action] of [['claude-sub', 'launch'], ['claude-sub-router', 'router']]) {
      const entry = `import sys; sys.path.insert(0, '${ctx.root}'); from src.${action} import main; main()`;
      writeFileSync(join(home, '.local/bin', name!), `#!/usr/bin/env bash\nexec ${shellQuote(join(ctx.root, '.venv/bin/python'))} -B -c ${shellQuote(entry)} "$@"\n`);
    }
    const unit = join(home, '.config/systemd/user', SERVICE); mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, serviceUnit('/tmp/legacy.env', ctx).replace(` ${systemdQuote(ctx.node, true)}\nRestart=`, '\nRestart='));
    await uninstall({ ...ctx, dryRun: true });
    assert.ok(existsSync(unit));
    await uninstall(ctx);
    assert.equal(existsSync(unit), false);
    assert.equal(existsSync(join(home, '.local/bin/claude-sub')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('readiness requires TypeScript runtime, current models and an active service', async () => {
  const registry = loadRegistry();
  const active = async () => true;
  const response = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body));
  await waitForRouter(registry, { active, fetch: response({ status: 'ok', runtime: 'typescript', models: [...registry.keys()] }) });
  await assert.rejects(() => waitForRouter(registry, { active, fetch: response({ status: 'ok', models: [...registry.keys()] }) }), /upgrading/);
  await assert.rejects(() => waitForRouter(registry, { active, fetch: response({ status: 'ok', runtime: 'typescript', models: ['wrong'] }) }), /differ from YAML/);
  await assert.rejects(() => waitForRouter(registry, { active: async () => false }), /stopped/);
  await assert.rejects(() => waitForRouter(registry, { timeout: 0 }), /not ready/);
});

test('shell wrappers quote paths and systemd rejects no normal installation characters', () => {
  const ctx = context({ root: "/tmp/project ' % $ spaces", home: '/tmp/home', uid: 1000 });
  execFileSync('bash', ['-n'], { input: commandWrapper('launch', ctx) });
  assert.ok(serviceUnit('/tmp/private keys.env', ctx).includes('%%'));
  assert.equal(execFileSync('bash', ['-c', `printf '%s' ${shellQuote("x'y $z")}`], { encoding: 'utf8' }), "x'y $z");
  assert.throws(() => serviceUnit('/tmp/newline\n.env', ctx), ConfigError);
});
