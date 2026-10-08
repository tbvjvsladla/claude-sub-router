import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError, loadRegistry } from './config.ts';
import { loadProviderEnvironment } from './environment.ts';
import { buildLaunchConfig } from './launcher.ts';
import { readSettings } from './settings.ts';
import { SERVICE, checked, context, findExecutable, regularContent, shellQuote, systemdQuote, writeManaged } from './platform.ts';
import type { Context } from './platform.ts';

export const BLOCK_START = '# >>> claude-sub >>>';
export const BLOCK_END = '# <<< claude-sub <<<';
const escaped = (value: string) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
export function removeBashrcBlock(existing: string): string {
  const pattern = new RegExp(`^${escaped(BLOCK_START)}\\r?\\n.*?^${escaped(BLOCK_END)}(?:\\r?\\n|$)`, 'gms');
  const matches = [...existing.matchAll(pattern)];
  if (existing.split(BLOCK_START).length - 1 !== matches.length || existing.split(BLOCK_END).length - 1 !== matches.length) throw new ConfigError('Incomplete claude-sub block in .bashrc; repair it before continuing');
  return existing.replace(pattern, '');
}
export function bashrcContent(existing: string, root: string): string {
  const base = removeBashrcBlock(existing).replace(/\n+$/, '');
  const path = shellQuote(join(root, 'env.bash'));
  return `${base ? `${base}\n\n` : ''}${BLOCK_START}\nif [ -f ${path} ]; then\n    source ${path}\nfi\n${BLOCK_END}\n`;
}
export function commandWrapper(action: 'launch' | 'router', ctx: Context): string {
  return `#!/usr/bin/env bash\nexec ${shellQuote(ctx.node)} ${shellQuote(join(ctx.root, 'dist/cli.js'))} ${action} "$@"\n`;
}
export function serviceUnit(envSource: string, ctx: Context): string {
  const bash = findExecutable('bash');
  if (!bash) throw new ConfigError('bash executable not found');
  return `[Unit]\nDescription=Local LLM router for claude-sub\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=exec\nWorkingDirectory=${ctx.root.replaceAll('%', '%%')}\nExecStart=${systemdQuote(bash, true)} ${systemdQuote(join(ctx.root, 'scripts/run-router.sh'), true)} ${systemdQuote(envSource, true)} ${systemdQuote(ctx.node, true)}\nRestart=on-failure\nRestartSec=2\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
function legacyWrapper(action: 'launch' | 'router', ctx: Context): string {
  const quote = ctx.root.includes("'") && !ctx.root.includes('"') ? '"' : "'";
  const representation = `${quote}${ctx.root.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)}${quote}`;
  const entry = `import sys; sys.path.insert(0, ${representation}); from src.${action} import main; main()`;
  return `#!/usr/bin/env bash\nexec ${shellQuote(join(ctx.root, '.venv/bin/python'))} -B -c ${shellQuote(entry)} "$@"\n`;
}
function ownsUnit(content: string, ctx: Context): boolean {
  const marker = '/__claude_sub_environment__';
  const template = serviceUnit(marker, ctx);
  const quoted = systemdQuote(marker, true);
  const [prefix, suffix] = template.split(quoted);
  const expression = '"(?:[^"\\\\\r\n]|\\\\.)*"';
  if (new RegExp(`^${escaped(prefix ?? '')}${expression}${escaped(suffix ?? '')}$`).test(content)) return true;
  const legacy = template.replace(` ${systemdQuote(ctx.node, true)}\nRestart=`, '\nRestart=');
  const [oldPrefix, oldSuffix] = legacy.split(quoted);
  return new RegExp(`^${escaped(oldPrefix ?? '')}${expression}${escaped(oldSuffix ?? '')}$`).test(content);
}
function requireUser(ctx: Context): void {
  if (ctx.uid === 0) throw new ConfigError('Run as your normal user, not with sudo');
  for (const command of ['bash', 'systemctl']) if (!findExecutable(command)) throw new ConfigError(`Required command not found: ${command}`);
}

export async function install(options: Partial<Context> & { envFile?: string } = {}): Promise<void> {
  const ctx = context(options);
  requireUser(ctx);
  if (!ctx.claude) throw new ConfigError('Install Claude Code and add claude to PATH first');
  await checked('systemctl', ['--user', 'list-units', '--no-legend', '--no-pager'], ctx.run);
  const registry = loadRegistry(join(ctx.root, 'config/providers'));
  buildLaunchConfig(registry, readSettings(ctx.root), process.env);
  const bashrc = join(ctx.home, '.bashrc');
  const previous = existsSync(bashrc) ? readFileSync(bashrc, 'utf8') : '';
  const updated = bashrcContent(previous, ctx.root);
  const mode = existsSync(bashrc) ? lstatSync(existsSync(bashrc) && lstatSync(bashrc).isSymbolicLink() ? realpathSync(bashrc) : bashrc).mode & 0o777 : 0o644;
  const envFile = options.envFile ? resolve(options.envFile) : undefined;
  const { files } = loadProviderEnvironment(registry, { root: ctx.root, envFile });
  if (!envFile && !files.length) {
    const directory = join(ctx.root, 'envs');
    mkdirSync(directory, { recursive: true });
    const target = join(directory, 'keys.env');
    copyFileSync(join(directory, '.env.example'), target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
  }
  writeManaged(join(ctx.home, '.local/bin/claude-sub'), commandWrapper('launch', ctx), 0o755);
  writeManaged(join(ctx.home, '.local/bin/claude-sub-router'), commandWrapper('router', ctx), 0o755);
  writeManaged(join(ctx.home, '.config/systemd/user', SERVICE), serviceUnit(envFile ?? '--auto', ctx), 0o600);
  writeManaged(bashrc, updated, mode, true);
  await checked('systemctl', ['--user', 'daemon-reload'], ctx.run);
  await checked('systemctl', ['--user', 'enable', SERVICE], ctx.run);
  await checked(ctx.node, [join(ctx.root, 'dist/cli.js'), 'router', 'restart'], ctx.run);
  console.log('Installation complete. Run: source ~/.bashrc\nThen: claude-sub\nClaude login, plugins and sessions use the same profile as native claude.');
}

export async function uninstall(options: Partial<Context> & { dryRun?: boolean } = {}): Promise<void> {
  const ctx = context(options);
  requireUser(ctx);
  const paths: string[] = [];
  for (const [name, action] of [['claude-sub', 'launch'], ['claude-sub-router', 'router']] as const) {
    const path = join(ctx.home, '.local/bin', name);
    const content = regularContent(path);
    if (content !== undefined) {
      if (content !== commandWrapper(action, ctx) && content !== legacyWrapper(action, ctx)) throw new ConfigError(`Refusing modified command or another installation: ${path}`);
      paths.push(path);
    }
  }
  const unit = join(ctx.home, '.config/systemd/user', SERVICE);
  const unitContent = regularContent(unit);
  if (unitContent !== undefined) {
    if (!ownsUnit(unitContent, ctx)) throw new ConfigError(`Refusing modified service or another installation: ${unit}`);
    paths.push(unit);
  }
  const enabled = join(dirname(unit), 'default.target.wants', SERVICE);
  let enabledLink = false;
  try { enabledLink = lstatSync(enabled).isSymbolicLink(); } catch {}
  if (enabledLink) {
    const target = readlinkSync(enabled);
    if ((isAbsolute(target) ? target : resolve(dirname(enabled), target)) !== unit) throw new ConfigError('Refusing a service link belonging to another installation');
  } else if (existsSync(enabled)) throw new ConfigError('Not a service symbolic link');
  const bashrc = join(ctx.home, '.bashrc');
  const existing = existsSync(bashrc) ? readFileSync(bashrc, 'utf8') : '';
  const updated = removeBashrcBlock(existing);
  if (options.dryRun) {
    console.log(`Would stop and disable ${SERVICE}`);
    for (const path of paths) console.log(`Would remove: ${path}`);
    if (enabledLink) console.log(`Would remove: ${enabled}`);
    if (updated !== existing) console.log(`Would back up and remove only the managed block from: ${bashrc}`);
    console.log('Native Claude, both profiles, credentials, sessions, project files and backups are preserved.');
    return;
  }
  if (unitContent !== undefined) await checked('systemctl', ['--user', 'disable', '--now', SERVICE], ctx.run);
  else {
    const state = await ctx.run('systemctl', ['--user', 'show', SERVICE, '--property=LoadState', '--property=ActiveState']);
    if (!state.stdout.includes('LoadState=not-found') || !state.stdout.includes('ActiveState=inactive')) throw new ConfigError('Service file missing but manager still knows a service. Check systemctl --user status claude-sub-router.service.');
  }
  if (updated !== existing) writeManaged(bashrc, updated, lstatSync(lstatSync(bashrc).isSymbolicLink() ? realpathSync(bashrc) : bashrc).mode & 0o777, true);
  try { if (lstatSync(enabled).isSymbolicLink()) unlinkSync(enabled); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const path of paths) { unlinkSync(path); console.log(`Removed: ${path}`); }
  await checked('systemctl', ['--user', 'daemon-reload'], ctx.run);
  await ctx.run('systemctl', ['--user', 'reset-failed', SERVICE]);
  console.log('Uninstallation complete. User data was preserved. Run: hash -r');
}
