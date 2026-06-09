---
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/domain": minor
"@sideline/migrations": minor
"@sideline/i18n": minor
---

feat(email): two-tier summaries (short + detailed) with ephemeral paginated Discord previews and dual-summary web editing

Every forwarded email now gets a SHORT summary (a plain opening sentence plus ~6 emoji-led bullets) and a DETAILED summary (the existing balanced one), generated in a single OpenAI JSON-mode call. The coach approval message shows both summaries inline; the posted team message shows the short summary with buttons that open ephemeral, paginated previews of the detailed summary and the original email (no Sideline redirect). The Sideline web email page edits both summaries. Adds a nullable `short_summary` column (legacy rows fall back to the detailed summary, then the body) and a team-ownership + posted-status-guarded `Email/GetEmailContent` RPC for the member-facing previews.
