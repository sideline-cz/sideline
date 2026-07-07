---
"@sideline/server": patch
---

Tighten the `TeamChallengeRepository` write-side types: the `created_by` and `member_id` request-schema fields and the `create`/`markCompleted`/`unmarkCompleted` method params are now typed as the branded `TeamMember.TeamMemberId` instead of raw `string`. Callers already pass branded ids, so this is a type-level hardening with no behavior change — the brand is refinement-free, so encoding at the SQL boundary is identity.
