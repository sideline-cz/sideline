---
"@sideline/migrations": patch
---

Add idempotent migration to create `team_onboarding_tokens` table on production databases where migration `1747700000` was silently skipped. The Effect SQL migrator only runs migrations with ID greater than the latest applied ID, so any migration added with an older timestamp than what is already in the database will never execute. This `IF NOT EXISTS` migration at a higher ID ensures the table is created correctly regardless of migration history.
