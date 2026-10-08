import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT, ConfigError } from './config.ts';

export const HOST = '127.0.0.1';
export const PORT = 18765;
export const BASE_URL = `http://${HOST}:${PORT}`;
export const SERVICE = 'claude-sub-router.service';
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Runner = (command: string, args: string[]) => Promise<CommandResult>;
export const run: Runner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (!('code' in error) || typeof error.code !== 'number')) reject(new ConfigError(`Could not execute ${command}`));
    else resolve({ code: error && 'code' in error ? Number(error.code) : 0, stdout, stderr });
  });
});
export interface Context { root: string; home: string; node: string; run: Runner; uid: number; claude?: string }
export function context(options: Partial<Context> = {}): Context {
  return { root: ROOT, home: homedir(), node: findExecutable('node') ?? process.execPath, run, uid: process.getuid?.() ?? -1, claude: findExecutable('claude'), ...options };
}
export async function checked(command: string, args: string[], runner: Runner = run): Promise<CommandResult> {
  const result = await runner(command, args);
  if (result.code !== 0) throw new ConfigError(`Command failed: ${command} ${args.join(' ')}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ''}`);
  return result;
}
export function findExecutable(name: string, environment = process.env): string | undefined {
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    const path = join(directory || '.', name);
    try { accessSync(path, constants.X_OK); if (lstatSync(path).isDirectory()) continue; return path; } catch {}
  }
  return undefined;
}
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}
export function systemdQuote(value: string, expand = false): string {
  if (/[\r\n\0]/.test(value)) throw new ConfigError('Installation paths must not contain newlines or NUL characters');
  let escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (expand) escaped = escaped.replaceAll('$', '$$');
  return `"${escaped}"`;
}
export function regularContent(path: string): string | undefined {
  if (!existsSync(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw new ConfigError(`Refusing symbolic link: ${path}`); } catch (error) { if (error instanceof ConfigError) throw error; }
    return undefined;
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new ConfigError(`Not a regular file: ${path}`);
  return readFileSync(path, 'utf8');
}
export function writeManaged(path: string, content: string, mode: number, followLink = false): boolean {
  if (followLink && existsSync(path) && lstatSync(path).isSymbolicLink()) path = realpathSync(path);
  const previous = regularContent(path);
  if (previous === content) { chmodSync(path, mode); return false; }
  mkdirSync(dirname(path), { recursive: true });
  if (previous !== undefined) {
    const backup = `${path}.${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.bak`;
    copyFileSync(path, backup);
    chmodSync(backup, lstatSync(path).mode & 0o777);
    console.log(`Backup: ${backup}`);
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, 'wx', mode);
    try { writeFileSync(descriptor, content); } finally { closeSync(descriptor); }
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  console.log(`Updated: ${path}`);
  return true;
}
