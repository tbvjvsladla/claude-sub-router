import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError, ROOT } from './config.ts';
import type { Registry } from './config.ts';

function regularFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new ConfigError(`Environment path must be a regular file, not a symlink: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Could not inspect environment file: ${path}`);
  }
}

export function environmentFiles(root = ROOT, envFile?: string): string[] {
  if (envFile !== undefined) {
    const path = resolve(envFile);
    return regularFile(path) ? [path] : [];
  }
  const directory = join(root, 'envs');
  let files: string[];
  try { files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.env') && !entry.isDirectory()).map(entry => join(directory, entry.name)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`Could not read environment directory: ${directory}`);
    files = [];
  }
  for (const path of files) if (!regularFile(path)) throw new ConfigError(`Environment file disappeared: ${path}`);
  if (files.length) return files;
  const legacy = join(root, '.env');
  return regularFile(legacy) ? [legacy] : [];
}

export function loadProviderEnvironment(registry: Registry, options: { root?: string; envFile?: string; environment?: NodeJS.ProcessEnv } = {}): { environment: NodeJS.ProcessEnv; files: string[] } {
  const files = environmentFiles(options.root, options.envFile);
  const environment = { ...(options.environment ?? process.env) };
  const keys = new Set([...registry.values()].flatMap(({ provider }) => provider.api_key_env ? [provider.api_key_env] : []));
  const definitions = new Map<string, { value: string; file: string }>();
  for (const file of files) {
    let parsed: ReturnType<typeof parseEnv>;
    try { parsed = parseEnv(readFileSync(file, 'utf8')); }
    catch { throw new ConfigError(`Could not parse environment file: ${file}`); }
    for (const name of keys) {
      const value = parsed[name];
      if (!value?.trim()) continue;
      const previous = definitions.get(name);
      if (previous && previous.value !== value) throw new ConfigError(`Conflicting ${name} in ${previous.file} and ${file}; keep one value (values omitted)`);
      definitions.set(name, { value, file });
    }
  }
  for (const [name, { value }] of definitions) if (!environment[name]?.trim()) environment[name] = value;
  return { environment, files };
}
