import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const name = `claude-sub-router-v${version}`;
const temporary = mkdtempSync(join(tmpdir(), 'claude-sub-release-test-'));
let server;
try {
  const archive = join(root, 'artifacts', `${name}.tar.gz`);
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(join(root, 'artifacts/SHA256SUMS'), 'utf8'), `${hash}  ${name}.tar.gz\n`);
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const path = file.slice(name.length + 1);
    assert.ok(file.startsWith(`${name}/`) && !path.split('/').includes('..'));
    assert.equal(/(^|\/)(?:src|node_modules|\.git|\.venv|\.claude(?:-sub)?)(?:\/|$)|credentials|\.bak$|claude-test\.json$/.test(path), false);
    if (path.startsWith('envs/')) assert.ok(['envs/', 'envs/.env.example'].includes(path));
    if (/(^|\/)\.env(?:\.|$)|\.env$/.test(path)) assert.equal(path, 'envs/.env.example');
  }
  assert.ok(files.includes(`${name}/envs/.env.example`));
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const project = join(temporary, name);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: project, stdio: 'pipe', timeout: 120000 });
  assert.equal(existsSync(join(project, 'node_modules/typescript')), false);
  const environment = { PATH: process.env.PATH, HOME: temporary };
  const models = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'models'], { cwd: project, env: environment, encoding: 'utf8' }));
  assert.deepEqual(models.availableModels, [...loadRegistry().keys()]);
  for (const action of ['install', 'uninstall']) execFileSync(process.execPath, ['dist/cli.js', action, '--help'], { cwd: project, env: environment, stdio: 'pipe' });
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.ok(port >= 10000);
  server = spawn(process.execPath, ['dist/cli.js', 'serve', '--port', String(port)], { cwd: project, env: environment, stdio: 'ignore' });
  let error;
  server.once('error', failure => { error = failure; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (error || server.exitCode !== null) throw new Error('Released server failed to start');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      assert.equal(health.runtime, 'typescript');
      assert.deepEqual(health.models, models.availableModels);
      healthy = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(healthy, true);
  console.log(`Release smoke test passed (${files.length} archive entries; runtime-only dependencies; isolated health check).`);
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('close', resolve));
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 2000);
    await stopped;
    clearTimeout(timeout);
  }
  rmSync(temporary, { recursive: true, force: true });
}
