---
'@sideline/server': patch
'@sideline/web': patch
'@sideline/i18n': patch
'@sideline/domain': patch
'@sideline/migrations': patch
---

Fix removed users retaining access to old teams. `TeamMembersRepository.findMembershipByIds` now filters inactive memberships by default, closing access through every endpoint that gates on team membership. Notification endpoints (`listNotifications`, `markAsRead`, `markAllAsRead`) now require active membership. iCal fee feed and payment-reminder cron exclude inactive members. `auth.autoJoinTeams` treats deactivation as terminal — removed users must rejoin via fresh invite. Web shows a new `/no-team` page for 0-team users with an optional "you were removed" banner; team-detail routes redirect removed users instead of 404ing.

Add global-admin bootstrap: the first registered user is automatically granted global admin (new `users.is_global_admin` column, set atomically on first insert). `isGlobalAdmin` now resolves from the DB flag OR the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist via a shared `toCurrentUser` helper. Global admins with no teams are routed to `/admin/onboarding-tokens` (where they can onboard the first team) instead of the `/no-team` page.
