# Plan — "As a global admin, I can manage global admins"

**Story:** Notion `36c93506081880e19a71c2147e058228` · **Branch:** `feat/manage-global-admins`

## Goal
Let a global admin view, grant, and revoke global-admin status from the web admin area. Only global admins can manage global admins. Safeguards prevent self-lockout and removing the last admin.

## Current state (research)
- `users.is_global_admin BOOLEAN` already exists (migration `1787300000`). No management UI/API yet.
- Two existing ways to become admin: first-user auto-promotion, and the `APP_GLOBAL_ADMIN_DISCORD_IDS` **env allowlist** (additive OR in `toCurrentUser`).
- Existing admin surfaces to mirror: web pages `/admin/onboarding-tokens`, `/admin/translations` (gated by `isGlobalAdmin`), server API groups guarded by `requireGlobalAdmin`. **No bot surface.**

## Surface decision
**Web admin page `/admin/global-admins` + server API group `GlobalAdminApi`.** No Discord command (global admin is a platform concept, not per-guild). Audit via `Effect.logInfo`.

## Locked product decisions
1. **Self-revoke is always blocked** — own row shows "You" badge, no revoke button; server rejects with `GlobalAdminSelfRevokeError` (409).
2. **Add a migration** for `users.global_admin_granted_at TIMESTAMPTZ` (nullable), set on grant, shown in the list. Backfill existing admins.
3. **Env-allowlist admins** appear as non-revocable `source:'env'` rows (deduped with any DB row for the same user).

## Tasks

### migrations
- **M1** New migration `…_add_user_global_admin_granted_at.ts`: `ADD COLUMN IF NOT EXISTS global_admin_granted_at TIMESTAMPTZ`, backfill existing admins to `now()`.

### @sideline/domain (rebuild after)
- **D1** Add `global_admin_granted_at: Schema.OptionFromNullOr(...)` to `User` model.
- **D2** New `GlobalAdminApi.ts`: errors `GlobalAdminForbidden`(403), `GlobalAdminUserNotFound`(404), `GlobalAdminLastAdminError`(409), `GlobalAdminSelfRevokeError`(409), `GlobalAdminEnvManaged`(409). `GlobalAdminListItem { discordId, userId?, username?, avatar?, source:'db'|'env', grantedAt?, revocable, isSelf }`. Endpoints: `GET /auth/global-admins`, `POST /auth/global-admins` (grant by discordId, idempotent → 200 + refreshed list), `DELETE /auth/global-admins/:userId` (204).
- **D3** Register group in `api.ts`, export from domain index.

### @sideline/server
- **S1** `UsersRepository`: `listGlobalAdmins()`, `countGlobalAdmins()`, idempotent `grantGlobalAdmin(discordId)` (sets `granted_at` via COALESCE), and TOCTOU-safe `revokeGlobalAdminGuarded(userId, envAdminCount)` — single conditional UPDATE that only succeeds if `(db admin count) + envAdminCount > 1`.
- **S2** First-user promotion also sets `global_admin_granted_at`.
- **S3** New handler `global-admin.ts` (mirrors `onboarding.ts`): all handlers start with `requireGlobalAdmin`. List merges DB + env admins, **deduped by discordId** (env wins, marked non-revocable), env-only-no-row entries tolerated. Grant idempotent. Revoke: self-guard → not-found → env-managed guard → effective-count guarded UPDATE → `LastAdminError` if blocked. Introduce a small `GlobalAdminAllowlist` service so the env set is injectable/testable.

### @sideline/web
- **W1** Route `/(authenticated)/admin/global-admins.tsx` (`ssr:false`, `beforeLoad` redirect, loader lists).
- **W2** `AdminGlobalAdminsPage.tsx`: list (avatar/name or raw discordId + "not yet logged in", source badge, granted date, action), grant form (Discord ID `^\d{17,20}$`), AlertDialog confirms, revoke only when `revocable`, "You" badge on self, disabled action for env rows. Typed-error → toast mapping.
- **W3** Sidebar "Global admins" nav item in the Admin group.

### i18n
- en + cs keys for the page, actions, confirms, and error messages.

## Safeguards
- **No self-removal** (UI hides button + server `GlobalAdminSelfRevokeError`).
- **No removing last effective admin** — guard counts DB admins ∪ env allowlist; blocks only when it would leave 0 effective admins. TOCTOU-safe via single conditional UPDATE.
- **Env admins non-revocable** via API (config-driven); shown clearly.

## Tests (TDD, server `test/GlobalAdmin.test.ts`)
403 for non-admin; list db admins; dedupe db+env → single env row; env-only no-row item; env admin with non-admin row; grant new/idempotent/unknown→404; granted_at set on grant; self-revoke blocked (guard not called); env-managed revoke blocked; last-admin DB-only blocked (409); **env-backed admin makes revoke allowed (effective count)**; revoke with multiple admins → 204; revoke unknown/non-admin → 404. Update `User.User` fixtures + `UsersRepository` mocks across suites.

## Migration / build notes
- One additive migration; idempotent + guarded backfill.
- `pnpm build` after domain edits; then `pnpm format && pnpm check && pnpm test`.
- No breaking changes — purely additive.
