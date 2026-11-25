"""Exercise a policy change within one Claude Code PTY session."""
import json
import os
import pathlib
import re
import subprocess
import time
import uuid

import pexpect

session = str(uuid.uuid4())
root = pathlib.Path(__file__).resolve().parents[1]
work = root / 'temp' / f'dynamic-policy-e2e-{session}'
work.mkdir(parents=True, exist_ok=True)
policy = work / 'policy.yaml'
env = dict(os.environ, CLAUDE_SUB_SUBAGENT_CONFIG=str(policy), CLAUDE_CODE_MAX_RETRIES='0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_TELEMETRY='1')
policy.write_text('subagents:\n  model: inherit\n  force: false\ncompaction:\n  model: inherit\n')
args = ['--model', 'deepseek-flash', '--session-id', session, '--ax-screen-reader', '--effort', 'low', '--tools', 'Agent,Read', '--allowedTools', 'Agent,Read', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--permission-mode', 'default']
child = pexpect.spawn('claude-sub', args, cwd=str(work), env=env, encoding='utf-8', timeout=1, dimensions=(35, 150))
screen = ''

def wait_for(pattern, seconds=70):
    global screen
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            screen += child.read_nonblocking(65536, timeout=0.5)
        except pexpect.TIMEOUT:
            continue
        except pexpect.EOF:
            break
        if re.search(pattern, screen, re.I | re.S):
            return True
    return False

def send(text):
    global screen
    screen = ''
    child.send(text)
    child.send('\r')

def journal():
    return subprocess.run(['journalctl', '--user', '-u', 'claude-sub-router.service', '--since', started, '--no-pager', '-o', 'cat'], capture_output=True, text=True, check=True).stdout

started = time.strftime('%Y-%m-%d %H:%M:%S')
result = {'session': session}
try:
    if not wait_for(r'\$|❯|trust this folder|Quick safety check', 30):
        raise RuntimeError('session did not start')
    if re.search(r'trust this folder|Quick safety check', screen, re.I):
        child.send('1\r')
        time.sleep(2)
    send('Use the Agent tool to start a new general-purpose subagent. Ask it to respond with the exact word FIRSTPROBE. Report its answer.')
    result['first_reply'] = wait_for('FIRSTPROBE.*FIRSTPROBE', 70)
    time.sleep(3)
    policy.write_text('subagents:\n  model: deepseek-pro\n  force: true\ncompaction:\n  model: deepseek-pro\n')
    send('Start a NEW general-purpose Agent, not the prior agent. Ask it to reply exactly SECONDPROBE and report the answer.')
    result['second_reply'] = wait_for('SECONDPROBE.*SECONDPROBE', 70)
    time.sleep(3)
    send('/compact Preserve the important context of this conversation.')
    result['compact_displayed'] = wait_for(r'conversation compacted|compacted \(ctrl\+o', 100)
    policy.write_text('subagents:\n  model: deepseek-pro\n  force: true\ncompaction:\n  model: inherit\n')
    send('Reply with the exact word AFTERCOMPACT and briefly describe what we just tested.')
    result['after_compact_reply'] = wait_for('AFTERCOMPACT.*AFTERCOMPACT', 70)
    time.sleep(2)
    send('/compact Preserve the important context of this conversation.')
    result['inherit_compact_displayed'] = wait_for(r'conversation compacted|compacted \(ctrl\+o', 100)
    logs = journal()
    result['pro_request'] = bool(re.search(r'REQUEST .*"model":"deepseek-pro".*"request_class":"subagent"', logs))
    result['compact_pro'] = bool(re.search(r'REQUEST .*"model":"deepseek-pro".*"request_class":"compaction"', logs))
    result['compact_inherit'] = bool(re.search(r'REQUEST .*"model":"deepseek-flash".*"request_class":"compaction"', logs))
    result['upstream_failure'] = bool(re.search(r'UPSTREAM_STATUS .*"status":(?:4|5)\d\d', logs))
    project = next((pathlib.Path.home() / '.claude/projects').glob(f'*/{session}/subagents'), None)
    child_models = []
    if project:
        for path in project.glob('agent-*.jsonl'):
            for line in path.read_text().splitlines():
                item = json.loads(line)
                if item.get('type') == 'assistant':
                    model = item.get('message', {}).get('model')
                    if model and model != '<synthetic>':
                        child_models.append(model)
    result['child_models'] = sorted(set(child_models))
finally:
    child.send('/exit\r')
    try:
        child.expect(pexpect.EOF, timeout=8)
    except pexpect.TIMEOUT:
        child.terminate(force=True)
    child.close()
    result['exit_code'] = child.exitstatus
    (work / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, ensure_ascii=False), flush=True)
if not (result.get('first_reply') and result.get('second_reply') and result.get('compact_displayed') and result.get('after_compact_reply') and result.get('inherit_compact_displayed') and result.get('pro_request') and result.get('compact_pro') and result.get('compact_inherit') and not result.get('upstream_failure') and set(result.get('child_models', [])) >= {'deepseek-flash', 'deepseek-v4-pro'} and result.get('exit_code') == 0):
    raise SystemExit(1)
