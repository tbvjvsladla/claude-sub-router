// Paid integration test: actual Claude Agent + child Read + provider response.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultModel, loadRegistry } from '../dist/config.js';
import { routerReport } from '../dist/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = loadRegistry();
const parentModel = process.env.SUBAGENT_TEST_MAIN_MODEL || 'deepseek-flash';
const requested = process.argv.slice(2);
const models = requested.length ? requested : [...registry].filter(([, entry]) => entry.provider.auth !== 'claude_subscription').map(([id]) => id);
for (const model of [parentModel, ...models]) if (!registry.has(model)) throw new Error(`Unknown registered model: ${model}`);
const directory = mkdtempSync(join(tmpdir(), 'claude-sub-agent-e2e-'));
const artifact = join(root, 'artifacts/subagents-e2e.json');
mkdirSync(join(root, 'artifacts'), { recursive: true });
const report = { started_at: new Date().toISOString(), default_model: getDefaultModel(registry), main_model: parentModel, cases: [] };
let cancelled = false;
const save = () => writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const textContent = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
const matchesModel = (actual, expected) => actual === expected || actual === registry.get(expected)?.model.upstream_model;

async function logs() {
  try { const result = await routerReport('logs'); return result.code === 0 ? result.stdout.trim().split('\n') : []; }
  catch { return []; }
}
function addedLines(before, after) {
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--) {
    if (before.slice(-overlap).every((line, index) => line === after[index])) return after.slice(overlap);
  }
  return after;
}
async function invoke(args, environment) {
  return new Promise(resolve => {
    const child = spawn('claude-sub', args, { cwd: directory, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let timedOut = false;
    const terminate = signal => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const interrupted = () => { cancelled = true; timedOut = true; terminate('SIGTERM'); };
    process.once('SIGINT', interrupted).once('SIGTERM', interrupted);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024); });
    child.stderr.resume();
    const timeout = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, 180000);
    const force = setTimeout(() => terminate('SIGKILL'), 185000);
    const finish = code => {
      clearTimeout(timeout); clearTimeout(force);
      process.off('SIGINT', interrupted).off('SIGTERM', interrupted);
      const events = stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      resolve({ code, events, timedOut });
    };
    child.once('error', () => finish(-1));
    child.once('close', finish);
  });
}

const cases = models.map(model => ({ name: 'force_over_definition', model, force: true, definitionModel: 'sonnet', expected: model, agentType: 'router-probe' }));
if (!requested.length) {
  cases.push(
    { name: 'default_without_definition', model: 'gpt-6.1-sol', force: false, expected: 'gpt-6.1-sol', agentType: 'router-probe' },
    { name: 'definition_over_default', model: 'gpt-6.1-sol', force: false, definitionModel: 'deepseek-flash', expected: 'deepseek-flash', agentType: 'router-probe' },
    { name: 'force_builtin_explore', model: 'gpt-6.1-sol', force: true, expected: 'gpt-6.1-sol', agentType: 'Explore' },
  );
}
try {
  for (const scenario of cases) {
    if (cancelled) break;
    const token = `CHILD_READ_${randomUUID()}`;
    const challenge = join(directory, 'challenge.txt');
    const config = join(directory, 'subagents.yaml');
    writeFileSync(challenge, `${token}\n`);
    writeFileSync(config, `model: ${scenario.model}\nforce: ${scenario.force}\n`);
    const worker = { description: 'Mandatory file reading test worker', prompt: 'Use Read to read challenge.txt in your current directory. Return its complete contents. Do not guess. Do not spawn other agents.', tools: ['Read'], maxTurns: 5 };
    if (scenario.definitionModel) worker.model = scenario.definitionModel;
    const args = ['-p', `Invoke the ${scenario.agentType} subagent once to read ${challenge} and return its exact contents. Do not read the file yourself. Wait for the agent to finish, then return its result. Do not use fork, isolation, or other agents.`,
      '--model', parentModel, '--output-format', 'stream-json', '--verbose', '--tools', 'Agent,Read', '--allowedTools', 'Agent', 'Read',
      '--agents', JSON.stringify({ 'router-probe': worker }), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--disable-slash-commands', '--no-session-persistence', '--effort', 'low', '--max-turns', '6',
      '--system-prompt', `You are a routing integration test coordinator. Always delegate the requested task to the ${scenario.agentType} subagent. Never read files yourself.`];
    const environment = { ...process.env, CLAUDE_SUB_SUBAGENT_CONFIG: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
    const before = await logs();
    const started = performance.now();
    console.log(JSON.stringify({ starting: scenario.name, main_model: parentModel, subagent_model: scenario.model, expected: scenario.expected }));
    const { code, events, timedOut } = await invoke(args, environment);
    const additions = addedLines(before, await logs());
    const routed = additions.flatMap(line => {
      const match = /\b(REQUEST|UPSTREAM_STATUS) (\{.*\})$/.exec(line);
      try { return match ? [{ event: match[1], ...JSON.parse(match[2]) }] : []; } catch { return []; }
    }).filter(event => event.model === scenario.expected);
    const main = events.filter(event => event.type === 'assistant' && !event.parent_tool_use_id);
    const calls = main.flatMap(event => event.message?.content ?? []).filter(block => block.type === 'tool_use' && block.name === 'Agent' && block.input?.subagent_type === scenario.agentType);
    const callIDs = new Set(calls.map(call => call.id));
    const children = events.filter(event => callIDs.has(event.parent_tool_use_id));
    const childMessages = children.filter(event => event.type === 'assistant');
    const reads = childMessages.flatMap(event => event.message?.content ?? []).filter(block => block.type === 'tool_use' && block.name === 'Read' && block.input?.file_path === challenge);
    const readIDs = new Set(reads.map(read => read.id));
    const readResult = children.some(event => (event.message?.content ?? []).some(block => block.type === 'tool_result' && readIDs.has(block.tool_use_id) && !block.is_error && textContent(block.content).includes(token)));
    const childReturned = childMessages.some(event => (event.message?.content ?? []).some(block => block.type === 'text' ? block.text?.includes(token) : block.name === 'SubagentHandback' && block.input?.message?.includes(token)));
    const childModels = [...new Set(childMessages.map(event => event.message?.model).filter(model => model && model !== '<synthetic>'))];
    const parentRead = main.some(event => event.message?.content?.some(block => block.type === 'tool_use' && block.name === 'Read'));
    const result = events.findLast(event => event.type === 'result');
    const checks = {
      main_model: main.some(event => matchesModel(event.message?.model, parentModel)),
      delegated: calls.length === 1,
      child_model: childModels.length > 0 && childModels.every(model => matchesModel(model, scenario.expected)),
      child_read_succeeded: readResult, child_returned_token: childReturned, parent_did_not_read: !parentRead,
      parent_received_token: result?.result?.includes(token) === true,
      provider_request: routed.some(event => event.event === 'REQUEST'), provider_success: routed.some(event => event.event === 'UPSTREAM_STATUS' && event.status === 200),
    };
    const passed = code === 0 && !timedOut && !result?.is_error && Object.values(checks).every(Boolean);
    const entry = { name: scenario.name, configured_model: scenario.model, force: scenario.force, definition_model: scenario.definitionModel ?? null, expected_child_model: scenario.expected, observed_child_models: childModels, passed, checks, exit_code: code, timed_out: timedOut, duration_ms: Math.round(performance.now() - started), cli_estimated_cost_usd: result?.total_cost_usd ?? null, cost_basis: result?.modelUsage ?? {}, errors: [...new Set(events.map(event => event.error).filter(Boolean))] };
    report.cases.push(entry); save(); console.log(JSON.stringify(entry));
  }
} finally { report.finished_at = new Date().toISOString(); save(); rmSync(directory, { recursive: true, force: true }); }
if (cancelled || report.cases.some(entry => !entry.passed)) process.exitCode = 1;
