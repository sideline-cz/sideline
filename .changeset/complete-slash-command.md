---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/i18n": patch
"@sideline/docs": patch
---

Add a `/complete` Discord slash command that lets a team member complete their profile without leaving Discord: it captures name, date of birth, gender, and jersey number. Gender is a native command choice; name, date of birth, and jersey number are collected via a modal. Name, birth date, and gender persist on the user and mark the profile complete (`is_profile_complete = true`, the same as web onboarding); jersey number persists on the team membership. Adds a `Guild/CompleteMemberProfile` RPC with defensive server-side validation and transactional writes, and tightens the shared birth-date schema to strict `YYYY-MM-DD` (rejecting rolled-over dates like `2005-02-30`).
