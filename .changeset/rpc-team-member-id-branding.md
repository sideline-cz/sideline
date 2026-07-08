---
"@sideline/domain": patch
"@sideline/server": patch
---

Brand the `team_member_id` fields in the PersonalEvents and Guild RPC groups as `TeamMember.TeamMemberId` instead of raw `Schema.String` (14 fields across request payloads and success responses). This lets the server RPC handlers drop their two `Schema.decodeSync(TeamMember.TeamMemberId)` helpers and 9 per-call-site decodes — the decoded payload is now branded end-to-end — and removes a latent brand-stripping `String(...)` coercion in `IdentifyEventsChannel`. The brand is refinement-free so the wire format is unchanged; this is a type-safety tightening with no runtime or protocol change.
