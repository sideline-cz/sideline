---
name: work
description: Fetches the next bug or story from the active Notion sprint (bugs always before stories, preferring in-progress work) and implements it task by task. Creates a plan, gets approval, then codes, commits, and updates Notion statuses.
---

# Work Skill

Pick up a story from the active sprint and implement it end-to-end.

## Execution

Follow these phases **in order**. Stop and report if any phase fails. Pass `$ARGUMENTS` to the agile-coach if the user specified a story.

Invoke each specialist agent directly via the Agent tool from the main thread — do NOT nest them inside a manager agent. This gives the user visibility into each step.

---

### Phase 1: Pick up work

Invoke the `/agile-coach` agent to:
- Find the active sprint
- Select the next bug or story (pass `$ARGUMENTS` if the user specified a story), **skipping any
  item already claimed by another session** — i.e. whose `Claude session` property is non-empty
- Update all statuses to In Progress
- **Stamp this session** into the item's `Claude session` property, so no other `/work` or
  `/worktree` run picks it up
- Create a feature branch

This is the phase that claims the ticket. When `/work` is launched inside a worktree by
`/worktree`, `$ARGUMENTS` is the ticket's page ID — the agile-coach fetches it directly and stamps
*this* worktree agent's session, which is the session actually doing the work.

Review the agile-coach's work summary before proceeding.

---

### Phase 2: Implement

Invoke the `/implement` skill with the story/bug description and task list from the agile-coach.

---

### Phase 3: Ship

Invoke the `/ship` skill to commit, push, open a PR, verify CI, and address review comments.

---

### Phase 4: Done

Invoke the `/agile-coach` agent to update final statuses.

If the PR has been merged, the agile-coach also **clears the `Claude session`** on the story/bug —
the item is no longer owned by a session. If the PR is only open/in review, leave the session
stamped so the ticket stays claimed.

Present the final state:
- PR URL
- All tasks completed and their Notion statuses
- Any review comments that were addressed or intentionally skipped
- Any remaining blockers
