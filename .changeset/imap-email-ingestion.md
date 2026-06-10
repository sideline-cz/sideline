---
"@sideline/server": minor
"@sideline/web": minor
"@sideline/domain": patch
"@sideline/i18n": patch
"@sideline/migrations": patch
---

Add per-team IMAP email ingestion alongside the existing inbound webhook. Teams can now
configure an IMAP mailbox in Team Settings; a UID-tracked cron poller fetches new mail every
few minutes, parses it, and feeds the same summarize → coach-approval → Discord pipeline the
webhook uses. Mailbox credentials are stored encrypted at rest (AES-256-GCM with an app-held
key), never returned by the API, and entered via a write-only password field. Message-ID
deduplication prevents double-processing when both ingestion methods run at once, and the
watermark only advances past mail that was successfully ingested so transient failures retry
rather than lose messages.
