---
name: complete
description: Mark a story or bug as complete after its PR has been merged. Moves stories to Done and bugs to Fixed. Use when the user says a PR was merged or asks to complete/close a work item.
---

# Complete Skill

Mark work as complete after its PR has been merged.

## Execution

> **Notion CLI:** resolve the binary first — `N=$(command -v notion || command -v ntn || echo /opt/homebrew/bin/ntn)`.
> Commands below use the `notion` syntax (positional method, `--body`). If you resolved `ntn`
> instead, translate to `-X <METHOD>` / `-d`. See the agile-coach agent for the full table.

1. Verify the PR is actually merged:

```bash
gh pr view --json state,body -q '{state: .state, body: .body}'
```

If the PR is not merged, tell the user and stop.

2. Extract the Notion page URL from the PR body (the `Notion: <url>` line at the top). Use this URL to fetch and update the work item directly — no searching needed.

3. Fetch the Notion page to determine its type (story or bug), then update it:
   - Move the **story** to `Done`
   - Move the **bug** to `✅ Fixed`
   - **Clear the `Claude session`** property so the item is no longer marked as claimed by a
     session:

     ```bash
     $N api PATCH /v1/pages/<page-id> --body '{"properties":{"Claude session":{"rich_text":[]}}}'
     ```

   Read the page back and confirm both the status and the cleared session before reporting success.

4. Switch back to `main` and pull latest:

```bash
git checkout main && git pull
```
