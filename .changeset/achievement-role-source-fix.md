---
'@sideline/web': patch
'@sideline/server': patch
'@sideline/domain': patch
---

Fix custom achievement role-source radio: "auto-create role" now actually creates the Discord role on save, and "no role" clears an existing mapping when editing. Previously the dialog only honored `existing` — `auto_create` was silently discarded and `none` left any prior role in place. `createCustom` now returns the new achievement id so the web client can enqueue the role provision event after a successful save.
