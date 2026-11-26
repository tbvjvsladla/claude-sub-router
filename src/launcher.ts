import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ConfigError, getDefaultModel, isObject, loadRegistry, NATIVE_AUTH_FEATURE, REASONING_FEATURE, resolveModelId, ROOT } from './config.ts';
import type { JsonObject, Registry } from './config.ts';
import { BASE_URL, context, findExecutable, run } from './platform.ts';
import type { Context } from './platform.ts';
import { loadProviderEnvironment, providerKeyNames } from './environment.ts';
import { readInstallation } from './installation.ts';
import { buildSettings, readSettings } from './settings.ts';
import { startRouter } from './service.ts';
import { applyModelPolicy, assertDynamicPolicyVersion, assertModelPolicyVersion, COMPACTION_POLICY_FEATURE, defaultModelPolicy, DYNAMIC_POLICY_FEATURE, DYNAMIC_POLICY_HEADER, loadModelPolicy } from './subagents.ts';
import type { ModelPolicy } from './subagents.ts';

export function buildLaunchConfig(registry: Registry, existing: JsonObject, inherited: NodeJS.ProcessEnv, policy: ModelPolicy = defaultModelPolicy()) {
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
    for (const key of providerKeyNames(provider)) delete environment[key];
    if ((provider.auth ?? 'api_key') === 'api_key' && model.context) windows.push(model.context.window);
  }
  if ([...registry.values()].some(({ provider }) => provider.auth === 'claude_native')) {
    // Only the launched Claude process receives the Anthropic key. Claude keeps
    // its own interactive approval and non-interactive authentication policy.
    if (inherited.ANTHROPIC_API_KEY?.trim()) environment.ANTHROPIC_API_KEY = inherited.ANTHROPIC_API_KEY;
    if (inherited.CLAUDE_CODE_OAUTH_TOKEN?.trim()) environment.CLAUDE_CODE_OAUTH_TOKEN = inherited.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // Keep Claude's native profile resolution, including an explicitly inherited
  // CLAUDE_CONFIG_DIR. Changing it also separates plugins, login and transcripts.
  environment.ANTHROPIC_BASE_URL = BASE_URL;
  environment.ANTHROPIC_DEFAULT_MODEL = defaultModel;
  if (windows.length) environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(...windows));
  applyModelPolicy(environment, policy);
  return { environment, settings };
}

export function loadLaunchEnvironment(registry: Registry, ctx: Context = context(), inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return loadProviderEnvironment(registry, { root: ctx.root, envFile: readInstallation(ctx)?.envFile, environment: inherited }).environment;
}

export function launchPreview(registry = loadRegistry(), existing = readSettings(), policy = loadModelPolicy(registry, { path: process.env.CLAUDE_SUB_SUBAGENT_CONFIG })) {
  const { environment, settings } = buildLaunchConfig(registry, existing, loadLaunchEnvironment(registry), policy);
  const binary = findExecutable('claude');
  if (!binary) throw new ConfigError('claude executable was not found in PATH');
  return {
    claude_binary: binary, config_dir: environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), base_url: BASE_URL,
    default_model: settings.model, default_option: environment.ANTHROPIC_DEFAULT_MODEL,
    custom_context_window: environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    subagent_model: environment.CLAUDE_CODE_SUBAGENT_MODEL ?? 'inherit',
    subagent_force: environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === '1',
    model_policy: policy,
    anthropic_auth: { api_key_configured: !!environment.ANTHROPIC_API_KEY, api_key_source: process.env.ANTHROPIC_API_KEY?.trim() ? 'inherited_environment' : environment.ANTHROPIC_API_KEY ? 'provider_env_file' : 'none', interactive: 'claude_code_policy', print: environment.ANTHROPIC_API_KEY ? 'api_key' : 'claude_code_policy' },
    available_models: settings.availableModels, router_auth: 'none', runtime: 'typescript',
  };
}

export async function assertRouterCompatibility(registry: Registry, policy: ModelPolicy, fetcher = fetch): Promise<void> {
  const required = [];
  required.push(DYNAMIC_POLICY_FEATURE);
  if (policy.compaction.model !== 'inherit') required.push(COMPACTION_POLICY_FEATURE);
  if ([...registry.values()].some(({ provider }) => provider.auth === 'claude_native')) required.push(NATIVE_AUTH_FEATURE);
  if ([...registry.values()].some(({ model }) => model.reasoning?.mode === 'map')) required.push(REASONING_FEATURE);
  if (!required.length) return;
  const response = await fetcher(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  const health: unknown = await response.json();
  if (!response.ok || !isObject(health) || !Array.isArray(health.features) || required.some(feature => !(health.features as unknown[]).includes(feature))) {
    throw new ConfigError('Running router does not support the required authentication, model or reasoning policy; run npm run build and claude-sub-router restart');
  }
}

export async function launch(args: string[]): Promise<number> {
  const registry = loadRegistry();
  const existing = readSettings();
  const policy = loadModelPolicy(registry, { path: process.env.CLAUDE_SUB_SUBAGENT_CONFIG });
  if (args.length === 1 && args[0] === '--check') { console.log(JSON.stringify(launchPreview(registry, existing, policy), null, 2)); return 0; }
  const binary = findExecutable('claude');
  if (!binary) throw new ConfigError('claude executable was not found in PATH');
  const { environment, settings } = buildLaunchConfig(registry, existing, loadLaunchEnvironment(registry), policy);
  // Keep the initial policy even if a user's Claude configuration disables
  // plugins. The mod needs the original environment to restore inherit.
  environment.CLAUDE_SUB_DYNAMIC_BASELINE = JSON.stringify({
    model: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
    force: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE,
    initialOverride: policy.subagents.model !== 'inherit',
  });
  const policyPath = process.env.CLAUDE_SUB_SUBAGENT_CONFIG ? resolve(process.env.CLAUDE_SUB_SUBAGENT_CONFIG) : undefined;
  if (policyPath) environment.CLAUDE_SUB_DYNAMIC_CONFIG = policyPath;
  else delete environment.CLAUDE_SUB_DYNAMIC_CONFIG;
  environment.CLAUDE_SUB_DYNAMIC_CLI = join(ROOT, 'dist/cli.js');
  environment.CLAUDE_SUB_DYNAMIC_NODE = process.execPath;
  environment.CLAUDE_CODE_GATEWAY_HINT_HEADERS = '1';
  environment.ANTHROPIC_CUSTOM_HEADERS = `${DYNAMIC_POLICY_HEADER}: ${policyPath ? `path.${Buffer.from(policyPath).toString('base64url')}` : 'default'}`;
  if (args.includes('--safe-mode') || args.includes('--bare')) throw new ConfigError('Dynamic model policies require plugins; --safe-mode and --bare are not supported');
  const version = await run(binary, ['--version']);
  if (version.code !== 0) throw new ConfigError('Could not determine Claude Code version for model policy');
  assertDynamicPolicyVersion(version.stdout);
  assertModelPolicyVersion(version.stdout, policy);
  await startRouter(registry);
  await assertRouterCompatibility(registry, policy);
  // Normalize explicit old IDs before Claude validates its model selection.
  const launchArgs = [...args];
  for (const [index, arg] of args.entries()) {
    if (arg === '--') break;
    const next = args[index + 1];
    if (arg === '--model' && next !== undefined) {
      launchArgs[index + 1] = resolveModelId(registry, next);
    } else if (arg.startsWith('--model=')) {
      launchArgs[index] = `--model=${resolveModelId(registry, arg.slice('--model='.length))}`;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--plugin-dir', join(ROOT, 'config/dynamic-policy-plugin'), '--settings', JSON.stringify(settings), '--model', String(settings.model), ...launchArgs], { env: environment, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt).on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt).off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}
