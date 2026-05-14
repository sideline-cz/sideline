---
'@sideline/domain': minor
'@sideline/migrations': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': minor
'@sideline/i18n': minor
---

Add fee management and payment tracking MVP. Admins can define fees, assign them to members, and record manual payments (cash or bank transfer); members see their outstanding fees via `/finance status` in Discord and captains get a team-wide overview in the web app. Introduces `finance:view`, `finance:manage_fees`, and `finance:record_payments` permissions (treasurer pattern).
