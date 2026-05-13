---
'@sideline/domain': minor
'@sideline/server': minor
'@sideline/bot': minor
'@sideline/web': minor
'@sideline/migrations': minor
'@sideline/i18n': patch
---

Admins can define custom activity types per team. Each type has a name, emoji,
and description, scoped to the team. Built-in types (Gym, Run, Stretch, Training)
remain global and read-only; tenant isolation is enforced at the repository
layer. The Discord `/makanicko log` command switches from a static choices list
to autocomplete that pulls the team's effective list (globals + custom). Web
exposes a new admin page at `/teams/:teamId/activity-types` with create/edit/
delete (delete is blocked when logs reference the type — rename instead).
