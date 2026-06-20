---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/web": minor
"@sideline/migrations": minor
"@sideline/i18n": minor
---

Add a balanced training team generator. Captains and admins (any member with `member:edit`) can generate two balanced teams for a training event based on player Elo ratings, with optional gender-mix weighting, then review, manually swap players, and post the result to Discord.

The core is a pure, deterministic engine (`TeamGenerator`) that seeds teams via snake-draft and refines them with hill-climbing local search over a normalized weighted cost function (Elo spread, team size, gender distribution), surfacing warnings for uneven team sizes, Elo outliers, and insufficient gender mix. Per-team balancing weights are configurable per team (`team_generation_config` table). The web `TeamGeneratorSection` provides generation, live balance feedback, and accessible select-two-to-swap manual adjustment; the `/training generate` Discord command deep-links to it. Posting to Discord goes through the event-sync outbox (`teams_generated` event) and re-derives all embed content server-side from the trusted roster. MVP ships two teams with an N-ready API and engine.
