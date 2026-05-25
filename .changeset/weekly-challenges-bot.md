---
'@sideline/bot': minor
'@sideline/i18n': minor
---

Add Discord bot processor for Weekly Challenges (Part 2/3 of Týdenní výzvy). The bot now drains the `weekly_challenge_sync_events` outbox introduced in Part 1 and posts a localized announcement embed in the team's announcement channel when the captain-scheduled week begins (Monday 09:00 in the team's timezone). Embeds are color-coded (emerald 🥏 for throwing challenges, amber 🏃 for sport) with inline `Druh` and `Týden` fields, an optional description, and an optional deep-link URL (controlled by the new optional `WEB_URL` env var). When Discord returns 404 (channel deleted) the row is marked processed with an audit log; other Discord errors retry with exponential backoff and surface as `MarkFailed` so the server-side 5-attempt cap can terminate them. Adds 7 new `weeklyChallenge_embed_*` i18n keys in cs/en. The web UI and user-facing HTTP API will land in Part 3.
