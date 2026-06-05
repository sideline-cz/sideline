# @sideline/effect-lib

## 0.0.8

### Patch Changes

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

## 0.0.7

### Patch Changes

- [#136](https://github.com/maxa-ondrej/sideline/pull/136) [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add comprehensive observability with tracing spans, metrics (HTTP, cron, Discord, sync, RSVP), and improve error handling with explicit catchTag patterns and descriptive LogicError messages

## 0.0.6

### Patch Changes

- [#119](https://github.com/maxa-ondrej/sideline/pull/119) [`c8db130`](https://github.com/maxa-ondrej/sideline/commit/c8db13047b962c021f18aa04941b2d6298f73cf2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add OpenTelemetry monitoring support via @effect/opentelemetry Otlp module for traces, metrics, and logs export to SigNoz

## 0.0.5

### Patch Changes

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove inline event embed update from RSVP handler (now handled by event channel routing) and add Option toEffect utility

## 0.0.4

### Patch Changes

- [#91](https://github.com/maxa-ondrej/sideline/pull/91) [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace plain string dates with proper DateTime.Utc types throughout the stack

- [#81](https://github.com/maxa-ondrej/sideline/pull/81) [`e9809ab`](https://github.com/maxa-ondrej/sideline/commit/e9809ab5ee687de7db088da83a06dce0790adec2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add LOG_LEVEL environment variable to override default log levels

- [#83](https://github.com/maxa-ondrej/sideline/pull/83) [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add typed business errors for unique constraint violations in repositories

## 0.0.3

### Patch Changes

- [#54](https://github.com/maxa-ondrej/sideline/pull/54) [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor event date/time from separate columns to TIMESTAMPTZ and extract DateTimeFromDate schema to effect-lib

## 0.0.2

### Patch Changes

- [#21](https://github.com/maxa-ondrej/sideline/pull/21) [`fa51b42`](https://github.com/maxa-ondrej/sideline/commit/fa51b42bab5144cc6027a9fafbc5e8b75271df90) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Standardize TypeScript imports to use `~` alias for `src/` and root-only package imports

## 0.0.1

### Patch Changes

- [`8505070`](https://github.com/maxa-ondrej/sideline/commit/850507079ac8e4a9846a34fc365b2c2714ecfa5b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enable changesets versioning and tagging for private application packages
