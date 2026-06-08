---
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/domain": minor
"@sideline/i18n": minor
---

Add email forwarding with AI summarization and coach approval. Teams can forward organizational emails to a unique inbound address (secured by a per-team token plus HMAC signature verification, body-size cap, and rate limiting). Each email is summarized via an `effect/unstable/ai` LLM client (config-gated, with a deterministic stub when no provider is configured), then an approval request with Approve/Reject buttons and a "Review & edit in Sideline" link is posted to a configurable coach channel. On approval the AI summary posts to the team's target channel; on rejection the original email posts instead. Both posts link back to a new web Email Detail page where coaches can review the original message, download attachments, edit the summary before approving, and members can view posted emails. Adds the `email_forwarding_config`, `email_messages`, `email_post_sync_events`, and `email_attachments` tables, the `EmailForwardingApi` endpoints, the `Email` RPC group, an email summarization cron, and the `EmailSyncService` bot worker. New env vars: `EMAIL_WEBHOOK_SIGNING_SECRET` (required) and optional `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL`.
