---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/i18n": patch
"@sideline/docs": patch
---

Add a `/complete` Discord slash command that lets a team member save their date of birth, gender, and jersey number. Gender is a native command choice; date of birth and jersey number are collected via a modal. Birth date and gender persist on the user; jersey number persists on the team membership. The command does not mark the profile globally complete (web onboarding remains that gate) and never overwrites the member's name. Adds a `Guild/CompleteMemberProfile` RPC with defensive server-side validation and transactional writes, and tightens the shared birth-date schema to strict `YYYY-MM-DD` (rejecting rolled-over dates like `2005-02-30`).
