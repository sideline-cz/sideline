---
"@sideline/server": patch
---

Fix admins getting a 404 when opening an event detail for a group they don't belong to. The "All groups" events list lets admins (members with `team:manage`) see every team event, but the event detail endpoint still ran the member-group access check for everyone and rejected events outside the admin's groups before the admin status was even evaluated. The detail endpoint now bypasses the member-group check for admins, matching the list, update, and cancel handlers.
