import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// Derived tool-parameter JSON Schema post-processor.
//
// Plan: `.work-plans/ai-app-interaction.md` §7. Single source of truth: tool
// parameter JSON Schemas are DERIVED from the Effect schema that decodes the
// tool call arguments — never hand-written — so the registry parity test
// (§13.3/10) cannot drift from what the executor actually accepts.
//
// Two corrections to the plan text, verified against the real
// `effect@4.0.0-beta.40` API (see the two probes below):
//   - `Schema.toJsonSchemaDocument` takes `{ additionalProperties: boolean |
//     JsonSchema }`, NOT `{ additionalPropertiesStrategy: 'strict' }` (that
//     option does not exist on `ToJsonSchemaOptions`).
//   - The `allOf` hoist is real (confirmed for `Schema.Int` + range checks and
//     for `Schema.isMaxLength` on both `Schema.String` and `Schema.Array`) —
//     but it is NOT the only shape the library emits; some future check may
//     land directly on the node without an `allOf` wrapper. The rewrite below
//     handles the wrapped case and is a no-op when there is nothing to hoist.
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ type: 'string', enum: [<single value>] }` — what `Schema.Literals` emits per branch. */
const isSingleValueStringEnum = (
  value: unknown,
): value is { readonly type: 'string'; readonly enum: ReadonlyArray<unknown> } =>
  isRecord(value) &&
  value.type === 'string' &&
  Array.isArray(value.enum) &&
  value.enum.length === 1;

/** `allOf` entries that carry only constraint keywords (no `type`) are safe to hoist. */
const isHoistableAllOfEntry = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !('type' in value);

/**
 * `Schema.Struct({})` at the document root emits `{"anyOf":[{"type":"object"},
 * {"type":"array"}]}` — `Schema.toJsonSchemaDocument`'s generic encoding of "a
 * record with zero required/optional properties", which happens to be
 * satisfied by both `{}` and `[]`. A zero-parameter tool (e.g.
 * `current_datetime`) must still describe a plain, closed JSON object, so this
 * is collapsed explicitly rather than left for the generic `anyOf` rewrite
 * (which only understands single-value string-enum branches).
 */
const isEmptyStructAnyOf = (node: Record<string, unknown>): boolean =>
  Object.keys(node).length === 1 &&
  Array.isArray(node.anyOf) &&
  node.anyOf.length === 2 &&
  node.anyOf.some(
    (branch) => isRecord(branch) && Object.keys(branch).length === 1 && branch.type === 'object',
  ) &&
  node.anyOf.some(
    (branch) => isRecord(branch) && Object.keys(branch).length === 1 && branch.type === 'array',
  );

const rewriteNode = (node: unknown): unknown => {
  if (Array.isArray(node)) {
    return node.map(rewriteNode);
  }
  if (!isRecord(node)) {
    return node;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'anyOf' &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(isSingleValueStringEnum)
    ) {
      // Collapse a Schema.Literals-shaped anyOf of single-value string enums
      // into one flat string enum — the shape the model reads best.
      result.type = 'string';
      result.enum = value.flatMap((branch) => branch.enum);
      continue;
    }

    if (key === 'anyOf' && Array.isArray(value)) {
      result.anyOf = value.map(rewriteNode);
      continue;
    }

    if (
      key === 'allOf' &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(isHoistableAllOfEntry)
    ) {
      // Hoist pure-constraint allOf entries onto the parent node, e.g.
      // {"type":"integer","allOf":[{"minimum":1,"maximum":50}]} becomes
      // {"type":"integer","minimum":1,"maximum":50}.
      for (const entry of value) {
        Object.assign(result, rewriteNode(entry));
      }
      continue;
    }

    if (key === 'allOf' && Array.isArray(value)) {
      result.allOf = value.map(rewriteNode);
      continue;
    }

    if (key === 'properties' && isRecord(value)) {
      const properties: Record<string, unknown> = {};
      for (const [propertyKey, propertyValue] of Object.entries(value)) {
        properties[propertyKey] = rewriteNode(propertyValue);
      }
      result.properties = properties;
      continue;
    }

    if (key === 'items') {
      result.items = rewriteNode(value);
      continue;
    }

    result[key] = value;
  }

  return result;
};

/**
 * Derives an OpenAI-function-calling-compatible JSON Schema from an Effect
 * schema, for use as a tool's `parameters`. Throws if the schema is not flat
 * (i.e. it produces `$ref`/`definitions` — a sign of a recursive or shared
 * schema, which tool parameter schemas must never be).
 */
export const toToolParameters = (schema: Schema.Top): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(schema, { additionalProperties: false });

  if (Object.keys(doc.definitions).length > 0) {
    throw new Error(
      'toToolParameters: tool parameter schemas must be flat (got $ref/definitions) — ' +
        'avoid Schema.suspend and shared/recursive schemas in tool parameters.',
    );
  }

  const rootSchema =
    isRecord(doc.schema) && isEmptyStructAnyOf(doc.schema)
      ? { type: 'object', properties: {} }
      : doc.schema;

  const rewritten = rewriteNode(rootSchema);
  if (!isRecord(rewritten)) {
    throw new Error(
      'toToolParameters: expected an object schema at the root of the tool parameters.',
    );
  }

  // Explicit and unconditional, always set regardless of the library default. This is only a
  // PROVIDER-FACING hint, though — it discourages a well-behaved model from emitting a
  // `teamId` (or anything else) outside the declared shape, but the schema in this document is
  // advisory, not enforced by the provider. What actually keeps a model-supplied `teamId` from
  // surviving decoding is `Schema.Struct` in `decodeToolArgs` (`ChatAgent.ts`): decoding a raw
  // tool-call JSON object against an exact-shape struct drops every key that struct does not
  // declare, independent of whatever the provider chose to send.
  return { ...rewritten, additionalProperties: false };
};
