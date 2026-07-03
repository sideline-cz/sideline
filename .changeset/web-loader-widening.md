---
'@sideline/web': patch
---

Replace object-literal-nested type-widening `as` casts in three loaders (workout, member-detail, event-detail) with explicit branch-type annotations. The casts did catch-branch/success-branch unification; the annotations reproduce the exact same loader success types without the assertions (a redundant `r.logs` no-op cast is also dropped). Pure type-erasure — identical emitted JS, behavior-preserving.
