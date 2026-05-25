# Weekly Challenges MVP — Part 2/3 (Bot Processor)

> Part 1 (server-side: schema, repository, RPCs, scheduler) is complete and shipped in d7513dc8.
> Part 3 (HTTP API for user-facing CRUD + web UI) is out of scope for this plan.

## 1. Goal

Wire the bot's poll loop to drain `weekly_challenge_sync_events` rows produced by the server scheduler, render a Czech-primary Discord embed announcing the new weekly challenge, post it into each team's configured challenge channel, and call back to the server to mark the event processed (or failed). This closes the loop between the Part 1 RPC surface and an actual Discord message — no user-facing surface yet, no web UI yet.

## 2. Inventory of available RPC methods (from Part 1)

Source: `packages/domain/src/rpc/weeklyChallenge/WeeklyChallengeSyncEvents.ts`. Prefix: `WeeklyChallenge/`.

| RPC key | Payload | Returns |
|---|---|---|
| `WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents` | _(none)_ | `ReadonlyArray<UnprocessedWeeklyChallengeEvent>` |
| `WeeklyChallenge/MarkWeeklyChallengeProcessed` | `{ eventId: UUIDString; deliveredAt: DateTimeUtc }` | `void` |
| `WeeklyChallenge/MarkWeeklyChallengeFailed` | `{ eventId: UUIDString; error: string }` | `void` |

`UnprocessedWeeklyChallengeEvent` (plain `Schema.Class`, **not** `TaggedClass` — there is no `_tag`):

```
{
  id: UUIDString
  teamId: Team.TeamId
  challengeId: WeeklyChallengeId
  channelId: Discord.Snowflake
  scheduledFor: DateTimeUtc
  attempts: Int
  title: WeeklyChallengeTitle              // non-empty, ≤120
  kind: 'throwing' | 'sport'
  description: Option<WeeklyChallengeDescription>   // OptionFromNullOr, ≤2000
  weekStartDate: string                    // ISO date "YYYY-MM-DD"
  weekEndDate: string                      // ISO date "YYYY-MM-DD"
}
```

Server-side guarantees relevant to the processor:
- The list query already filters `scheduled_for <= now()` AND `processed_at IS NULL` AND `attempts < 5` (server-side cap, see `applications/server/src/repositories/WeeklyChallengeRepository.ts`). The bot does **not** re-filter future events.
- The server query currently has **no `LIMIT` clause**. Acceptable for MVP because at most one challenge per team per week → backlog is bounded. Recorded as a follow-up.
- The 5-attempt cap is enforced server-side. Bot-side does **not** need to count attempts.

## 3. Files to create

All paths absolute.

1. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/rcp/weeklyChallenge/index.ts`
2. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/rcp/weeklyChallenge/ProcessorService.ts`
3. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/rcp/weeklyChallenge/handleWeeklyChallengeReady.ts`
4. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/rest/weeklyChallenge/buildWeeklyChallengeEmbed.ts`
5. `/Users/ondrej.maxa/Projects/sideline/applications/bot/test/rest/weeklyChallenge/buildWeeklyChallengeEmbed.test.ts`
6. `/Users/ondrej.maxa/Projects/sideline/applications/bot/test/rcp/weeklyChallenge/ProcessorService.test.ts` (consolidated processor + handler tests)

## 4. Files to modify

All paths absolute.

1. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/rcp/index.ts` — re-export `WeeklyChallengeSyncService`.
2. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/index.ts` — re-export `WeeklyChallengeSyncService` (mirrors `WeeklySummarySyncService` on line 16).
3. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/AppLive.ts` — add `WeeklyChallengeSyncService.Default` to the `Layer.mergeAll(...)` block (after `WeeklySummarySyncService.Default` on line 31).
4. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/Bot.ts`:
   - Add `WeeklyChallengeSyncService` to the import list (after `WeeklySummarySyncService` on line 20).
   - `Effect.bind('weeklyChallenge', () => WeeklyChallengeSyncService.asEffect())` after the `weeklySummary` bind on line 57.
   - Destructure `weeklyChallenge` in the `Effect.andThen` block (between lines 61-73).
   - Add `pollLoop(weeklyChallenge.processTick)` to the `Effect.all([...])` array (after `pollLoop(weeklySummary.processTick)` on line 86).
   - Append `| WeeklyChallengeSyncService` to the hand-maintained type-union tail at lines 96-112 (specifically after `| WeeklySummarySyncService` on line 111).
5. `/Users/ondrej.maxa/Projects/sideline/applications/bot/src/env.ts` — add optional `WEB_URL` env var mirroring `LOG_LEVEL` (line 28).
6. `/Users/ondrej.maxa/Projects/sideline/applications/bot/test/Bot.test.ts` — add `MockWeeklyChallengeSyncServiceLayer` and provide it (mirrors lines 94-97 for `WeeklySummarySyncService`).
7. `/Users/ondrej.maxa/Projects/sideline/packages/i18n/messages/cs.json` — add 7 keys (Czech values, primary).
8. `/Users/ondrej.maxa/Projects/sideline/packages/i18n/messages/en.json` — add the same 7 keys (English fallback).
9. `/Users/ondrej.maxa/Projects/sideline/docker-compose.yaml` — add `WEB_URL: ${SERVICE_URL_PROXY}` to the `bot:` service env block (after line 70, matching the `web:` service line 86). Note as a deploy-coordination follow-up: production env in Coolify must define `SERVICE_URL_PROXY` for the bot too (it already does for web).

## 5. Per-file specification

### 5.1 `applications/bot/src/rcp/weeklyChallenge/index.ts`

**Public:**
```ts
import { Effect } from 'effect';
import { ProcessorService } from './ProcessorService.js';

export class WeeklyChallengeSyncService extends Effect.Service<WeeklyChallengeSyncService>()(
  'bot/WeeklyChallengeSyncService',
  { effect: ProcessorService },
) {}
```

Mirrors `applications/bot/src/rcp/weeklySummary/index.ts`. Tag string follows the `bot/<ServiceName>` convention used elsewhere in the codebase.

### 5.2 `applications/bot/src/rcp/weeklyChallenge/ProcessorService.ts`

**Exported:** `ProcessorService` (Effect that returns `{ processTick }`).

**Imports:**
```ts
import type { WeeklyChallengeSyncEvents } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Metric } from 'effect';
import { env } from '~/env.js';
import { syncEventsFailedTotal, syncEventsProcessedTotal } from '../../metrics.js';
import { SyncRpc } from '../../services/SyncRpc.js';
import { handleWeeklyChallengeReady } from './handleWeeklyChallengeReady.js';
```

**Implementation outline:**

```ts
const processEvent = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.map(
    ({ rpc, discord }) =>
      (event: WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent) =>
        // NOTE: UnprocessedWeeklyChallengeEvent is a plain Schema.Class (no _tag).
        // Single event type — no Match.tag dispatch. Call the handler directly.
        handleWeeklyChallengeReady(event, env.WEB_URL).pipe(
          Effect.flatMap(() =>
            rpc['WeeklyChallenge/MarkWeeklyChallengeProcessed']({
              eventId: event.id,
              deliveredAt: DateTime.nowUnsafe(),
            }),
          ),
          Effect.tap(() =>
            Metric.update(
              Metric.withAttributes(syncEventsProcessedTotal, {
                sync_type: 'weekly_challenge',
              }),
              1,
            ),
          ),
          Effect.catchAll((error) =>
            rpc['WeeklyChallenge/MarkWeeklyChallengeFailed']({
              eventId: event.id,
              error: String(error),
            }).pipe(
              Effect.tap(() =>
                Effect.logWarning(
                  `Failed to process weekly challenge sync event ${event.id}`,
                  error,
                ),
              ),
              Effect.tap(() =>
                Metric.update(
                  Metric.withAttributes(syncEventsFailedTotal, {
                    sync_type: 'weekly_challenge',
                  }),
                  1,
                ),
              ),
            ),
          ),
          Effect.provideService(SyncRpc, rpc),
          Effect.provideService(DiscordREST, discord),
          Effect.withSpan('sync/weekly_challenge/ready', {
            attributes: { 'event.id': String(event.id) },
          }),
        ),
  ),
);

export const ProcessorService = Effect.Do.pipe(
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('discord', () => DiscordREST.asEffect()),
  Effect.bind('processEvent', ({ rpc, discord }) =>
    processEvent.pipe(
      Effect.provideService(SyncRpc, rpc),
      Effect.provideService(DiscordREST, discord),
    ),
  ),
  Effect.tap(() => Effect.logInfo('WeeklyChallengeSyncService initialized')),
  Effect.let('processTick', ({ rpc, processEvent }) =>
    // NOTE: server-side query is currently unbounded (no LIMIT). Acceptable
    // because at most one challenge per team per week bounds the backlog.
    // Follow-up: add LIMIT in Part 1 follow-up; bot adds no client-side cap.
    rpc['WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents']().pipe(
      Effect.tap((events) =>
        Effect.logDebug(`Weekly challenge sync poll: ${events.length} event(s)`),
      ),
      Effect.flatMap((events) =>
        events.length === 0
          ? Effect.void
          : Effect.all(Array.map(events, processEvent), { concurrency: 1 }).pipe(
              Effect.tap(() =>
                Effect.logInfo(
                  `Processed ${events.length} weekly challenge sync event(s)`,
                ),
              ),
              Effect.asVoid,
            ),
      ),
      Effect.tapError((error) =>
        Effect.logError('Error polling weekly challenge sync events', error),
      ),
    ),
  ),
  Bind.remove('rpc'),
  Bind.remove('processEvent'),
);
```

Key design decisions baked in:
- **No `Match.type/Match.tag/Match.exhaustive`.** `UnprocessedWeeklyChallengeEvent` is plain `Schema.Class`. Single event type → direct call to `handleWeeklyChallengeReady`.
- **Span name is a literal** `sync/weekly_challenge/ready` (not interpolated from `event._tag`) — `_tag` does not exist on this Schema.Class.
- **Metric `action` attribute is omitted** for the same reason (achievement processor uses `event._tag` for `action`; we have none). Only `sync_type: 'weekly_challenge'` is set, mirroring the failed-side achievement metric (line 42 of the achievement processor).
- **Poll cadence:** wired via the standard `pollLoop` (5s) in `Bot.ts`. Not "fast poll" — weekly cadence does not need 1s polling.
- **Concurrency:** 1 (matches every other sync processor).
- **`Effect.catchAll` wraps the whole `handle → MarkProcessed → metric` chain.** Any failure from the handler (including unrecoverable 403s after retries) routes to `MarkWeeklyChallengeFailed` and the server-side `attempts` counter increments. A handler that returns `void` (e.g. 404 short-circuit) flows through to `MarkProcessed` — the row is marked done, not failed (deliberate; see §7 and the §5.3 handler note).

### 5.3 `applications/bot/src/rcp/weeklyChallenge/handleWeeklyChallengeReady.ts`

**Public signature:**
```ts
export const handleWeeklyChallengeReady = (
  event: WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent,
  webUrl: Option.Option<string>,
) => Effect.Effect<void, ErrorResponse | unknown, DiscordREST>;
```

**Implementation outline:**

```ts
import type { WeeklyChallengeSyncEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { buildWeeklyChallengeEmbed } from '~/rest/weeklyChallenge/buildWeeklyChallengeEmbed.js';

export const handleWeeklyChallengeReady = (
  event: WeeklyChallengeSyncEvents.UnprocessedWeeklyChallengeEvent,
  webUrl: Option.Option<string>,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) => {
      // TODO(part-3 or later): plumb team.onboarding_locale through
      // UnprocessedWeeklyChallengeEvent. For MVP, product is Czech-primary.
      const embed = buildWeeklyChallengeEmbed({
        title: event.title,
        kind: event.kind,
        description: event.description,
        weekStartDate: event.weekStartDate,
        weekEndDate: event.weekEndDate,
        teamId: event.teamId,
        webUrl,
        locale: 'cs',
      });

      // Order: short-circuit 404 BEFORE Effect.retry. A deleted channel is a
      // permanent failure; retrying only delays the worker. Other Discord
      // permission codes (e.g. 50001 / 50013) intentionally bubble through the
      // retry policy — the server-side 5-attempt cap eventually terminates them
      // by ceasing to return the row.
      //
      // NOTE: on 404 the handler returns Effect.void. The outer Effect.catchAll in
      // ProcessorService will NOT fire, so the row is marked PROCESSED, not
      // failed. This matches the achievement & weekly-summary precedent — a
      // permanently-gone channel cannot be retried into existence, so further
      // attempts would be wasted.
      return rest
        .createMessage(event.channelId, { embeds: [embed] })
        .pipe(
          Effect.catchTag('ErrorResponse', (err) =>
            err.response.status === 404
              ? Effect.logWarning(
                  `Weekly challenge channel ${event.channelId} not found (404) for team ${event.teamId}, skipping`,
                )
              : Effect.fail(err),
          ),
          Effect.retry(retryPolicy),
        );
    }),
    Effect.tap(() =>
      Effect.logInfo(
        `Posted weekly challenge embed to channel ${event.channelId} for team ${event.teamId}`,
      ),
    ),
    Effect.asVoid,
  );
```

Note on order: `catchTag` **inside** `retry` (i.e. `pipe(catchTag(...), retry(retryPolicy))`) means the 404 short-circuit converts the error to a success before the retry sees it, so retries do not fire for 404s. This matches `handleAchievementEarned.ts:63-72`, which uses the same ordering with a comment explaining why. Note: `handleWeeklySummaryReady.ts` has the OPPOSITE (broken) order — do not copy from there.

### 5.4 `applications/bot/src/rest/weeklyChallenge/buildWeeklyChallengeEmbed.ts`

**Public signature:**

```ts
import type { Discord, Team, WeeklyChallenge } from '@sideline/domain';
import type * as DiscordTypes from 'dfx/types';
import type { Option } from 'effect';
import type { Locale } from '~/locale.js';

export type BuildWeeklyChallengeEmbedInput = {
  readonly title: WeeklyChallenge.WeeklyChallengeTitle;
  readonly kind: WeeklyChallenge.WeeklyChallengeKind;
  readonly description: Option.Option<WeeklyChallenge.WeeklyChallengeDescription>;
  readonly weekStartDate: string; // "YYYY-MM-DD"
  readonly weekEndDate: string;   // "YYYY-MM-DD"
  readonly teamId: Team.TeamId;
  readonly webUrl: Option.Option<string>;
  readonly locale: Locale;
};

export const buildWeeklyChallengeEmbed: (
  input: BuildWeeklyChallengeEmbedInput,
) => DiscordTypes.RichEmbed;
```

**Implementation outline:**

```ts
import * as m from '@sideline/i18n/messages';
import { Option } from 'effect';

const THROWING_COLOR = 0x10b981; // emerald (designer spec)
const SPORT_COLOR    = 0xf59e0b; // amber (designer spec)

export const buildWeeklyChallengeEmbed = (
  input: BuildWeeklyChallengeEmbedInput,
): DiscordTypes.RichEmbed => {
  const { title, kind, description, weekStartDate, weekEndDate, teamId, webUrl, locale } = input;

  const titleMessageKey =
    kind === 'throwing'
      ? m.weeklyChallenge_embed_title_throwing
      : m.weeklyChallenge_embed_title_sport;

  const kindLabel =
    kind === 'throwing'
      ? m.weeklyChallenge_embed_kind_throwing({}, { locale })
      : m.weeklyChallenge_embed_kind_sport({}, { locale });

  const fields: Array<DiscordTypes.RichEmbedField> = [
    {
      name: m.weeklyChallenge_embed_field_kind({}, { locale }),
      value: kindLabel,
      inline: true,
    },
    {
      name: m.weeklyChallenge_embed_field_week({}, { locale }),
      value: `${weekStartDate} – ${weekEndDate}`,
      inline: true,
    },
  ];

  // Conditionally include description (Option<string>); empty Option = no field.
  Option.match(description, {
    onNone: () => undefined,
    onSome: (desc) => {
      fields.push({ name: title, value: desc, inline: false });
    },
  });

  const baseEmbed: DiscordTypes.RichEmbed = {
    title: titleMessageKey({ title }, { locale }),
    color: kind === 'throwing' ? THROWING_COLOR : SPORT_COLOR,
    fields,
    footer: { text: m.weeklyChallenge_embed_footer({}, { locale }) },
  };

  // Gate the deep-link URL on Option.isSome(webUrl). Conditional spread keeps
  // the embed valid when WEB_URL is unset (matches buildWeeklySummaryEmbed which
  // has no URL at all).
  return Option.match(webUrl, {
    onNone: () => baseEmbed,
    onSome: (url) => ({
      ...baseEmbed,
      url: `${url}/teams/${teamId}/challenges`,
    }),
  });
};
```

Design notes:
- **Type strictness:** no `as X`, no `any`. The two-kind discrimination is a literal `if` on the union member; TypeScript narrows correctly.
- **Locale:** parameterised even though we hardcode `'cs'` at the call site, so unit tests can assert both locales and Part 3 can plumb `team.onboarding_locale` without changing the builder signature.
- **No `WEB_URL` ⇒ no `url`:** mirrors `buildWeeklySummaryEmbed.ts` which never sets `url`. Discord renders embeds with or without it.
- **Deep-link path** `/teams/${teamId}/challenges` matches the future Part 3 web route. `WEB_URL` is OPTIONAL — when unset, the embed omits `url` entirely (no broken link). Deployment guidance: until Part 3 ships, either leave `WEB_URL` unset on the bot in production, or accept a brief 404 until the route lands.

### 5.5 `packages/i18n/messages/cs.json` and `packages/i18n/messages/en.json`

Add **7 keys** to both files (Czech values primary, English fallback). Append in the area after `weeklySummary_*` keys / before any closing brace — paraglide is order-agnostic.

| Key | cs.json value | en.json value |
|---|---|---|
| `weeklyChallenge_embed_title_throwing` | `Týdenní házecí výzva` | `Weekly throwing challenge` |
| `weeklyChallenge_embed_title_sport` | `Týdenní sportovní výzva` | `Weekly sport challenge` |
| `weeklyChallenge_embed_field_kind` | `Typ` | `Type` |
| `weeklyChallenge_embed_field_week` | `Týden` | `Week` |
| `weeklyChallenge_embed_kind_throwing` | `Házecí` | `Throwing` |
| `weeklyChallenge_embed_kind_sport` | `Sportovní` | `Sport` |
| `weeklyChallenge_embed_footer` | `Sideline · Týdenní výzva` | `Sideline · Weekly challenge` |

After modifying these files, **always run `pnpm -F @sideline/i18n build`** before running typecheck / tests in the bot, because the compiled output at `packages/i18n/dist/messages.js` is gitignored and the bot imports it via `@sideline/i18n/messages`. See `packages/i18n/AGENTS.md` for build details. The build script is `paraglide-js compile … && node scripts/pack.js`.

### 5.6 `applications/bot/src/env.ts`

Add a single line in the `server` block, after the `LOG_LEVEL` line (line 28):

```ts
WEB_URL: Schema.toStandardSchemaV1(Schema.OptionFromNullishOr(Schema.NonEmptyString)),
```

Result: `env.WEB_URL: Option<string>`. The handler in §5.3 passes this directly to the builder.

Justification:
- **Optional**, not required: a misconfigured deploy must not crash the bot — the embed still works without a URL.
- Mirrors the existing `LOG_LEVEL` pattern using `OptionFromNullishOr` so empty string and missing both become `Option.none()` (because `emptyStringAsUndefined: true` is set on line 35).
- Name is `WEB_URL` to align with the web app's existing usage in `docker-compose.yaml:86`.

### 5.7 `applications/bot/src/AppLive.ts`, `Bot.ts`, `rcp/index.ts`, `index.ts`

Mechanical additions following the `WeeklySummarySyncService` pattern. Specifically in `Bot.ts`:

- Import (line ~20):
  ```ts
  WeeklyChallengeSyncService,
  ```
- Bind (after line 57):
  ```ts
  Effect.bind('weeklyChallenge', () => WeeklyChallengeSyncService.asEffect()),
  ```
- Destructure (in the `Effect.andThen` block, lines 61-73): add `weeklyChallenge,` to the destructured `{...}`.
- Poll loop (in the `Effect.all([...])` block, after line 86): add `pollLoop(weeklyChallenge.processTick),`.
- Type-union tail (line 111, after `| WeeklySummarySyncService`): add `| WeeklyChallengeSyncService`.

### 5.8 `applications/bot/test/Bot.test.ts`

Add a mock layer alongside the existing 10:

```ts
const MockWeeklyChallengeSyncServiceLayer = Layer.succeed(WeeklyChallengeSyncService, {
  processTick: Effect.void,
} as never);
```

Provide it to the test's `Effect.provide([... layers ...])` array. Mirrors the existing `MockWeeklySummarySyncServiceLayer` at line 94.

### 5.9 `docker-compose.yaml`

Add one line under the `bot:` service environment block (after `OTEL_SERVICE_NAME: sideline-bot` on line 70):

```yaml
      WEB_URL: ${SERVICE_URL_PROXY}
```

Production / Coolify already expands `SERVICE_URL_PROXY` for the web service (line 86) — same value works for the bot.

## 6. Test plan

Test files use Vitest + Effect runtime patterns established by `test/rcp/achievement/handleAchievementEarned.test.ts`. The bot already uses TDD elsewhere (see top-of-file note in `test/buildWeeklySummaryEmbed.test.ts`); follow the same style.

### 6.1 Pure embed builder — `test/rest/weeklyChallenge/buildWeeklyChallengeEmbed.test.ts`

No mocks required. Direct function calls.

| # | Test name | Assertion |
|---|---|---|
| 1 | `renders title from i18n + event title for kind=throwing` | `embed.title` contains the Czech "Týdenní házecí výzva" prefix AND the literal event title. |
| 2 | `renders title from i18n + event title for kind=sport` | same as #1 but the sport prefix. |
| 3 | `uses kind-specific color` | throwing → `0x10b981` (emerald), sport → `0xf59e0b` (amber). |
| 4 | `field 'Kind' shows kind label in Czech for cs locale` | a field with `field.name === 'Druh'` and `field.value === '🥏 Házecí'` for throwing / `'🏃 Sportovní'` for sport (exact equality, not substring). |
| 5 | `field 'Kind' shows kind label in English for en locale` | `field.name === 'Kind'` and `field.value === '🥏 Throwing'` / `'🏃 Sport'` (exact equality). |
| 6 | `field 'Week' contains start-end date range` | a field whose value is `${weekStartDate} – ${weekEndDate}`. |
| 7 | `omits description field when description is Option.none` | only 2 fields total. |
| 8 | `includes description field when description is Option.some` | 3 fields total; the description's `value` equals the inner string; `name` equals the event title. |
| 9 | `sets embed.url when webUrl is Option.some` | `embed.url === '${webUrl}/teams/${teamId}/challenges'`. |
| 10 | `omits embed.url when webUrl is Option.none` | `embed.url === undefined` (property must not be present). |
| 11 | `footer is i18n footer text` | `embed.footer.text` equals the Czech `Sideline · Týdenní výzva` for cs locale. |

### 6.2 Processor + handler (consolidated) — `test/rcp/weeklyChallenge/ProcessorService.test.ts`

Mocks: `DiscordREST` proxy (mirror `handleAchievementEarned.test.ts:48-80`), Logger capture layer (mirror lines 96-104), and a `SyncRpc` mock that records `GetUnprocessed`/`MarkProcessed`/`MarkFailed` calls. Because `webUrl` is now a handler parameter (not read from `env` inside the handler), tests pass `Option.some('https://test.example')` or `Option.none()` directly — no `vi.mock('~/env.js')` needed.

> Top-of-file comment for the test file:
> > "The server-side 5-attempt cap is asserted in `WeeklyChallengeRepository.test.ts` integration tests, not here. Bot-side handler is stateless w.r.t. attempt counting. Handler-level and processor-level tests are consolidated here because the handler is small and only meaningfully exercised through the processor's catchAll/MarkProcessed/MarkFailed wiring."

**Wall-clock note (Decision 9):** the 50001/50013 retry tests below accept ~7-8s real wall-clock (exponential 1s/2s/4s `retryPolicy` + ~50ms mocked call latency × 4 attempts). Total bot test suite should remain under 30s. If CI cost grows, refactor to use `TestClock` or make `retryPolicy` injectable into the handler.

**Empty-list polling assertion (Decision 10):** add a test that calls `processTick` once with `GetUnprocessed` returning `[]`; assert `rpcCalls.GetUnprocessed.length === 1` (proves polling happened and was not skipped) and that no `MarkProcessed` / `MarkFailed` calls were made.

**Error-string assertions (Decision 12):** tests 6 and 7 below must inspect the recorded `MarkWeeklyChallengeFailed` payload and assert the `error` string contains either the HTTP status (`'403'`) or the Discord error code (`'50001'` / `'50013'`). If `String(err)` produces `'[object Object]'`, the handler must switch to `JSON.stringify` or a tagged-error-aware formatter so the recorded string is diagnostically useful.

| # | Test name | Assertion |
|---|---|---|
| 1 | `happy path — kind=throwing posts one embed to channelId` | `rest.createMessage` called exactly once, args `(channelId, { embeds: [<embed>] })`, embed has throwing color. |
| 2 | `happy path — kind=sport posts one embed to channelId` | same as #1 but sport color. |
| 3 | `embed.url is present when WEB_URL env is set` | mock or stub `env.WEB_URL = Option.some('https://example.test')`; assert `embed.url` ends in `/teams/${teamId}/challenges`. |
| 4 | `embed.url is absent when WEB_URL env is unset` | stub `env.WEB_URL = Option.none()`; assert `embed.url === undefined`. |
| 5 | `404 ErrorResponse short-circuits — handler returns void, no retries` | `rest.createMessage` returns `ErrorResponse { status: 404 }`; assert: (a) call count = 1 (no retries), (b) handler resolves to void, (c) log capture contains a warning mentioning channelId + teamId. |
| 6 | `403 / 50001 ErrorResponse bubbles after retries exhausted` | `rest.createMessage` always returns `ErrorResponse { status: 403, code: 50001 }`; assert: (a) call count > 1 (retry policy fires), (b) handler fails with the wrapped ErrorResponse. (No assertion on MarkFailed — that's in the ProcessorService composition, not the pure handler.) |
| 7 | `403 / 50013 ErrorResponse bubbles after retries exhausted` | same shape as #6 with code 50013. |
| 8 | `(processor-level) future events are not returned by the server query — contract check` | a documentation-only test stub or comment in the processor test file that confirms the bot does not re-filter `scheduledFor`. Asserted by: passing in an event with `scheduledFor` in the future works the same as one in the past — the bot does not gate on it. (Optional; can be omitted as a comment-only note if it adds no value.) |

Test 9 (the deleted 5-attempt-cap test) is **not** present — see top-of-file comment in the test file. All assertions above live in this single `ProcessorService.test.ts` file.

### 6.3 Bot.ts type-union test

`test/Bot.test.ts` continues to compile only if every service in `Bot.program`'s requirement set has a corresponding mock layer. Adding the new mock (§5.8) is the test.

## 7. Error handling decision table

| Condition | Branch | Outcome | Why |
|---|---|---|---|
| `rest.createMessage` returns `ErrorResponse` with `status === 404` (channel deleted) | `catchTag('ErrorResponse', …)` short-circuit, returns void | Outer `Effect.catchAll` in `ProcessorService` does **not** fire → `MarkWeeklyChallengeProcessed` is called → row is marked done. | Matches `handleAchievementEarned.ts:60-72` and `handleWeeklySummaryReady.ts:24-30`. A permanently-gone channel cannot be retried into existence; marking the row done prevents the server's 5-attempt counter from wastefully incrementing on something we cannot fix. Deliberate (not accidental) — the channel-rebind workflow is captain-mediated and out of scope for the processor. |
| `rest.createMessage` returns `ErrorResponse` with other 5xx status (transient) | falls through to `Effect.retry(retryPolicy)` (exponential, recur 3) | After exhausted retries → outer `Effect.catchAll` fires → `MarkWeeklyChallengeFailed` increments server `attempts`. | Standard transient-retry pattern from `applications/bot/src/rest/utils.ts:6`. |
| `rest.createMessage` returns `ErrorResponse` with `403` / code `50001` (missing channel access) | falls through to `Effect.retry(retryPolicy)` | After exhausted retries → outer `Effect.catchAll` → `MarkWeeklyChallengeFailed`. Server's 5-attempt cap eventually stops returning the row. | Rare (channel-perm misconfig). Not worth a dedicated short-circuit branch — the 5-attempt cap terminates the retry loop on the server side. |
| `rest.createMessage` returns `ErrorResponse` with `403` / code `50013` (missing permissions) | same as 50001 | same as 50001. | same as 50001. |
| Any non-`ErrorResponse` defect (e.g. JSON decode failure of payload, network timeout outside `ErrorResponse` envelope) | not caught by `catchTag` — falls through `Effect.retry`, then bubbles | Outer `Effect.catchAll` → `MarkWeeklyChallengeFailed`. | Safety net; consistent with the achievement / weekly-summary processors. |
| `GetUnprocessedWeeklyChallengeEvents` RPC fails (server down, network) | logged via `Effect.tapError`; tick ends; next tick retries | Polling loop continues — no event is marked one way or the other. | Matches `weeklySummary/ProcessorService.ts:86-87` and `achievement/ProcessorService.ts:80`. |

## 8. Risks / known follow-ups

| Risk | Mitigation / status |
|---|---|
| **Server query has no `LIMIT`** — unbounded if backlog grows. | At most one challenge/team/week + 5-attempt server cap = backlog is intrinsically bounded for the MVP. Added as a code comment in `ProcessorService.ts` (`Effect.let('processTick', …)`) and tracked as a Part-1 follow-up. |
| **Locale hardcoded to `'cs'`** in the handler — Czech-only on Discord even for English-locale teams. | Acceptable for MVP (product is Czech-primary; `'en'` would be wrong). `TODO(part-3 or later)` comment in the handler. Resolution path: extend `UnprocessedWeeklyChallengeEvent` with `locale: Locale` (read from `team.onboarding_locale` in the server query) and pass it through. |
| **`WEB_URL` not yet present on bot in production env.** | Optional schema → bot starts fine without it. Embed simply omits `url`. Production rollout: ensure `docker-compose.yaml` change (§5.9) is merged **and** Coolify-side var is present before announcing the deep-link as a feature. Until then, embeds without URL still post. |
| **Deep-link path `/teams/{teamId}/challenges` does not exist until Part 3 ships.** | `WEB_URL` is optional — leave it unset on the bot in production until Part 3 ships to avoid 404s on the deep-link, or set it and accept a brief 404 window (captain's choice). The builder is the single point of change if the path needs to move later. |
| **i18n build dependency.** | Anyone adding the 7 keys must run `pnpm -F @sideline/i18n build` before bot typecheck / test, or imports of `m.weeklyChallenge_embed_*` will not resolve. Documented in §5.5 and `packages/i18n/AGENTS.md`. |
| **Domain rebuild not required.** | No changes to `packages/domain/` — Part 1 already shipped the types. |

## 9. Out of scope

The following are explicitly **deferred to Part 3** and must not be implemented in this PR:

- HTTP API for user-facing CRUD (`List`, `Create`, `UpdateTitleDescription`, `Delete`, `MarkCompleted`, `UnmarkCompleted`).
- Web UI routes / pages (`/teams/$teamId/challenges`, captain form, member completion toggle).
- Discord slash commands for challenge management (`/challenge create`, `/challenge complete`, etc.).
- Read-side aggregation for "weekly digest mentions of challenges" (cross-feature integration).
- Locale plumbing from `team.onboarding_locale` through `UnprocessedWeeklyChallengeEvent`.
- A `/challenges` web route that the embed could deep-link to (Part 3 will add it; until then the bot omits `url` when `WEB_URL` is unset).
- Server query `LIMIT` clause and per-team / per-tick batch sizing.
