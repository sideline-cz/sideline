---
"@sideline/domain": minor
"@sideline/migrations": minor
"@sideline/server": minor
"@sideline/bot": minor
"@sideline/i18n": minor
"@sideline/web": patch
---

feat: add a custom `/poll` command

Captains can create polls in a team channel with `/poll`, choosing a question and
2–10 options (semicolon-separated). Members vote by clicking option buttons; results
render live in the embed with per-option bars, counts, and percentages. Two optional
features: restrict who may add new options to a selected Discord role, and set a
deadline after which voting closes.

Polls support single-choice (click to vote, click again to retract, click another to
move) and multiple-choice (`multiple:true`, toggle each option independently). Voting
is serialized per poll with a `FOR UPDATE` lock for deterministic toggle behavior.
Authorization is enforced server-side: a new `poll:manage` permission (granted to
Admin and Captain) gates creating and closing polls, and the add-option role gate is
checked against the member's raw Discord roles on the server (members with
`poll:manage` or the poll's creator may always add). Deadlines are parsed in the
team's timezone and the poll closes lazily on the next interaction after the deadline,
rebuilding the message to its closed, read-only state. Fully localized (EN/CS).
