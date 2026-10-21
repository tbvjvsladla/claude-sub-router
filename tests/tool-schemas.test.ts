import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistry } from '../src/config.ts';
import { applyToolSchemaCompatibility } from '../src/tool-schemas.ts';

const provider = loadRegistry().get('deepseek-flash')!.provider;
const originalPattern = String.raw`^[^\0]*$`;
const compatiblePattern = String.raw`^[^\u0000]*$`;
function normalizePattern(pattern: string): string {
  const payload = applyToolSchemaCompatibility({ tools: [{ input_schema: { pattern } }] }, provider);
  return (payload.tools as { input_schema: { pattern: string } }[])[0]!.input_schema.pattern;
}

test('DeepSeek NUL escape normalization preserves regex semantics and escaped backslashes', () => {
  assert.equal(normalizePattern(originalPattern), compatiblePattern);
  for (const value of ['', 'hello', '한글', '😀', 'line\nbreak', String.raw`\0`, '\0', 'a\0b']) {
    assert.equal(new RegExp(compatiblePattern).test(value), new RegExp(originalPattern).test(value));
  }
  for (const [pattern, expected] of [
    [String.raw`\0`, String.raw`\u0000`],
    [String.raw`\\0`, String.raw`\\0`],
    [String.raw`\\\0`, String.raw`\\\u0000`],
    [String.raw`\00`, String.raw`\00`],
    [String.raw`\01`, String.raw`\01`],
    [String.raw`\u0000`, String.raw`\u0000`],
    [String.raw`[A-Z]+\d*`, String.raw`[A-Z]+\d*`],
    ['[invalid', '[invalid'],
  ]) assert.equal(normalizePattern(pattern!), expected);
});

test('nested schemas are normalized without rewriting literal constraints, examples or message data', () => {
  const leaf = { type: 'string', pattern: originalPattern };
  const literal = { pattern: originalPattern, properties: { pattern: originalPattern } };
  const input_schema = {
    type: 'object', description: originalPattern,
    properties: {
      pattern: leaf,
      nested: { type: 'array', items: { anyOf: [leaf, { allOf: [{ not: leaf }] }] } },
      literal: { const: literal, enum: [literal], default: literal, examples: [literal] },
    },
    $defs: { text: leaf }, definitions: { old: leaf },
    patternProperties: { '.*': leaf }, additionalProperties: leaf,
    dependentSchemas: { value: { if: leaf, then: leaf, else: leaf } },
    dependencies: { schema: leaf, names: ['pattern', 'properties'] },
    prefixItems: [leaf], items: [leaf, false], contains: leaf,
    unevaluatedProperties: leaf, propertyNames: leaf,
  };
  const body = { tools: [{ name: 'Artifact', description: originalPattern, input_schema }, { name: 'server_tool', type: 'server' }], messages: [{ role: 'user', content: literal }], output_config: { format: { schema: literal } } };
  const original = structuredClone(body);
  const output = applyToolSchemaCompatibility(body, provider) as typeof body;
  const wire = output.tools[0]!.input_schema!;
  assert.equal(wire.properties.pattern.pattern, compatiblePattern);
  const nested = wire.properties.nested.items.anyOf[0]!;
  assert.ok('pattern' in nested);
  assert.equal(nested.pattern, compatiblePattern);
  assert.equal(wire.$defs.text.pattern, compatiblePattern);
  assert.equal(wire.patternProperties['.*'].pattern, compatiblePattern);
  assert.equal(wire.dependentSchemas.value.then.pattern, compatiblePattern);
  assert.equal(wire.items[0] && (wire.items[0] as typeof leaf).pattern, compatiblePattern);
  assert.equal(wire.description, originalPattern);
  assert.deepEqual(wire.properties.literal, input_schema.properties.literal);
  assert.deepEqual(wire.dependencies.names, ['pattern', 'properties']);
  assert.deepEqual(output.messages, body.messages);
  assert.deepEqual(output.output_config, body.output_config);
  assert.deepEqual(body, original);
  for (const { provider: other } of loadRegistry().values()) {
    if (other.id !== 'deepseek') assert.equal(applyToolSchemaCompatibility(body, other), body);
  }
  assert.deepEqual(applyToolSchemaCompatibility({ messages: [] }, provider), { messages: [] });
});
