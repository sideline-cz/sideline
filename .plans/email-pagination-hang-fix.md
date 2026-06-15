# Fix: "Původní e-mail" / "Detailed summary" ephemeral buttons hang on large emails

## Problem
Clicking the original/detailed email button for a very large email leaves the
ephemeral reply stuck "loading" forever.

Two root causes in `applications/bot/src/interactions/email-pages.ts`:
1. **The hang** — `fetchAndRenderPage` runs via `Effect.forkDetach` and only
   catches `EmailRpcMessageNotFound` and `RpcClientError`. Any other failure or
   defect (e.g. `RequestError`/`ErrorResponse` on a multi-MB RPC response) kills
   the detached fiber silently, so `updateOriginalWebhookMessage` is never
   called and Discord shows "loading" indefinitely.
2. **Unbounded size** — no cap on the body; a huge email chunks into hundreds of
   pages.

## Decisions (approved)
- Cap pages at `MAX_PAGES = 20`; append a truncation notice (+ Sideline deep
  link when `WEB_URL` is set) to the last kept page.
- Always resolve the deferred interaction so it never hangs.

## Task 1 — `capPages` helper (`applications/bot/src/rest/email/chunkText.ts`)
```ts
export const capPages = (
  chunks: ReadonlyArray<string>,
  maxPages: number,
  suffix: string,
  maxChars = 4096,
): ReadonlyArray<string>
```
- `chunks.length <= maxPages` → return unchanged (covers boundary + small body).
- else keep `chunks.slice(0, maxPages)`; trim the last kept page so
  `trimmed.length + suffix.length <= maxChars`, then append `suffix`.
- **Use UTF-16 `.length` for the budget** (consistent with
  `chunkForEmbedDescription`, which measures in code units; Discord's 4096 limit
  is code-unit based). After slicing, if the last unit is a lone high surrogate,
  drop it (surrogate safety).
- If `suffix.length >= maxChars` (pathological): clamp the suffix itself to
  `maxChars` (surrogate-safe) and use it alone as the last page.

## Task 2 — i18n keys (`packages/i18n/messages/cs.json` + `en.json`)
Paraglide-compiled; rebuild via `pnpm --filter @sideline/i18n build`.

| key | cs | en |
|---|---|---|
| `bot_email_truncation_notice` | `✂️ Zpráva je příliš dlouhá a byla zkrácena. Celý e-mail najdeš na {link}.` | `✂️ This message is too long and was cut off. Read the full email on {link}.` |
| `bot_email_truncation_notice_no_link` | `✂️ Zpráva je příliš dlouhá a byla zkrácena.` | `✂️ This message is too long and was cut off.` |
| `bot_email_truncation_link_label` | `Sideline` | `Sideline` |
| `bot_email_page_indicator_capped` | `Strana {current}/{total} (zkráceno)` | `Page {current}/{total} (truncated)` |

`{link}` is filled in code with markdown `[label](deepLink)`.

## Task 3 — `email-pages.ts` + `buildEmailEmbeds.ts`
- Imports: `env` from `~/env.js`, `buildEmailDeepLink`, `capPages`. Add
  `const MAX_PAGES = 20;`.
- In `fetchAndRenderPage` flatMap:
  ```ts
  const rawChunks = chunkForEmbedDescription(text);
  const deepLink = buildEmailDeepLink(env.WEB_URL, teamId, emailId);
  const noticeText = Option.match(deepLink, {
    onNone: () => m.bot_email_truncation_notice_no_link({}, { locale }),
    onSome: (url) =>
      m.bot_email_truncation_notice(
        { link: `[${m.bot_email_truncation_link_label({}, { locale })}](${url})` },
        { locale },
      ),
  });
  const suffix = `\n\n──────────\n${noticeText}`;
  const truncated = rawChunks.length > MAX_PAGES;
  const chunks = capPages(rawChunks, MAX_PAGES, suffix);
  const totalPages = chunks.length;
  const pageIndex = Math.max(0, Math.min(requestedPageIndex, totalPages - 1));
  const pageText = chunks[pageIndex] ?? '';
  ```
- Pass `truncated` into `buildPageEmbed`; add `truncated` to
  `BuildPageEmbedOptions`. Footer uses `bot_email_page_indicator_capped` when
  `truncated`, else `bot_email_page_indicator`.
- **The hang fix** — after the existing two `Effect.catchTag` calls, append a
  single terminal handler:
  ```ts
  Effect.catchCause((cause) =>
    Effect.logError('email-pages: failed to render page', cause).pipe(
      Effect.zipRight(errorUpdate(m.bot_email_page_empty({}, { locale }))),
    ),
  ),
  ```
  `catchCause` covers typed failures + defects + interrupts in one shot
  (matches existing codebase usage; `catchAll`/`catchAllDefect` do not exist in
  `effect@4.0.0-beta.40`).
- Make the terminal recovery total: ensure `errorUpdate` cannot re-fail (it
  already catches the known HTTP tags; wrap its tail in `Effect.ignore` /
  `Effect.catchCause(() => Effect.void)` to guarantee totality).

## Tests
`chunkText.test.ts` (`capPages`):
- under cap unchanged; exactly at cap unchanged (no suffix appended);
- over cap → length === maxPages, last page ends with suffix, earlier pages
  untouched;
- last page trimmed so `.length <= maxChars`;
- suffix longer than a page → clamps, `.length <= maxChars`, no crash;
- surrogate safety (astral chars at the cut → no lone surrogate, `.length <= maxChars`);
- empty input `['']` passthrough.

`email-pages.test.ts` (via handlers; `vi.mock('~/env.js')`):
- oversized body capped to 20 pages, notice on last page — WEB_URL None
  (`_no_link` variant) and WEB_URL Some (markdown link present);
- realistic long WEB_URL (~120 chars) → last page `.length <= 4096`, notice text
  intact (content trimmed, not the notice);
- footer shows capped indicator when truncated;
- normal small body unchanged (no notice, normal footer);
- RPC fails with uncaught tag (`RequestError`, `ErrorResponse`) →
  `updateOriginalWebhookMessage` still called (interaction resolved);
- RPC `Effect.die` defect → still resolved.

## Build / scope notes
- Run `pnpm --filter @sideline/i18n build` before bot typecheck/tests.
- No domain changes, no migrations. Bot-only.
