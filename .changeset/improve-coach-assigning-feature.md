---
"@sideline/domain": minor
"@sideline/migrations": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/i18n": minor
---

Improve the coach assigning feature:

- **Configurable claim lead-time** — training claim-request messages now post a configurable number of days before the training (new per-team setting `claim_request_days_before`, default 3) instead of at event creation time, which could be up to the event horizon (~2 weeks) ahead. A new `TrainingClaimRequestCron` drives the scheduled posting; the on-creation emitter only fires immediately when the training already falls inside the lead-time window.
- **Training-day coaching status** — a new `CoachingStatusCron` posts a "today's coach is X" announcement to the member-visible training channel on the training day, only when the training is already claimed (to avoid notification spam).
- **Thread-based claim management** — the claim message now spawns a Discord thread (tracked via the new `events.claim_thread_id` column); the claim embed and buttons remain on the starter message.

Includes an idempotent migration adding `team_settings.claim_request_days_before`, `events.claim_request_sent_at`, `events.coaching_status_sent_at`, and `events.claim_thread_id`, extending the `event_sync_events` type check with `coaching_status`, partial indexes for the new cron scans, and a backfill that marks existing trainings as already-handled so there is no first-deploy notification blast.
