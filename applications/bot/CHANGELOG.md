# @sideline/bot

## 0.11.6

### Patch Changes

- [#253](https://github.com/maxa-ondrej/sideline/pull/253) [`152bfb7`](https://github.com/maxa-ondrej/sideline/commit/152bfb74bb39112e71a3dda2cb0eeaebd6c5db59) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix `reorderChannelMessages` corruption that wrote event A's content into event B's Discord message and persisted the wrong `discord_message_id`. Replaced the zip-and-edit strategy with a longest strictly-increasing tail-dominating prefix algorithm: keep prefix entries whose snowflakes already form a valid display order, recreate the suffix in display order so new snowflakes increase monotonically. Added a startup healing pass via bulk `listMessages` that detects missing Discord messages and forces their entries into the recreate set. Added an in-process `Effect.Semaphore` registry per channel ID to serialise concurrent reorders. Capped channel events at 10, with cap-dropped Discord messages cleaned up. Refactored `editMessage` to surface a typed `EditOutcome = 'edited' | 'message_gone'` instead of self-healing 10008 inline.

## 0.11.5

### Patch Changes

- [#246](https://github.com/maxa-ondrej/sideline/pull/246) [`3c63376`](https://github.com/maxa-ondrej/sideline/commit/3c633763b8d7d1db4c474c6786f44d2de68b1057) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - When an event starts, push the original embed up into the past section and apply the started color/banner consistently. Also recover from messages that have been deleted in Discord — `editMessage` and `handleStarted`'s in-place edit fall back to creating a new message and saving the new ID, and the bot runs a one-time scan on connect to recreate any messages that went missing while it was offline.

- Updated dependencies [[`3c63376`](https://github.com/maxa-ondrej/sideline/commit/3c633763b8d7d1db4c474c6786f44d2de68b1057)]:
  - @sideline/domain@0.16.5

## 0.11.4

### Patch Changes

- [#244](https://github.com/maxa-ondrej/sideline/pull/244) [`b5ddcc9`](https://github.com/maxa-ondrej/sideline/commit/b5ddcc974359ff7e505e11e652fdcf0a57f0e88f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Render the claimer of a training in the Discord claim-message embed using the same `**Name** (<@discord-id>)` formatter that already powers the events RSVP attendees embed, so claimers now appear with their Discord mention instead of just a plain display name. Identity is resolved at read-time via a join in the sync-event outbox, with a fallback to the snapshotted display name for orphaned rows — no database migration required.

- Updated dependencies [[`b5ddcc9`](https://github.com/maxa-ondrej/sideline/commit/b5ddcc974359ff7e505e11e652fdcf0a57f0e88f)]:
  - @sideline/domain@0.16.4

## 0.11.3

### Patch Changes

- [#242](https://github.com/maxa-ondrej/sideline/pull/242) [`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix a crash that prevented creating or updating events and event series unless every optional field was filled in. The cross-field validation that links the new "location link" feature to the location text was reading internal Option markers without first checking that the field was present, which threw `TypeError: Cannot read properties of undefined (reading '_tag')` whenever the location link or location text was empty. The check now correctly evaluates each field's state and only rejects payloads that set a location link without a location text.

- Updated dependencies [[`4ee7b70`](https://github.com/maxa-ondrej/sideline/commit/4ee7b7029c76a3a17e19bc902a7284aea076f5b0)]:
  - @sideline/domain@0.16.3
  - @sideline/i18n@0.3.16

## 0.11.2

### Patch Changes

- [#240](https://github.com/maxa-ondrej/sideline/pull/240) [`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach an optional link to an event's location (e.g. Google Maps, venue page). The location text becomes a clickable link on the website and a markdown hyperlink in Discord posts.

- Updated dependencies [[`57cde28`](https://github.com/maxa-ondrej/sideline/commit/57cde28ef0095cc6b309ab3316967f859cd6b1f2)]:
  - @sideline/domain@0.16.2
  - @sideline/i18n@0.3.15

## 0.11.1

### Patch Changes

- [#238](https://github.com/maxa-ondrej/sideline/pull/238) [`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - You can now attach a cover image URL to events. Images appear on the event page and as a thumbnail in Discord posts.

- Updated dependencies [[`2e53d6a`](https://github.com/maxa-ondrej/sideline/commit/2e53d6a4b2a40f222efee89e9a204a66bf33fc4c)]:
  - @sideline/domain@0.16.1
  - @sideline/i18n@0.3.14

## 0.11.0

### Minor Changes

- [#236](https://github.com/maxa-ondrej/sideline/pull/236) [`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - feat: add coach claim training feature

  Coaches can now volunteer to organize trainings via a dedicated Discord message posted to the owners group's channel. The message contains a Claim button that toggles to Release once claimed, and the regular reminder cron also posts a "still no coach" reminder when a training stays unclaimed at reminder time.

### Patch Changes

- [#234](https://github.com/maxa-ondrej/sideline/pull/234) [`62db409`](https://github.com/maxa-ondrej/sideline/commit/62db409f482d724157dbab513171b41fa7259248) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - fix: drop member-group role mention from RSVP reminder posts

- Updated dependencies [[`cb91dc7`](https://github.com/maxa-ondrej/sideline/commit/cb91dc72b9f471511d96ac5604e086a60f4193f5)]:
  - @sideline/domain@0.16.0
  - @sideline/i18n@0.3.13

## 0.10.8

### Patch Changes

- [#232](https://github.com/maxa-ondrej/sideline/pull/232) [`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Improve the reminders feature: configurable reminder time and timezone (per-team), dedicated reminders channel, member-group-aware audience and role mentions, and a new "Starting now" announcement when an event begins.

  Team settings now expose `rsvpReminderDaysBefore`, `rsvpReminderTime` (HH:MM, capped at 23:54 to avoid midnight wrap), `timezone` (any IANA zone, default `Europe/Prague`), and `remindersChannelId`. Reminders fire at the configured time in the team's timezone with a 5-minute tolerance window. The reminder embed and the new "Starting now" post target the reminders channel (falling back to the owner-group channel, then the guild's system channel) and mention the event's member-group role. The reminder's "Going" and "Not yet responded" lists are filtered to the member group when one is set.

- Updated dependencies [[`ee68d21`](https://github.com/maxa-ondrej/sideline/commit/ee68d215ab1a26accc771119c3249b99aa6c9c71), [`13f887c`](https://github.com/maxa-ondrej/sideline/commit/13f887ced827ab2425a279da00281b183c15a1ea)]:
  - @sideline/domain@0.15.6
  - @sideline/i18n@0.3.12

## 0.10.7

### Patch Changes

- [#216](https://github.com/maxa-ondrej/sideline/pull/216) [`8c98ef5`](https://github.com/maxa-ondrej/sideline/commit/8c98ef5f0d7ed231eb8e57dec9400521211e3e24) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extract shared `formatName` helper for attendee display names

- [#221](https://github.com/maxa-ondrej/sideline/pull/221) [`efca9d7`](https://github.com/maxa-ondrej/sideline/commit/efca9d7556dac7e05fc19d2255b76788c1ed8700) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord display name to the name fallback chain in formatName

- [`1fb9223`](https://github.com/maxa-ondrej/sideline/commit/1fb92239f66c1205710133f38a031790dc838d52) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Paginate RSVP reminder attendee and non-responder lists across multiple embed fields

  Previously the reminder message failed for large teams because the non-responder list exceeded Discord's 1024-character embed field limit, causing every reminder to be rejected with `BASE_TYPE_MAX_LENGTH`. The previous fix truncated the list with "…and N more"; this replaces that with full pagination: names are split across as many consecutive embed fields as needed so all members are always shown.

- [#222](https://github.com/maxa-ondrej/sideline/pull/222) [`f235bf5`](https://github.com/maxa-ondrej/sideline/commit/f235bf5c181ec88cdcd923aca1d71edba46d6a3b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show Discord mentions alongside names in RSVP reminder messages and the late-RSVP channel
  - RSVP reminder embeds now render attendees as `**Name** (<@id>)` instead of `**Name**` alone, matching the format used in the attendees list.
  - Late-RSVP notifications (posted to the channel configured via `discord_channel_late_rsvp` after the reminder is sent) also now include the user's name alongside the mention, sourced from the new name fields on `SubmitRsvpResult`.
  - Reminder attendee lists now truncate with a localised "…and N more" suffix when the joined text would exceed Discord's 1024-character embed-field limit, preventing `createMessage` from failing for large teams.
  - Closes a related edge case in the attendees list where a user with only `display_name` (no name/nickname/username) would render as mention-only.

- Updated dependencies [[`efca9d7`](https://github.com/maxa-ondrej/sideline/commit/efca9d7556dac7e05fc19d2255b76788c1ed8700), [`f235bf5`](https://github.com/maxa-ondrej/sideline/commit/f235bf5c181ec88cdcd923aca1d71edba46d6a3b)]:
  - @sideline/domain@0.15.5
  - @sideline/i18n@0.3.11

## 0.10.6

### Patch Changes

- [`8833ee2`](https://github.com/maxa-ondrej/sideline/commit/8833ee2c58481b1801da0bb5fcd213d4d8c38eff) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Restore Discord mentions alongside names in attendees list

## 0.10.5

### Patch Changes

- [#206](https://github.com/maxa-ondrej/sideline/pull/206) [`d99385d`](https://github.com/maxa-ondrej/sideline/commit/d99385d26b7a112f8c632cb020b37de48f4cc9ad) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Store Discord server nickname and use name display priority: DB name → server nickname → username

- Updated dependencies [[`d99385d`](https://github.com/maxa-ondrej/sideline/commit/d99385d26b7a112f8c632cb020b37de48f4cc9ad)]:
  - @sideline/domain@0.15.4

## 0.10.4

### Patch Changes

- [#204](https://github.com/maxa-ondrej/sideline/pull/204) [`2c66246`](https://github.com/maxa-ondrej/sideline/commit/2c66246b2ee985a7fea2a40a2762367a7d928336) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send ephemeral event messages sequentially to preserve chronological order

## 0.10.3

### Patch Changes

- [#199](https://github.com/maxa-ondrej/sideline/pull/199) [`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix unreliable Discord mentions on mobile by showing bold names as primary display instead of @mentions in event embeds, attendees lists, and RSVP reminders. Add /event pending subcommand to list events awaiting the user's RSVP.

- [#203](https://github.com/maxa-ondrej/sideline/pull/203) [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Redesign /event upcoming to show one full event embed per page with per-user RSVP status. Add /event overview command for persistent channel button. Remove /event pending.

- [#195](https://github.com/maxa-ondrej/sideline/pull/195) [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder attendance channel messages so the nearest upcoming event is the last (most visible) message, and add a divider between past and future events

- Updated dependencies [[`b64c794`](https://github.com/maxa-ondrej/sideline/commit/b64c794005a3249889ea374f4ef13e9419fea6a9), [`19d94f2`](https://github.com/maxa-ondrej/sideline/commit/19d94f2bb999bd6465b2a41955d7cae1a2dc7135), [`d2d3eb6`](https://github.com/maxa-ondrej/sideline/commit/d2d3eb666c115009d1d24d1d4c80071633ba2e38), [`0704c17`](https://github.com/maxa-ondrej/sideline/commit/0704c17897ced04f67ee10a7ed65cd0ec51f74d7)]:
  - @sideline/domain@0.15.3
  - @sideline/i18n@0.3.10

## 0.10.2

### Patch Changes

- [#193](https://github.com/maxa-ondrej/sideline/pull/193) [`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Notify server when Discord channels are created, updated, or deleted so the internal channel list stays in sync.

- [#191](https://github.com/maxa-ondrej/sideline/pull/191) [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix newly created Discord channels not showing their name on the web by upserting the channel into the discord_channels table immediately after creation.

- [#189](https://github.com/maxa-ondrej/sideline/pull/189) [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove RSVP buttons from Discord event messages after an event starts and mark events as started via a new cron job.

- Updated dependencies [[`9e6a3ea`](https://github.com/maxa-ondrej/sideline/commit/9e6a3ea57fffc2207ef32f2594476f437566771c), [`16192c7`](https://github.com/maxa-ondrej/sideline/commit/16192c762bbef950c6eb587a74c5925cec954cf3), [`c0ec370`](https://github.com/maxa-ondrej/sideline/commit/c0ec3701d6b72c2a0dbba3d216041fd4f1342f41), [`bfbc107`](https://github.com/maxa-ondrej/sideline/commit/bfbc107dae79520fc5801792b5aede8f05ed4e83), [`12fb74d`](https://github.com/maxa-ondrej/sideline/commit/12fb74d22d5c0c118dc803bc6cbbdfd3faeb9271)]:
  - @sideline/domain@0.15.2
  - @sideline/i18n@0.3.9

## 0.10.1

### Patch Changes

- [#182](https://github.com/maxa-ondrej/sideline/pull/182) [`a5c51c1`](https://github.com/maxa-ondrej/sideline/commit/a5c51c1885911f23c41e77e6a3244b950f5380fc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - RSVP now saves immediately on button click. Ephemeral confirmation shows "Add a message" button (or "Edit message" + "Clear message" if a message already exists). Message is preserved when re-clicking the same RSVP button.

- Updated dependencies [[`a5c51c1`](https://github.com/maxa-ondrej/sideline/commit/a5c51c1885911f23c41e77e6a3244b950f5380fc)]:
  - @sideline/domain@0.15.1
  - @sideline/i18n@0.3.8

## 0.10.0

### Minor Changes

- [#178](https://github.com/maxa-ondrej/sideline/pull/178) [`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add late RSVP notifications: when a member responds after the reminder is sent, post a notification to a configurable team channel and show a polite hint in the RSVP confirmation. Also include the list of yes attendees in the reminder embed.

### Patch Changes

- Updated dependencies [[`24174e9`](https://github.com/maxa-ondrej/sideline/commit/24174e90b31d73c8bf5f5181a087a41c3289ae54)]:
  - @sideline/domain@0.15.0
  - @sideline/i18n@0.3.7

## 0.9.5

### Patch Changes

- [`e62e1d4`](https://github.com/maxa-ondrej/sideline/commit/e62e1d4ca51fb24c5bb0bd6c26885dca1739edff) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Increase the event embed yes attendees display limit from 10 to 20

## 0.9.4

### Patch Changes

- [`cc742d8`](https://github.com/maxa-ondrej/sideline/commit/cc742d8f5ae355e7485593255629b5fada51bda0) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Show a list of yes attendees on RSVP event embeds

- Updated dependencies [[`cc742d8`](https://github.com/maxa-ondrej/sideline/commit/cc742d8f5ae355e7485593255629b5fada51bda0)]:
  - @sideline/domain@0.14.4
  - @sideline/i18n@0.3.6

## 0.9.3

### Patch Changes

- [#153](https://github.com/maxa-ondrej/sideline/pull/153) [`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add 3-mode Discord channel cleanup (nothing, delete, archive) with separate settings for groups and rosters

- [#154](https://github.com/maxa-ondrej/sideline/pull/154) [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel/role name format templates to team settings

- [#169](https://github.com/maxa-ondrej/sideline/pull/169) [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add color and emoji support to groups and rosters with Discord role sync

- [#146](https://github.com/maxa-ondrej/sideline/pull/146) [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add discord channel linking to rosters with auto-creation, role management, and web UI

- Updated dependencies [[`690c5c0`](https://github.com/maxa-ondrej/sideline/commit/690c5c0be363ef1461e74a20ad0545ba140282db), [`2284bea`](https://github.com/maxa-ondrej/sideline/commit/2284bea83d34f7f93768457ca401fc45dfe6d4e2), [`883189a`](https://github.com/maxa-ondrej/sideline/commit/883189a4c56c2da0c2dcf92544bb72445bbc343a), [`1e8def9`](https://github.com/maxa-ondrej/sideline/commit/1e8def9790e7b31c9eb15faf81c71641d69e9d2d), [`b871b3c`](https://github.com/maxa-ondrej/sideline/commit/b871b3c3def2b9eb2397a2072e88eb99d9c87170)]:
  - @sideline/domain@0.14.3
  - @sideline/i18n@0.3.5

## 0.9.2

### Patch Changes

- [#136](https://github.com/maxa-ondrej/sideline/pull/136) [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add comprehensive observability with tracing spans, metrics (HTTP, cron, Discord, sync, RSVP), and improve error handling with explicit catchTag patterns and descriptive LogicError messages

- Updated dependencies [[`247fa44`](https://github.com/maxa-ondrej/sideline/commit/247fa444ad52fc44796e54ac9231a73221c29ff0), [`e4f8969`](https://github.com/maxa-ondrej/sideline/commit/e4f8969bcaf1278169e6e5a6aa2b3af49701ec78), [`dc1ed99`](https://github.com/maxa-ondrej/sideline/commit/dc1ed99d334839bddf17636b48e525b665321a18)]:
  - @sideline/domain@0.14.2
  - @sideline/i18n@0.3.4
  - @sideline/effect-lib@0.0.7

## 0.9.1

### Patch Changes

- Updated dependencies [[`4a471dc`](https://github.com/maxa-ondrej/sideline/commit/4a471dc4bc0000168c25fef000ded1ecfd11fd09), [`8d97865`](https://github.com/maxa-ondrej/sideline/commit/8d978654612cab81032e51a3e602ddcf07918ac0)]:
  - @sideline/i18n@0.3.2
  - @sideline/domain@0.14.0

## 0.9.0

### Minor Changes

- [#121](https://github.com/maxa-ondrej/sideline/pull/121) [`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add team leaderboard with activity rankings, streaks, web page, and Discord command

### Patch Changes

- [#119](https://github.com/maxa-ondrej/sideline/pull/119) [`c8db130`](https://github.com/maxa-ondrej/sideline/commit/c8db13047b962c021f18aa04941b2d6298f73cf2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add OpenTelemetry monitoring support via @effect/opentelemetry Otlp module for traces, metrics, and logs export to SigNoz

- Updated dependencies [[`737817d`](https://github.com/maxa-ondrej/sideline/commit/737817d36047e914a30f2d2c54b2220b96de21c5), [`683e8cb`](https://github.com/maxa-ondrej/sideline/commit/683e8cb3e0098fe2802cab6140f5986707d55136), [`c8db130`](https://github.com/maxa-ondrej/sideline/commit/c8db13047b962c021f18aa04941b2d6298f73cf2)]:
  - @sideline/domain@0.13.0
  - @sideline/i18n@0.3.1
  - @sideline/effect-lib@0.0.6

## 0.8.0

### Minor Changes

- [#115](https://github.com/maxa-ondrej/sideline/pull/115) [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add player activity streaks and stats — streak calculation, /makanicko stats Discord command, web profile stats card, and HTTP API endpoint

### Patch Changes

- [#117](https://github.com/maxa-ondrej/sideline/pull/117) [`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace hardcoded activity types with a global activity_types table, auto-track training attendance via cron after events end, and switch stats to dynamic counts

- [#114](https://github.com/maxa-ondrej/sideline/pull/114) [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add activity logging via Discord slash command (/makanicko log)

- [#111](https://github.com/maxa-ondrej/sideline/pull/111) [`66a30b3`](https://github.com/maxa-ondrej/sideline/commit/66a30b3b88b907f16dd84bf6304ab82e1204622c) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor block-body arrow functions to expression-body arrows and replace nested calls with pipe chains

- [#108](https://github.com/maxa-ondrej/sideline/pull/108) [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add training type selection to Discord event creation flow

- Updated dependencies [[`1d39492`](https://github.com/maxa-ondrej/sideline/commit/1d394922570fb268808b92b0ceacd555048cc35a), [`c902f5a`](https://github.com/maxa-ondrej/sideline/commit/c902f5aeb9551c43309f3e70134527dd39c5eb49), [`0fb3acd`](https://github.com/maxa-ondrej/sideline/commit/0fb3acd1ebf9afa6fc7b4fc6d9e14d5b786df4f1), [`174013c`](https://github.com/maxa-ondrej/sideline/commit/174013ca0e42655ee261423a0bddcebb894e83d2), [`0fc40b6`](https://github.com/maxa-ondrej/sideline/commit/0fc40b6cb2f3f765e2b65cf2343de39efb53e652)]:
  - @sideline/domain@0.12.0
  - @sideline/i18n@0.3.0

## 0.7.2

### Patch Changes

- [#104](https://github.com/maxa-ondrej/sideline/pull/104) [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Enforce group membership checks on RSVP endpoints

- [#103](https://github.com/maxa-ondrej/sideline/pull/103) [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove inline event embed update from RSVP handler (now handled by event channel routing) and add Option toEffect utility

- Updated dependencies [[`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d), [`5d2979f`](https://github.com/maxa-ondrej/sideline/commit/5d2979f3ee666d24b461994e2ddb51abd2ce7017), [`9584a67`](https://github.com/maxa-ondrej/sideline/commit/9584a6700fa5dcc86d1ccfed5ed44c07db9f3570), [`79ca632`](https://github.com/maxa-ondrej/sideline/commit/79ca6325566fc6a2c9e37d4551bcea4f6507d03d)]:
  - @sideline/domain@0.11.0
  - @sideline/i18n@0.2.1
  - @sideline/effect-lib@0.0.5

## 0.7.1

### Patch Changes

- [#91](https://github.com/maxa-ondrej/sideline/pull/91) [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace plain string dates with proper DateTime.Utc types throughout the stack

- [#90](https://github.com/maxa-ondrej/sideline/pull/90) [`c885234`](https://github.com/maxa-ondrej/sideline/commit/c885234c8f89088b1cc49a4619b69a617a8e9976) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Replace native JS array methods with Effect Array module in server and bot

- [#96](https://github.com/maxa-ondrej/sideline/pull/96) [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add /event-list Discord slash command with paginated upcoming events embed

- [#100](https://github.com/maxa-ondrej/sideline/pull/100) [`b63f5b0`](https://github.com/maxa-ondrej/sideline/commit/b63f5b017ace088eca0480b814252e2d268137ca) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Group /event-create and /event-list into /event create and /event list subcommands

- [#89](https://github.com/maxa-ondrej/sideline/pull/89) [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord.Snowflake branded type across the entire stack, remove catchAll on unfailable effects, and refactor repository methods to use destructuring with default values

- [#81](https://github.com/maxa-ondrej/sideline/pull/81) [`e9809ab`](https://github.com/maxa-ondrej/sideline/commit/e9809ab5ee687de7db088da83a06dce0790adec2) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add LOG_LEVEL environment variable to override default log levels

- [#97](https://github.com/maxa-ondrej/sideline/pull/97) [`0230c98`](https://github.com/maxa-ondrej/sideline/commit/0230c98db317f20800485a0ad758020236ff2f77) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Remove /ping slash command from Discord bot

- Updated dependencies [[`3b20ab1`](https://github.com/maxa-ondrej/sideline/commit/3b20ab1ed4d61dffc0d136d6ee6a055672e65788), [`dbe2a0b`](https://github.com/maxa-ondrej/sideline/commit/dbe2a0b480314845e45bcae95ea100ce0d06cf25), [`b49b814`](https://github.com/maxa-ondrej/sideline/commit/b49b814c7166d2ae2d95b00a95ec87a55cb8e9b6), [`c12900d`](https://github.com/maxa-ondrej/sideline/commit/c12900da82a09999081325bccbb29a39f93f3215), [`3b16731`](https://github.com/maxa-ondrej/sideline/commit/3b1673170ea6bb9b44b298fc3566415f016ea654), [`4d2ce92`](https://github.com/maxa-ondrej/sideline/commit/4d2ce92b94498e0683756fb4e1439cda51001abc), [`e9809ab`](https://github.com/maxa-ondrej/sideline/commit/e9809ab5ee687de7db088da83a06dce0790adec2), [`0230c98`](https://github.com/maxa-ondrej/sideline/commit/0230c98db317f20800485a0ad758020236ff2f77), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a), [`381d85d`](https://github.com/maxa-ondrej/sideline/commit/381d85d6f47deb87f68bcebd5a266e0f29bb71f3), [`38381e3`](https://github.com/maxa-ondrej/sideline/commit/38381e3695b8d2d5fc6704df9dfa8d29e55e2e0a)]:
  - @sideline/i18n@0.2.0
  - @sideline/domain@0.10.0
  - @sideline/effect-lib@0.0.4

## 0.7.0

### Minor Changes

- [#78](https://github.com/maxa-ondrej/sideline/pull/78) [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add RSVP reminders and threshold warnings with non-responder visibility

### Patch Changes

- [#79](https://github.com/maxa-ondrej/sideline/pull/79) [`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add /event-create Discord slash command for creating events via bot modal

- [#78](https://github.com/maxa-ondrej/sideline/pull/78) [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Send RSVP reminder DMs to non-responders who have a Discord account

- Updated dependencies [[`7dccd31`](https://github.com/maxa-ondrej/sideline/commit/7dccd31fe72f0063e7092cc4e762698b32a83e34), [`f21c610`](https://github.com/maxa-ondrej/sideline/commit/f21c61061b8b67faa87a2cadfec3f728603cae1f), [`f71d644`](https://github.com/maxa-ondrej/sideline/commit/f71d644aff2f4d181986b1510467577adb14fadc), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f), [`5d55e46`](https://github.com/maxa-ondrej/sideline/commit/5d55e463e6be04b01ac87377825a2372caa2713f)]:
  - @sideline/domain@0.9.0
  - @sideline/i18n@0.1.2

## 0.6.0

### Minor Changes

- [#73](https://github.com/maxa-ondrej/sideline/pull/73) [`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rename discord_username/discord_avatar to username/avatar across the codebase and fix RSVP member name display to fall back to username

### Patch Changes

- Updated dependencies [[`bbaec4d`](https://github.com/maxa-ondrej/sideline/commit/bbaec4d84940ca8aad14ac650ea6214b3e6ee645)]:
  - @sideline/domain@0.8.0

## 0.5.2

### Patch Changes

- [#69](https://github.com/maxa-ondrej/sideline/pull/69) [`5455854`](https://github.com/maxa-ondrej/sideline/commit/5455854590e40219532403d35dc2e068fd5b62d3) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Reorder Discord event messages by start date after creating or updating events

- Updated dependencies [[`5455854`](https://github.com/maxa-ondrej/sideline/commit/5455854590e40219532403d35dc2e068fd5b62d3)]:
  - @sideline/domain@0.7.1

## 0.5.1

### Patch Changes

- Updated dependencies [[`ca6db57`](https://github.com/maxa-ondrej/sideline/commit/ca6db57efc94442f6a690322ea1ae52355e1d903)]:
  - @sideline/i18n@0.1.0

## 0.5.0

### Minor Changes

- [#60](https://github.com/maxa-ondrej/sideline/pull/60) [`48648de`](https://github.com/maxa-ondrej/sideline/commit/48648dea12e25843ce93dadf1275ea06ee3395d8) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add i18n support to Discord bot with shared translation package

- [#66](https://github.com/maxa-ondrej/sideline/pull/66) [`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Extract OAuth into oauth_connections table and auto-register Discord guild members as team members

### Patch Changes

- Updated dependencies [[`7c483c5`](https://github.com/maxa-ondrej/sideline/commit/7c483c5a68b9ebf115ccd141d487e334fdee4c2e)]:
  - @sideline/domain@0.7.0

## 0.4.1

### Patch Changes

- [#58](https://github.com/maxa-ondrej/sideline/pull/58) [`fc4a030`](https://github.com/maxa-ondrej/sideline/commit/fc4a030319bbe581bf1b82b289711ecdb0731dac) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Migrate EventsRepository schemas from NullOr to OptionFromNullOr for consistent Option types across the repository layer

- Updated dependencies [[`fc4a030`](https://github.com/maxa-ondrej/sideline/commit/fc4a030319bbe581bf1b82b289711ecdb0731dac)]:
  - @sideline/domain@0.6.1

## 0.4.0

### Minor Changes

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add configurable Discord channel targeting for events at three levels: per-event/series, per-training-type default, and per-event-type in team settings

### Patch Changes

- [#55](https://github.com/maxa-ondrej/sideline/pull/55) [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add view attendees feature with ephemeral embed and pagination on event RSVP

- Updated dependencies [[`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`2badaeb`](https://github.com/maxa-ondrej/sideline/commit/2badaebfb5fd221dd84209a2925e5f3c4ead6c75), [`a2b503c`](https://github.com/maxa-ondrej/sideline/commit/a2b503ce5e7dce8835af0182fa3c8e7242c98355), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`41d6d6a`](https://github.com/maxa-ondrej/sideline/commit/41d6d6aa26130a3f4e09386b607a18ed7063cdf0), [`001061a`](https://github.com/maxa-ondrej/sideline/commit/001061aeb91bcf2bae85e778c89c91226bbbdb6f)]:
  - @sideline/domain@0.6.0
  - @sideline/effect-lib@0.0.3

## 0.3.1

### Patch Changes

- [`90b50bb`](https://github.com/maxa-ondrej/sideline/commit/90b50bbf8317901cedaa7cda8216ecef12be9acc) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Patch bump all applications

## 0.3.0

### Minor Changes

- [#47](https://github.com/maxa-ondrej/sideline/pull/47) [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Rework groups and roles: rename subgroups to groups with hierarchical support, assign roles to groups with recursive permission inheritance, scope training types to groups instead of coaches, and update age thresholds to operate on groups

### Patch Changes

- Updated dependencies [[`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`bdacd74`](https://github.com/maxa-ondrej/sideline/commit/bdacd74ce3ef5900ba18b266ef4836b284059428), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`85d3108`](https://github.com/maxa-ondrej/sideline/commit/85d3108070f0868622a56d75a3cdd813b57e03bd), [`74544b4`](https://github.com/maxa-ondrej/sideline/commit/74544b4ede8dde9539bcb5c76c25afda279d883b)]:
  - @sideline/domain@0.5.0

## 0.2.1

### Patch Changes

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Fix double commitChanges in age check, pass subgroup name in member sync events, remove spurious subgroup_name check on member_removed, fix copy-paste log messages in role sync, and prevent duplicate channel creation when mapping lacks role_id

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Use Discord roles for channel permissions instead of per-user permission overwrites

- [#44](https://github.com/maxa-ondrej/sideline/pull/44) [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Refactor RPC layer to use RpcGroup with prefix and configurable RPC_PREFIX env var

- Updated dependencies [[`3a2daa7`](https://github.com/maxa-ondrej/sideline/commit/3a2daa77509b9a1066c48b78e94697db7609e3d6), [`eb7fdf3`](https://github.com/maxa-ondrej/sideline/commit/eb7fdf3c4607770baf78df856f450f5f303fdc9f), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`3700082`](https://github.com/maxa-ondrej/sideline/commit/3700082b552e0e87a80bc6fec466d6a54a6317cb), [`0c98f29`](https://github.com/maxa-ondrej/sideline/commit/0c98f291ee6168e73077feec4cdbc89f0ccdfd3f)]:
  - @sideline/domain@0.4.0

## 0.2.0

### Minor Changes

- [#35](https://github.com/maxa-ondrej/sideline/pull/35) [`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Discord role sync via @effect/rpc: server emits role change events, bot polls and syncs to Discord

### Patch Changes

- [#33](https://github.com/maxa-ondrej/sideline/pull/33) [`018b413`](https://github.com/maxa-ondrej/sideline/commit/018b413fc26bd25b011c05f13456dcd8fd34475a) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add modular command, interaction, and event framework with gateway health checks

- Updated dependencies [[`eed4aa3`](https://github.com/maxa-ondrej/sideline/commit/eed4aa3820c6bbad12ff2292bcc92aee5a7460b9)]:
  - @sideline/domain@0.3.0

## 0.1.7

### Patch Changes

- Updated dependencies [[`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`780bca9`](https://github.com/maxa-ondrej/sideline/commit/780bca9d0300030fafd76edc3efd81e5f7a6f88d), [`2b1f4b4`](https://github.com/maxa-ondrej/sideline/commit/2b1f4b460b2d234f026cf658a6b0651f84ef58a9), [`11b920c`](https://github.com/maxa-ondrej/sideline/commit/11b920c61ae409100c9bf09221a23929fdf053ef), [`e8fd1ab`](https://github.com/maxa-ondrej/sideline/commit/e8fd1ab2e0b47aa37fa6ed58e01572d25f90e64d)]:
  - @sideline/domain@0.2.0

## 0.1.6

### Patch Changes

- [#21](https://github.com/maxa-ondrej/sideline/pull/21) [`fa51b42`](https://github.com/maxa-ondrej/sideline/commit/fa51b42bab5144cc6027a9fafbc5e8b75271df90) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Standardize TypeScript imports to use `~` alias for `src/` and root-only package imports

- Updated dependencies [[`fa51b42`](https://github.com/maxa-ondrej/sideline/commit/fa51b42bab5144cc6027a9fafbc5e8b75271df90)]:
  - @sideline/domain@0.1.2
  - @sideline/effect-lib@0.0.2

## 0.1.5

### Patch Changes

- [`0685679`](https://github.com/maxa-ondrej/sideline/commit/06856798d01a669df8ac7ec38b64aca076e2b888) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Split migrations into before/after lifecycle, decompose DATABASE_URL into individual connection params, and update docker-compose for full-stack deployment.

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
  - @sideline/effect-lib@0.0.1

## 0.1.0

### Minor Changes

- [`6579f9e`](https://github.com/maxa-ondrej/sideline/commit/6579f9e28eaf8f5ea2ef9d388e092a7cf672198b) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Initial project setup
  - Add Discord OAuth login flow with session and user management
  - Add typed frontend runtime with ApiClient context and ClientError
  - Add env-aware runMain for bot and server (JSON logger in production, pretty logger in development)
  - Add Dockerfiles and Docker CI workflow for all applications
  - Migrate Vitest to root test.projects configuration
  - Refactor app layers into AppLive + run.ts pattern
  - Add Swagger UI and OpenAPI docs to server
  - Add shadcn/ui components to web app

### Patch Changes

- [#7](https://github.com/maxa-ondrej/sideline/pull/7) [`156389b`](https://github.com/maxa-ondrej/sideline/commit/156389b1ede03fb5922aaeebdf0a8ac1e6e402ee) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Bot ping command now responds in the server's configured language by reading `guild_locale` from the Discord interaction.

- [`8a9287b`](https://github.com/maxa-ondrej/sideline/commit/8a9287bca2a249267cf1133802c656e8c489d4cd) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Centralize environment variable validation with @t3-oss/env-core

- [#5](https://github.com/maxa-ondrej/sideline/pull/5) [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add dev scripts for watch-mode development; fix HealthServerLive port and log address

- [#5](https://github.com/maxa-ondrej/sideline/pull/5) [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83) Thanks [@maxa-ondrej](https://github.com/maxa-ondrej)! - Add Czech + English i18n support with Paraglide JS, language switcher, persistent user locale, and locale-aware formatting

- Updated dependencies [[`e3a3938`](https://github.com/maxa-ondrej/sideline/commit/e3a393841205f203c16c65dfb0f05a8a5b656cab), [`0458277`](https://github.com/maxa-ondrej/sideline/commit/0458277c509fccaa36fefdc7f2d9a8e9833caa83), [`6579f9e`](https://github.com/maxa-ondrej/sideline/commit/6579f9e28eaf8f5ea2ef9d388e092a7cf672198b), [`e3a3938`](https://github.com/maxa-ondrej/sideline/commit/e3a393841205f203c16c65dfb0f05a8a5b656cab), [`2776ed6`](https://github.com/maxa-ondrej/sideline/commit/2776ed65f129a1206637332b94bdf64a9280cfeb), [`a89cf75`](https://github.com/maxa-ondrej/sideline/commit/a89cf758025d95caae8a98c4337e9679c8bf301e)]:
  - @sideline/domain@0.1.0
