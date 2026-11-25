import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../config/dynamic-policy-plugin/hooks/register.js';

test('dynamic spawn restores inherited values and applies a later override', async () => {
  let hook;
  register((_name, callback) => { hook = callback; return { catch() {} }; });
  const values = new Map([
    ['CLAUDE_SUB_DYNAMIC_BASELINE', JSON.stringify({ model: 'original', force: '0', initialOverride: true })],
    ['CLAUDE_CODE_SUBAGENT_MODEL', 'old-override'],
    ['CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '1'],
    ['CLAUDE_SUB_DYNAMIC_CLI', '/cli'],
    ['CLAUDE_SUB_DYNAMIC_NODE', '/node'],
  ]);
  let selection = { model: 'inherit', force: false };
  const api = {
    env: {
      get: async key => values.get(key),
      set: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, value); return {}; },
    },
    settings: { read: async () => ({ CLAUDE_CODE_SUBAGENT_MODEL: 'settings-model' }) },
    process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(selection) }) },
  };
  const next = async () => ({ model: values.get('CLAUDE_CODE_SUBAGENT_MODEL'), force: values.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE') });
  assert.deepEqual(await hook(api, {}, next), { model: 'settings-model', force: '0' });
  selection = { model: 'deepseek-pro', force: true };
  assert.deepEqual(await hook(api, {}, next), { model: 'deepseek-pro', force: '1' });
  selection = { model: 'inherit', force: false };
  assert.deepEqual(await hook(api, {}, next), { model: 'settings-model', force: '0' });
});
