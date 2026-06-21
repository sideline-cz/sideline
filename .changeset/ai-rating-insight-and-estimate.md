---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/web": minor
"@sideline/i18n": minor
---

Add two AI-assisted features to the captain-only player ELO rating card, reusing the existing LlmClient.

- **Rating insight**: an on-demand, plain-language summary of a player's recent form (trend from recent rating deltas, win/loss/draw record, calibration status), shown on the rating card with an AI-vs-fallback indicator. Backed by `GET /teams/:teamId/members/:memberId/rating/insight`.
- **ELO from description (suggest-and-confirm)**: for an unrated player, a captain describes the player's ability in free text and AI suggests a starting rating + rationale; the captain can edit the number before confirming. The applied rating seeds `player_ratings` while keeping `games_played = 0`, so the first calibration games (K=40) quickly correct the estimate. Backed by `POST .../rating/estimate` (no persist) and `POST .../rating/seed`.

Ratings stay 800–1800 (enforced in the domain schema, the server, and the UI). Both AI calls degrade to deterministic fallbacks when the LLM is unavailable and never fail the request. All endpoints require `member:edit` (captain/admin) and verify the member belongs to the team. No database migration.
