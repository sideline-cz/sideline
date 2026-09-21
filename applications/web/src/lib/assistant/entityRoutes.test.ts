// Tests for src/lib/assistant/entityRoutes.ts
//
// Plan §13.8 / design §3.7. `ENTITY_ROUTE` is a literal-typed table
// (`as const satisfies Record<EntityRef['kind'], string>`) so `to={ENTITY_ROUTE[kind]}`
// type-checks against TanStack Router's literal-union `to` prop with no `as never` cast. A
// *missing* kind is already a compile error via `satisfies`; this suite exists to catch a
// *typo in a value*, which `satisfies` cannot see — hence asserting the exact route strings
// and cross-checking them against the real route files on disk.
//
// `entityKindLabels` lives in the same module, as an explicit `Record<EntityRef['kind'],
// () => string>` (the `event-labels.ts:13` idiom) — never a computed
// `tr(`assistant_result_${kind}`)` template, which would both be invisible to the literal-key
// audit in `staticTrKeys.test.ts` and print the raw key to the user on a miss. Per plan §12
// step 8 vs. step 9, the `assistant_result_*` i18n keys are NOT added until step 9 (after this
// module lands in step 8), so calling a label here legitimately falls through `tr()`'s
// missing-key branch (console.warn + raw key) rather than returning real copy — these tests
// therefore only assert *shape* (a callable returning a string), never specific translated text.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiChatApi } from '@sideline/domain';
import { describe, expect, it, vi } from 'vitest';
import { ENTITY_ROUTE, entityKindLabels } from './entityRoutes.js';

type Kind = AiChatApi.EntityRef['kind'];

const HERE = dirname(fileURLToPath(import.meta.url));
// applications/web/src/lib/assistant -> applications/web/src/routes/(authenticated)/teams/$teamId
const ROUTES_DIR = join(HERE, '..', '..', 'routes', '(authenticated)', 'teams', '$teamId');

const EXPECTED_KINDS: ReadonlyArray<Kind> = ['event', 'group', 'member', 'roster', 'trainingType'];

// kind -> the route file that must exist on disk for ENTITY_ROUTE[kind] to be real.
const ROUTE_FILES: Record<Kind, string> = {
  event: 'events.$eventId.tsx',
  member: 'members.$memberId.tsx',
  group: 'groups.$groupId.tsx',
  roster: 'rosters.$rosterId.tsx',
  trainingType: 'training-types.$trainingTypeId.tsx',
};

describe('ENTITY_ROUTE', () => {
  // 13.8/1
  it('has exactly one entry per EntityRef kind', () => {
    expect(Object.keys(ENTITY_ROUTE).sort()).toEqual(
      ['event', 'group', 'member', 'roster', 'trainingType'].sort(),
    );
  });

  // 13.8/2
  it.each(EXPECTED_KINDS)('route for %s matches /^\\/teams\\/$teamId\\// exactly once', (kind) => {
    expect(ENTITY_ROUTE[kind]).toMatch(/^\/teams\/\$teamId\//);
  });

  it.each(EXPECTED_KINDS)('route for %s names exactly one further param segment', (kind) => {
    const route = ENTITY_ROUTE[kind];
    // '/teams/$teamId/<segment>/$<param>' — exactly two '$'-prefixed segments total: $teamId and
    // one more identifying this entity. A typo that drops the id param or doubles it up (e.g. an
    // extra '$something' segment) must fail this.
    const paramSegments = route.match(/\$[A-Za-z]+/g) ?? [];
    expect(paramSegments).toEqual(['$teamId', expect.stringMatching(/^\$[a-zA-Z]+Id$/)]);
    // And nothing trails the id param (no extra path segments after it).
    expect(route.endsWith(String(paramSegments[1]))).toBe(true);
  });

  // Exact values — a typo in the string is what `satisfies` cannot catch.
  it('has the exact expected route string for every kind', () => {
    expect(ENTITY_ROUTE).toEqual({
      event: '/teams/$teamId/events/$eventId',
      member: '/teams/$teamId/members/$memberId',
      group: '/teams/$teamId/groups/$groupId',
      roster: '/teams/$teamId/rosters/$rosterId',
      trainingType: '/teams/$teamId/training-types/$trainingTypeId',
    });
  });

  // Cross-check against the real filesystem: every destination route must actually exist.
  it.each(EXPECTED_KINDS)('the route file backing kind %s exists on disk', (kind) => {
    const path = join(ROUTES_DIR, ROUTE_FILES[kind]);
    expect(existsSync(path)).toBe(true);
  });
});

describe('entityKindLabels', () => {
  // 13.8/3
  it('has exactly the same five keys as ENTITY_ROUTE', () => {
    expect(Object.keys(entityKindLabels).sort()).toEqual(Object.keys(ENTITY_ROUTE).sort());
  });

  it.each(EXPECTED_KINDS)('entry for %s is a function returning a string', (kind) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(typeof entityKindLabels[kind]).toBe('function');
      const label = entityKindLabels[kind]();
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
