---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/web": minor
"@sideline/migrations": minor
---

Add a team-average Elo rating system. Captains and admins (any member with `member:edit`) can record game results via `POST /teams/:teamId/ratings/games`; the server applies K=40 during calibration (first 10 games) and K=20 thereafter. Current standings are readable by all team members via `GET /teams/:teamId/ratings`; individual rating details and full game history are available per-member. Two new database tables (`player_ratings`, `player_rating_history`) back the feature. A `MemberRatingCard` component surfaces ratings on the player profile page.
