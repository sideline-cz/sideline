/**
 * Pure client-side lexer for an assistant `answer` string. Plan
 * `.work-plans/ai-app-interaction.md` §13.7, design §3.3.
 *
 * Splits `answer` into paragraphs of `{ kind: 'text' } | { kind: 'ref' }` segments on
 * `\n\n` (a single `\n` stays inside a paragraph) and on the opaque `[[ref:<token>]]`
 * marker grammar. The marker grammar is deliberately strict — exactly 4 lowercase
 * alphanumeric characters, matching the server's minting alphabet
 * (`applications/server/src/services/ai/refTokens.ts`) and its own stripping regex
 * (`applications/server/src/services/ChatAgent.ts`). A near-miss (wrong length,
 * uppercase, internal whitespace, unbalanced brackets) is never a marker — it survives
 * as literal text.
 *
 * `parseAnswer` does not know the reference list: a well-formed token absent from
 * `tokens` is still emitted as a `ref` segment. Resolving (or refusing to render) an
 * unresolvable token is `AssistantAnswer`'s job, downstream. `cited` collects the
 * `tokens` positions actually pointed at by a resolved marker, deduplicated.
 */

export type AnswerSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ref'; readonly token: string };

export interface ParsedAnswer {
  readonly paragraphs: ReadonlyArray<ReadonlyArray<AnswerSegment>>;
  readonly cited: ReadonlySet<number>;
}

const MARKER = /\[\[ref:([a-z0-9]{4})\]\]/g;

const parseParagraph = (
  paragraph: string,
  tokens: ReadonlyMap<string, number>,
  cited: Set<number>,
): ReadonlyArray<AnswerSegment> => {
  const segments: Array<AnswerSegment> = [];
  let lastIndex = 0;

  for (const match of paragraph.matchAll(MARKER)) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ kind: 'text', text: paragraph.slice(lastIndex, start) });
    }
    const token = match[1];
    segments.push({ kind: 'ref', token });
    const position = tokens.get(token);
    if (position !== undefined) {
      cited.add(position);
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < paragraph.length) {
    segments.push({ kind: 'text', text: paragraph.slice(lastIndex) });
  }

  return segments;
};

export const parseAnswer = (text: string, tokens: ReadonlyMap<string, number>): ParsedAnswer => {
  const cited = new Set<number>();

  if (text.length === 0) {
    return { paragraphs: [], cited };
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => parseParagraph(paragraph, tokens, cited));

  return { paragraphs, cited };
};
