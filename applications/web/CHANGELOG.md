# @sideline/web

## 0.22.1

### Patch Changes

- [#404](https://github.com/maxa-ondrej/sideline/pull/404) [`717bf0c`](https://github.com/maxa-ondrej/sideline/commit/717bf0c90f40c933951532327df4a5211311d0b2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix channel access for groups that were never provisioned with a Discord role.

  Granting channel access to such a group silently saved the grant but never
  applied a Discord permission overwrite and gave no feedback — so the group
  appeared to "do nothing" (confirmed in production for role-only groups created
  before their team's Discord provisioning, which had no `discord_channel_mappings`
  row and thus no resolvable role).

  The server now backfills missing group roles (a low-cadence bot tick calls a new
  `Channel/BackfillMissingGroupRoles` RPC; role-only groups get a role, groups that
  already have a channel get the role attached to it — no duplicate channels), and
  re-applies a group's stored channel-access grants automatically the moment its
  Discord role first appears (group-axis reconcile on the role none→present
  transition, generalising the existing channel-axis reconcile). `setAccess` also
  best-effort enqueues provisioning when it encounters a role-less group, and the
  bot's role provisioning is now idempotent (no duplicate roles on retry).

  Channel detail responses also expose a per-grant `roleResolvable` flag, and the
  channel access sheet shows a "Not yet active in Discord" badge, info notice, and
  clearer toast so the saved-but-pending state is visible until it self-heals.

- Updated dependencies [[`1681e50`](https://github.com/maxa-ondrej/sideline/commit/1681e5075b9f824075fcda935bd3dcf5b5a65410), [`717bf0c`](https://github.com/maxa-ondrej/sideline/commit/717bf0c90f40c933951532327df4a5211311d0b2)]:
  - @sideline/domain@0.27.1
  - @sideline/i18n@0.12.5

## 0.22.0

### Minor Changes

- [#399](https://github.com/maxa-ondrej/sideline/pull/399) [`58b7a5a`](https://github.com/maxa-ondrej/sideline/commit/58b7a5aa2954faa5925bdcf0f3e9334b5d102d2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Link a tournament event to a real roster with a per-pair auto-approve toggle. An
  RSVP "yes" drives roster membership: with auto-approve on, the member is added
  automatically; with it off, an Approve/Decline request is posted to a dedicated
  per-event thread in the owner group's channel and is also actionable on the web
  roster detail page. Withdrawing a "yes" removes flow-added members (manual members
  are protected) and cancels pending requests; enabling auto-approve backfills current
  "yes" responders. Configure and approve from either Discord or the web.

### Patch Changes

- Updated dependencies [[`58b7a5a`](https://github.com/maxa-ondrej/sideline/commit/58b7a5aa2954faa5925bdcf0f3e9334b5d102d2e)]:
  - @sideline/domain@0.27.0
  - @sideline/i18n@0.12.4

## 0.21.0

### Minor Changes

- [#396](https://github.com/maxa-ondrej/sideline/pull/396) [`4f69c4c`](https://github.com/maxa-ondrej/sideline/commit/4f69c4ce586911ad828844928ec4a393e5f39678) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add per-team IMAP email ingestion alongside the existing inbound webhook. Teams can now
  configure an IMAP mailbox in Team Settings; a UID-tracked cron poller fetches new mail every
  few minutes, parses it, and feeds the same summarize → coach-approval → Discord pipeline the
  webhook uses. Mailbox credentials are stored encrypted at rest (AES-256-GCM with an app-held
  key), never returned by the API, and entered via a write-only password field. Message-ID
  deduplication prevents double-processing when both ingestion methods run at once, and the
  watermark only advances past mail that was successfully ingested so transient failures retry
  rather than lose messages.

### Patch Changes

- Updated dependencies [[`4f69c4c`](https://github.com/maxa-ondrej/sideline/commit/4f69c4ce586911ad828844928ec4a393e5f39678)]:
  - @sideline/domain@0.26.3
  - @sideline/i18n@0.12.3

## 0.20.0

### Minor Changes

- [#383](https://github.com/maxa-ondrej/sideline/pull/383) [`741f36a`](https://github.com/maxa-ondrej/sideline/commit/741f36adbbbc7f77b43e4a9ab400003418e13d7f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(email): two-tier summaries (short + detailed) with ephemeral paginated Discord previews and dual-summary web editing

  Every forwarded email now gets a SHORT summary (a plain opening sentence plus ~6 emoji-led bullets) and a DETAILED summary (the existing balanced one), generated in a single OpenAI JSON-mode call. The coach approval message shows both summaries inline; the posted team message shows the short summary with buttons that open ephemeral, paginated previews of the detailed summary and the original email (no Sideline redirect). The Sideline web email page edits both summaries. Adds a nullable `short_summary` column (legacy rows fall back to the detailed summary, then the body) and a team-ownership + posted-status-guarded `Email/GetEmailContent` RPC for the member-facing previews.

### Patch Changes

- Updated dependencies [[`741f36a`](https://github.com/maxa-ondrej/sideline/commit/741f36adbbbc7f77b43e4a9ab400003418e13d7f)]:
  - @sideline/domain@0.26.0
  - @sideline/i18n@0.12.0

## 0.19.0

### Minor Changes

- [#376](https://github.com/maxa-ondrej/sideline/pull/376) [`4f2d818`](https://github.com/maxa-ondrej/sideline/commit/4f2d818a03acf47d15e1a74eabf06136c84f1c94) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add email forwarding with AI summarization and coach approval. Teams can forward organizational emails to a unique inbound address (secured by a per-team token plus HMAC signature verification, body-size cap, and rate limiting). Each email is summarized via an `effect/unstable/ai` LLM client (config-gated, with a deterministic stub when no provider is configured), then an approval request with Approve/Reject buttons and a "Review & edit in Sideline" link is posted to a configurable coach channel. On approval the AI summary posts to the team's target channel; on rejection the original email posts instead. Both posts link back to a new web Email Detail page where coaches can review the original message, download attachments, edit the summary before approving, and members can view posted emails. Adds the `email_forwarding_config`, `email_messages`, `email_post_sync_events`, and `email_attachments` tables, the `EmailForwardingApi` endpoints, the `Email` RPC group, an email summarization cron, and the `EmailSyncService` bot worker. New env vars: `EMAIL_WEBHOOK_SIGNING_SECRET` (required) and optional `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL`.

### Patch Changes

- [#374](https://github.com/maxa-ondrej/sideline/pull/374) [`5e0a4a0`](https://github.com/maxa-ondrej/sideline/commit/5e0a4a0c781ee8574eb62c69fe613cae13515118) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add two more feature-preview snapshots to the logged-out homepage hero. Alongside the existing stats, upcoming-events, leaderboard, and RSVP demo cards, the bento grid now also showcases a "Team Finances" card (paid/outstanding KPIs and an upcoming-due row) and an "Achievements" card (unlocked-count badge with example badges). Adds the matching `hero_demo_*` i18n keys in English and Czech and extends the homepage E2E coverage.

- Updated dependencies [[`4f2d818`](https://github.com/maxa-ondrej/sideline/commit/4f2d818a03acf47d15e1a74eabf06136c84f1c94), [`5e0a4a0`](https://github.com/maxa-ondrej/sideline/commit/5e0a4a0c781ee8574eb62c69fe613cae13515118)]:
  - @sideline/domain@0.25.0
  - @sideline/i18n@0.11.0

## 0.18.2

### Patch Changes

- [#371](https://github.com/maxa-ondrej/sideline/pull/371) [`8d5c386`](https://github.com/maxa-ondrej/sideline/commit/8d5c38680e82293b1bca226da837be0749115c66) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Expose the training claim-request lead time (`claim_request_days_before`) in the web Team Settings UI. Captains can now configure, in a new "Coach assignment" card, how many days before a training the coach claim request is posted (0–30, default 3) — previously only changeable directly in the database. Adds the field to the team-settings API contract (response + partial-update request, bounded 0–30), maps it through the server handler, and renders a number input that is independent of the RSVP reminder toggle.

- Updated dependencies [[`8d5c386`](https://github.com/maxa-ondrej/sideline/commit/8d5c38680e82293b1bca226da837be0749115c66), [`7479b19`](https://github.com/maxa-ondrej/sideline/commit/7479b1992514f9eec87456e09ad93e4ebb2f754e)]:
  - @sideline/domain@0.24.0
  - @sideline/i18n@0.10.0

## 0.18.1

### Patch Changes

- [#365](https://github.com/maxa-ondrej/sideline/pull/365) [`c931704`](https://github.com/maxa-ondrej/sideline/commit/c9317041669c68437576931e74832f163a4b521b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Route frontend OTEL telemetry through the nginx proxy to avoid cross-origin issues with the SigNoz collector. The browser OTEL exporter now posts to the same-origin `/otel/` path which nginx proxies to the collector, eliminating CORS preflight failures. Also bumps server to pick up the migrations 0.18.1 patch.

## 0.18.0

### Minor Changes

- [#360](https://github.com/maxa-ondrej/sideline/pull/360) [`2b1b9eb`](https://github.com/maxa-ondrej/sideline/commit/2b1b9eb98d71051c658d6098c28314cb25a2a14a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add OpenTelemetry / SigNoz monitoring for the web application.

  Sets up a `ManagedRuntime` singleton (built once per page session) with OTLP JSON export via the Fetch API. Registers Web Vitals metrics (LCP, CLS, FCP, INP, TTFB), page load timing, and React component render duration. OTEL config is optional so local dev works without it configured.

### Patch Changes

- [#360](https://github.com/maxa-ondrej/sideline/pull/360) [`2b1b9eb`](https://github.com/maxa-ondrej/sideline/commit/2b1b9eb98d71051c658d6098c28314cb25a2a14a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix `Uncaught undefined` crash after Discord login (real root cause)

  `fetchTranslations` and `fetchVersions` used bare `Effect.runPromise` which
  only catches typed errors — any defect or interrupt (e.g. an aborted fetch
  during the post-login redirect sequence) escaped as an unhandled
  `Uncaught (in promise) undefined`, crashing the page.

  Both now use `Effect.runPromiseExit` + `Exit.isSuccess` so defects are
  silently treated as "no data" rather than crashing the app.

- [#360](https://github.com/maxa-ondrej/sideline/pull/360) [`2b1b9eb`](https://github.com/maxa-ondrej/sideline/commit/2b1b9eb98d71051c658d6098c28314cb25a2a14a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Serve the service worker script with `Cache-Control: no-cache`

  `sw.js` is now sent with `Cache-Control: no-cache` from the origin so the
  browser always revalidates it against the server. A stale, long-cached service
  worker keeps an old worker (and the old cached app it serves) alive, which
  delays deployed fixes from reaching returning users. `no-cache` makes a newly
  deployed service worker take effect promptly. Cloudflare passes the origin
  `no-cache` through to the browser.

## 0.17.1

### Patch Changes

- [#358](https://github.com/maxa-ondrej/sideline/pull/358) [`4fccc7f`](https://github.com/maxa-ondrej/sideline/commit/4fccc7f87cd2021e0c5e1d93451b17854018639f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix `Uncaught undefined` crash after Discord login (real root cause)

  `fetchTranslations` and `fetchVersions` used bare `Effect.runPromise` which
  only catches typed errors — any defect or interrupt (e.g. an aborted fetch
  during the post-login redirect sequence) escaped as an unhandled
  `Uncaught (in promise) undefined`, crashing the page.

  Both now use `Effect.runPromiseExit` + `Exit.isSuccess` so defects are
  silently treated as "no data" rather than crashing the app.

- [#358](https://github.com/maxa-ondrej/sideline/pull/358) [`4fccc7f`](https://github.com/maxa-ondrej/sideline/commit/4fccc7f87cd2021e0c5e1d93451b17854018639f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Serve the service worker script with `Cache-Control: no-cache`

  `sw.js` is now sent with `Cache-Control: no-cache` from the origin so the
  browser always revalidates it against the server. A stale, long-cached service
  worker keeps an old worker (and the old cached app it serves) alive, which
  delays deployed fixes from reaching returning users. `no-cache` makes a newly
  deployed service worker take effect promptly. Cloudflare passes the origin
  `no-cache` through to the browser.

## 0.17.0

### Minor Changes

- [#356](https://github.com/maxa-ondrej/sideline/pull/356) [`8e17378`](https://github.com/maxa-ondrej/sideline/commit/8e173785eb8ce2a74f6a9bd729e51e6de252102b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat(events): hide started/cancelled events by default and support all-day / multi-day events
  - The events list now hides `started` and `cancelled` events by default, with a "Show past & cancelled" toggle. The calendar view continues to show all events.
  - Events can be marked **all day** (no time), including multi-day spans such as tournaments. An "All day" toggle on the create/edit forms hides the time inputs. All-day events render as date(s) only across the web list, detail, and calendar views, in Discord embeds (date-style timestamps), and in the iCal feed (`VALUE=DATE`).

### Patch Changes

- Updated dependencies [[`8e17378`](https://github.com/maxa-ondrej/sideline/commit/8e173785eb8ce2a74f6a9bd729e51e6de252102b)]:
  - @sideline/domain@0.23.0
  - @sideline/i18n@0.9.0

## 0.16.1

### Patch Changes

- [#355](https://github.com/maxa-ondrej/sideline/pull/355) [`0d1f890`](https://github.com/maxa-ondrej/sideline/commit/0d1f890595427ead71157364e88312c747805b5c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Serve the service worker script with `Cache-Control: no-cache`

  `sw.js` is now sent with `Cache-Control: no-cache` from the origin so the
  browser always revalidates it against the server. A stale, long-cached service
  worker keeps an old worker (and the old cached app it serves) alive, which
  delays deployed fixes from reaching returning users. `no-cache` makes a newly
  deployed service worker take effect promptly. Cloudflare passes the origin
  `no-cache` through to the browser.

- [#353](https://github.com/maxa-ondrej/sideline/pull/353) [`07a27b1`](https://github.com/maxa-ondrej/sideline/commit/07a27b18fd77ca0c5dafc6d913cc3064f6a30ac4) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix white-page crash for returning users caused by a stale service worker

  Returning visitors kept hitting a full white page with `Uncaught (in promise)
undefined` because the service worker served a stale, cached app shell (and the
  old hashed JS bundles it referenced), so a previously deployed crash fix never
  reached them. Hard-refreshing or clearing site data worked around it.

  Navigation requests now use `NetworkOnly` with the existing `offline.html`
  fallback so the app document always comes from the network and a freshly
  deployed shell reaches users immediately. The service worker now purges any
  unexpected caches (such as the old `pages` shell) on activate, and the app
  reloads once when an updated service worker takes control — so returning users
  escape stale code automatically.

  Note: offline navigation now always shows `offline.html` rather than a cached
  last-known shell. Immutable, content-hashed static assets are still cached.

## 0.16.0

### Minor Changes

- [#346](https://github.com/maxa-ondrej/sideline/pull/346) [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Restore archived channels and set a channel emoji

  Admins can now restore an archived channel (single, with bulk support on the
  server) — moving it back out of the configured archive category. Managed-channel
  archiving keeps the Discord link so a restored channel re-activates cleanly.

  When creating a channel, admins can specify an emoji; the channel's Discord name
  is composed from the team's configured channel name format (e.g. `{emoji}│{name}`),
  with a live preview in the create dialog.

- [#346](https://github.com/maxa-ondrej/sideline/pull/346) [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add web-based Discord channel management for admins

  Admins (with `group:manage`) can now create, rename, and archive Discord text
  channels directly from Sideline, organize them with Sideline-side categories and
  ordering, and grant existing groups VIEW/EDIT/ADMIN access to each channel
  (mapped to Discord permission overwrites). The ADMIN tier is bounded — it grants
  message/thread moderation but never channel rename or delete. Introduces a new
  `managed` channel entity that reuses the existing channel-sync pipeline, backed
  by new `team_channels` and `team_channel_access` tables and a new channel HTTP
  API. v1 scope: text channels only; ordering/categories are Sideline-side.

  The channel list reflects the team's actual Discord channels (synced from the
  `discord_channels` mirror, merged with managed channels still provisioning),
  grouped by their Discord category. Channels in the team's configured archive
  category are shown as archived, and admins can archive any Discord channel — not
  just Sideline-created ones — moving it into the archive category.

  Admins can also **bulk-archive** channels (multi-select) and **manage permissions
  for any Discord channel**, not just Sideline-created ones: managing access on a
  previously-unmanaged channel "adopts" it — making it private and replacing its
  existing Discord permissions with the Sideline access model (after a clear
  confirmation). A partial unique index keeps adoption idempotent.

  Also hardens `Runtime.runMain` so unsatisfied layer dependencies fail `pnpm check`
  at the call site instead of crashing the app at startup (the previous `as never`
  cast hid them). This surfaced and fixed a pre-existing missing dependency in
  `EventStartCron` (`DiscordChannelMappingRepository`).

### Patch Changes

- [#346](https://github.com/maxa-ondrej/sideline/pull/346) [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix two dark-mode/UX issues in the channel management dialogs
  - The destructive confirm button (Adopt / Archive / Bulk archive / Remove access)
    rendered white-on-white in dark mode because a `className` override lost to the
    AlertDialogAction's default button variant; it now uses the `destructive`
    button variant for correct contrast.
  - The access-level select showed its option description in the collapsed trigger,
    causing overflow; the trigger now shows only the level label.

- Updated dependencies [[`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878), [`e22ccc5`](https://github.com/maxa-ondrej/sideline/commit/e22ccc5c9f367efca2e26956b6abcb9f351f3878)]:
  - @sideline/domain@0.22.0
  - @sideline/i18n@0.8.0

## 0.15.2

### Patch Changes

- [#350](https://github.com/maxa-ondrej/sideline/pull/350) [`42c5822`](https://github.com/maxa-ondrej/sideline/commit/42c58226132734f72388d0acd6c60d89f1c30fee) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Pick up the corrected Translations API endpoint paths (08fb679c). The server now mounts the translations endpoints at `/api/translations` (instead of the double-prefixed `/api/api/translations`), and the web client requests them at the matching `/api/translations`. This restores translation-override loading and fixes the CSV/JSON export route.

## 0.15.1

### Patch Changes

- [#347](https://github.com/maxa-ondrej/sideline/pull/347) [`f7d95f8`](https://github.com/maxa-ondrej/sideline/commit/f7d95f85bede5120eccfaeedb9ccaec3a361d507) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix every authenticated API call (translations, teams, etc.) returning 404 / "team not found". The API base URL (`serverUrl`) was read via `Route.useRouteContext()` inside the document `shellComponent`, but TanStack Router renders the shell _above_ the root match's context provider, so `serverUrl` was `undefined` there. With an undefined base URL the HTTP client skipped its prefix and sent requests (e.g. `/api/translations`) to the page origin instead of the API, which the server's prefixed routes returned 404 for. The `serverUrl`-dependent providers (`RunProvider`, `TranslationOverridesProvider`) now live in a root route `component` that renders inside the match context, so the resolved base URL reaches every client call. The translations query is also keyed by `serverUrl` and gated until it resolves.

- Updated dependencies [[`08fb679`](https://github.com/maxa-ondrej/sideline/commit/08fb679cde568d45a51fb274ddb789ac5588c6b4)]:
  - @sideline/domain@0.21.1

## 0.15.0

### Minor Changes

- [#338](https://github.com/maxa-ondrej/sideline/pull/338) [`c50e57f`](https://github.com/maxa-ondrej/sideline/commit/c50e57f4e00c9b46fefbd3241917f4a1d214a435) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Team members can now customize their dashboard: show/hide and reorder the four non-urgent widgets (stats, upcoming events, activity, team management) per team. The layout is persisted server-side in a new `dashboard_layouts` table so it syncs across devices. The two urgency banners (awaiting RSVP, outstanding payments) stay pinned and are intentionally not user-hideable so members never silently miss alerts. New `GET`/`PUT /teams/:teamId/dashboard-layout` endpoints; the dashboard read endpoint is unchanged and the layout loads as a graceful-degradation arm so the dashboard never breaks if the config call fails.

### Patch Changes

- [#343](https://github.com/maxa-ondrej/sideline/pull/343) [`4345dd3`](https://github.com/maxa-ondrej/sideline/commit/4345dd3fec03ac134c8ad22e4ef9d16ec63a7052) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show a consistent, server-resolved display name for users across the website. The name-selection logic that previously lived only in the Discord bot is now a shared `DisplayName.pickDisplayName` helper in `@sideline/domain`, computed server-side and returned as a `displayName` field on the `CurrentUser`, `RosterPlayer`, `LeaderboardEntry`, RSVP (`RsvpEntry`/`NonResponderEntry`), and group-member API responses. The web app now renders that field everywhere it shows a person's name (nav menu, profile, leaderboard, rosters, team members, player detail, group members, RSVP panel, fee/challenge assignee pickers) instead of ad-hoc fallbacks — fixing the leaderboard, which previously showed the raw Discord username with no fallback to the user's real name.

  Precedence is profile name → Discord nickname → Discord display name → username. Empty/whitespace-only Discord name strings are now skipped (also fixes a latent bot bug). Also fixes the weekly-summary top-contributor name, which was previously a placeholder team-member id.

- [#337](https://github.com/maxa-ondrej/sideline/pull/337) [`a48c644`](https://github.com/maxa-ondrej/sideline/commit/a48c644e56bcae9a615bf7f3273fb77810141f5f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix removed users retaining access to old teams. `TeamMembersRepository.findMembershipByIds` now filters inactive memberships by default, closing access through every endpoint that gates on team membership. Notification endpoints (`listNotifications`, `markAsRead`, `markAllAsRead`) now require active membership. iCal fee feed and payment-reminder cron exclude inactive members. `auth.autoJoinTeams` treats deactivation as terminal — removed users must rejoin via fresh invite. Web shows a new `/no-team` page for 0-team users with an optional "you were removed" banner; team-detail routes redirect removed users instead of 404ing.

  Add global-admin bootstrap: the first registered user is automatically granted global admin (new `users.is_global_admin` column, set atomically on first insert). `isGlobalAdmin` now resolves from the DB flag OR the `APP_GLOBAL_ADMIN_DISCORD_IDS` env allowlist via a shared `toCurrentUser` helper. Global admins with no teams are routed to `/admin/onboarding-tokens` (where they can onboard the first team) instead of the `/no-team` page.

- [#344](https://github.com/maxa-ondrej/sideline/pull/344) [`385ca7b`](https://github.com/maxa-ondrej/sideline/commit/385ca7b71c1456019b8812c9c7fed3ca8be4a23a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix the onboarding-token admin page where generating a token left a dark overlay stuck on screen and the copy button could show an error page. The minted-link dialog is now always mounted and driven by its `open` prop (instead of being force-unmounted on close, which orphaned the Radix overlay), the one-time token is scrubbed from state on close, and the copy handler guards `navigator.clipboard` and swallows rejections.

  The same hardening is applied app-wide: a shared `copyToClipboard()` helper now backs all clipboard-copy call sites (team invites, calendar subscription, invite dialog), and four more conditionally-mounted dialogs (activity-type form, cannot-delete, edit-built-in achievement sheet, custom-achievement) were refactored to the always-mounted pattern with reset-on-open to avoid the same overlay-leak and stale-state bugs.

- [#345](https://github.com/maxa-ondrej/sideline/pull/345) [`f593074`](https://github.com/maxa-ondrej/sideline/commit/f593074f3dbaa57c046f6452c361e4d56b169c10) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix an `Uncaught undefined` crash that appeared immediately after Discord login. The post-login self-redirect (used to strip the `?token=` param) aborts the in-flight navigation, and the interrupted Effect run was letting a bare `undefined` escape to the router. Server runs now go through `Effect.runPromiseExit` with a correctly-wired abort signal: superseded navigations are dropped cleanly, genuine defects surface as real errors (never `undefined`), and `Redirect`/`NotFound` behaviour is preserved.

- Updated dependencies [[`f4f0e3f`](https://github.com/maxa-ondrej/sideline/commit/f4f0e3f9a33a200c58e02c45949489cf8f7a226b), [`32f598b`](https://github.com/maxa-ondrej/sideline/commit/32f598b8c8c83471b38d5221ac2eaced1da634d5), [`c50e57f`](https://github.com/maxa-ondrej/sideline/commit/c50e57f4e00c9b46fefbd3241917f4a1d214a435), [`4345dd3`](https://github.com/maxa-ondrej/sideline/commit/4345dd3fec03ac134c8ad22e4ef9d16ec63a7052), [`a48c644`](https://github.com/maxa-ondrej/sideline/commit/a48c644e56bcae9a615bf7f3273fb77810141f5f)]:
  - @sideline/domain@0.21.0
  - @sideline/i18n@0.7.0

## 0.14.0

### Minor Changes

- [#326](https://github.com/maxa-ondrej/sideline/pull/326) [`7fe28e8`](https://github.com/maxa-ondrej/sideline/commit/7fe28e84facfe9b4bef5b70c8627710fea5eb690) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add an admin-mediated team onboarding flow. Global admins now mint single-use, time-limited onboarding links bound to a specific Discord user; captains complete team setup (identity, Discord server, channels) via a 2-step wizard that authenticates with their bound Discord account. Team provisioning runs in a SQL transaction so the token is only consumed if the team is fully provisioned. As part of this work, `TeamsRepository.insertQuery` now persists all 16 team columns (previously silently dropped 6).

- [#333](https://github.com/maxa-ondrej/sideline/pull/333) [`e953389`](https://github.com/maxa-ondrej/sideline/commit/e9533899780a0983329bbb8acdd159c4f1e71cc8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add user-facing surface for Weekly Challenges (Part 3/3 of Týdenní výzvy). Captains can create, edit, and delete one challenge per week per team; members tick "splněno" on their own row for the current ISO week. The new page at `/teams/{teamId}/challenges` shows a 12-week history grid (chronological-left, sticky member-name column on desktop, vertical card list with the active week pinned on top on mobile) with optimistic toggle updates, stale-response handling via monotonic in-flight request IDs, and post-midnight refresh on window focus. The new HTTP API at `applications/server/src/api/weekly-challenge.ts` adds six endpoints — `GET/POST/PATCH/DELETE /teams/:teamId/weekly-challenges[/:challengeId]` plus mark/unmark — reusing the existing `requireMembership` + `requirePermission` primitives; cross-team isolation is enforced on every mutation, and Discord sync events are enqueued only on Create. `MondayPicker` correctly identifies Mondays in the team's timezone (not the captain's browser) via `Intl.DateTimeFormat`, and the grid uses the server-computed `view.isActive` flag as the source of truth for current-week styling. Adds 47 new `challenges_*` i18n keys (cs primary, en fallback, gender-neutral). Closes the Sportovní aktivity bug.

### Patch Changes

- Updated dependencies [[`7fe28e8`](https://github.com/maxa-ondrej/sideline/commit/7fe28e84facfe9b4bef5b70c8627710fea5eb690), [`d7513dc`](https://github.com/maxa-ondrej/sideline/commit/d7513dc8615ea3b28d905493c050d461adc8a4c9), [`fbc2627`](https://github.com/maxa-ondrej/sideline/commit/fbc2627fd07a378f1a11c6ae3d1ec3b4a2fe83e7), [`e953389`](https://github.com/maxa-ondrej/sideline/commit/e9533899780a0983329bbb8acdd159c4f1e71cc8)]:
  - @sideline/domain@0.20.0
  - @sideline/i18n@0.6.0

## 0.13.4

### Patch Changes

- [#323](https://github.com/maxa-ondrej/sideline/pull/323) [`f1fd0cd`](https://github.com/maxa-ondrej/sideline/commit/f1fd0cda5578907f85e49efdb240fd48adb9f070) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Achievement notifications are now posted to a configurable per-team Achievement channel. Existing teams continue posting to their welcome channel by default; set the channel to "None" on the team settings page to disable achievement notifications.

- [#325](https://github.com/maxa-ondrej/sideline/pull/325) [`ad72f98`](https://github.com/maxa-ondrej/sideline/commit/ad72f9845d5f4ebc5272dbbafe7f258dfccbf538) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Event date displays now show the full end date only when it differs from the start date. Same-day events show the end time only, while multi-day events show both the full end date and end time so the duration stays unambiguous.

- Updated dependencies [[`f1fd0cd`](https://github.com/maxa-ondrej/sideline/commit/f1fd0cda5578907f85e49efdb240fd48adb9f070)]:
  - @sideline/domain@0.19.4
  - @sideline/i18n@0.5.3

## 0.13.3

### Patch Changes

- [#318](https://github.com/maxa-ondrej/sideline/pull/318) [`eac2e36`](https://github.com/maxa-ondrej/sideline/commit/eac2e365aedadbe052174e202700392bef507a7b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Allow backdating and future-dating activity (makánicko) logs. Previously, activities could only be recorded for the current day; users now choose any date within ±2 years when logging or editing an activity, both on the web app and via the `/makanicko log` Discord command.
  - **Web**: the activity log create form and edit sheet show a date picker. The picker defaults to "today" (empty submission) for create; on edit it pre-fills with the existing log's date and only overrides the stored timestamp when the user explicitly changes it.
  - **Discord**: `/makanicko log` accepts an optional `date` (`YYYY-MM-DD`) parameter; omitting it keeps the original "log now" behaviour.
  - Picked dates anchor at 12:00 Europe/Prague (DST-safe), so they always land in the correct day-bucket for streaks, stats and the leaderboard. Same-day display ordering gets a stable `id` tiebreaker so two logs sharing a noon timestamp don't jitter on refresh.
  - Out-of-range or malformed dates surface a clear "Invalid date" toast (web) or ephemeral reply (bot) instead of failing silently.

- Updated dependencies [[`eac2e36`](https://github.com/maxa-ondrej/sideline/commit/eac2e365aedadbe052174e202700392bef507a7b), [`344dcb8`](https://github.com/maxa-ondrej/sideline/commit/344dcb8b542f57b360e186a8b09a63645855f933)]:
  - @sideline/domain@0.19.3
  - @sideline/i18n@0.5.2

## 0.13.2

### Patch Changes

- [#316](https://github.com/maxa-ondrej/sideline/pull/316) [`f2a41c3`](https://github.com/maxa-ondrej/sideline/commit/f2a41c3a0210dd1d300df24e2038272d97981faf) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add explicit `rsvp_reminders_enabled` toggle to team settings and fix `daysBefore = 0` to mean "remind on the day of the event" (was silently treated as "disabled" because the cron filtered on `rsvp_reminder_days_before > 0`). With this change:
  - Teams that had `rsvp_reminder_days_before = 0` expecting same-day reminders will now actually receive them at `rsvp_reminder_time` on the day of the event (and the late-RSVP and unclaimed-training reminders that depend on this same cron path will fire too).
  - A new `rsvp_reminders_enabled` boolean (default `true`) is the explicit way to disable RSVP reminders. Surface in `Team Settings` as the "Enable RSVP reminders" checkbox.

  Migrate-up only — defaults to `TRUE` for all existing teams.

- Updated dependencies [[`f2a41c3`](https://github.com/maxa-ondrej/sideline/commit/f2a41c3a0210dd1d300df24e2038272d97981faf)]:
  - @sideline/domain@0.19.2
  - @sideline/i18n@0.5.1

## 0.13.1

### Patch Changes

- [`976c68c`](https://github.com/maxa-ondrej/sideline/commit/976c68c5e08e45906f65a237fe0e9b891642883f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix custom achievement role-source radio: "auto-create role" now actually creates the Discord role on save, and "no role" clears an existing mapping when editing. Previously the dialog only honored `existing` — `auto_create` was silently discarded and `none` left any prior role in place. `createCustom` now returns the new achievement id so the web client can enqueue the role provision event after a successful save.

- Updated dependencies [[`976c68c`](https://github.com/maxa-ondrej/sideline/commit/976c68c5e08e45906f65a237fe0e9b891642883f)]:
  - @sideline/domain@0.19.1

## 0.13.0

### Minor Changes

- [#311](https://github.com/maxa-ondrej/sideline/pull/311) [`2f5291f`](https://github.com/maxa-ondrej/sideline/commit/2f5291f5a2b6643ee5bd6bed922b208c669c3f09) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team expense tracking. Admins and treasurers can log, edit, and delete team expenses across five categories (fields, equipment, travel, tournaments, other) via a new `/teams/:teamId/finances/expenses` page. The Finances overview gains a new default "Overview" tab with an income vs. expense balance dashboard — KPI strip for income, expenses, and net balance, plus a category breakdown — driven by a multi-currency `balance-summary` endpoint. Every write is captured in an `expense_history` audit table via a Postgres trigger. Reuses existing `finance:view` (read) and `finance:manage_fees` (write) permissions — no new permission literal.

- [#289](https://github.com/maxa-ondrej/sideline/pull/289) [`6abf99c`](https://github.com/maxa-ondrej/sideline/commit/6abf99c886c1e5b43fed364699e1f0ee947c4a9c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add fee management and payment tracking MVP. Admins can define fees, assign them to members, and record manual payments (cash or bank transfer); members see their outstanding fees via `/finance status` in Discord and captains get a team-wide overview in the web app. Introduces `finance:view`, `finance:manage_fees`, and `finance:record_payments` permissions (treasurer pattern).

- [#306](https://github.com/maxa-ondrej/sideline/pull/306) [`9e421b5`](https://github.com/maxa-ondrej/sideline/commit/9e421b5ea30984b60f37c132f3a4e2da90801e38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add web UI for fee management and payment tracking. Captains and treasurers can now define, edit, and archive fees from a new `Fees` page, and the existing finance overview gains an `By assignment` tab listing every fee assignment with filters (status, fee, player, search), inline Record Payment / Mark Waived / Un-waive actions, and per-currency outstanding amounts. Adds query filters (`memberId`, `feeId`, `from`, `to`, `includeVoided`) to `listPayments` and a new `listMemberAssignments` HTTP endpoint scoped by team ownership.

- [#307](https://github.com/maxa-ondrej/sideline/pull/307) [`2f6bd5b`](https://github.com/maxa-ondrej/sideline/commit/2f6bd5b9c480a1fc4ff3a59e7fdd4ad521860bb2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player-facing payment status view. Adds a new "My payments" page (`/teams/:teamId/my-payments`) with KPI cards (outstanding, overdue count, paid total, next due), filter chips, and per-fee tables with expandable payment history. Adds an outstanding-payments banner on the team dashboard that appears when the current player has pending or overdue fees. Introduces a new `myPaymentHistory` endpoint (`GET /teams/:teamId/finance/my-payments`) that lets any team member view their own payment history without the `finance:view` permission; the endpoint is membership-gated and hardcodes the caller's member id, so a player cannot read another member's payments.

### Patch Changes

- [#303](https://github.com/maxa-ondrej/sideline/pull/303) [`978746c`](https://github.com/maxa-ondrej/sideline/commit/978746ca35b12203a046be017483dbfa968dfaf8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Captains can now create, update, and delete custom activity types (previously admin-only). The activity types management page is now reachable from the team sidebar (under Coach).

- [#304](https://github.com/maxa-ondrej/sideline/pull/304) [`54662cf`](https://github.com/maxa-ondrej/sideline/commit/54662cf751cfb8fa740fc11ad99d41532498ad24) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show app versions (web, server, bot) in the user dropdown menu and add a `/info` slash command to the Discord bot.

- Updated dependencies [[`978746c`](https://github.com/maxa-ondrej/sideline/commit/978746ca35b12203a046be017483dbfa968dfaf8), [`2f5291f`](https://github.com/maxa-ondrej/sideline/commit/2f5291f5a2b6643ee5bd6bed922b208c669c3f09), [`6abf99c`](https://github.com/maxa-ondrej/sideline/commit/6abf99c886c1e5b43fed364699e1f0ee947c4a9c), [`9e421b5`](https://github.com/maxa-ondrej/sideline/commit/9e421b5ea30984b60f37c132f3a4e2da90801e38), [`2f6bd5b`](https://github.com/maxa-ondrej/sideline/commit/2f6bd5b9c480a1fc4ff3a59e7fdd4ad521860bb2), [`62db467`](https://github.com/maxa-ondrej/sideline/commit/62db46789598c4ec0b02c0f31dded7a262bca718), [`54662cf`](https://github.com/maxa-ondrej/sideline/commit/54662cf751cfb8fa740fc11ad99d41532498ad24), [`e656e54`](https://github.com/maxa-ondrej/sideline/commit/e656e543f3bb51f9279941d9d7edee529988bfa6)]:
  - @sideline/domain@0.19.0
  - @sideline/i18n@0.5.0

## 0.12.0

### Minor Changes

- [#268](https://github.com/maxa-ondrej/sideline/pull/268) [`1a361c7`](https://github.com/maxa-ondrej/sideline/commit/1a361c7124725e40f0d62e5c546b1dedfcc34535) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add achievement system: players earn badges for their activity, and selected achievements automatically grant Discord roles.
  - Code-defined catalog of 11 V1 achievements covering total activities (1/10/50/100), longest streak (3/7/30 days), cumulative duration (10h/50h), and per-activity-type counts (25 gym / 25 running).
  - `AchievementEvaluator` runs after every activity-log create and update; new badges are inserted idempotently and emit a sync event for the bot to process.
  - Bot polls `Achievement/GetUnprocessedEvents`, optionally grants a per-team Discord role (5 of 11 achievements), and posts a gold embed to the team's welcome channel.
  - Player profile shows an Achievements grid between Roles and Activity Stats; earned badges are highlighted, unearned ones are dimmed.
  - New tables: `earned_achievements`, `achievement_role_mappings`, `achievement_sync_events`.
  - Fix: `TeamsRepository.insert` now persists `welcome_channel_id` instead of silently dropping it.

- [#272](https://github.com/maxa-ondrej/sideline/pull/272) [`22d7c79`](https://github.com/maxa-ondrej/sideline/commit/22d7c7996efa5a3ce9a8c5a11c070ac7d4b156f6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Admins can define custom activity types per team. Each type has a name, emoji,
  and description, scoped to the team. Built-in types (Gym, Run, Stretch, Training)
  remain global and read-only; tenant isolation is enforced at the repository
  layer. The Discord `/makanicko log` command switches from a static choices list
  to autocomplete that pulls the team's effective list (globals + custom). Web
  exposes a new admin page at `/teams/:teamId/activity-types` with create/edit/
  delete (delete is blocked when logs reference the type — rename instead).

- [#270](https://github.com/maxa-ondrej/sideline/pull/270) [`fd7956f`](https://github.com/maxa-ondrej/sideline/commit/fd7956fedd865b0618823cb68c5d9c6a90d7edc6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add admin achievement management: captains can override built-in thresholds, create custom achievements, map achievements to Discord roles (existing or auto-created), and preview qualification impact before saving.
  - New admin page at `/teams/:teamId/achievements` (gated by `team:manage`).
  - Per-team threshold overrides for the 11 built-in achievements via new `achievement_settings` table; `AchievementEvaluator` applies overrides at evaluation time without disturbing the closure-based catalog.
  - New `custom_achievements` table for admin-created achievements (CRUD-only — evaluation/role-granting for customs is a follow-up).
  - Auto-create Discord role flow uses a separate idempotent outbox table (`discord_role_provision_events`) with attempt-based retry; bot reuses same-named existing roles to avoid duplicates.
  - Preview endpoint reports qualifying count, sample of soon-to-be-disqualified players, and whether the bot has Manage Roles permission.
  - `AchievementSlug` stays a closed literal; player-facing `AchievementsGrid` is untouched.

- [#273](https://github.com/maxa-ondrej/sideline/pull/273) [`54256fa`](https://github.com/maxa-ondrej/sideline/commit/54256fa02de18a1e422b8a8e0f6db03a744f9699) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Translation CMS: admins can edit UI translations from inside Sideline; changes go live without a redeploy.
  - New `/admin/translations` page (gated by `APP_GLOBAL_ADMIN_DISCORD_IDS`) with inline edit, search, JSON import/export, and per-locale delete-override action. Bot-only keys are flagged with a "requires redeploy" badge.
  - New `translation_overrides` table stores only admin overrides; defaults remain in compiled Paraglide messages. Resolution order: override → compiled default → key. Empty-string override is a valid value; `null` deletes the override.
  - New `tr(key, params)` helper + `TranslationOverridesProvider` (React Query, 30s polling paused when tab hidden). All ~80+ web call sites of `m.foo()` were codemodded to `tr('foo')` so overrides apply across the app.
  - `TranslationCache` service uses Postgres `LISTEN/NOTIFY` on `translation_cache_invalidate` for cross-instance refresh; every mutation bumps `translation_cache_version`.
  - `@sideline/i18n` now exports `./registry` (typed `messagesByKey` + `messageKeys` + `TranslationKey` type) and ships raw `./raw/{en,cs}.json` for the admin UI.
  - New endpoints: `GET /api/translations`, `PATCH /api/translations/:key`, `POST /api/translations/import`, `GET /api/translations/export.json`. All require auth; admin-only operations check `isGlobalAdmin` derived from env.
  - Bot remains on compiled `m.*` (out of scope for v1); editing `bot_*` keys does not affect Discord until next redeploy.

- [#271](https://github.com/maxa-ondrej/sideline/pull/271) [`21fff86`](https://github.com/maxa-ondrej/sideline/commit/21fff86ae25742437e8c7ebae0f2b14e98402f88) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add weekly makáníčko summaries: teams receive an automated weekly recap every Sunday ~20:00 local team time, posted to a configured Discord channel, with a captain-only web page mirroring the data.
  - New `WeeklySummary` domain models (`WeekRange`, `PlayerWeeklySummary`, `TeamWeeklySummary`, `WeeklySummaryResponse`, `WeeklySummaryDigest`) plus `WeeklySummaryApi` HTTP group and `WeeklySummaryRpcGroup` (`Get/Mark` outbox RPCs).
  - New `team_settings.weekly_summary_channel_id` column and `weekly_summary_sync_events` outbox table with `UNIQUE (team_id, week_start)` so cron inserts are idempotent (`ON CONFLICT DO NOTHING`).
  - Server: `WeeklySummaryRepository` (week-scoped activity, achievement, and active-member queries), `WeeklySummarySyncEventsRepository` (outbox with `delivered_at` separate from `processed_at`, attempt-capped retry), `WeeklySummaryService` (`buildPlayerSummary`, `buildTeamSummary`), `WeeklySummaryHandler` (HTTP API gated on team membership; team section requires `roster:manage`), `WeeklySummaryCron` (per-minute, timezone-aware Sunday 20:00 firing with `Effect.exit` per team, `concurrency: 1`).
  - Bot: `buildWeeklySummaryEmbed` (team channel embed with empty-state, top contributors, week-over-week delta), `handleWeeklySummaryReady`, polling `ProcessorService`.
  - Web: `WeeklySummaryPage` with player + team sections (coach-only) and ISO week navigation (handles W53 long years), new `workout.weekly.tsx` route, link from `MakanickoPage`.
  - Tests: 47 new unit tests across domain + server + bot. Integration repo test scaffolded (`.skip`) pending Pg testcontainer wiring.

  MVP boundaries: channel-only delivery, single team embed; per-player DMs, "didn't log this week" callouts, and player rank deferred to v2.

### Patch Changes

- [#266](https://github.com/maxa-ondrej/sideline/pull/266) [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Decouple Discord channels from roles for groups. A group's Discord role is now created independently of its channel:
  - The role is always created when a group is created (or lazily on first member-add for legacy groups).
  - The channel is only created when explicitly requested (settings flag or `Create channel` action).
  - Disconnecting a channel keeps the role; re-linking a channel reuses the existing role.
  - Deleting a group removes both role and channel.

  `channel_sync_events` consolidates provisioning into a single `channel_created` event whose payload carries `Option<channel_name>` to distinguish role-only vs. role + channel paths. `discord_channel_id` is now nullable on the mapping (CHECK constraint enforces at least one of channel/role is set), and a partial unique index prevents two groups from being linked to the same channel. The bot processor splits permanent (Discord 403/404, schema decode) from transient errors so structurally broken events don't poison-pill the queue.

- [#266](https://github.com/maxa-ondrej/sideline/pull/266) [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Render the pending Discord-join banner inside the sidebar inset instead of above the layout. The fixed-position sidebar was overlapping the banner's left half, clipping the message.

- [#266](https://github.com/maxa-ondrej/sideline/pull/266) [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add manual "Sync Discord role" action on the group detail page. Reconciles the Discord role's membership with the group's current member list — useful when the bot was offline, after a manual member import, or when a member joins the Discord guild later. Adds missing role-holders and removes role from team members who left the group. Events are batched into a single multi-row INSERT and wrapped in a transaction for consistency.

- Updated dependencies [[`1a361c7`](https://github.com/maxa-ondrej/sideline/commit/1a361c7124725e40f0d62e5c546b1dedfcc34535), [`22d7c79`](https://github.com/maxa-ondrej/sideline/commit/22d7c7996efa5a3ce9a8c5a11c070ac7d4b156f6), [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6), [`fd7956f`](https://github.com/maxa-ondrej/sideline/commit/fd7956fedd865b0618823cb68c5d9c6a90d7edc6), [`39eadd1`](https://github.com/maxa-ondrej/sideline/commit/39eadd113c4404280d7ab66a389183ef26f5e2a6), [`54256fa`](https://github.com/maxa-ondrej/sideline/commit/54256fa02de18a1e422b8a8e0f6db03a744f9699), [`21fff86`](https://github.com/maxa-ondrej/sideline/commit/21fff86ae25742437e8c7ebae0f2b14e98402f88)]:
  - @sideline/domain@0.18.0
  - @sideline/i18n@0.4.0

## 0.11.1

### Patch Changes

- [#262](https://github.com/maxa-ondrej/sideline/pull/262) [`91c4c3d`](https://github.com/maxa-ondrej/sideline/commit/91c4c3d073be32833199cbc3c71c5eb6efa195cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extend automatic group assignment with a gender criterion alongside age. Captains can now configure rules like "U12 boys → Mladší žáci" and "U12 girls → Mladší žáci dívky" by combining age thresholds with gender filters, evaluated with AND semantics.

  Highlights:
  1. **Single nullable `gender` enum** on `AgeThresholdRule`, reusing the existing `User.Gender` literal. The request schema uses `Schema.OptionFromOptionalKey` so legacy web bundles that don't send the field continue to validate.
  2. **Composite uniqueness** — the previous `UNIQUE (team_id, group_id)` is replaced by `UNIQUE NULLS NOT DISTINCT (team_id, group_id, min_age, max_age, gender)` so multiple rules can target the same group as long as their criteria differ. Same-criteria duplicates still surface as 409 `AgeThresholdAlreadyExists` on both POST and PATCH.
  3. **All-None rejection** — the API rejects rules where age and gender are all unset (400 `AgeThresholdEmptyCriteria`) on both POST and PATCH; the web form mirrors this with a disabled submit button. A DB CHECK enforces the invariant at the storage layer.
  4. **Option-aware match logic** — `AgeCheckService.detectChanges` now evaluates `ageOk` and `genderOk` separately and ANDs them. As a side effect it fixes a pre-existing bug where members with no birth date could silently match age-only rules through `NaN` comparisons; the SQL filter `WHERE birth_date IS NOT NULL` is dropped so gender-only rules can apply to members with no birth date.
  5. **Inclusive age bounds** (`>=` / `<=`) — `min=12` now includes 12-year-olds, matching the natural reading of "minimum age 12".
  6. **Captain UI** — Shadcn `Select` for gender between the group picker and min-age input, new "Pohlaví / Gender" column with a tooltip explaining match semantics, "members who match all conditions" subtitle, AND-semantics microcopy, `overflow-x-auto` on the table, and the group dropdown no longer hides "already used" groups.
  7. **Notification copy** — softened "based on age threshold" → "based on automatic group rules" across all three paths (member-facing add, admin bulk add, admin bulk remove).
  8. **Migration `1747400000_add_gender_to_age_thresholds`** — adds the column, gender CHECK, deletes pathological pre-existing rows that already had all criteria NULL (with `Effect.logWarning` listing affected team_ids), adds the non-empty CHECK, drops the old unique constraint and installs the new one.

  Adds the `AgeThresholdEmptyCriteria` error class to `@sideline/domain`, exposed on both `createAgeThreshold` and `updateAgeThreshold` endpoints alongside `AgeThresholdAlreadyExists` (409).

  The captain-facing page label is broadened from "Age thresholds" / "Věkové prahy" to "Automatic groups" / "Automatické skupiny". The route URL (`/teams/:teamId/age-thresholds`) and the i18n key names (`ageThreshold_*`) are unchanged.

- Updated dependencies [[`91c4c3d`](https://github.com/maxa-ondrej/sideline/commit/91c4c3d073be32833199cbc3c71c5eb6efa195cb)]:
  - @sideline/domain@0.17.1
  - @sideline/i18n@0.3.18

## 0.11.0

### Minor Changes

- [#259](https://github.com/maxa-ondrej/sideline/pull/259) [`bdc0b0e`](https://github.com/maxa-ondrej/sideline/commit/bdc0b0ed9bcf4de3ca463bf2331a7da931ac5a79) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Sideline-managed Discord native onboarding: Welcome Screen, Server Guide, and a single mandatory "I've read the rules" prompt that grants an entry role.

  Captains configure the rules channel, entry role, and onboarding language in team settings; a new bot poll-loop merges the Sideline-owned prompt into the guild's existing onboarding (preserving any captain-authored prompts) and pushes the Welcome Screen + Server Guide. A `GuildMemberUpdate` handler grants the entry role when Discord flips `pending: false`.

  Adds:
  - `teams.rules_channel_id`, `teams.onboarding_rules_role_id`, `teams.onboarding_rules_prompt_id`, `teams.onboarding_locale` (en/cs), `teams.onboarding_synced_at`, `teams.onboarding_sync_status` (pending/syncing/done/failed), `teams.onboarding_sync_error` (JSON `{code, detail}`)
  - `bot_guilds.is_community_enabled`
  - New `discord_guild_roles` table mirroring `discord_channels`, populated from `GuildCreate`/`GuildRoleCreate/Update/Delete` and `READY` backfill
  - 10 new `Guild/*` RPCs: `PendingOnboardingSyncs`, `MarkOnboardingSyncDone`, `MarkOnboardingSyncFailed`, `MarkOnboardingSyncSkipped`, `RevertOnboardingSync`, `GetOnboardingRulesRoleId`, `SyncCommunityFlags`, `ListGuildRoles`, `SyncGuildRoles`, `UpsertGuildRole`, `DeleteGuildRole`
  - `POST /teams/:teamId/onboarding/retry` HTTP endpoint
  - New web "Onboarding" card on TeamSettingsPage with Discord-role picker, locale toggle, sync status, retry, and Community-feature warning state

  Sync uses a four-state machine (`pending → syncing → done | failed`) with atomic `FOR UPDATE SKIP LOCKED` claims and conditional `MarkSyncDone` to safely tolerate captain re-saves mid-sync. The bot caches the per-guild rules role with a 60s TTL, invalidated on every successful PUT and on failures so captain reconfigurations take effect immediately. Guilds without the Discord Community feature are marked `done` with a `community_disabled` error code (no infinite re-poll); enabling Community in Discord auto-flips the team back to `pending` for re-sync.

  Multi-bot coexistence: we preserve non-Sideline prompts but always set `enabled=true`, `mode=ONBOARDING_ADVANCED`, and rebuild `default_channel_ids`. A typed error classifier walks Discord's structured error tree (looking for `UNKNOWN_ROLE`/`INVALID_ROLE`/`UNKNOWN_CHANNEL`/`INVALID_CHANNEL` codes) so dead-role/dead-channel failures surface actionable copy in the captain UI rather than generic Discord error text.

- [#255](https://github.com/maxa-ondrej/sideline/pull/255) [`9af6d3c`](https://github.com/maxa-ondrej/sideline/commit/9af6d3c99b469f8d50f5fa18c868efc972085e18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord member welcome flow: group-targeted invites, invite-aware welcome messages, and captain audit log.

  Captains can now create multiple invites per team, each optionally bound to a specific group. When a member joins, the bot identifies the invite they used (via `INVITE_CREATE`/`INVITE_DELETE` event tracking + REST diff fallback), the server adds them to the invite's target group automatically, and renders a per-team welcome message template into the configured welcome channel. A separate hidden system-log channel receives a structured audit entry for every join — including vanity-URL and unknown-source joins.

  Adds:
  - `team_invites.group_id` (nullable, `ON DELETE SET NULL`)
  - `teams.welcome_channel_id`, `teams.system_log_channel_id`, `teams.welcome_message_template`
  - `POST /teams/:teamId/invites` (`createInvite`) — multi-invite per team, optional group binding, expiry preset
  - `GET /teams/:teamId/invites` (`listInvitesForTeam`)
  - `POST /teams/:teamId/invites/:inviteId/deactivate` (`deactivateInvite`)
  - New shared package `@sideline/template-renderer` (pure, no Effect deps) — `applyTemplate`, `sanitizeRendered`, `sanitizeHexColor`
  - New web pages: team invites list + create-invite dialog with group picker, welcome-message card on team settings with live preview
  - Bot `InviteCache` service (per-guild Ref-based snapshot) + `InviteCreate`/`InviteDelete` event handlers + `GuildInvites` gateway intent

  `regenerateInvite` is kept as a deprecated alias delegating to `createInvite(None, +14d)` for one release; will be removed in a future minor. Native Discord Onboarding (Welcome Screen + rules-acknowledgement prompt) is deferred to a follow-up bug.

- [#260](https://github.com/maxa-ondrej/sideline/pull/260) [`40b33ef`](https://github.com/maxa-ondrej/sideline/commit/40b33ef26ec3a4d979e9022b1de0506965f037d0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Generate a fresh single-use Discord invite per invite acceptance instead of one shared, reusable invite per team_invite.

  Captains no longer see a "Copy Discord link" affordance — the only shareable link is `/invite/{code}` on the Sideline web. When a recipient clicks "Accept", the server records an `invite_acceptances` row, the bot creates a `max_uses: 1, max_age: 24h` Discord invite on the team's welcome channel within ~1s, and the web polls `GET /invite/acceptances/:acceptanceId` to redirect the user to a Discord URL that's bound to that one accept.

  Schema:
  - New `invite_acceptances(id, team_invite_id, user_id, discord_code, discord_code_error_code, discord_code_error_detail, created_at, generated_at)` with a unique partial index on `discord_code` and a pending-row index
  - `team_invites.discord_code` (and its indexes) dropped

  Server:
  - New `InviteAcceptancesRepository` with `create`, `findById`, `findPending`, `setDiscordCode`, `markFailed`, `findByDiscordCodeWithContext`
  - `joinViaInvite` returns `acceptanceId` instead of a Discord URL; new `getJoinStatus` endpoint exposes the URL once generated
  - `Guild/RegisterMember` welcome-meta lookup now resolves via `invite_acceptances.discord_code` so the welcome message still fires for the consumed code
  - Three replacement RPCs: `Invite/PendingAcceptances`, `Invite/SetAcceptanceDiscordCode`, `Invite/MarkAcceptanceFailed`

  Bot:
  - Invite-generator poll loop retargeted at acceptances; promoted to a 1s cadence so the user's wait after Accept stays short

  Web:
  - TeamInvitesPage: copy-Discord button and "generating…" placeholder removed
  - InvitePage: polls every 1.5s after accept; shows a "Preparing your Discord invite" state, an "Open Discord server" CTA when the URL arrives, or an error card if the bot reports a failure

### Patch Changes

- [#258](https://github.com/maxa-ondrej/sideline/pull/258) [`7422384`](https://github.com/maxa-ondrej/sideline/commit/7422384074804ae42f7ca4b6e4c4ca1d96801b3e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Recover gracefully when a user's Discord OAuth token is missing the `guilds.join` scope (e.g. anyone who logged in before PR #255). Previously these users silently failed the auto-join after accepting a web invite and there was no remediation path short of manual log-out / log-in.

  The fix is layered:
  1. **Detect at login** — the auth callback persists the granted scope list on `oauth_connections.granted_scopes` and, if `guilds.join` is missing, redirects the user back through Discord OAuth once (idempotent, gated on a `scopeRetry` flag in state).
  2. **Detect at join** — `joinViaInvite` checks the stored scopes. If the scope is missing it skips the `pending_guild_joins` enqueue and returns `requiresReauth: true`. The web invite page renders a "One more step — connect Discord access" CTA that re-enters the OAuth flow.
  3. **Retroactive requeue** — when the scope is newly granted on callback, prior `pending_guild_joins` rows that failed for this user are reset to `pending` so the bot picks them up on the next poll.

  Adds:
  - `oauth_connections.granted_scopes TEXT NOT NULL DEFAULT ''` (migration `1746800000`)
  - `Invite.JoinResult.requiresReauth: boolean`
  - `OAuthConnection` helpers: `parseScopes`, `hasScope`, `REQUIRED_DISCORD_SCOPE`
  - `OAuthConnectionsRepository.getGrantedScopes`; `PendingGuildJoinsRepository.requeueFailedForUser`

- Updated dependencies [[`bdc0b0e`](https://github.com/maxa-ondrej/sideline/commit/bdc0b0ed9bcf4de3ca463bf2331a7da931ac5a79), [`9af6d3c`](https://github.com/maxa-ondrej/sideline/commit/9af6d3c99b469f8d50f5fa18c868efc972085e18), [`7422384`](https://github.com/maxa-ondrej/sideline/commit/7422384074804ae42f7ca4b6e4c4ca1d96801b3e), [`40b33ef`](https://github.com/maxa-ondrej/sideline/commit/40b33ef26ec3a4d979e9022b1de0506965f037d0)]:
  - @sideline/domain@0.17.0
  - @sideline/i18n@0.3.17

## 0.10.7

### Patch Changes

- [#242](https://github.com/maxa-ondrej/sideline/pull/242) [`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix a crash that prevented creating or updating events and event series unless every optional field was filled in. The cross-field validation that links the new "location link" feature to the location text was reading internal Option markers without first checking that the field was present, which threw `TypeError: Cannot read properties of undefined (reading '_tag')` whenever the location link or location text was empty. The check now correctly evaluates each field's state and only rejects payloads that set a location link without a location text.

- Updated dependencies [[`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0)]:
  - @sideline/domain@0.16.3
  - @sideline/i18n@0.3.16

## 0.10.6

### Patch Changes

- [#240](https://github.com/maxa-ondrej/sideline/pull/240) [`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach an optional link to an event's location (e.g. Google Maps, venue page). The location text becomes a clickable link on the website and a markdown hyperlink in Discord posts.

- Updated dependencies [[`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2)]:
  - @sideline/domain@0.16.2
  - @sideline/i18n@0.3.15

## 0.10.5

### Patch Changes

- [#238](https://github.com/maxa-ondrej/sideline/pull/238) [`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach a cover image URL to events. Images appear on the event page and as a thumbnail in Discord posts.

- Updated dependencies [[`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c)]:
  - @sideline/domain@0.16.1
  - @sideline/i18n@0.3.14

## 0.10.4

### Patch Changes

- Updated dependencies [[`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5)]:
  - @sideline/domain@0.16.0
  - @sideline/i18n@0.3.13

## 0.10.3

### Patch Changes

- [#232](https://github.com/maxa-ondrej/sideline/pull/232) [`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the reminders feature: configurable reminder time and timezone (per-team), dedicated reminders channel, member-group-aware audience and role mentions, and a new "Starting now" announcement when an event begins.

  Team settings now expose `rsvpReminderDaysBefore`, `rsvpReminderTime` (HH:MM, capped at 23:54 to avoid midnight wrap), `timezone` (any IANA zone, default `Europe/Prague`), and `remindersChannelId`. Reminders fire at the configured time in the team's timezone with a 5-minute tolerance window. The reminder embed and the new "Starting now" post target the reminders channel (falling back to the owner-group channel, then the guild's system channel) and mention the event's member-group role. The reminder's "Going" and "Not yet responded" lists are filtered to the member group when one is set.

- [#227](https://github.com/maxa-ondrej/sideline/pull/227) [`13f887c`](https://github.com/maxa-ondrej/sideline/commit/13f887ced827ab2425a279da00281b183c15a1ea) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Documentation and Report a bug links to the user menu in the web navigation sidebar. Both open in a new tab: Documentation points to the hosted Starlight docs, Report a bug opens a fresh GitHub issue.

- Updated dependencies [[`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71), [`13f887c`](https://github.com/maxa-ondrej/sideline/commit/13f887ced827ab2425a279da00281b183c15a1ea)]:
  - @sideline/domain@0.15.6
  - @sideline/i18n@0.3.12

## 0.10.2

### Patch Changes

- [#197](https://github.com/maxa-ondrej/sideline/pull/197) [`19d94f2`](https://github.com/maxa-ondrej/sideline/commit/19d94f2bb999bd6465b2a41955d7cae1a2dc7135) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP confirmation step on web — clicking Yes/No/Maybe now immediately submits the response, matching the Discord bot behavior

- [#202](https://github.com/maxa-ondrej/sideline/pull/202) [`b669fed`](https://github.com/maxa-ondrej/sideline/commit/b669fedf293e95575e8488f91687ae94a24ce5a0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show attendees list on web even after event has started — the RSVP panel now remains visible for started events (with RSVP buttons hidden)

- Updated dependencies [[`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9), [`19d94f2`](https://github.com/maxa-ondrej/sideline/commit/19d94f2bb999bd6465b2a41955d7cae1a2dc7135), [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38), [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7)]:
  - @sideline/domain@0.15.3
  - @sideline/i18n@0.3.10

## 0.10.1

### Patch Changes

- [#189](https://github.com/maxa-ondrej/sideline/pull/189) [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP buttons from Discord event messages after an event starts and mark events as started via a new cron job.

- [#190](https://github.com/maxa-ondrej/sideline/pull/190) [`e62b7c8`](https://github.com/maxa-ondrej/sideline/commit/e62b7c83223ae2dd7790f62f47bab8262769d02f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix "Invalid date" crash on training type detail page caused by PostgreSQL TIME columns returning HH:mm:ss format, which broke utcTimeToLocal when it appended :00Z.

- [#188](https://github.com/maxa-ondrej/sideline/pull/188) [`12fb74d`](https://github.com/maxa-ondrej/sideline/commit/12fb74d22d5c0c118dc803bc6cbbdfd3faeb9271) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add searchable select component with search filtering and alphabetical sorting to all dynamic select boxes (channels, groups, members, roles, training types) across the web app.

- Updated dependencies [[`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c), [`16192c7`](https://github.com/maxa-ondrej/sideline/commit/16192c762bbef950c6eb587a74c5925cec954cf3), [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41), [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83), [`12fb74d`](https://github.com/maxa-ondrej/sideline/commit/12fb74d22d5c0c118dc803bc6cbbdfd3faeb9271)]:
  - @sideline/domain@0.15.2
  - @sideline/i18n@0.3.9

## 0.10.0

### Minor Changes

- [#178](https://github.com/maxa-ondrej/sideline/pull/178) [`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add late RSVP notifications: when a member responds after the reminder is sent, post a notification to a configurable team channel and show a polite hint in the RSVP confirmation. Also include the list of yes attendees in the reminder embed.

### Patch Changes

- [#180](https://github.com/maxa-ondrej/sideline/pull/180) [`0bd7e64`](https://github.com/maxa-ondrej/sideline/commit/0bd7e64c932b435ca0afdc052b5e9a2aa2451304) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix event series time display and storage: convert local times to UTC on submit and UTC back to local on display/edit.

- Updated dependencies [[`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54)]:
  - @sideline/domain@0.15.0
  - @sideline/i18n@0.3.7

## 0.9.4

### Patch Changes

- [`ecdebf6`](https://github.com/maxa-ondrej/sideline/commit/ecdebf6dbac861b9ddb133ab6f1bba54ebc79b96) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redirect to home page when the last saved team no longer exists instead of navigating to a 404

## 0.9.3

### Patch Changes

- [`a5b5aea`](https://github.com/maxa-ondrej/sideline/commit/a5b5aea8aecab3f572a92d6c64ce929861983bc9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redirect to home page after completing profile instead of prompting to create a team

## 0.9.2

### Patch Changes

- [#153](https://github.com/maxa-ondrej/sideline/pull/153) [`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add 3-mode Discord channel cleanup (nothing, delete, archive) with separate settings for groups and rosters

- [#150](https://github.com/maxa-ondrej/sideline/pull/150) [`2820c4a`](https://github.com/maxa-ondrej/sideline/commit/2820c4ad2d2773aee3240c98ef7adc508851d680) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix calendar components to use the app's selected language instead of browser locale

- [#168](https://github.com/maxa-ondrej/sideline/pull/168) [`2284bea`](https://github.com/maxa-ondrej/sideline/commit/2284bea83d34f7f93768457ca401fc45dfe6d4e2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Display Discord channels as clickable links that open the actual channel in Discord

- [#154](https://github.com/maxa-ondrej/sideline/pull/154) [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel/role name format templates to team settings

- [#169](https://github.com/maxa-ondrej/sideline/pull/169) [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add color and emoji support to groups and rosters with Discord role sync

- [#149](https://github.com/maxa-ondrej/sideline/pull/149) [`34785f7`](https://github.com/maxa-ondrej/sideline/commit/34785f7d59bdf4116e70ca8f0cbc4991564cab25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Open Graph and Twitter Card meta tags for rich link preview embeds on Discord, Slack, Twitter, and other platforms

- [#152](https://github.com/maxa-ondrej/sideline/pull/152) [`c2c0b8a`](https://github.com/maxa-ondrej/sideline/commit/c2c0b8a6ce767f1238c164cbf3725744160bc774) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redesign profile editing page to match profile complete page UI with card-based centered layout

- [#146](https://github.com/maxa-ondrej/sideline/pull/146) [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord channel linking to rosters with auto-creation, role management, and web UI

- Updated dependencies [[`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db), [`2284bea`](https://github.com/maxa-ondrej/sideline/commit/2284bea83d34f7f93768457ca401fc45dfe6d4e2), [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a), [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d), [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170)]:
  - @sideline/domain@0.14.3
  - @sideline/i18n@0.3.5

## 0.9.1

### Patch Changes

- [#140](https://github.com/maxa-ondrej/sideline/pull/140) [`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team setting to control whether Discord channels are auto-created for new groups

- [#141](https://github.com/maxa-ondrej/sideline/pull/141) [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix incorrect permissions: add group:manage permission, gate nav items by role, fix avatar rendering and drawer padding

- [#136](https://github.com/maxa-ondrej/sideline/pull/136) [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add comprehensive observability with tracing spans, metrics (HTTP, cron, Discord, sync, RSVP), and improve error handling with explicit catchTag patterns and descriptive LogicError messages

- [#144](https://github.com/maxa-ondrej/sideline/pull/144) [`126d784`](https://github.com/maxa-ondrej/sideline/commit/126d7848dd926d5ae8f285cdff335a9af6f56d0d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add owner group authorization for training type event creation and enhance list page with group selectors

- Updated dependencies [[`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0), [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78)]:
  - @sideline/domain@0.14.2
  - @sideline/i18n@0.3.4

## 0.9.0

### Minor Changes

- [#128](https://github.com/maxa-ondrej/sideline/pull/128) [`b629285`](https://github.com/maxa-ondrej/sideline/commit/b629285a4bfa1e7ff277f5257045bbaf6196148e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve website design: dark mode toggle, sidebar sections, hero page, RSVP side panel, leaderboard redesign, workout layout, team logo in switcher, and calendar subscription consistency

### Patch Changes

- [#131](https://github.com/maxa-ondrej/sideline/pull/131) [`0d1567e`](https://github.com/maxa-ondrej/sideline/commit/0d1567eb18fd472e24bc40ac01238c8c6395a983) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Auto-join users to existing teams matching their Discord guilds after profile completion

- [#130](https://github.com/maxa-ondrej/sideline/pull/130) [`d689595`](https://github.com/maxa-ondrej/sideline/commit/d6895955ebb2f1a8de72fdf6d18e9035ee022eee) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add success toast notifications to all user actions and fix runtime to decouple loading/success toasts

- Updated dependencies [[`0d1567e`](https://github.com/maxa-ondrej/sideline/commit/0d1567eb18fd472e24bc40ac01238c8c6395a983), [`d689595`](https://github.com/maxa-ondrej/sideline/commit/d6895955ebb2f1a8de72fdf6d18e9035ee022eee), [`b629285`](https://github.com/maxa-ondrej/sideline/commit/b629285a4bfa1e7ff277f5257045bbaf6196148e)]:
  - @sideline/domain@0.14.1
  - @sideline/i18n@0.3.3

## 0.8.0

### Minor Changes

- [#125](https://github.com/maxa-ondrej/sideline/pull/125) [`4a471dc`](https://github.com/maxa-ondrej/sideline/commit/4a471dc4bc0000168c25fef000ded1ecfd11fd09) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add responsive design and PWA support for mobile devices. Auto-close sidebar on navigation, sticky header, responsive table-to-card layouts, touch target optimization, PWA manifest with service worker, and install prompt.

- [#123](https://github.com/maxa-ondrej/sideline/pull/123) [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team profile settings (name, description, sport, logo URL) with new API endpoints, card-based settings page, and Discord channel configuration UI improvements

### Patch Changes

- Updated dependencies [[`4a471dc`](https://github.com/maxa-ondrej/sideline/commit/4a471dc4bc0000168c25fef000ded1ecfd11fd09), [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0)]:
  - @sideline/i18n@0.3.2
  - @sideline/domain@0.14.0

## 0.7.0

### Minor Changes

- [#121](https://github.com/maxa-ondrej/sideline/pull/121) [`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team leaderboard with activity rankings, streaks, web page, and Discord command

- [#122](https://github.com/maxa-ondrej/sideline/pull/122) [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add personalized dashboard as the team home page with upcoming events, awaiting RSVP, activity summary, and team management widgets

### Patch Changes

- Updated dependencies [[`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5), [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136)]:
  - @sideline/domain@0.13.0
  - @sideline/i18n@0.3.1

## 0.6.0

### Minor Changes

- [#117](https://github.com/maxa-ondrej/sideline/pull/117) [`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace hardcoded activity types with a global activity_types table, auto-track training attendance via cron after events end, and switch stats to dynamic counts

- [#116](https://github.com/maxa-ondrej/sideline/pull/116) [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via web app with quick-log widget, history page, and edit/delete support

- [#115](https://github.com/maxa-ondrej/sideline/pull/115) [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player activity streaks and stats — streak calculation, /makanicko stats Discord command, web profile stats card, and HTTP API endpoint

### Patch Changes

- [#112](https://github.com/maxa-ondrej/sideline/pull/112) [`cfd11e4`](https://github.com/maxa-ondrej/sideline/commit/cfd11e4c639f69d0bffb9fb432edb2478f28f627) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix timezone mismatch between web and Discord by using browser local timezone for event datetime input and display instead of raw UTC

- Updated dependencies [[`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a), [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49), [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1), [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2), [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652)]:
  - @sideline/domain@0.12.0
  - @sideline/i18n@0.3.0

## 0.5.0

### Minor Changes

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add owner/member group assignment to events, event series, and training types for group-based access control and visibility

### Patch Changes

- [#101](https://github.com/maxa-ondrej/sideline/pull/101) [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Hide UI elements from users without required permissions (role and roster management buttons, admin sidebar links, events page for non-admins)

- Updated dependencies [[`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d), [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017), [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570)]:
  - @sideline/domain@0.11.0
  - @sideline/i18n@0.2.1

## 0.4.0

### Minor Changes

- [#98](https://github.com/maxa-ondrej/sideline/pull/98) [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add iCal subscription feature allowing players to subscribe to team events via webcal URL in Google Calendar, Apple Calendar, and Outlook

### Patch Changes

- [#88](https://github.com/maxa-ondrej/sideline/pull/88) [`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add client-side age validation with localized error message and preselect birth year to 18 years ago in date picker

- [#94](https://github.com/maxa-ondrej/sideline/pull/94) [`3c51350`](https://github.com/maxa-ondrej/sideline/commit/3c51350f4f069f12241369ffe027471079c3b7f6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Set calendar date picker week start to Monday

- [#91](https://github.com/maxa-ondrej/sideline/pull/91) [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace plain string dates with proper DateTime.Utc types throughout the stack

- [#92](https://github.com/maxa-ondrej/sideline/pull/92) [`fe5c2ac`](https://github.com/maxa-ondrej/sideline/commit/fe5c2ac0acd4b9d3ad39baf7961e2127373a6d47) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Disable name editing for built-in roles to prevent rejected save attempts

- [#93](https://github.com/maxa-ondrej/sideline/pull/93) [`7fe506e`](https://github.com/maxa-ondrej/sideline/commit/7fe506e367762bd084ca1d5c7d8604b48efd5c62) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Move Save changes button to bottom of team settings page so it clearly applies to all fields

- [#89](https://github.com/maxa-ondrej/sideline/pull/89) [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord.Snowflake branded type across the entire stack, remove catchAll on unfailable effects, and refactor repository methods to use destructuring with default values

- [#84](https://github.com/maxa-ondrej/sideline/pull/84) [`b1d7909`](https://github.com/maxa-ondrej/sideline/commit/b1d79090d6d9b001f6fe2b60341c7862c709be91) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve client error handling with loading/success/error toast transitions, rich colors, close button, and top-right positioning

- Updated dependencies [[`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788), [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25), [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6), [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215), [`3b16731`](https://github.com/maxa-ondrej/sideline/commit/3b1673170ea6bb9b44b298fc3566415f016ea654), [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc), [`0230c98`](https://github.com/maxa-ondrej/sideline/commit/0230c98db317f20800485a0ad758020236ff2f77), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a), [`381d85d`](https://github.com/maxa-ondrej/sideline/commit/381d85d6f47deb87f68bcebd5a266e0f29bb71f3), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a)]:
  - @sideline/i18n@0.2.0
  - @sideline/domain@0.10.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34), [`f21c610`](https://github.com/maxa-ondrej/sideline/commit/f21c61061b8b67faa87a2cadfec3f728603cae1f), [`f71d644`](https://github.com/maxa-ondrej/sideline/commit/f71d644aff2f4d181986b1510467577adb14fadc), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f)]:
  - @sideline/domain@0.9.0
  - @sideline/i18n@0.1.2

## 0.3.0

### Minor Changes

- [#73](https://github.com/maxa-ondrej/sideline/pull/73) [`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rename discord_username/discord_avatar to username/avatar across the codebase and fix RSVP member name display to fall back to username

### Patch Changes

- Updated dependencies [[`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645)]:
  - @sideline/domain@0.8.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`ca6db57`](https://github.com/maxa-ondrej/sideline/commit/ca6db57efc94442f6a690322ea1ae52355e1d903)]:
  - @sideline/i18n@0.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e)]:
  - @sideline/domain@0.7.0

## 0.2.0

### Minor Changes

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel targeting for events at three levels: per-event/series, per-training-type default, and per-event-type in team settings

### Patch Changes

- [#53](https://github.com/maxa-ondrej/sideline/pull/53) [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add edit UI for recurring schedules and change event ordering to ascending

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP feature for team events — players can respond Yes/No/Maybe with optional message via web app

- Updated dependencies [[`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f)]:
  - @sideline/domain@0.6.0

## 0.1.9

### Patch Changes

- [`90b50bb`](https://github.com/maxa-ondrej/sideline/commit/90b50bbf8317901cedaa7cda8216ecef12be9acc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Patch bump all applications

## 0.1.8

### Patch Changes

- Updated dependencies [[`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`74544b4`](https://github.com/maxa-ondrej/sideline/commit/74544b4ede8dde9539bcb5c76c25afda279d883b)]:
  - @sideline/domain@0.5.0

## 0.1.7

### Patch Changes

- Updated dependencies [[`3a2daa7`](https://github.com/maxa-ondrej/sideline/commit/3a2daa77509b9a1066c48b78e94697db7609e3d6), [`eb7fdf3`](https://github.com/maxa-ondrej/sideline/commit/eb7fdf3c4607770baf78df856f450f5f303fdc9f), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`0c98f29`](https://github.com/maxa-ondrej/sideline/commit/0c98f291ee6168e73077feec4cdbc89f0ccdfd3f)]:
  - @sideline/domain@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9)]:
  - @sideline/domain@0.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`780bca9`](https://github.com/maxa-ondrej/sideline/commit/780bca9d0300030fafd76edc3efd81e5f7a6f88d), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`e8fd1ab`](https://github.com/maxa-ondrej/sideline/commit/e8fd1ab2e0b47aa37fa6ed58e01572d25f90e64d)]:
  - @sideline/domain@0.2.0

## 0.1.4

### Patch Changes

- [`894c836`](https://github.com/maxa-ondrej/sideline/commit/894c836d65dc885a94d25d4f280c04c74b4866d0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Simplify version extraction in Docker release workflow

## 0.1.3

### Patch Changes

- [`79f2e9e`](https://github.com/maxa-ondrej/sideline/commit/79f2e9e7271e5ab82acdcff1b72f2e2a3b77f59f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix Docker build: add BuildKit setup and version-based image tags

## 0.1.2

### Patch Changes

- [`e1389ba`](https://github.com/maxa-ondrej/sideline/commit/e1389ba855a70a285581639d349908570456659c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Build and push Docker images for changed applications as part of the release workflow

## 0.1.1

### Patch Changes

- [`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enable changesets versioning and tagging for private application packages

- Updated dependencies [[`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b)]:
  - @sideline/domain@0.1.1
