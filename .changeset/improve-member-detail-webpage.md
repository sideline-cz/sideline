---
"@sideline/web": minor
"@sideline/server": patch
"@sideline/domain": patch
"@sideline/i18n": patch
"@sideline/docs": patch
---

Improve the member detail webpage

Redesign the team member detail page into a card-based, responsive layout with a new member summary header (avatar, name, @username, jersey, joined date, primary role). Surface the member's joined date through the roster API, add a confirmation dialog before removing a role, give the profile edit form unsaved-changes feedback (per-field indicators, a dirty footer, save disabled until valid changes exist) plus name-length and future-birth-date validation, and add friendlier empty states with owner-only CTAs for activities and achievements.

Also add a view/edit toggle for the profile card, let captains/admins manage the member's group and roster memberships directly from the page, and add a "Danger zone" to deactivate or reactivate a member (restricted to admins with the `member:remove` permission) — deactivation now also revokes the member's Discord roster/group role and channel access, and reactivation restores it.
