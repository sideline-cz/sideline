---
name: work
description: Fetches the next bug or story from the active Notion sprint (bugs always before stories, preferring in-progress work) and takes it through the full dev loop to a reviewed PR. Claims the ticket, runs research → plan → implement → review → fix → ship, then updates Notion statuses.
---

# Work Skill

Pick up a story or bug from the active sprint and take it end-to-end.

This skill owns the **ticket bookkeeping** — claiming, status cascades, releasing the claim. The
development loop itself belongs to `/dev-loop:work`; do not restate its phase order here, or the
two will drift.

Invoke agents directly via the Agent tool from the main thread — do NOT nest them inside a manager
agent. That keeps each step visible to the user.

---

## Phase 1: Claim the ticket

Invoke the `agile-coach` agent to:

- Find the active sprint
- Select the next bug or story (pass `$ARGUMENTS` if one was specified), **skipping any item
  already claimed by another session** — i.e. whose `Claude session` property is non-empty
- Update statuses to In Progress, cascading to parents
- **Stamp this session** into the item's `Claude session`, so no other `/work` or
  `/worktree:worktree` run picks it up
- Create a feature branch

This is the phase that claims the ticket. When `/work` is launched inside a worktree by
`/worktree:worktree`, `$ARGUMENTS` is the ticket's page ID — the agile-coach fetches that page
directly rather than re-selecting, and stamps *this* worktree agent's session, which is the one
actually doing the work.

See `## Sprint` in AGENTS.md for the database ids, status vocabularies, ordering rules, and the
claim-property rules.

Review the agile-coach's summary before continuing.

---

## Phase 2: Run the development loop

Invoke `/dev-loop:work` with the ticket's description and task list.

It runs research → plan → implement → review → fix → ship, and **stops at the plan for approval**.
Honour that stop: do not tell it to skip the gate because a ticket is in a sprint. A sprint ticket
with an empty body is exactly the case the gate exists for.

Two things to pass through from the ticket, because `/dev-loop:work` cannot see Notion:

- The **full body verbatim**, not a summary. If the body is empty, say so explicitly rather than
  inferring what the title probably means — an invented spec is worse than an acknowledged gap.
- Any **open question** the ticket leaves undecided, so the planner surfaces it for the user
  instead of quietly picking an answer.

---

## Phase 3: Release the claim

Invoke the `agile-coach` agent to update final statuses.

If the PR has been **merged**, the agile-coach also **clears the `Claude session`** — the item is
no longer owned by a session. If the PR is only **open or in review**, leave the stamp in place so
the ticket stays claimed.

---

## Reporting

Present:

- PR URL
- Which loop phases ran, and which were skipped and why
- All tasks completed and their Notion statuses
- Review findings addressed, and any deliberately declined with the reason
- Anything still blocked

State CI as what it actually is. "20 of 21 checks green, integration still running" is an honest
report; "CI passed" while a check is pending is not — and a check with an empty conclusion is
pending, not passed.
