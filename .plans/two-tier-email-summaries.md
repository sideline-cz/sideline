# Plan: Two-tier email summaries (SHORT + DETAILED)

Branch: `feat/email-two-tier-summaries`. Minor bump for affected `@sideline/*` packages.

## Product behaviour
- Every email gets **two** AI summaries: a **SHORT** one (plain opener sentence — no "TL;DR:" prefix — + ~6 emoji-led bullets) and a **DETAILED** one (the current balanced summary).
- **Coach channel (approval):** one message with two embeds — amber embed = SHORT + From/Subject/Received; blurple embed = DETAILED. Buttons: `[✅ Approve] [🚫 Reject] [✏️ Edit on Sideline]`. One Approve approves the email. Approval also possible on Sideline web.
- **Team channel (posted on approve):** green embed, title = subject, body = SHORT. Buttons: `[📄 Detailed summary] [✉️ Original email]` → **ephemeral, paginated** previews. No Sideline link on this message.
- **Sideline web:** captain edits **both** summaries and approves/rejects (and may still "send original").

## Resolved design decisions (from hater review)
1. **custom_id** (matches existing `email-approve:{teamId}:{emailId}`):
   - open: `email-detail:{teamId}:{emailId}` / `email-original:{teamId}:{emailId}` → respond `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` + Ephemeral, then `updateOriginalWebhookMessage` with page 0.
   - navigate: `email-detail-page:{teamId}:{emailId}:{page}` / `email-original-page:{teamId}:{emailId}:{page}` → `DEFERRED_UPDATE_MESSAGE`, edit same ephemeral. Stateless (page index only in custom_id). Mirrors `attendees.ts`.
2. **Authz:** `Email/GetEmailContent` RPC verifies `row.team_id === team_id` and that status is postable (approved/posted_summary/posted_original). Does NOT require `team:manage` (member-facing previews).
3. **LLM:** ONE OpenAI call with `response_format: { type: 'json_object' }` returning `{ "short": ..., "detailed": ... }`, decoded via `Schema.parseJson`. Fallback if JSON invalid: whole content → detailed, derive short from first paragraph + ~6 bullet lines. Empty → `LlmError` (unchanged retry semantics). Stub returns both deterministically. `max_tokens` ~1900.
4. **Original-email ephemeral:** plain text in description with `allowed_mentions: { parse: [] }` (NO code fences). Paginate on line/paragraph boundaries.
5. **Lengths:** `short_summary` ≤ 2000, detailed `summary` ≤ 8000 (storage + `UpdateEmailSummaryRequest`). Discord detailed embed truncated at ~3500 + marker pointing to "Edit on Sideline" (truncate-then-marker, headroom under 4096).
6. **Send-original:** keep RPC + `post_original` kind + web button; drop ONLY the Discord approval-row send-original button; update `buildDisabledApprovalRow`.
7. **Legacy rows** (short_summary = None): posted/approval embeds fall back `short → summary → body` (truncated) — unchanged behaviour for pre-existing rows. No backfill.
8. **Chunking:** code-point-safe (`Array.from`), split on `\n\n` then `\n`, word-boundary for over-long lines; per page ≤ 4096 desc. Single page → no pagination row.

## Tasks by package
- **migrations:** `1789400004_add_short_summary_to_email_messages.ts` → `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS short_summary TEXT`.
- **domain:** add `short_summary` (`OptionFromNullOr`) to `EmailPostEvent` + `EmailDetailView`; extend `UpdateEmailSummaryRequest` → `{ summary(≤8000), short_summary(≤2000) }`; new `Email/GetEmailContent` RPC + `EmailContentView` model; register in `EmailRpcGroup`. Rebuild domain before dependents.
- **server:** `LlmClient` (JSON two-summary + stub), `EmailSummarizer` (store both), `EmailMessagesRepository` (row + setSummaryPendingApproval/updateSummary both columns), `EmailPostSyncEventsRepository` (row + query + mapper), `api/email-forwarding` (toDetailView + updateEmailSummary both), `rpc/email/index.ts` (GetEmailContent handler with team + status guard).
- **bot:** `buildEmailEmbeds` (two-embed approval, SHORT posted embed, detailed/original ephemeral page builders, new buttons, drop Discord send-original button); new `chunkText.ts` (code-point-safe); new interaction handlers `email-pages.ts` (open + paginate, ephemeral) registered in `interactions/index.ts`; `handleEmailPostEvent` rewire (no deep link on posted message).
- **web:** `EmailDetailPage.tsx` — two textareas (short ≤2000, detailed ≤8000), send both, approve/reject; read-only when not actionable.
- **i18n:** new `bot_email_*` keys (buttons, section/ephemeral titles, page indicator, truncation marker) + `email_detail_*` web keys, in cs.json + en.json; run i18n codegen.

## Tests (TDD)
- LLM JSON parse + fallback + stub determinism + multibyte (server `LlmClient.test.ts`).
- `chunkText` boundaries: single/multi page, paragraph/word split, multibyte/surrogate safety, empty (bot `chunkText.test.ts`).
- Embed builders: two-embed approval + overflow truncation, SHORT posted, page components disabled-state/footer, two posted buttons custom_ids (bot `buildEmailEmbeds.test.ts`).
- Repository round-trip of short_summary null vs present (server).
- Ephemeral handler: open (ephemeral create) + paginate (update), clamp stale index, kind=original uses body, not-found error path (bot `email-pages.test.ts`).
- Existing `email-approval.test.ts` stays green.

## Build ordering / risks
- Rebuild `@sideline/domain` + run i18n codegen before server/bot/web typecheck.
- Register `Email/GetEmailContent` in BOTH `EmailRpcGroup` and the `rpc/email/index.ts` handler map.
- Ephemeral pagination token expires ~15 min → catch webhook errors and log (as `attendees.ts` does).
- Detailed truncation: truncate to ~3500 THEN append marker (avoid 4096 off-by-one).
