---
"@sideline/domain": patch
"@sideline/i18n": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/docs": patch
---

Carpool improvements:

- **Stable car ordering** — cars are now numbered in creation order (oldest is car 1, newly added cars append as the next number). Previously the board sorted by a random UUID, so adding a car could renumber the existing one.
- **Change seats** — a car's owner can update the seat count from the car thread. Reducing below the number of people already in the car is blocked.
- **Kick passenger** — a car's owner can remove a specific passenger from their car (also removes them from the car thread).
