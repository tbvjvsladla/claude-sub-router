import { isObject } from './config.ts';
import type { JsonObject, Provider } from './config.ts';

function flattenKimiTools(body: JsonObject): JsonObject {
  if (!Array.isArray(body.messages) || (body.tools !== undefined && !Array.isArray(body.tools))) return body;
  const declared = new Map<string, JsonObject>();
  const active = new Map<string, JsonObject>();
  const unnamed: unknown[] = [];
  let changed = false;
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isObject(tool) || typeof tool.name !== 'string') { unnamed.push(tool); continue; }
    declared.set(tool.name, tool);
    if (tool.defer_loading === true) changed = true;
    else active.set(tool.name, tool);
  }
  // Search results can reference a definition added later in the same request.
  for (const message of body.messages) {
    if (!isObject(message) || message.role !== 'system' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== 'tool_addition' || !isObject(block.tool) || block.tool.type !== 'tool_definition') continue;
      const definition = block.tool.definition;
      if (isObject(definition) && typeof definition.name === 'string' && isObject(definition.input_schema)) declared.set(definition.name, definition);
    }
  }
  const messages = body.messages.flatMap(message => {
    if (!isObject(message) || !Array.isArray(message.content)) return [message];
    let messageChanged = false;
    const content = message.content.flatMap(block => {
      if (isObject(block) && message.role === 'user' && block.type === 'tool_result' && Array.isArray(block.content)) {
        let resultChanged = false;
        const result = block.content.map(reference => {
          if (!isObject(reference) || reference.type !== 'tool_reference' || typeof reference.tool_name !== 'string') return reference;
          const definition = declared.get(reference.tool_name);
          if (!definition) return reference;
          active.set(reference.tool_name, definition);
          resultChanged = messageChanged = changed = true;
          return { type: 'text', text: `Tool available: ${reference.tool_name}`, ...(reference.cache_control !== undefined ? { cache_control: reference.cache_control } : {}) };
        });
        return resultChanged ? [{ ...block, content: result }] : [block];
      }
      if (!isObject(block) || message.role !== 'system' || !['tool_addition', 'tool_removal'].includes(String(block.type)) || !isObject(block.tool)) return [block];
      const tool = block.tool;
      const definition = tool.type === 'tool_definition' && isObject(tool.definition) ? tool.definition : undefined;
      const name = definition?.name ?? (tool.type === 'tool_reference' ? tool.name : undefined);
      if (typeof name !== 'string' || !name || (definition && !isObject(definition.input_schema))) return [block];
      if (definition) declared.set(name, definition);
      if (block.type === 'tool_removal') active.delete(name);
      else {
        const available = declared.get(name);
        if (!available) return [block];
        active.set(name, available);
      }
      messageChanged = true;
      changed = true;
      return [];
    });
    if (!messageChanged) return [message];
    return content.length ? [{ ...message, content }] : [];
  });
  if (!changed) return body;
  const tools = [...unnamed, ...[...active.values()].map(tool => {
    const definition = { ...tool };
    delete definition.defer_loading;
    return definition;
  })];
  return { ...body, tools, messages };
}

export function applyInlineToolCompatibility(body: JsonObject, provider: Provider): JsonObject {
  if (provider.id === 'openrouter-openai' && Array.isArray(body.tools)) {
    // Claude reserves this non-callable sentinel even when no tool search is
    // enabled. OpenRouter treats it as a real deferred tool and rejects the
    // request without a search tool. Keep real deferred tools and search intact.
    const tools = body.tools.filter(tool => !(isObject(tool) && tool.name === 'DeferredToolPlaceholder' &&
      tool.defer_loading === true &&
      tool.description === 'Reserved placeholder that keeps deferred tool loading active; never call this tool.' &&
      isObject(tool.input_schema) && tool.input_schema.type === 'object' &&
      isObject(tool.input_schema.properties) && Object.keys(tool.input_schema.properties).length === 0 &&
      (!Array.isArray(tool.input_schema.required) || tool.input_schema.required.length === 0)));
    return tools.length === body.tools.length ? body : { ...body, tools };
  }
  if (provider.id === 'kimi') return flattenKimiTools(body);
  if (provider.id !== 'deepseek' || !Array.isArray(body.messages) || (body.tools !== undefined && !Array.isArray(body.tools))) return body;
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  const positions = new Map<string, number>();
  tools.forEach((tool, index) => { if (isObject(tool) && typeof tool.name === 'string') positions.set(tool.name, index); });
  let changed = false;
  const messages = body.messages.map(message => {
    if (!isObject(message) || message.role !== 'system' || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map(block => {
      if (!isObject(block) || block.type !== 'tool_addition' || !isObject(block.tool) || block.tool.type !== 'tool_definition') return block;
      const definition = block.tool.definition;
      if (!isObject(definition) || typeof definition.name !== 'string' || !definition.name || !isObject(definition.input_schema)) return block;
      const index = positions.get(definition.name);
      const previous = index !== undefined && isObject(tools[index]) ? tools[index] : undefined;
      // DeepSeek accepts additions by reference. Defer newly hoisted tools so
      // they become available at the original addition, not from the first turn.
      const hoisted: JsonObject = { ...definition, defer_loading: previous ? previous.defer_loading === true : true };
      delete hoisted.cache_control;
      if (index === undefined) {
        positions.set(definition.name, tools.length);
        tools.push(hoisted);
      } else tools[index] = hoisted;
      messageChanged = true;
      changed = true;
      return {
        ...block,
        ...(block.cache_control === undefined && definition.cache_control !== undefined ? { cache_control: definition.cache_control } : {}),
        tool: { type: 'tool_reference', name: definition.name },
      };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? { ...body, tools, messages } : body;
}
