# Plan: Configurable Dashboard (server-side, cross-device sync)

**Bug:** "konfigurovatelný dashboard" — low severity, web.
**Branch:** `feat/configurable-dashboard`
**Notion:** https://www.notion.so/35e93506081880259fa7de519d0abd2e

## Decision: SERVER-SIDE persistence (per user's request — cross-platform sync)

Per-(user, team) layout stored in a new `dashboard_layouts` table (JSONB array of
ordered widget configs). The dashboard read endpoint is untouched; a separate API
group/table holds the layout. Web loads it as a graceful-degradation arm so the
dashboard never breaks if the config call fails.

## Scope

Dashboard = team detail page (`/teams/:teamId`).
- **Pinned (NOT configurable):** `AwaitingRsvpBanner`, `OutstandingPaymentsBanner`
  — self-hide when empty; never user-hideable (avoid silently losing alerts).
- **Configurable (show/hide + reorder):** `stats`, `upcomingEvents`, `activity`,
  `teamManagement`.

## UX

- "Customize" button toggles edit mode. Each widget: visibility Switch + Move
  up/Move down buttons (NOT drag-and-drop). "Reset layout" → canonical default.
- Edit mode holds a local working copy; **single PUT on Save** → `router.invalidate()`
  (no write per click). "Done" exits edit mode.
- All-hidden empty state scoped strictly to configurable region (banners never buried).

## Tasks (ordered)

1. **Domain** — `packages/domain/src/api/DashboardLayoutApi.ts` (new):
   `DashboardWidgetId` literal (4 ids), `DashboardWidget {id, visible}`,
   `DASHBOARD_WIDGET_ORDER`, `DashboardLayout {widgets}`, `UpdateDashboardLayoutPayload`,
   `Forbidden`. Group with `GET`/`PUT /teams/:teamId/dashboard-layout` (AuthMiddleware).
   Barrel-export in `index.ts`; register in `api/api.ts`. → `pnpm codegen && pnpm build`.
2. **Migration** — `packages/migrations/src/before/1787400000_create_dashboard_layouts.ts`:
   table (user_id, team_id, widgets JSONB, timestamps, PK(user_id,team_id), CASCADE).
3. **Repository** — `applications/server/src/repositories/DashboardLayoutsRepository.ts`:
   `findByUserTeam`, `upsert` (ON CONFLICT, JSONB bound as `${json}::jsonb`,
   `INSERT...RETURNING`→`LogicError.die` guard, `catchSqlErrors`).
4. **Server endpoints** — `applications/server/src/api/dashboard-layout.ts` +
   pure `normalizeWidgets` (dedupe, drop unknown, append missing as visible in
   canonical order — forward-compatible). Membership check; server re-normalizes
   payload. Register in `api/index.ts`.
5. **Web** — loader third arm (graceful degradation to `DEFAULT_LAYOUT`);
   config-driven rendering in `TeamDetailPage.tsx` (ordered stack, banners pinned,
   all-hidden empty state); `DashboardCustomizer.tsx` (new organism, edit mode);
   `lib/dashboardLayout.ts` (new, DEFAULT_LAYOUT + web normalizeWidgets);
   i18n keys in `en.json` + `cs.json`. → `pnpm codegen`.
6. **Docs** — `docs/database.md`, `docs/api.md`, ER diagram, use-cases.

## Tests

- Domain decode: valid widget; banner id rejected; unknown id rejected; missing
  `visible` rejected; layout round-trip; `DASHBOARD_WIDGET_ORDER` == 4 exact.
- `normalizeWidgets` unit: empty→all default; scrambled preserved; partial appends
  rest; dedupe; drop unknown; preserves `visible:false`.
- Repository integration: none→Option.none; upsert round-trip (pins JSONB shape);
  upsert twice updates; per-user isolation; CASCADE on team/user delete.
- Server API: default for no row; normalized for stale row; non-member→Forbidden;
  PUT persists+normalizes; upsert-empty→LogicError die.
- Web: widgets render in config order; hidden widget absent; banners always render;
  all-hidden empty state scoped; undefined layout→DEFAULT_LAYOUT; customizer
  toggles/reorder update working copy only; Save = exactly one PUT + invalidate.

## Risks

- **Grid → ordered stack:** flattening the current 2/3 + sidebar grid into a
  responsive single-column ordered stack changes the dashboard's visual layout
  (StatCards stays full-width). Needed for independent reordering.
- **JSONB read shape** (node-pg parsed object vs string) pinned by repo integration test.
- HttpApi type-inference limit → add group to the second `.add` block.

## Out of scope

- Hiding urgency banners; drag-and-drop; per-widget grid-span metadata.
