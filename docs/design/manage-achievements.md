# Design Spec: Admin Achievement Management Page

**Story:** As an admin, I can manage achievements
**Branch:** `feat/manage-achievements`
**Audience:** Captains / team admins (utility-first; not player-facing)
**Status:** Design only — no implementation in this branch

---

## 1. Goals & non-goals

### Goals
- A single page where an admin can see **all** achievements (system + custom) for the team at a glance.
- Edit thresholds of system achievements (the numeric/rule value, not the slug or rule type).
- Create new **custom** achievements with name, description, threshold/rule, and optional Discord role mapping.
- Map any achievement to a Discord role — either pick an existing role or auto-create one.
- Give the admin confidence before saving: show a live count of how many players currently qualify, and a "preview" count under the proposed threshold before commit.
- Make accidental footguns hard: prevent saving thresholds that would mass-disqualify players without an explicit confirmation.

### Non-goals
- Inventing new achievement *rule types* in the UI. The available rule types are defined in domain code (`totalActivities`, `longestStreak`, `totalDurationMinutes`, `countsBySlug[activitySlug]`). The UI lets the admin pick from these via a dropdown.
- Bulk edit of multiple achievements at once.
- Player-facing changes — `AchievementsGrid.tsx` continues to render the catalog as-is.

---

## 2. Route, navigation, and access control

- **Route:** `/teams/$teamId/achievements` (new file: `applications/web/src/routes/(authenticated)/teams/$teamId/achievements.index.tsx`)
- **Page component:** `applications/web/src/components/pages/AchievementsManagePage.tsx`
- **Linked from:** Team detail page sidebar / settings area, next to "Age thresholds", "Roles", "Training types".
- **Auth:** captain or admin only. Non-admins get redirected (mirrors `RolesListPage`'s `canManage` pattern but stricter — the page itself is gated, not just the form). If a non-admin somehow lands here, render a single "You do not have permission" message; do not render the table.

---

## 3. Page layout

Follows the visual language of `AgeThresholdsPage.tsx` and `RolesListPage.tsx`: a single-column page with a header, optional create-form section, and a table. No sidebar layout, no tabs.

```
+--------------------------------------------------------------------------------+
| ← Back to team                                                                 |
| Achievements                                                                   |
| Define what players earn and which Discord role they get for it.               |
+--------------------------------------------------------------------------------+
|                                                                                |
|  [ + New custom achievement ]                                                  |
|                                                                                |
|  Tabs (segmented):  [ All ]  [ System ]  [ Custom ]                            |
|                                                                                |
|  +---+-------------------+-----------------------+----------+------------+----+ |
|  |   | Name              | Rule                  | Players  | Discord    |    | |
|  |   |                   |                       | qualify  | role       |    | |
|  +---+-------------------+-----------------------+----------+------------+----+ |
|  | 🎯 | Fifty activities  | ≥ 50 total activities | 12 / 34  | @Veteran   | ⋯  | |
|  | 🔥 | 3-day streak      | ≥ 3-day streak        | 21 / 34  | —          | ⋯  | |
|  | 🏆 | 30-day streak     | ≥ 30-day streak       | 4 / 34   | @Streaker  | ⋯  | |
|  | 🌟 | "Captain's pick"  | Custom: manual grant  | 2 / 34   | @VIP       | ⋯  | |
|  +---+-------------------+-----------------------+----------+------------+----+ |
|                                                                                |
+--------------------------------------------------------------------------------+
```

### Header
- `← Back to team` ghost button (matches existing pages).
- `<h1>` Achievements (`m.achievement_title()`).
- Muted `<p>` subtitle: "Define what players earn and which Discord role they get for it." (`m.achievement_subtitle()`).

### Top-of-page action
- A single primary button: **`+ New custom achievement`** (right-aligned on `sm+`, full-width on mobile). Opens the **Create** dialog.

### Filter tabs (`<ToggleGroup type="single">` from shadcn)
- `All` (default) / `System` / `Custom`.
- Pure client-side filter — does not refetch.

### Table
Mobile-aware, same pattern as `RolesListPage` (`hidden sm:table-cell` on non-essential columns):

| Column            | Mobile | Desktop | Notes                                                  |
|-------------------|--------|---------|--------------------------------------------------------|
| Emoji             | shown  | shown   | `w-10`, centered                                       |
| Name              | shown  | shown   | Bold; tag chip after: `[System]` (blue) or `[Custom]` (muted) |
| Rule              | hidden | shown   | e.g. `≥ 50 total activities`; threshold is bold        |
| Players qualify   | shown* | shown   | `X / Y` where Y = active team members. Tooltip explains source. On mobile, shown below name as small muted text |
| Discord role      | hidden | shown   | `@RoleName` color chip, or `—` if unmapped             |
| Action menu (⋯)   | shown  | shown   | dropdown: Edit threshold, Map Discord role, Delete (custom only) |

Row click = open edit drawer/sheet (see §5). The `⋯` menu duplicates these actions for discoverability.

### Empty states
- **No custom achievements yet, system list still shows:** under the filtered list, when `Custom` tab is selected: a centered "No custom achievements yet" block with the same shape as `AchievementsGrid.tsx`'s empty state (🏅 emoji, title, subtitle, primary button "Create your first custom achievement").
- **All tab is never empty** — the system catalog is always present.

---

## 4. Create custom achievement (dialog)

Trigger: `+ New custom achievement` button.
Component: `<Dialog>` (matches other modal patterns in the app).

```
+------------------------------------------------------------+
| New custom achievement                                  [×]|
+------------------------------------------------------------+
|                                                            |
|  Emoji *                                                   |
|  [ 🌟 ] (single-line text input, max 4 chars)              |
|                                                            |
|  Name *                                                    |
|  [______________________________________________]          |
|  e.g. "Captain's pick"                                     |
|                                                            |
|  Description *                                             |
|  [______________________________________________]          |
|  [______________________________________________]          |
|  Shown to players in the achievements grid. (≤ 140 chars)  |
|                                                            |
|  Rule *                                                    |
|  ( ) Total activities ≥  [   ] events                      |
|  ( ) Total duration   ≥  [   ] minutes                     |
|  ( ) Longest streak   ≥  [   ] days                        |
|  ( ) Count of activity type:                               |
|      [ Activity ▾ ]  ≥ [   ] occurrences                   |
|  ( ) Manual grant only (captain awards it)                 |
|                                                            |
|  Preview: 7 of 34 active members would qualify right now.  |
|                                                            |
|  Discord role                                              |
|  ( ) Don't map to a role                                   |
|  ( ) Use existing role:  [ SearchableSelect: @Veteran ▾ ]  |
|  (•) Auto-create role:   [ Captain's pick           ]      |
|      Bot will create this role in Discord on save.         |
|                                                            |
|  [ Cancel ]                          [ Create achievement ]|
+------------------------------------------------------------+
```

### Fields & validation

| Field         | Required | Validation                                              | i18n error key                       |
|---------------|----------|---------------------------------------------------------|--------------------------------------|
| `emoji`       | Yes      | 1–4 chars, not empty                                    | `achievement_emojiRequired`          |
| `name`        | Yes      | 1–64 chars, not empty, unique within team               | `achievement_nameRequired`, `achievement_nameTaken` |
| `description` | Yes      | 1–140 chars                                             | `achievement_descriptionRequired`    |
| `rule.kind`   | Yes      | one of the radio options                                | `achievement_ruleRequired`           |
| `rule.value`  | Yes (except for manual) | integer ≥ 1                              | `achievement_thresholdMin`           |
| `rule.activitySlug` | Yes if `Count of activity type` | must be a known activity     | `achievement_activityRequired`       |
| `roleMode`    | Yes      | `none` \| `existing` \| `create`                        | —                                    |
| `roleId`      | Yes if `roleMode === 'existing'` | must be a member of `filteredDiscordRoles` (same filter as `TeamSettingsPage`: drop `@everyone` and `managed` roles) | `achievement_roleRequired` |
| `roleNameToCreate` | Yes if `roleMode === 'create'` | 1–32 chars, valid Discord role name (no `@`, no emoji constraints since Discord allows them) | `achievement_roleNameInvalid` |

### Auto-name behaviour for "Auto-create role"
- When `roleMode` switches to `create`, **prefill** the input with the achievement `name` value.
- Show an inline hint: "Bot will create this role in Discord on save."
- If a Discord role with the same name already exists, surface a non-blocking warning under the input: "A Discord role named '@Captain's pick' already exists. We'll create a new one with the same name." (Discord allows duplicate role names.) Provide a button "Use existing instead" that flips the radio to `existing` and pre-selects that role.

### Buttons
- `Cancel` — secondary, closes dialog (with unsaved-changes confirm if any field is dirty).
- `Create achievement` — primary; disabled while submitting or when form invalid. Label translates via `m.achievement_create()`.

### Submit flow
1. Client calls `api.achievement.createCustom(...)`.
2. On `AchievementNameAlreadyTaken` → field error on `name` via `withFieldErrors`.
3. On `DiscordRoleCreateFailed` → toast error: "Achievement saved, but the Discord role could not be created. Try mapping a role again later." (achievement is still created; the row shows `—` for role with a retry icon).
4. On success → toast `m.achievement_created()`, close dialog, `router.invalidate()`.

---

## 5. Edit achievement (sheet/drawer)

Triggered by: clicking a row, or `⋯ → Edit threshold` / `Edit`.
Component: `<Sheet side="right">` for desktop, full-screen on mobile. We pick a sheet over a dialog so the admin can read the full table behind it for context (which threshold neighbours it).

```
+-----------------------------------------------+
| Edit: Fifty activities                     [×]|
+-----------------------------------------------+
|                                               |
|  Emoji   🎯  (read-only for system)           |
|  Name    Fifty activities  (read-only for sys)|
|  Type    [System]                             |
|                                               |
|  Description                                  |
|  ┌─────────────────────────────────────────┐  |
|  │ Reach 50 total recorded activities.     │  |
|  └─────────────────────────────────────────┘  |
|  (read-only for system achievements)          |
|                                               |
|  Rule                                         |
|  Total activities ≥  [ 50 ▾ ]    ← editable   |
|                                                |
|  Current:    12 of 34 members qualify         |
|  After save: 18 of 34 would qualify           |
|              (+6 newly qualify, 0 lose it)    |
|                                               |
|  Discord role                                 |
|  (•) Use existing: [ @Veteran ▾ ]             |
|  ( ) Auto-create:  [ Veteran           ]      |
|  ( ) Unmap                                    |
|                                               |
|  [ Discard ]                  [ Save changes ]|
+-----------------------------------------------+
```

### What's editable per achievement kind

| Field       | System achievement | Custom achievement |
|-------------|--------------------|--------------------|
| Emoji       | read-only          | editable           |
| Name        | read-only          | editable           |
| Description | read-only          | editable           |
| Rule kind   | read-only          | editable           |
| Rule value (threshold) | **editable** | editable     |
| Discord role mapping   | **editable** | editable     |
| Delete                 | not allowed   | allowed (with confirm) |

Rationale: system achievement copy is owned by domain code (`achievement_*_title`/`description` i18n keys), so editing it in the UI would diverge from translations. Only the *numeric threshold* and *role mapping* are tunable.

### Live qualification preview

This is the key safety feature.

- **"Current"** line: fetched on sheet open (`api.achievement.qualifyCount({ achievementId })`). Single number, always reflects the saved threshold.
- **"After save"** line: debounced (300 ms) recompute as the admin changes the threshold input. Calls `api.achievement.previewQualifyCount({ achievementId, ruleKind, ruleValue, activitySlug? })`.
  - Shows delta: `(+6 newly qualify, 0 lose it)` in green/red respectively.
  - **Loading state:** while the request is in flight, show a `Skeleton` block (`w-32 h-4`) in place of the number; the delta line is hidden. Use `Skeleton` from `~/components/ui/skeleton`.
  - **Error state:** an inline `Alert variant="destructive"` with text "Couldn't load preview. The threshold can still be saved." and a small `Retry` button. The Save button is **not** blocked by preview errors — the admin can still save blind if they're sure.
  - **Idle (no change):** "After save" line shows the same number as "Current", greyed out, no delta shown.

### Confirm-on-destructive-change

If saving the new threshold would **disqualify ≥ 1 currently-qualifying player** (delta on "lose it" > 0), show an inline confirmation **before** allowing save:

```
+-----------------------------------------------+
|  ⚠ This change will disqualify 3 players      |
|  who currently hold this achievement.         |
|  Their Discord role will be removed.          |
|                                               |
|  [ Show affected players ]                    |
|  [ ] I understand, continue                   |
+-----------------------------------------------+
```

- Save button stays disabled until the checkbox is ticked.
- "Show affected players" toggles a list (names only) inside the sheet, no extra request — server returns the player list as part of the preview response when the delta is negative (max 100 names).
- Threshold *increases* are the common path that triggers this; decreases generally only *add* qualifiers, which is safe and does not require confirmation.

### Save flow
- `Save changes` disabled while submitting, form-invalid, or unconfirmed destructive change.
- On submit: optimistic toast "Saving…" is fine, but we don't optimistically update the row count — wait for server.
- On success: close sheet, `router.invalidate()`, toast `m.achievement_updated()`.
- On `DiscordRoleSyncFailed`: toast warning "Saved, but Discord roles will be re-synced in the background."

### Delete (custom only)
- `⋯ → Delete` shows a `confirm()` (matches `AgeThresholdsPage`'s `window.confirm(m.ageThreshold_deleteConfirm())`).
- Confirm copy: "Delete '{name}'? Players who earned it will lose it, and the mapped Discord role will be unassigned (but not deleted)."
- Strictly never offered for system achievements.

---

## 6. Discord role selector — detailed UX

This is the trickiest part. We have three modes; the radio group keeps the choices visible side-by-side so the admin doesn't miss "auto-create".

### Pattern
```
Discord role
  ( ) Don't map to a role
  ( ) Use existing role
        [ SearchableSelect: pick a role ▾ ]
  (•) Auto-create role
        [ ___________________________ ]
        Bot will create this role on save.
```

- Built on `<RadioGroup>` from shadcn (we don't currently have one — would need `pnpm dlx shadcn@latest add radio-group`).
- The **inactive** mode's input is rendered but `disabled` and visually muted — so the admin can see all three options without expanding rows.
- The Discord role list comes from the same source as `TeamSettingsPage` (`filteredDiscordRoles`, dropping `@everyone` and `managed: true`). We surface role color via the `ColorDot` atom that already exists.

### Auto-name behaviour
- On switching to **Auto-create**, prefill with the achievement `name`.
- If the admin types a different name and then changes the achievement `name`, do **not** overwrite their custom role name (only the initial prefill is automatic).
- An "✨ Reset to achievement name" link appears next to the input if the values diverge.

### Existing role with same name
- When the admin types in the auto-create input or clicks Save, the client compares the proposed name to `filteredDiscordRoles` (case-insensitive). If a match exists:
  - Show inline blue info `Alert`: "A Discord role named '@X' already exists. To avoid duplicates, you can use it instead." + button "Use existing".
  - Do **not** block submit. Discord permits duplicate role names, and the admin may want a fresh one.

### Failure modes
- **Bot lacks permission to create roles:** API returns `DiscordPermissionDenied`. Render an `Alert variant="destructive"` inside the dialog: "The Sideline bot needs the `Manage Roles` permission to create new roles." Save remains blocked until the admin switches to `none` or `existing`.
- **Bot is not in the guild:** same as above with copy "The bot must be in your Discord server."

---

## 7. States summary (all surfaces)

| Surface                         | Loading                                              | Empty                                                                              | Error                                                       |
|---------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------|-------------------------------------------------------------|
| Page table                      | `Skeleton` rows (5 rows, full width) inside `<tbody>` | Custom-tab only: 🏅 + "No custom achievements yet" + CTA                            | Top-of-page `Alert variant="destructive"` + Retry button    |
| Qualify count in row            | small `Skeleton w-12 h-4` in the cell                | "0 / N" with no special treatment (zero is valid data)                              | "—" with tooltip "Failed to compute"                        |
| Create dialog                   | submit button shows "Creating…" and is disabled       | n/a                                                                                | Inline `Alert` for top-level errors; field errors via `FormMessage` |
| Edit sheet                      | sheet opens immediately, "Current" qualify count uses `Skeleton` | n/a                                                                                | Inline `Alert`; preview errors are non-blocking             |
| Preview qualify count           | `Skeleton` while debounced fetch is in flight         | "—" if computed value is null/undef                                                 | Non-blocking inline `Alert` with Retry                      |

---

## 8. New translations (en + cs)

Keys (English values shown; Czech to be supplied by translator — placeholders below match existing translation style):

```jsonc
// applications/web/src/messages/en.json (additive)
{
  "achievement_title": "Achievements",
  "achievement_subtitle": "Define what players earn and which Discord role they get for it.",
  "achievement_newCustom": "New custom achievement",
  "achievement_tabAll": "All",
  "achievement_tabSystem": "System",
  "achievement_tabCustom": "Custom",
  "achievement_colName": "Name",
  "achievement_colRule": "Rule",
  "achievement_colQualify": "Players qualify",
  "achievement_colRole": "Discord role",
  "achievement_typeSystem": "System",
  "achievement_typeCustom": "Custom",
  "achievement_qualifyOfTotal": "{qualifying} of {total} members qualify",
  "achievement_emptyCustomTitle": "No custom achievements yet",
  "achievement_emptyCustomDescription": "Create one to recognise team-specific milestones.",
  "achievement_create": "Create achievement",
  "achievement_created": "Achievement created.",
  "achievement_updated": "Achievement updated.",
  "achievement_deleted": "Achievement deleted.",
  "achievement_deleteConfirm": "Delete '{name}'? Players who earned it will lose it, and the mapped Discord role will be unassigned.",
  "achievement_emoji": "Emoji",
  "achievement_name": "Name",
  "achievement_description": "Description",
  "achievement_descriptionHint": "Shown to players in the achievements grid.",
  "achievement_rule": "Rule",
  "achievement_ruleTotalActivities": "Total activities",
  "achievement_ruleTotalDuration": "Total duration (minutes)",
  "achievement_ruleLongestStreak": "Longest streak (days)",
  "achievement_ruleActivityCount": "Count of activity type",
  "achievement_ruleManual": "Manual grant only (captain awards it)",
  "achievement_thresholdLabel": "Threshold",
  "achievement_previewCurrent": "Current: {qualifying} of {total} members qualify",
  "achievement_previewAfter": "After save: {qualifying} of {total} would qualify",
  "achievement_previewDelta": "(+{added} newly qualify, {removed} lose it)",
  "achievement_previewFailed": "Couldn't load preview. The threshold can still be saved.",
  "achievement_previewRetry": "Retry",
  "achievement_discordRole": "Discord role",
  "achievement_roleNone": "Don't map to a role",
  "achievement_roleExisting": "Use existing role",
  "achievement_roleCreate": "Auto-create role",
  "achievement_roleCreateHint": "Bot will create this role in Discord on save.",
  "achievement_roleResetToName": "Reset to achievement name",
  "achievement_roleDuplicateWarning": "A Discord role named '@{name}' already exists.",
  "achievement_roleDuplicateUseExisting": "Use existing instead",
  "achievement_roleBotMissingPermission": "The Sideline bot needs the 'Manage Roles' permission to create new roles.",
  "achievement_destructiveWarningTitle": "This change will disqualify {count} players",
  "achievement_destructiveWarningBody": "They currently hold this achievement. Their Discord role will be removed.",
  "achievement_destructiveShowAffected": "Show affected players",
  "achievement_destructiveConfirm": "I understand, continue",
  "achievement_emojiRequired": "Pick an emoji.",
  "achievement_nameRequired": "Name is required.",
  "achievement_nameTaken": "An achievement with this name already exists.",
  "achievement_descriptionRequired": "Description is required.",
  "achievement_ruleRequired": "Pick a rule.",
  "achievement_thresholdMin": "Threshold must be at least 1.",
  "achievement_activityRequired": "Pick an activity type.",
  "achievement_roleRequired": "Pick a role.",
  "achievement_roleNameInvalid": "Role name must be 1–32 characters."
}
```

Czech translations live in `applications/web/src/messages/cs.json` with identical keys; copywriting handled by translator.

---

## 9. Accessibility notes

- **Page-level focus:** on page load, focus is *not* trapped; first focusable element after the header is the `+ New custom achievement` button.
- **Dialog & sheet:** shadcn `Dialog`/`Sheet` already trap focus and handle `Esc` to close. Verify the close button has `aria-label="Close"` (it does in shadcn defaults).
- **Tab order in Create dialog:**
  1. Emoji input
  2. Name input
  3. Description textarea
  4. Rule radio group (arrow keys move between options; `space` selects)
  5. Numeric threshold input (or activity select + threshold)
  6. Role mode radio group
  7. Active role input (existing select or new-name input)
  8. Cancel → Create achievement
- **Role picker:** `SearchableSelect` already supports keyboard nav (it's a Combobox). Ensure the `<label>` for the role mode radio is associated via `htmlFor` so screen readers announce "Use existing role, radio button, 2 of 3". Inactive input under each radio is `aria-disabled="true"` and has `tabIndex={-1}`.
- **Live regions:** The qualify-count preview line should be wrapped in `<div aria-live="polite">` so screen readers announce "After save: 18 of 34 would qualify" when it updates.
- **Destructive confirm checkbox** must have a visible label (the full sentence "I understand, continue") and be reachable via Tab; Save button has `aria-disabled` when unchecked.
- **Color is never the only signal:** the green/red delta (`+6` / `−3`) uses a leading `+`/`−` symbol so colour-blind users still parse it.
- **Contrast:** all status text (Custom/System chips, delta counts) uses Tailwind tokens with WCAG AA contrast (e.g. `text-blue-700`, `text-red-700`, `text-green-700` — same as existing pages).

---

## 10. Component hierarchy

```
applications/web/src/components/pages/AchievementsManagePage.tsx       (page)
└── organisms/
    ├── AchievementsManageTable.tsx                                    (table + filter tabs)
    │   └── molecules/
    │       └── AchievementRow.tsx                                     (single <tr>)
    ├── AchievementCreateDialog.tsx                                    (Dialog)
    │   └── molecules/
    │       ├── AchievementRuleField.tsx                               (radio group + value input)
    │       └── DiscordRoleSelector.tsx                                (radio + select + auto-name input)
    ├── AchievementEditSheet.tsx                                       (Sheet)
    │   ├── molecules/
    │   │   ├── AchievementQualifyPreview.tsx                          (Current / After save / Delta)
    │   │   └── AchievementDestructiveConfirm.tsx                      (warning + checkbox + affected list)
    │   └── (reuses) AchievementRuleField, DiscordRoleSelector
    └── (reuses ui/) Dialog, Sheet, Form, RadioGroup, Skeleton, Alert, ToggleGroup
```

`DiscordRoleSelector` and `AchievementRuleField` are shared between Create and Edit. The `Edit` sheet just disables the read-only fields for system achievements via a prop.

---

## 11. API surface needed (informational, not part of this design)

The developer will need (names suggestive):

- `api.achievement.list({ teamId })` → returns catalog merged with team's custom + threshold overrides + role mappings + per-achievement qualify counts.
- `api.achievement.createCustom({ teamId }, payload)` → returns created achievement; may also create a Discord role.
- `api.achievement.updateThreshold({ teamId, achievementId }, payload)`.
- `api.achievement.updateRoleMapping({ teamId, achievementId }, payload)`.
- `api.achievement.deleteCustom({ teamId, achievementId })`.
- `api.achievement.previewQualifyCount({ teamId, achievementId, ruleKind, ruleValue, activitySlug? })` → `{ qualifying, total, addedMemberIds, removedMembers: [{ memberId, name }] }` (cap names at 100).

All return `Option<Discord*>` failure tags so the page can show targeted alerts. Errors that should map to `withFieldErrors`: `AchievementNameAlreadyTaken` → `name`, `AchievementRoleNameInvalid` → `roleNameToCreate`.

---

## 12. Acceptance criteria for the developer / tester

A tester should be able to verify:

1. **Listing:** all system achievements appear with the same emoji and titles as `AchievementsGrid.tsx`. Custom achievements appear with the admin-supplied emoji.
2. **Qualify count:** the "X / Y" matches a manual count of team members who satisfy the rule today.
3. **Create custom achievement (manual):** can create one without a Discord role mapping; row appears with `—` in the role column.
4. **Create custom achievement (auto-create role):** a new Discord role appears in the guild with the chosen name; row shows it. Permission failure shows the documented alert and does not partially create.
5. **Edit threshold up:** preview shows correctly; if any player loses the achievement, the destructive confirm is shown; save requires checkbox. After save, those players no longer have the Discord role.
6. **Edit threshold down:** preview shows correctly; no confirm required; save adds the Discord role to newly-qualifying players.
7. **Preview error:** simulate network failure on `previewQualifyCount` — admin sees the inline retry alert and **can still save** without preview.
8. **Delete custom:** confirm dialog appears; on confirm, row disappears, Discord role is unassigned but not deleted.
9. **Delete system:** option is absent from the `⋯` menu and the sheet.
10. **Non-admin access:** opening `/teams/$teamId/achievements` as a non-admin shows the permission message, not the table.
11. **Keyboard-only flow:** can complete the full Create flow without a mouse, including selecting a role and submitting.
12. **i18n:** switching to Czech translates all visible strings, including dynamic placeholders (`{qualifying}`, `{total}`, `{count}`).

---

## 13. Out-of-scope reminders

- This branch does **not** introduce new rule *kinds*. The five listed (`Total activities`, `Total duration`, `Longest streak`, `Activity type count`, `Manual grant`) are the only ones designed; if the domain doesn't yet support `Manual grant`, the developer can defer that one radio option and the rest of the design still stands.
- No bulk operations.
- No history / audit log of threshold changes on this page (that would belong on the existing Activity Log page).
- The player-facing `AchievementsGrid` continues to render the catalog from domain — custom achievements being shown to players is a follow-up story and intentionally not designed here.
