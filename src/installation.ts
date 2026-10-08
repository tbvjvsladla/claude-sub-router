import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, isObject } from './config.ts';
import { context, findExecutable, regularContent } from './platform.ts';
import type { Context } from './platform.ts';

export type Backend = 'systemd' | 'standalone';
export interface Installation { backend: Backend; root: string; node: string; envFile?: string }
export const stateDirectory = (ctx: Context) => join(ctx.home, '.local/state/claude-sub-router');
export const installationPath = (ctx: Context) => join(stateDirectory(ctx), 'installation.json');

export function readInstallation(ctx = context()): Installation | undefined {
  const content = regularContent(installationPath(ctx));
  if (content === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new ConfigError('Invalid router installation metadata'); }
  if (!isObject(value) || !['systemd', 'standalone'].includes(String(value.backend)) || value.root !== ctx.root || typeof value.node !== 'string' || !value.node || (value.envFile !== undefined && typeof value.envFile !== 'string')) {
    throw new ConfigError('Router metadata is invalid or belongs to another installation');
  }
  return value as unknown as Installation;
}

export function inContainer(): boolean {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try { return /docker|containerd|kubepods|lxc/.test(readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; }
}

export async function chooseBackend(ctx: Context, requested = 'auto', container = inContainer()): Promise<Backend> {
  if (!['auto', 'systemd', 'standalone'].includes(requested)) throw new ConfigError('--service must be auto, systemd or standalone');
  if (requested === 'standalone') return 'standalone';
  if (ctx.uid === 0) {
    if (requested === 'auto' && container) return 'standalone';
    throw new ConfigError('Run as your normal user, not with sudo. Root containers can use --service standalone.');
  }
  let available = false;
  if (findExecutable('systemctl')) {
    try { available = (await ctx.run('systemctl', ['--user', 'list-units', '--no-legend', '--no-pager'])).code === 0; } catch {}
  }
  if (available) return 'systemd';
  if (requested === 'systemd') throw new ConfigError('User systemd is unavailable. Use --service standalone in containers.');
  return 'standalone';
}
