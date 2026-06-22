---
"@sideline/web": patch
---

Fix the player rating card so an ELO seeded from the AI "set starting rating from description" flow is actually visible. Because a seeded rating intentionally keeps `games_played = 0`, the card's zero-games branch previously showed only the "no matches played" text and the describe widget, never the rating number — so the value a captain had just set was invisible. The zero-games branch now displays the rating value with a calibrating badge. Also moved the AI/fallback source indicator dot in the "Form" insight section from in front of the paragraph (where it read like a stray list bullet) to next to the "Form" label.
