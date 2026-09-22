// Spec for the AI write path's pure registry pieces — `src/services/ai/actions.ts` and
// `src/services/EventCreation.ts#resolveEventGroups` — plan `.work-plans/ai-app-interaction.md`
// §3 (the registry) / §16 / §7 (this file's spec). Deliberately PURE: no repository, no
// `Effect.provide`, no HTTP harness. `ACTION_REGISTRY.create_event.propose`/`.confirm` (which DO
// need repositories) are exercised in `aiTools.test.ts` and `api/ai-chat.test.ts` respectively.

import { describe, expect, it } from '@effect/vitest';
import { AiActionProposal, type GroupModel } from '@sideline/domain';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  ACTION_REGISTRY,
  buildCreateEventSummary,
  ProposeCreateEventArgs,
  toCreateEventRequest,
} from '~/services/ai/actions.js';
import { toToolParameters } from '~/services/ai/jsonSchema.js';
import { resolveEventGroups } from '~/services/EventCreation.js';

const decode = (rawArgs: unknown) => Schema.decodeUnknownSync(ProposeCreateEventArgs)(rawArgs);
const decodeFails = (rawArgs: unknown): boolean => {
  try {
    decode(rawArgs);
    return false;
  } catch {
    return true;
  }
};

const minimalTimed = (overrides: Record<string, unknown> = {}) => ({
  title: 'Practice',
  eventType: 'training',
  startAt: '2026-06-01T10:00:00.000Z',
  ...overrides,
});

const minimalAllDay = (overrides: Record<string, unknown> = {}) => ({
  title: 'Tournament',
  eventType: 'tournament',
  allDay: true,
  startDate: '2026-07-04',
  ...overrides,
});

describe('ACTION_REGISTRY — exhaustiveness', () => {
  it.effect(
    'has exactly one entry per AiActionName literal, each with all five members defined',
    () =>
      Effect.sync(() => {
        const literals = AiActionProposal.AiActionName.literals;
        expect(Object.keys(ACTION_REGISTRY).sort()).toEqual([...literals].sort());
        for (const name of literals) {
          const def = ACTION_REGISTRY[name];
          expect(def.permission).toBeTruthy();
          expect(def.description.length).toBeGreaterThan(0);
          expect(def.argsSchema).toBeDefined();
          expect(typeof def.propose).toBe('function');
          expect(typeof def.confirm).toBe('function');
        }
      }),
  );
});

describe('ProposeCreateEventArgs — decode / root filter', () => {
  it.effect('allDay:true without startDate -> error', () =>
    Effect.sync(() => {
      expect(decodeFails({ title: 'X', eventType: 'training', allDay: true })).toBe(true);
    }),
  );

  it.effect('allDay:true WITH startAt (as well as startDate) -> error', () =>
    Effect.sync(() => {
      expect(
        decodeFails(
          minimalAllDay({ startAt: '2026-07-04T10:00:00.000Z', startDate: '2026-07-04' }),
        ),
      ).toBe(true);
    }),
  );

  it.effect('timed with endAt < startAt -> error naming endAt', () =>
    Effect.sync(() => {
      try {
        decode(
          minimalTimed({
            startAt: '2026-06-01T10:00:00.000Z',
            endAt: '2026-06-01T09:00:00.000Z',
          }),
        );
        expect.unreachable('expected a decode failure');
      } catch (e) {
        expect(String(e)).toContain('endAt');
      }
    }),
  );

  it.effect('timed with endAt === startAt -> ACCEPTED', () =>
    Effect.sync(() => {
      expect(() =>
        decode(
          minimalTimed({
            startAt: '2026-06-01T10:00:00.000Z',
            endAt: '2026-06-01T10:00:00.000Z',
          }),
        ),
      ).not.toThrow();
    }),
  );

  it.effect('all-day with endDate < startDate -> error', () =>
    Effect.sync(() => {
      expect(decodeFails(minimalAllDay({ startDate: '2026-07-04', endDate: '2026-07-03' }))).toBe(
        true,
      );
    }),
  );

  it.effect('all-day with endDate >= startDate -> accepted', () =>
    Effect.sync(() => {
      expect(() =>
        decode(minimalAllDay({ startDate: '2026-07-04', endDate: '2026-07-05' })),
      ).not.toThrow();
    }),
  );

  it.effect("startDate: '2025-02-30' -> error (not a real calendar date)", () =>
    Effect.sync(() => {
      expect(decodeFails(minimalAllDay({ startDate: '2025-02-30' }))).toBe(true);
    }),
  );

  it.effect("startDate: '2025-02-28' (non-leap year) -> accepted", () =>
    Effect.sync(() => {
      expect(() => decode(minimalAllDay({ startDate: '2025-02-28' }))).not.toThrow();
    }),
  );

  it.effect("startDate: '2024-02-29' (leap year) -> accepted", () =>
    Effect.sync(() => {
      expect(() => decode(minimalAllDay({ startDate: '2024-02-29' }))).not.toThrow();
    }),
  );

  it.effect(
    'a teamId, locationUrl or imageUrl key in raw args is DROPPED — never reaches toCreateEventRequest',
    () =>
      Effect.sync(() => {
        const decoded = decode(
          minimalTimed({
            teamId: '00000000-0000-0000-0000-000000000010',
            locationUrl: 'https://evil.example/track-me',
            imageUrl: 'https://evil.example/pixel.png',
          }),
        );
        expect(decoded).not.toHaveProperty('teamId');
        expect(decoded).not.toHaveProperty('locationUrl');
        expect(decoded).not.toHaveProperty('imageUrl');
        const request = toCreateEventRequest(decoded);
        expect(Option.isNone(request.locationUrl)).toBe(true);
        expect(Option.isNone(request.imageUrl)).toBe(true);
      }),
  );
});

describe('buildCreateEventSummary — always all nine fields, fixed order', () => {
  const FIXED_ORDER = [
    'title',
    'eventType',
    'start',
    'end',
    'trainingType',
    'ownerGroup',
    'memberGroup',
    'location',
    'description',
  ];

  it.effect(
    'a minimal timed payload emits exactly nine fields in the fixed order, every absent one as {type:"none"}',
    () =>
      Effect.sync(() => {
        const args = decode(minimalTimed());
        const summary = buildCreateEventSummary(args, {
          trainingTypeName: Option.none(),
          ownerGroupName: Option.none(),
          memberGroupName: Option.none(),
        });
        expect(summary).toHaveLength(9);
        expect(summary.map((f) => f.key)).toEqual(FIXED_ORDER);

        const byKey = new Map(summary.map((f) => [f.key, f.value]));
        expect(byKey.get('title')).toEqual({ type: 'text', value: 'Practice' });
        expect(byKey.get('eventType')).toEqual({ type: 'eventType', value: 'training' });
        expect(byKey.get('end')).toEqual({ type: 'none' });
        expect(byKey.get('trainingType')).toEqual({ type: 'none' });
        expect(byKey.get('ownerGroup')).toEqual({ type: 'none' });
        // Explicitly asserted PRESENT-as-none, not omitted — a silently-dropped memberGroup would
        // hide "everyone on the team sees this event", a visibility fact the user must verify.
        expect(byKey.get('memberGroup')).toEqual({ type: 'none' });
        expect(byKey.get('location')).toEqual({ type: 'none' });
        expect(byKey.get('description')).toEqual({ type: 'none' });
      }),
  );

  it.effect(
    'start is {type:"instant"} for a timed event and {type:"date"} for an all-day one — no allDay key anywhere',
    () =>
      Effect.sync(() => {
        const timedArgs = decode(minimalTimed());
        const timedSummary = buildCreateEventSummary(timedArgs, {
          trainingTypeName: Option.none(),
          ownerGroupName: Option.none(),
          memberGroupName: Option.none(),
        });
        const timedStart = timedSummary.find((f) => f.key === 'start');
        expect(timedStart?.value.type).toBe('instant');

        const allDayArgs = decode(minimalAllDay());
        const allDaySummary = buildCreateEventSummary(allDayArgs, {
          trainingTypeName: Option.none(),
          ownerGroupName: Option.none(),
          memberGroupName: Option.none(),
        });
        const allDayStart = allDaySummary.find((f) => f.key === 'start');
        expect(allDayStart?.value).toEqual({ type: 'date', value: '2026-07-04' });

        expect(JSON.stringify(timedSummary)).not.toContain('allDay');
        expect(JSON.stringify(allDaySummary)).not.toContain('allDay');
      }),
  );

  it.effect(
    'is pure and deterministic: two calls on the same payload deep-equal; no Date objects, no locale-formatted strings',
    () =>
      Effect.sync(() => {
        const args = decode(
          minimalTimed({
            description: 'Bring cones',
            location: 'Field 2',
            endAt: '2026-06-01T11:00:00.000Z',
          }),
        );
        const resolved = {
          trainingTypeName: Option.some('Fitness'),
          ownerGroupName: Option.some('Coaches'),
          memberGroupName: Option.none() as Option.Option<string>,
        };
        const summaryA = buildCreateEventSummary(args, resolved);
        const summaryB = buildCreateEventSummary(args, resolved);
        expect(summaryA).toEqual(summaryB);

        const json = JSON.stringify(summaryA);
        // `instant` crosses as an ISO string via `Schemas.DateTimeFromIsoString`'s encoder — never
        // a `Date` instance, and never something like "Jun 1, 2026" (locale-formatted).
        expect(json).not.toMatch(/\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/);
      }),
  );
});

describe('toCreateEventRequest — blocker 1, the all-day wire convention', () => {
  it.effect('all-day: startDate crosses as noon-UTC of that date, allDay is true', () =>
    Effect.sync(() => {
      const args = decode(minimalAllDay({ startDate: '2026-07-04' }));
      const request = toCreateEventRequest(args);
      expect(request.allDay).toBe(true);
      expect(DateTime.toEpochMillis(request.startAt)).toBe(Date.parse('2026-07-04T12:00:00.000Z'));
    }),
  );

  it.effect('timed: startAt is byte-identical to the submitted instant, allDay is false', () =>
    Effect.sync(() => {
      const args = decode(minimalTimed({ startAt: '2026-06-01T10:00:00.000Z' }));
      const request = toCreateEventRequest(args);
      expect(request.allDay).toBe(false);
      expect(DateTime.toEpochMillis(request.startAt)).toBe(Date.parse('2026-06-01T10:00:00.000Z'));
    }),
  );
});

describe('resolveEventGroups (pure)', () => {
  const OWNER = 'owner-group' as unknown as GroupModel.GroupId;
  const MEMBER = 'member-group' as unknown as GroupModel.GroupId;
  const TT_OWNER = 'tt-owner-group' as unknown as GroupModel.GroupId;
  const TT_MEMBER = 'tt-member-group' as unknown as GroupModel.GroupId;

  it.effect('payload groups win when either is set, even with a training type present', () =>
    Effect.sync(() => {
      const result = resolveEventGroups({
        payloadOwnerGroupId: Option.some(OWNER),
        payloadMemberGroupId: Option.none(),
        trainingType: Option.some({
          owner_group_id: Option.some(TT_OWNER),
          member_group_id: Option.some(TT_MEMBER),
        }),
      });
      expect(result).toEqual({ ownerGroupId: Option.some(OWNER), memberGroupId: Option.none() });
    }),
  );

  it.effect(
    'payload groups win via memberGroupId alone too — the training type pair is NOT mixed in',
    () =>
      Effect.sync(() => {
        const result = resolveEventGroups({
          payloadOwnerGroupId: Option.none(),
          payloadMemberGroupId: Option.some(MEMBER),
          trainingType: Option.some({
            owner_group_id: Option.some(TT_OWNER),
            member_group_id: Option.some(TT_MEMBER),
          }),
        });
        expect(result).toEqual({
          ownerGroupId: Option.none(),
          memberGroupId: Option.some(MEMBER),
        });
      }),
  );

  it.effect(
    'training-type groups are inherited only when BOTH payload groups are absent and a training type is present',
    () =>
      Effect.sync(() => {
        const result = resolveEventGroups({
          payloadOwnerGroupId: Option.none(),
          payloadMemberGroupId: Option.none(),
          trainingType: Option.some({
            owner_group_id: Option.some(TT_OWNER),
            member_group_id: Option.some(TT_MEMBER),
          }),
        });
        expect(result).toEqual({
          ownerGroupId: Option.some(TT_OWNER),
          memberGroupId: Option.some(TT_MEMBER),
        });
      }),
  );

  it.effect('absent training type -> the (possibly empty) payload pair, unchanged', () =>
    Effect.sync(() => {
      const result = resolveEventGroups({
        payloadOwnerGroupId: Option.none(),
        payloadMemberGroupId: Option.none(),
        trainingType: Option.none(),
      });
      expect(result).toEqual({ ownerGroupId: Option.none(), memberGroupId: Option.none() });
    }),
  );
});

describe('toToolParameters(ProposeCreateEventArgs)', () => {
  it.effect('additionalProperties:false, no $ref, enum for eventType', () =>
    Effect.sync(() => {
      const parameters = toToolParameters(ProposeCreateEventArgs);
      expect(parameters.additionalProperties).toBe(false);
      const json = JSON.stringify(parameters);
      expect(json).not.toContain('$ref');

      const properties = parameters.properties as Record<string, unknown>;
      expect(properties.eventType).toBeDefined();
      const eventType = properties.eventType as { readonly enum?: ReadonlyArray<string> };
      expect(Array.isArray(eventType.enum)).toBe(true);
      expect(eventType.enum?.length).toBeGreaterThan(0);
    }),
  );

  // FLAGGED, not asserted as a pass/fail here — reported to the architect/developer instead of
  // silently adjusted: `actions.ts`'s `Instant` schema is annotated with
  // `Schema.annotate({ description: '...' })` specifically so `startAt`/`endAt` "does not probe
  // as a bare {"type":"string"}" (its own doc comment's words). Verified empirically (see this
  // tester's final report): `Schema.annotate({ description })` on a TRANSFORM schema
  // (`Schema.DateTimeUtcFromString`, what `Schemas.DateTimeFromIsoString` is) never reaches
  // `Schema.toJsonSchemaDocument`'s output in `effect@4.0.0-beta.40` — confirmed both wrapped in
  // `Schema.optionalKey` and bare, and confirmed the SAME annotate call DOES surface correctly on
  // a leaf schema (`Schema.Number`/`Schema.String`). So `properties.startAt` here is genuinely
  // `{"type":"string"}` with no `description` key, contradicting the source comment's claim. This
  // is a real, verified `src/` behavior gap — not this test's bug — and is intentionally NOT
  // asserted below (a test asserting the doc comment's claim would simply fail against correct,
  // unmodified `src/` code).
  it.effect(
    "startAt genuinely probes as a bare {type:'string'} today — the Instant annotation does not survive `toJsonSchemaDocument` for a transform schema (see the comment above; reported, not fixed here)",
    () =>
      Effect.sync(() => {
        const parameters = toToolParameters(ProposeCreateEventArgs);
        const properties = parameters.properties as Record<string, unknown>;
        expect(properties.startAt).toEqual({ type: 'string' });
      }),
  );
});
