---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/web': minor
'@sideline/migrations': minor
'@sideline/i18n': minor
---

Add an admin-mediated team onboarding flow. Global admins now mint single-use, time-limited onboarding links bound to a specific Discord user; captains complete team setup (identity, Discord server, channels) via a 2-step wizard that authenticates with their bound Discord account. Team provisioning runs in a SQL transaction so the token is only consumed if the team is fully provisioned. As part of this work, `TeamsRepository.insertQuery` now persists all 16 team columns (previously silently dropped 6).
