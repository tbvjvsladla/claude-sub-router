import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConfigError, getDefaultModel, loadRegistry } from './config.ts';
import type { JsonObject, Registry } from './config.ts';
import { BASE_URL, findExecutable } from './platform.ts';
import { buildSettings, readSettings } from './settings.ts';
import { startRouter } from './service.ts';

export function buildLaunchConfig(registry: Registry, existing: JsonObject, inherited: NodeJS.ProcessEnv, home = homedir()) {
  const defaultModel = getDefaultModel(registry);
  if (!defaultModel) throw new ConfigError('Exactly one model must have default: true');
  const settings = buildSettings(existing, registry);
  if ('apiKeyHelper' in settings || 'env' in settings) throw new ConfigError('Launcher settings must not contain apiKeyHelper or env');
  const environment = { ...inherited };
  for (const name of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'LOCAL_ROUTER_TOKEN', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY',
  ]) delete environment[name];
  const windows: number[] = [];
  for (const { provider, model } of registry.values()) {
    if (provider.api_key_env) delete environment[provider.api_key_env];
    if ((provider.auth ?? 'api_key') === 'api_key' && model.context) windows.push(model.context.window);
  }
  environment.CLAUDE_CONFIG_DIR = join(home, '.claude-sub');
  environment.ANTHROPIC_BASE_URL = BASE_URL;
  environment.ANTHROPIC_DEFAULT_MODEL = defaultModel;
  if (windows.length) environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(...windows));
  return { environment, settings };
}

export function launchPreview(registry = loadRegistry(), existing = readSettings()) {
  const { environment, settings } = buildLaunchConfig(registry, existing, process.env);
  const binary = findExecutable('claude');
  if (!binary) throw new ConfigError('claude executable was not found in PATH');
  return {
    claude_binary: binary, config_dir: environment.CLAUDE_CONFIG_DIR, base_url: BASE_URL,
    default_model: settings.model, default_option: environment.ANTHROPIC_DEFAULT_MODEL,
    custom_context_window: environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    available_models: settings.availableModels, router_auth: 'none', runtime: 'typescript',
  };
}

export async function launch(args: string[]): Promise<number> {
  const registry = loadRegistry();
  const existing = readSettings();
  if (args.length === 1 && args[0] === '--check') { console.log(JSON.stringify(launchPreview(registry, existing), null, 2)); return 0; }
  const binary = findExecutable('claude');
  if (!binary) throw new ConfigError('claude executable was not found in PATH');
  const { environment, settings } = buildLaunchConfig(registry, existing, process.env);
  await startRouter(registry);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--settings', JSON.stringify(settings), '--model', String(settings.model), ...args], { env: environment, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt).on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt).off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}
