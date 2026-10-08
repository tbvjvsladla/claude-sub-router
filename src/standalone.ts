import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, isObject } from './config.ts';
import { stateDirectory } from './installation.ts';
import type { Installation } from './installation.ts';
import { regularContent } from './platform.ts';
import type { Context } from './platform.ts';

interface Identity { pid: number; started: string }
const pidPath = (ctx: Context) => join(stateDirectory(ctx), 'router.pid.json');
export const logPath = (ctx: Context) => join(stateDirectory(ctx), 'router.log');

function identity(pid: number): Identity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X' || !fields[19]) return undefined;
    return { pid, started: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(String((error as NodeJS.ErrnoException).code))) return undefined;
    throw new ConfigError('Could not verify the router process identity');
  }
}

function parseIdentity(content: string): Identity {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new ConfigError('Invalid router process metadata'); }
  if (!isObject(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 1 || typeof value.started !== 'string') throw new ConfigError('Invalid router process metadata');
  return value as unknown as Identity;
}

function ensureState(ctx: Context): void {
  const path = stateDirectory(ctx);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new ConfigError('Router state directory must not be a symbolic link');
  chmodSync(path, 0o700);
}

export function standaloneProcess(ctx: Context): Identity | undefined {
  const content = regularContent(pidPath(ctx));
  if (content === undefined) return undefined;
  const saved = parseIdentity(content);
  const current = identity(saved.pid);
  if (!current || current.started !== saved.started) return undefined;
  let args: string[];
  try { args = readFileSync(`/proc/${saved.pid}/cmdline`, 'utf8').split('\0'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError('Could not verify the router command');
  }
  if (args[1] !== join(ctx.root, 'dist/cli.js') || args[2] !== 'serve') throw new ConfigError('Refusing a PID belonging to another process');
  return current;
}

// Serialize start/stop so simultaneous Claude launches cannot replace each
// other's PID file. Recover locks only after their owner has exited.
export async function withStandaloneLock<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  ensureState(ctx);
  const path = join(stateDirectory(ctx), 'control.lock');
  const owner = identity(process.pid)!;
  const content = JSON.stringify(owner);
  const ticket = `${path}.${randomUUID()}.tmp`;
  writeFileSync(ticket, content, { flag: 'wx', mode: 0o600 });
  let acquired = false;
  const deadline = performance.now() + 15_000;
  try {
    while (!acquired && performance.now() < deadline) {
      try {
        linkSync(ticket, path);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // One recovery operation at a time prevents competing launches from
        // removing a fresh lock after both observed the same abandoned lock.
        const recovery = `${path}.recovery`;
        let recovering = false;
        try {
          linkSync(ticket, recovery);
          recovering = true;
          const previous = regularContent(path);
          if (previous) {
            const holder = parseIdentity(previous);
            if (identity(holder.pid)?.started !== holder.started) unlinkSync(path);
          }
        } catch (failure) { if (!['EEXIST', 'ENOENT'].includes(String((failure as NodeJS.ErrnoException).code))) throw failure; }
        finally { if (recovering) unlinkSync(recovery); }
        await delay(100);
      }
    }
    if (!acquired) throw new ConfigError('Another router operation is in progress; retry shortly');
    try { return await action(); }
    finally { if (regularContent(path) === content) unlinkSync(path); }
  } finally { unlinkSync(ticket); }
}

export async function spawnStandalone(ctx: Context, installation: Installation): Promise<void> {
  ensureState(ctx);
  const path = logPath(ctx);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new ConfigError('Router log must be a regular file');
  const fd = openSync(path, 'a', 0o600);
  chmodSync(path, 0o600);
  const args = [join(ctx.root, 'dist/cli.js'), 'serve'];
  if (installation.envFile) args.push('--env-file', installation.envFile);
  try {
    const child = spawn(installation.node, args, { cwd: ctx.root, detached: true, stdio: ['ignore', fd, fd] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new ConfigError('Could not start standalone router'))); });
    child.unref();
    const current = child.pid ? identity(child.pid) : undefined;
    if (!current) throw new ConfigError('Router exited during startup. Run claude-sub-router logs.');
    const temporary = `${pidPath(ctx)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(current), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, pidPath(ctx));
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  } finally { closeSync(fd); }
}

// Called while holding the control lock. Never signal a stale or reused PID.
export async function stopStandalone(ctx: Context): Promise<void> {
  const current = standaloneProcess(ctx);
  if (current) {
    try { process.kill(current.pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = performance.now() + 12_000;
    while (identity(current.pid)?.started === current.started) {
      if (performance.now() >= deadline) throw new ConfigError('Router has not stopped yet; retry shortly');
      await delay(100);
    }
  }
  if (regularContent(pidPath(ctx)) !== undefined) unlinkSync(pidPath(ctx));
}

export function standaloneLogs(ctx: Context): string {
  const path = logPath(ctx);
  if (!existsSync(path)) return 'No router logs yet.\n';
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new ConfigError('Router log must be a regular file');
  const fd = openSync(path, 'r');
  try {
    const size = lstatSync(path).size;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString('utf8').trimEnd().split('\n');
    if (size > buffer.length) lines.shift();
    return `${lines.slice(-100).join('\n')}\n`;
  } finally { closeSync(fd); }
}
