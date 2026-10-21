import { isObject } from './config.ts';
import type { JsonObject, Provider } from './config.ts';

export function applyInlineToolCompatibility(body: JsonObject, provider: Provider): JsonObject {
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
