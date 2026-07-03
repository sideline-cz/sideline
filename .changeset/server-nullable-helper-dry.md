---
"@sideline/server": patch
---

DRY up the duplicated `nullable` event-property accessor in the role and channel RPC event constructors into a shared `makeNullableEventProperty` factory, consolidating the two generic mapped-type casts into a single location.
