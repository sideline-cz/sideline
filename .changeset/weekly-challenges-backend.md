---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/migrations': minor
---

Add backend foundation for Weekly Challenges (Týdenní výzvy). Captains can create one challenge per week per team with a kind discriminator (`throwing` or `sport`), title, and optional description; team members can self-mark completion on the current ISO week only. Includes 3 new tables (`weekly_challenges`, `weekly_challenge_completions`, `weekly_challenge_sync_events`), domain schemas, RPC group with 5 typed error tags, repository with transactional FOR UPDATE mark/unmark, timezone-aware Monday-date helpers, and an outbox table populated at create time so the bot can announce the challenge on its start Monday at 09:00 team-local. The Discord bot drain and web UI will land in follow-up PRs.
