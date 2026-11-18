import { isObject } from './config.ts';
import type { JsonObject } from './config.ts';

function normalizeCacheControl(value: unknown): unknown {
  if (!isObject(value) || value.ttl !== '1h') return value;
  return { ...value, ttl: '5m' };
}

function normalizeCache(value: unknown): unknown {
  if (!isObject(value) || !Object.hasOwn(value, 'cache_control')) return value;
  return { ...value, cache_control: normalizeCacheControl(value.cache_control) };
}

function normalizeContent(content: unknown[]): unknown[] {
  return content.map(block => {
    const normalized = normalizeCache(block);
    if (isObject(normalized) && normalized.type === 'tool_result' && Array.isArray(normalized.content)) {
      return { ...normalized, content: normalized.content.map(normalizeCache) };
    }
    return normalized;
  });
}

export function applyMetaMessagesCompatibility(body: JsonObject): JsonObject {
  // Meta Messages accepts only a 5-minute cache TTL and summarized or omitted thinking.
  const payload = { ...body };
  if (Object.hasOwn(body, 'cache_control')) payload.cache_control = normalizeCacheControl(body.cache_control);
  if (isObject(body.thinking) && body.thinking.display === 'updates') {
    payload.thinking = { ...body.thinking, display: 'summarized' };
  }
  if (Array.isArray(body.system)) payload.system = normalizeContent(body.system);
  if (Array.isArray(body.tools)) payload.tools = body.tools.map(normalizeCache);
  if (Array.isArray(body.messages)) {
    payload.messages = body.messages.map(message => (isObject(message) && Array.isArray(message.content)
      ? { ...message, content: normalizeContent(message.content) }
      : message));
  }
  return payload;
}
