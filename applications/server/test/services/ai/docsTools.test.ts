// Spec for the `search_docs` tool — `.dev-loop/plan.md` half 1 / `.dev-loop/spec.md` half 1.
//
// Contract this file pins down:
//
//   - `applications/server/scripts/build-docs-index.mjs` (a `codegen` step) walks
//     `applications/docs/src/content/docs/**/*.{md,mdx}` and emits
//     `src/services/ai/generated/docsIndex.ts`:
//
//       export interface DocsSection {
//         readonly slug: string;    // path under content/docs/, no extension, e.g. 'guides/finances'
//         readonly title: string;   // the file's frontmatter title
//         readonly heading: string; // the `##` heading, '' for the lead-in section
//         readonly text: string;
//       }
//       export const DOCS_SECTIONS: ReadonlyArray<DocsSection>
//
//     `changelog.md` (116 KB) and everything under `legal/` (incl. `cs/legal/`) are EXCLUDED.
//     An empty index must never build green, so this file also asserts the index is non-trivial.
//
//   - `searchDocs(args, ctx)` in `src/services/ai/docsTools.ts` is
//     `(args: { query: string; limit?: number }, ctx: EntityReadContext) =>
//      Effect.Effect<ToolExecutionResult>` — `E = never`, `R = never`, pure over the generated
//     array, no repository and no Layer. It returns `{ result: { sections: [...] }, hits: [] }`.
//
//   - It is UNGATED (`Option.none()` in `registry.ts`): the docs are a public website. A caller
//     holding zero permissions gets the same answer a team admin does. (That `visibleTools`
//     offers it to a bare player is asserted in `test/services/aiTools.test.ts`; what is
//     asserted HERE is that the executor itself does not gate.)
//
//   - The combined `text` of the returned sections is clamped to 5500 chars — under
//     `ChatAgent.ts`'s `TOOL_RESULT_CHAR_BUDGET` of 6000, so a `search_docs` result is never
//     silently truncated by `truncateForBudget` after the fact.
//
// Deliberately NOT pinned here: the exact relevance ranking (weighted keyword overlap,
// title x3 / heading x2 / text x1) beyond "a query whose words appear in a known heading
// surfaces that section". Pinning the score arithmetic would freeze a heuristic the spec
// explicitly leaves free to tune.

import { describe, expect, it } from '@effect/vitest';
import type { GroupModel, Team, TeamMember } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { searchDocs } from '~/services/ai/docsTools.js';
import { DOCS_SECTIONS } from '~/services/ai/generated/docsIndex.js';
import type { EntityReadContext } from '~/services/ai/toolTypes.js';

const TEAM_A = '00000000-0000-0000-0000-00000000a001' as Team.TeamId;
const MEMBER_A1 = '00000000-0000-0000-0000-0000000a0001' as TeamMember.TeamMemberId;

/** A caller with NO permissions at all — `search_docs` must answer anyway. */
const bareCtx = (): EntityReadContext => ({
  teamId: TEAM_A,
  membership: new MembershipWithRole({
    id: MEMBER_A1,
    team_id: TEAM_A,
    user_id: 'user-1' as MembershipWithRole['user_id'],
    active: true,
    role_names: [],
    permissions: [],
    is_profile_complete: true,
    require_complete_profile: Option.none(),
  }),
  canSeeGroup: (_groupId: Option.Option<GroupModel.GroupId>) => Effect.succeed(true),
});

interface Section {
  readonly slug: string;
  readonly title: string;
  readonly heading: string;
  readonly text: string;
}

const sectionsOf = (result: unknown): ReadonlyArray<Section> =>
  (result as { sections: ReadonlyArray<Section> }).sections;

// ---------------------------------------------------------------------------
// The generated index
// ---------------------------------------------------------------------------

describe('DOCS_SECTIONS (generated index)', () => {
  it('is non-empty — an empty index must never build green', () => {
    expect(DOCS_SECTIONS.length).toBeGreaterThan(20);
  });

  it('excludes the changelog and every legal slug, in both locales', () => {
    const slugs = DOCS_SECTIONS.map((s) => s.slug);
    expect(slugs).not.toContain('changelog');
    for (const slug of slugs) {
      expect(slug).not.toMatch(/(^|\/)changelog$/);
      expect(slug).not.toMatch(/(^|\/)legal\//);
    }
    // Specifically the four files the plan names, so a regex that quietly stops matching
    // still fails here.
    for (const excluded of ['legal/privacy', 'legal/terms', 'cs/legal/privacy', 'cs/legal/terms']) {
      expect(slugs).not.toContain(excluded);
    }
  });

  it('still includes the guides the assistant is meant to answer from', () => {
    const slugs = new Set(DOCS_SECTIONS.map((s) => s.slug));
    expect(slugs.has('guides/finances')).toBe(true);
    expect(slugs.has('faq')).toBe(true);
  });

  it('carries no section longer than the 4000-char per-section cap', () => {
    for (const section of DOCS_SECTIONS) {
      expect(section.text.length).toBeLessThanOrEqual(4000);
    }
  });
});

// ---------------------------------------------------------------------------
// searchDocs
// ---------------------------------------------------------------------------

describe('search_docs', () => {
  it.effect('returns a matching section for a query whose words appear in a known heading', () =>
    Effect.gen(function* () {
      // `guides/finances.mdx` has had a `## Payment QR codes` heading since the Fio work.
      const outcome = yield* searchDocs({ query: 'payment QR codes' }, bareCtx());
      const sections = sectionsOf(outcome.result);

      expect(sections.length).toBeGreaterThan(0);
      expect(sections.some((s) => s.slug === 'guides/finances')).toBe(true);
      expect(sections.some((s) => s.heading.toLowerCase().includes('payment qr'))).toBe(true);
      expect(outcome.hits).toEqual([]);
    }),
  );

  it.effect('returns an EMPTY section list, not an error, for a query that matches nothing', () =>
    Effect.gen(function* () {
      const outcome = yield* searchDocs(
        { query: 'zzzqqqxx unmatchableneedle flibbertigibbetwombat' },
        bareCtx(),
      );

      expect(sectionsOf(outcome.result)).toEqual([]);
      expect(outcome.result).not.toMatchObject({ error: 'not_found' });
      expect(outcome.result).not.toMatchObject({ error: 'forbidden' });
      expect(outcome.hits).toEqual([]);
    }),
  );

  it.effect('is UNGATED — a caller holding zero permissions gets the same results', () =>
    Effect.gen(function* () {
      const outcome = yield* searchDocs({ query: 'how do I invite members' }, bareCtx());

      expect(outcome.result).not.toMatchObject({ error: 'forbidden' });
      expect(sectionsOf(outcome.result).length).toBeGreaterThan(0);
    }),
  );

  it.effect('clamps the combined section text under the 6000-char per-tool budget', () =>
    Effect.gen(function* () {
      // A deliberately broad query at the maximum `limit`, to push the result as wide as the
      // schema allows.
      const outcome = yield* searchDocs(
        { query: 'team event member payment training group channel discord season', limit: 50 },
        bareCtx(),
      );
      const sections = sectionsOf(outcome.result);

      expect(sections.length).toBeGreaterThan(0);
      const combined = sections.reduce((sum, s) => sum + s.text.length, 0);
      expect(combined).toBeLessThanOrEqual(5500);
      // The whole serialized result, which is what `ChatAgent` measures, must also fit.
      expect(JSON.stringify(outcome.result).length).toBeLessThan(6000);
      // Clamping truncates the LAST section rather than dropping it — so a wide query still
      // returns more than one section.
      expect(sections.length).toBeGreaterThan(1);
    }),
  );

  it.effect('defaults to 3 sections when no limit is given', () =>
    Effect.gen(function* () {
      const outcome = yield* searchDocs({ query: 'team member event' }, bareCtx());
      expect(sectionsOf(outcome.result).length).toBeLessThanOrEqual(3);
    }),
  );

  it.effect('returns only the four allow-listed keys per section — no file paths, no raw mdx', () =>
    Effect.gen(function* () {
      const outcome = yield* searchDocs({ query: 'payment QR codes' }, bareCtx());
      const [section] = sectionsOf(outcome.result);

      expect(section).toBeDefined();
      expect(Object.keys(section ?? {}).sort()).toEqual(['heading', 'slug', 'text', 'title']);
      expect(section?.text).not.toContain('import ');
      expect(section?.text).not.toContain('@astrojs/starlight');
    }),
  );
});
