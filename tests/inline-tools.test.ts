import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistry } from '../src/config.ts';
import type { JsonObject } from '../src/config.ts';
import { applyInlineToolCompatibility } from '../src/inline-tools.ts';

const provider = loadRegistry().get('deepseek-flash')!.provider;
const definition = { name: 'mcp__docs__read', description: 'Read a document', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const addition = { type: 'tool_addition', tool: { type: 'tool_definition', definition } };

test('OpenRouter omits the non-callable Claude deferred placeholder without changing real tools', () => {
  const openrouter = loadRegistry().get('gpt-6-luna')!.provider;
  const placeholder = { name: 'DeferredToolPlaceholder', description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.', input_schema: { type: 'object', properties: {} }, defer_loading: true };
  const read = { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } };
  const body = { tools: [placeholder, read], messages: [{ role: 'user', content: 'Read a file' }] };
  const original = structuredClone(body);
  assert.deepEqual(applyInlineToolCompatibility(body, openrouter), { ...body, tools: [read] });
  assert.deepEqual(body, original);
  const deferred = { ...definition, defer_loading: true };
  const search = { name: 'ToolSearch', input_schema: { type: 'object' } };
  const discovered = { tools: [placeholder, search, deferred], messages: [{ role: 'system', content: [addition] }] };
  assert.deepEqual(applyInlineToolCompatibility(discovered, openrouter), { ...discovered, tools: [search, deferred] });
  for (const { provider: other } of loadRegistry().values()) {
    if (other.id !== openrouter.id && !['kimi', 'deepseek'].includes(other.id)) assert.equal(applyInlineToolCompatibility(body, other), body);
  }
  const sameNameRealTool = { tools: [{ ...placeholder, input_schema: { type: 'object', properties: { value: { type: 'string' } } } }], messages: [] };
  assert.equal(applyInlineToolCompatibility(sameNameRealTool, openrouter), sameNameRealTool);
});

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
    if (!['deepseek', 'kimi'].includes(other.id)) assert.equal(applyInlineToolCompatibility(body, other), body);
  }
});

test('Kimi exposes discovered tools without preloading deferred or removed tools', () => {
  const kimi = loadRegistry().get('kimi-k3')!.provider;
  const search = { name: 'ToolSearch', input_schema: { type: 'object' } };
  const unused = { ...definition, name: 'unused', defer_loading: true };
  const body = {
    tools: [search, unused],
    messages: [{ role: 'user', content: 'hello' }, { role: 'system', content: [{ type: 'text', text: 'New tools' }, addition] }],
  };
  const original = structuredClone(body);
  const result = applyInlineToolCompatibility(body, kimi);
  assert.deepEqual(result.tools, [search, definition]);
  assert.deepEqual(result.messages, [body.messages[0], { role: 'system', content: [{ type: 'text', text: 'New tools' }] }]);
  assert.deepEqual(body, original);
  const removed = applyInlineToolCompatibility({ ...body, messages: [...body.messages, { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: definition.name } }] }] }, kimi);
  assert.deepEqual(removed.tools, [search]);
  assert.deepEqual(removed.messages, result.messages);
  const initial = applyInlineToolCompatibility({ tools: [search, unused], messages: [body.messages[0]] }, kimi);
  assert.deepEqual(initial.tools, [search]);
  const selected = applyInlineToolCompatibility({ tools: [search, unused], messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'unused' } }] }] }, kimi);
  assert.deepEqual(selected.tools, [search, { ...definition, name: 'unused' }]);
  assert.deepEqual(selected.messages, []);
});

test('Kimi uses the current tool definition and preserves text, call history and literal tool result data', () => {
  const kimi = loadRegistry().get('kimi-k3')!.provider;
  const updated = { ...definition, description: 'Updated document reader', defer_loading: true };
  const history = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: definition.name, input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [addition] }] }];
  const body = { messages: [{ role: 'system', content: [addition] }, ...history, { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: updated } }] }], thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
  const original = structuredClone(body);
  const result = applyInlineToolCompatibility(body, kimi);
  const { defer_loading: _deferred, ...current } = updated;
  assert.deepEqual(result.tools, [current]);
  assert.deepEqual(result.messages, history);
  assert.deepEqual(result.thinking, body.thinking);
  assert.deepEqual(result.output_config, body.output_config);
  assert.deepEqual(body, original);
});

test('Kimi resolves tool search references from deferred declarations and later inline additions', () => {
  const kimi = loadRegistry().get('kimi-k3')!.provider;
  const search = { name: 'ToolSearch', input_schema: { type: 'object' } };
  const cache_control = { type: 'ephemeral' };
  const result = { type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'text', text: 'Found a tool' }, { type: 'tool_reference', tool_name: definition.name, cache_control }] };
  const history = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'search_1', name: 'ToolSearch', input: { query: 'docs' } }] }, { role: 'user', content: [result] }];
  const expectedHistory = [history[0], { role: 'user', content: [{ ...result, content: [result.content[0], { type: 'text', text: `Tool available: ${definition.name}`, cache_control }] }] }];
  for (const inline of [false, true]) {
    const body = { tools: [search, { ...definition, name: 'unused', defer_loading: true }, ...(inline ? [] : [{ ...definition, defer_loading: true }])], messages: [...history, ...(inline ? [{ role: 'system', content: [addition] }] : [])] };
    const original = structuredClone(body);
    const output = applyInlineToolCompatibility(body, kimi);
    assert.deepEqual(output.tools, [search, definition]);
    assert.deepEqual(output.messages, expectedHistory);
    assert.deepEqual(body, original);
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
