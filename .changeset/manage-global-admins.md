---
"@sideline/domain": minor
"@sideline/server": minor
"@sideline/web": minor
"@sideline/migrations": minor
"@sideline/i18n": minor
---

Add a global-admin management area so existing global admins can view, grant, and revoke global-admin status from the web admin section. Grants are recorded with a new `global_admin_granted_at` timestamp. Safeguards prevent self-revocation and removing the last effective admin (counting both database admins and the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist); env-allowlisted admins are surfaced as non-revocable. The last-admin check uses a TOCTOU-safe guarded update.
