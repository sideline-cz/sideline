---
'@sideline/web': patch
---

Scroll the fee and assignment lists under a pinned header, like the team lists already do.

PR #762 built `listScrollClass` / `listHeaderClass` and applied them to roles, rosters,
training-types and members; the finance lists were out of its scope. The by-assignment tab and
the fees list now reuse the same pair — the expenses list picked it up in #764.

The `sm:` gate and the opaque header background are kept as #762 set them: a fixed-height box
inside an already-scrolling page is worse on a phone, and rows scroll *under* the header.
