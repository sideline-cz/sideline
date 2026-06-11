---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/bot": patch
---

Fix carpool car creation: any team member can now add their own car (volunteer as
a driver), not just captains. Starting a carpool remains captain/admin-only
(`carpool:manage`). Previously the `Carpool/AddCar` action was incorrectly gated
behind `carpool:manage`, so the "Add Car" button shown to everyone always failed
for regular members. Membership is still required — non-members are rejected.
