// Spec for the derived tool-parameter JSON Schema post-processor, `toToolParameters`
// (`src/services/ai/jsonSchema.ts`) — plan `.work-plans/ai-app-interaction.md` §7 / §13.2.
//
// Every assertion below deep-compares the derived JSON Schema shape (not just key
// names) — a hand-written `{"limit":{"type":"string"}}` checked only for the key
// "limit" existing would pass a shallow check while carrying the wrong `type` for a
// `Schema.Number`/`Schema.Int` field. That drift class is exactly what this file
// guards against.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { toToolParameters } from '~/services/ai/jsonSchema.js';

describe('toToolParameters — Schema.Literals collapse', () => {
  it.effect('collapses a single-value-string-enum anyOf into {type:string, enum:[...]}', () =>
    Effect.sync(() => {
      const schema = Schema.Struct({
        status: Schema.Literals(['active', 'cancelled']),
      });
      const result = toToolParameters(schema);
      const properties = result.properties as Record<string, unknown>;
      expect(properties.status).toEqual({ type: 'string', enum: ['active', 'cancelled'] });
      expect(JSON.stringify(result)).not.toContain('anyOf');
    }),
  );
});

describe('toToolParameters — allOf hoist for numeric range checks', () => {
  it.effect(
    'Schema.Int with min/max checks becomes {type:integer, minimum, maximum}, no allOf',
    () =>
      Effect.sync(() => {
        const schema = Schema.Struct({
          limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
        });
        const result = toToolParameters(schema);
        const properties = result.properties as Record<string, unknown>;
        expect(properties.limit).toEqual({ type: 'integer', minimum: 1, maximum: 50 });
        expect(JSON.stringify(result)).not.toContain('allOf');
      }),
  );
});

describe('toToolParameters — required / additionalProperties', () => {
  it.effect(
    'a struct with optionalKey fields: required contains only non-optional keys; additionalProperties is false',
    () =>
      Effect.sync(() => {
        const schema = Schema.Struct({
          teamId: Schema.String,
          query: Schema.optionalKey(Schema.String),
        });
        const result = toToolParameters(schema);
        expect(result.required).toEqual(['teamId']);
        expect(result.additionalProperties).toBe(false);
        const properties = result.properties as Record<string, unknown>;
        // Both keys are still described in `properties` — only `required` excludes the optional one.
        expect(Object.keys(properties).sort()).toEqual(['query', 'teamId']);
      }),
  );
});

describe('toToolParameters — branded ids', () => {
  it.effect('a branded string id emits a plain {type:string}, no brand metadata leaks', () =>
    Effect.sync(() => {
      const EventId = Schema.String.pipe(Schema.brand('EventId'));
      const schema = Schema.Struct({ eventId: EventId });
      const result = toToolParameters(schema);
      const properties = result.properties as Record<string, unknown>;
      expect(properties.eventId).toEqual({ type: 'string' });
    }),
  );
});

describe('toToolParameters — collapse recurses into array items', () => {
  it.effect('Schema.Array(Schema.Literals([...])) collapses the anyOf inside `items`', () =>
    Effect.sync(() => {
      const schema = Schema.Struct({
        statuses: Schema.Array(Schema.Literals(['active', 'cancelled', 'draft'])),
      });
      const result = toToolParameters(schema);
      const properties = result.properties as Record<string, unknown>;
      expect(properties.statuses).toEqual({
        type: 'array',
        items: { type: 'string', enum: ['active', 'cancelled', 'draft'] },
      });
      expect(JSON.stringify(result)).not.toContain('anyOf');
    }),
  );
});

describe('toToolParameters — flat schemas only', () => {
  it.effect(
    'a schema that produces non-empty `definitions` (a recursive suspend schema) throws',
    () =>
      Effect.sync(() => {
        interface CategoryType {
          readonly name: string;
          readonly subcategories: ReadonlyArray<CategoryType>;
        }
        const Category = Schema.Struct({
          name: Schema.String,
          subcategories: Schema.Array(Schema.suspend((): Schema.Codec<CategoryType> => Category)),
        });

        expect(() => toToolParameters(Category)).toThrow();
      }),
  );
});

describe('toToolParameters — Schema.Number is banned (documents why)', () => {
  it.effect('Schema.Number is NOT rewritten away: the derived output still contains "NaN"', () =>
    Effect.sync(() => {
      const schema = Schema.Struct({
        limit: Schema.Number,
      });
      const result = toToolParameters(schema);
      // toToolParameters does not special-case Schema.Number — it is the registry
      // test (13.3/10) that must reject any tool whose derived parameters still
      // contain "NaN". This test documents *why*: Schema.Number's NaN/Infinity
      // anyOf survives the post-processing unchanged.
      expect(JSON.stringify(result)).toContain('NaN');
    }),
  );
});

describe('toToolParameters — empty-struct root (Known trap: Schema.Struct({}) emits anyOf)', () => {
  it.effect('collapses the zero-property root anyOf into a plain closed object schema', () =>
    Effect.sync(() => {
      const schema = Schema.Struct({});
      const result = toToolParameters(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      });
      expect(JSON.stringify(result)).not.toContain('anyOf');
    }),
  );
});

describe('toToolParameters — additionalProperties is set explicitly, always', () => {
  it.effect('the top-level object always carries additionalProperties: false', () =>
    Effect.sync(() => {
      const schema = Schema.Struct({ a: Schema.String });
      const result = toToolParameters(schema);
      expect(result.additionalProperties).toBe(false);
    }),
  );
});
