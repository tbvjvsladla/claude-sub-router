import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistry } from '../src/config.ts';
import type { JsonObject } from '../src/config.ts';
import { applyInlineToolCompatibility } from '../src/inline-tools.ts';

const provider = loadRegistry().get('deepseek-flash')!.provider;
const definition = { name: 'mcp__docs__read', description: 'Read a document', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const addition = { type: 'tool_addition', tool: { type: 'tool_definition', definition } };

test('inline client tools become deferred declarations and references at the same point in history', () => {
  const messages = [{ role: 'user', content: 'hello' }, { role: 'system', content: [{ type: 'text', text: 'New tools are available' }, addition] }];
  const body = { messages, metadata: { user_id: 'FAKE' } };
  const original = structuredClone(body);
  const result = applyInlineToolCompatibility(body, provider);
  assert.deepEqual(result.tools, [{ ...definition, defer_loading: true }]);
  assert.deepEqual(result.messages, [messages[0], { role: 'system', content: [messages[1]!.content[0], { type: 'tool_addition', tool: { type: 'tool_reference', name: definition.name } }] }]);
  assert.deepEqual(result.metadata, body.metadata);
  assert.deepEqual(body, original);
  for (const { provider: other } of loadRegistry().values()) {
    if (other.id !== 'deepseek') assert.equal(applyInlineToolCompatibility(body, other), body);
  }
});

test('tool replacements, removals and re-additions keep one current declaration and their message order', () => {
  const updated = { ...definition, description: 'Updated document reader' };
  const removal = { type: 'tool_removal', tool: { type: 'tool_reference', name: definition.name } };
  const body = {
    tools: [{ name: 'base', input_schema: { type: 'object' } }],
    messages: [
      { role: 'system', content: [addition] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: definition.name, input: { path: '/old' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'old result' }] },
      { role: 'system', content: [removal, { ...addition, tool: { type: 'tool_definition', definition: updated } }] },
    ],
  };
  const original = structuredClone(body);
  const result = applyInlineToolCompatibility(body, provider);
  assert.deepEqual(result.tools, [body.tools[0], { ...updated, defer_loading: true }]);
  const messages = result.messages as JsonObject[];
  assert.deepEqual(messages[1], body.messages[1]);
  assert.deepEqual(messages[2], body.messages[2]);
  assert.deepEqual(messages[3]!.content, [removal, { type: 'tool_addition', tool: { type: 'tool_reference', name: definition.name } }]);
  assert.deepEqual(body, original);
});

test('existing availability and inline cache controls survive conversion without touching tool output data', () => {
  const cache_control = { type: 'ephemeral' };
  const cached = { ...addition, tool: { type: 'tool_definition', definition: { ...definition, cache_control } } };
  const literal = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [cached] }] };
  const body = { tools: [definition], messages: [{ role: 'system', content: [cached] }, literal] };
  const result = applyInlineToolCompatibility(body, provider);
  assert.deepEqual(result.tools, [{ ...definition, defer_loading: false }]);
  assert.deepEqual(result.messages, [{ role: 'system', content: [{ type: 'tool_addition', cache_control, tool: { type: 'tool_reference', name: definition.name } }] }, literal]);
  const unsupported = { type: 'tool_addition', tool: { type: 'tool_definition', definition: { type: 'mcp_toolset', mcp_server_name: 'docs' } } };
  for (const unchanged of [{}, { messages: [] }, { messages: [{ role: 'system', content: [unsupported] }] }, { tools: 'invalid', messages: [{ role: 'system', content: [addition] }] }]) {
    assert.equal(applyInlineToolCompatibility(unchanged, provider), unchanged);
  }
});
