#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { ConfigError, loadRegistry } from './config.ts';
import { HOST, PORT, SERVICE, checked, run } from './platform.ts';
import { createRouterServer } from './proxy.ts';
import { launch } from './launcher.ts';
import { install, uninstall } from './lifecycle.ts';
import { startRouter } from './service.ts';
import { buildSettings, readSettings } from './settings.ts';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new ConfigError(`${name} requires a value`);
  return value;
}

function validateOptions(args: string[], values: string[], switches: string[] = []): void {
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (values.includes(name)) { option(args, name); index++; }
    else if (!switches.includes(name)) throw new ConfigError(`Unknown option: ${name}`);
  }
}

async function main(): Promise<number> {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === '--help') {
    console.log('claude-sub-router: serve | launch [Claude arguments] | router start|restart|stop|status|logs | install [--env-file PATH] | uninstall [--dry-run] | models');
    return 0;
  }
  if (action === 'launch') return launch(args);
  if (args.includes('--help')) {
    console.log(action === 'install' ? 'install [--env-file PATH]' : action === 'uninstall' ? 'uninstall [--dry-run] (preserves keys and profiles)' : 'serve [--env-file PATH] [--port 18765] | router start|restart|stop|status|logs');
    return 0;
  }
  if (action === 'models') { console.log(JSON.stringify(buildSettings(readSettings(), loadRegistry()), null, 2)); return 0; }
  if (action === 'install') { validateOptions(args, ['--env-file']); await install({ envFile: option(args, '--env-file') }); return 0; }
  if (action === 'uninstall') { validateOptions(args, [], ['--dry-run']); await uninstall({ dryRun: args.includes('--dry-run') }); return 0; }
  if (action === 'router') {
    if (args.length !== 1) throw new ConfigError('Specify exactly one router action');
    const command = args[0];
    if (command === 'start' || command === 'restart') { await startRouter(undefined, command === 'restart'); console.log(`Router ready: http://${HOST}:${PORT}`); return 0; }
    if (command === 'stop') { await checked('systemctl', ['--user', 'stop', SERVICE]); return 0; }
    if (command === 'status' || command === 'logs') {
      const result = command === 'status' ? await run('systemctl', ['--user', 'status', '--no-pager', SERVICE]) : await run('journalctl', ['--user', '--unit', SERVICE, '--lines=100', '--no-pager']);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); return result.code;
    }
    throw new ConfigError('Use claude-sub-router start|restart|stop|status|logs');
  }
  if (action !== 'serve') throw new ConfigError(`Unknown command: ${action}`);
  validateOptions(args, ['--env-file', '--port']);
  const envFile = option(args, '--env-file');
  if (envFile && existsSync(envFile)) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) process.env[name] ??= value;
  } else if (envFile) console.warn('Provider environment file is missing; provider calls may fail.');
  const registry = loadRegistry();
  const port = Number(option(args, '--port') ?? PORT);
  if (!Number.isInteger(port) || port < 10000 || port > 65535) throw new ConfigError('port must be an integer from 10000 to 65535');
  const server = createRouterServer(registry, { log: (event, metadata) => console.log(`${event} ${JSON.stringify(metadata)}`) });
  server.on('error', error => { console.error(`Router failed to listen (${(error as NodeJS.ErrnoException).code ?? 'error'})`); process.exitCode = 1; });
  server.listen(port, HOST, () => console.log(`Router ready: http://${HOST}:${port} (typescript; no local authentication)`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10_000).unref();
  };
  process.once('SIGINT', shutdown).once('SIGTERM', shutdown);
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error instanceof ConfigError ? error.message : `Operation failed (${error instanceof Error ? error.name : 'unknown error'})`);
  process.exitCode = 1;
});
