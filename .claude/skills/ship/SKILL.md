---
name: ship
description: Commit, push, open a PR, verify CI, and address code review comments. The delivery loop from local changes to a reviewed PR. Use this whenever the user asks to commit, push, ship, send, or submit changes.
---

# Ship Skill

Commit local changes, push, open a PR, and handle CI + code review.

## Execution

Follow these steps **in order**. Stop and report if any step fails.

**Never push directly to `main`.** All work goes through feature branches and pull requests.

---

### Step 1: Check for changes

Run `git status` and `git diff` to understand what changed. If there are no changes, tell the user and stop.

---

### Step 2: Versioning note (no changesets)

This repo does NOT use Changesets. Do not create `.changeset/` files. Releases are per-app `@sideline/<app>@vX.Y.Z` git tags handled by MajNet after merge (see `/deploy`) — nothing version-related is needed in the PR.

---

### Step 3: Update documentation and agent config

Run the `/docs` and `/meta` agents **in parallel** (both in one message):

1. **`/docs` agent** — Updates two documentation surfaces:
   - **Internal technical reference** (`docs/*.md`, `docs/thesis/*.md`) — API docs, database docs, ER diagrams, use-cases, deployment
   - **End-user product docs** (`applications/docs/src/content/docs/**`) — Starlight site at `/docs` (guides, quick-start, api overview, changelog, FAQ)
   - Reads the diff to identify affected documentation across both surfaces
   - Checks and updates E2E mock data if API schemas changed

2. **`/meta` agent** — Updates AGENTS.md files and `.claude/` configuration:
   - Reads the diff to identify new patterns, conventions, or architecture changes
   - Updates the relevant AGENTS.md files with precise, unambiguous instructions
   - Updates agent/skill definitions if workflow changed
   - Verifies cross-references between all agent infrastructure files

If either agent makes changes, stage them before proceeding.

---

### Step 4: Run all checks

Run these commands and make sure they all pass:

```bash
pnpm format        # Biome formatting and linting
pnpm codegen       # Regenerate generated code
pnpm check         # TypeScript type checking
pnpm test          # Run all tests
```

Stage any files modified by format/codegen before proceeding.

---

### Step 5: Commit

- Stage all relevant files (avoid secrets like `.env`, credentials)
- Write a concise commit message describing **why**, not what
- If the user provided a message via `$ARGUMENTS`, use that as the commit message
- Never add `Co-Authored-By`, `Generated-By`, or any AI attribution footers
- Use a HEREDOC for the commit message to preserve formatting

---

### Step 6: Push and open PR

Run `git push` to push the commit to the remote. If the branch has no upstream yet, use `git push -u origin <branch>`.

Then open a pull request with `gh pr create` (skip if a PR already exists).

Before creating the PR, find the Notion link for the current work item:
- Search Notion for the story or bug matching the current branch/work
- Include `Notion: <url>` as the first line of the PR body

```bash
gh pr create --title "<short title>" --body "$(cat <<'EOF'
Notion: https://www.notion.so/<page-id>

## Summary
- <bullet points>

## Test plan
- <test plan>
EOF
)"
```

Return the PR URL to the user.

---

### Step 7: Wait for CI and code review (background)

After pushing, run **both** CI verification and review comment polling concurrently in the background:

1. **Launch a background agent** that watches CI:
   - Run `gh run watch` to wait for the latest run to complete
   - If it fails, capture the failed logs with `gh run view --log-failed`

2. **Launch a second background agent** that polls for review comments:
   - Get the PR number with `gh pr view --json number -q '.number'`
   - Poll every 30 seconds for up to 6 minutes:
     ```bash
     gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews
     gh api repos/{owner}/{repo}/pulls/{pr_number}/comments
     ```
   - Collect any comments found

Both agents run in the background (`run_in_background: true`). You will be notified when each completes — do **not** poll or sleep while waiting.

---

### Step 8: Handle results

Once both background agents finish:

- **CI failed**: investigate the logs, fix the issue, and restart from Step 4.
- **Review comments found**: invoke the `/revise` skill to address them.
- **Both passed with no comments**: proceed to Step 9.

---

### Step 9: Done

Report the PR URL and CI status. Do **not** update Notion statuses — that is the `/agile-coach` agent's responsibility.
