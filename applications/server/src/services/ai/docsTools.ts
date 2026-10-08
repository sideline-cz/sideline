/**
 * `search_docs` — the one assistant tool that reads something other than the team's own data.
 *
 * The corpus is the end-user documentation site (`applications/docs`), flattened into sections at
 * build time by `scripts/build-docs-index.mjs` and imported here as a plain array. It is bundled
 * rather than fetched because the docs ship as a SEPARATE nginx image: a runtime fetch would let
 * a newer docs container describe a server that does not behave that way yet.
 *
 * UNGATED, and that is deliberate — the content is a public website. It is also the reason this
 * executor takes `EntityReadContext` and ignores it: there is no team scope to apply, no
 * permission to re-check, and no row that could belong to another club. Every OTHER executor in
 * `readTools.ts` re-checks its gate because it reads tenant data; this one has none to re-check.
 *
 * Pure and synchronous under the hood (`R = never`, `E = never`), wrapped in `Effect.sync` only
 * to match the executor signature `ChatAgent.dispatchOneCall` expects.
 */
import { Effect } from 'effect';
import { DOCS_SECTIONS, type DocsSection } from '~/services/ai/generated/docsIndex.js';
import type { EntityReadContext, ToolExecutionResult } from '~/services/ai/toolTypes.js';

export interface SearchDocsArgs {
  readonly query: string;
  readonly limit?: number;
}

/** Default section count when the model does not ask for one — three is enough to answer a
 *  "how do I…" question without crowding the turn's shared `TOTAL_TOOL_CHAR_BUDGET`. */
const DEFAULT_LIMIT = 3;

/**
 * Under `ChatAgent`'s `TOOL_RESULT_CHAR_BUDGET` (6000), which truncates mid-JSON if exceeded —
 * clamping here instead keeps the result valid JSON the model can actually parse.
 *
 * Measured against the SERIALIZED result, not the sum of `text` lengths. `slug`, `title` and
 * `heading` are serialized too, and JSON escaping is not length-preserving (a quote costs two
 * chars, a control char six) — budgeting on `text` alone produced a 6213-char payload against a
 * 6000-char budget, i.e. exactly the mid-JSON truncation this constant exists to prevent.
 */
const RESULT_CHAR_BUDGET = 5500;

/** Shorter words ("the", "a", "is", "do") match everything and rank nothing. */
const MIN_WORD_LENGTH = 3;

const WEIGHT_TITLE = 3;
const WEIGHT_HEADING = 2;
const WEIGHT_TEXT = 1;

const countWeight = (haystack: string, word: string, weight: number): number =>
  haystack.includes(word) ? weight : 0;

const scoreSection = (section: DocsSection, words: ReadonlyArray<string>): number => {
  const title = section.title.toLowerCase();
  const heading = section.heading.toLowerCase();
  const text = section.text.toLowerCase();
  let score = 0;
  for (const word of words) {
    score +=
      countWeight(title, word, WEIGHT_TITLE) +
      countWeight(heading, word, WEIGHT_HEADING) +
      countWeight(text, word, WEIGHT_TEXT);
  }
  return score;
};

export const tokenizeQuery = (query: string): ReadonlyArray<string> =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);

/**
 * Trims the chosen sections so the serialized result fits `RESULT_CHAR_BUDGET`. The section that
 * crosses the budget is TRUNCATED rather than dropped: a partial answer from the best-scoring
 * section beats a whole one from a worse section, and dropping it silently would make a long
 * first section look like "the docs say nothing else about this".
 *
 * The shrink loop re-measures instead of subtracting the overshoot once, because escaping means
 * removing N source chars can free more or fewer than N serialized chars. It converges in one or
 * two passes; the `text.length` guard makes termination unconditional.
 */
const clampSections = (sections: ReadonlyArray<DocsSection>): ReadonlyArray<DocsSection> => {
  const out: Array<DocsSection> = [];
  const serializedWith = (candidates: ReadonlyArray<DocsSection>): number =>
    JSON.stringify({ sections: candidates }).length;

  for (const section of sections) {
    if (serializedWith([...out, section]) <= RESULT_CHAR_BUDGET) {
      out.push(section);
      continue;
    }
    let text = section.text;
    while (text.length > 0) {
      const overshoot =
        serializedWith([...out, { ...section, text: `${text}…` }]) - RESULT_CHAR_BUDGET;
      if (overshoot <= 0) {
        break;
      }
      text = text.slice(0, Math.max(0, text.length - overshoot));
    }
    if (text.length > 0) {
      out.push({ ...section, text: `${text}…` });
    }
    // Everything after this section would only overflow further.
    break;
  }
  return out;
};

export const searchDocs = (
  args: SearchDocsArgs,
  _ctx: EntityReadContext,
): Effect.Effect<ToolExecutionResult> =>
  Effect.sync(() => {
    const words = tokenizeQuery(args.query);
    // Every word was below `MIN_WORD_LENGTH` — scoring would give every section 0 and the sort
    // would return the first N sections of the corpus as if they were matches.
    if (words.length === 0) {
      return { result: { sections: [] }, hits: [] };
    }
    const ranked = DOCS_SECTIONS.map((section) => ({
      section,
      score: scoreSection(section, words),
    }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit ?? DEFAULT_LIMIT)
      .map(({ section }) => section);

    return {
      // No `hits`: a docs section is not a team entity, so it has no `SearchHit` variant and
      // mints no reference token. The answer cites it in prose, not as a card.
      result: { sections: clampSections(ranked) },
      hits: [],
    };
  });
