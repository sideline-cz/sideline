# Make Event Types Custom — Implementation Plan (rev 2)

Story: Notion `3e393506-0818-80bd-b034-c5ff5ea668ea` · Branch `feat/make-event-types-custom`

> "Make the training, tournament, social, … customizable. Allow setting colors."

Reviewed by architect → designer → hater → architect (rev 2). All 7 hater blockers resolved.

---

## 0. Core design decisions

| Decision | Choice | Why |
|---|---|---|
| `kind` vs `name` | `kind` is an immutable `Event.EventType` literal set at creation; drives **all** behaviour. `name`/`color`/`position` are presentation. | ~548 `event_type` call sites keep routing off the enum column. Zero behaviour change. |
| Who owns `events.event_type` | A **BEFORE INSERT/UPDATE trigger** on `events`, bidirectional. | 4+ independent writers: `EventsRepository.insert`/`update`, `api/event-series.ts` (hardcodes `eventType:'training'` at :162, :575), RPC `Event/CreateEvent`, raw test fixtures. Generated columns can't read another table. The reverse direction leaves series generation and every fixture untouched. |
| Kind→id resolution order | `(archived_at IS NOT NULL) ASC, created_at ASC, id ASC`. **`position` never appears in a resolution query.** | B1: `position` is mutated by a ▲ button. Ordering by it would make reordering the admin list silently re-target every future series occurrence. |
| Can `kind` change? | **No.** Not on the update endpoint. | Would re-bucket personal channels and re-scope ratings/workouts for every past event. `usageCount === 0` is not a sufficient guard (series, TOCTOU, orphaned `training_type_id`). |
| Delete policy | **Soft-delete via `archived_at`, always.** 409 `EventTypeLastRemaining` only when it is the team's last active type. | Hard delete + `ON DELETE SET NULL` fires the trigger, which silently re-points historical events onto a sibling type of the same kind. Archived-but-referenced types still render (the LEFT JOIN is unfiltered). |
| Default names | `name` **NULLABLE**; NULL = render the built-in translated label for `kind`. Seed rows are NULL. | `teams.onboarding_locale` defaults to `'en'`, so seeding literals would stamp English names on every pre-onboarding Czech club. The bot also renders per *user* locale. |
| Seeding new teams | `AFTER INSERT ON teams` trigger. | Covers onboarding, tests and every integration fixture without editing one. |
| Permission | Reuse **`team:manage`**. | Trade-off owned: **Captains will NOT see the Event types page**, unlike training-types/activity-types. Reversible with a 4-line grant migration. |
| Training-type hash colours | **Deleted** (`buildTrainingTypeColorMap`, `hashString`, `TRAINING_PALETTE`). | An unstable hash silently overriding a team's explicit choice is the bug you file next week. Net deletion ~60 lines + 3 memo sites. |
| Discord embed colours | **Change on deploy. Accepted.** | Today `training` is blue on the web (`event-colors.ts:63`) but green `0x57f287` in Discord (`buildUpcomingEventEmbed.ts:14`). They already disagree; one column cannot preserve both. |

---

## 1. Migration

One file. **Timestamp rule, not a number**: at *commit time* run `ls -1 packages/migrations/src/before/ | sort | tail -1`, pick strictly greater. Re-check after every rebase — the slot is claimed by merge order. Placeholder: `packages/migrations/src/before/1792400000_create_event_types.ts`.

### Step 1 — table

```sql
CREATE TABLE IF NOT EXISTS event_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- NULL = render the built-in translated label for `kind`. Set = team free text.
  name        TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('training','match','tournament','meeting','social','other')),
  color       TEXT NOT NULL CHECK (color IN ('blue','emerald','purple','amber','cyan','rose',
                                             'indigo','teal','red','orange','slate','pink','gray')),
  -- Presentation ONLY. Never read by a kind-to-id resolution query.
  position    INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_types_team_position
  ON event_types (team_id, position) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_types_team_kind_created
  ON event_types (team_id, kind, created_at);            -- the resolution path
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_types_team_name
  ON event_types (team_id, lower(name)) WHERE archived_at IS NULL AND name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_types_team_default_kind
  ON event_types (team_id, kind) WHERE name IS NULL AND archived_at IS NULL;
```

The `color` CHECK stays in lockstep with `EventTypeColor` — an unknown colour renders *no* Tailwind class, i.e. an invisible badge.

### Step 2 — seed existing teams (idempotent)

```sql
INSERT INTO event_types (team_id, name, kind, color, position)
SELECT t.id, NULL, v.kind, v.color, v.position
FROM teams t
CROSS JOIN (VALUES ('training','blue',0), ('match','red',1), ('tournament','orange',2),
                   ('meeting','slate',3), ('social','pink',4), ('other','gray',5))
     AS v(kind, color, position)
WHERE NOT EXISTS (SELECT 1 FROM event_types et WHERE et.team_id = t.id);
```

Colours reproduce `event-colors.ts:62-99` exactly — **the web sees no change on deploy**.

### Step 3 — seed trigger for future teams

`seed_default_event_types()` AFTER INSERT ON teams, inserting the same six rows.

### Step 4 — `events.event_type_id` + backfill

```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type_id UUID
  REFERENCES event_types(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_events_event_type_id ON events (event_type_id);

UPDATE events e SET event_type_id = et.id FROM event_types et
WHERE et.team_id = e.team_id AND et.kind = e.event_type AND e.event_type_id IS NULL;
```

Deliberately NULLABLE. `ON DELETE SET NULL` — never CASCADE (deletes events), never RESTRICT (blocks team-delete cascade).

### Step 5 — the ownership trigger (created AFTER the backfill)

```sql
CREATE OR REPLACE FUNCTION events_sync_event_type() RETURNS trigger AS $$
DECLARE v_kind TEXT; v_id UUID;
BEGIN
  -- A caller that changed only the legacy enum is asking for a re-resolve.
  IF TG_OP = 'UPDATE'
     AND NEW.event_type_id IS NOT DISTINCT FROM OLD.event_type_id
     AND NEW.event_type    IS DISTINCT FROM OLD.event_type THEN
    NEW.event_type_id := NULL;
  END IF;

  -- The team_id predicate is THE authorization boundary: a foreign or deleted id is
  -- discarded here, in the one place every writer passes through.
  IF NEW.event_type_id IS NOT NULL THEN
    SELECT et.kind INTO v_kind FROM event_types et
     WHERE et.id = NEW.event_type_id AND et.team_id = NEW.team_id;
    IF v_kind IS NOT NULL THEN NEW.event_type := v_kind;
    ELSE                       NEW.event_type_id := NULL;
    END IF;
  END IF;

  IF NEW.event_type_id IS NULL THEN
    -- CREATION order, never `position`.
    SELECT et.id INTO v_id FROM event_types et
     WHERE et.team_id = NEW.team_id AND et.kind = NEW.event_type
     ORDER BY (et.archived_at IS NOT NULL), et.created_at, et.id
     LIMIT 1;
    NEW.event_type_id := v_id;   -- may stay NULL; that is legal
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER events_sync_event_type_trg
  BEFORE INSERT OR UPDATE OF event_type, event_type_id, team_id ON events
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION events_sync_event_type();
```

Three load-bearing details:

- **Separate `v_kind`/`v_id` locals** — `SELECT … INTO NEW.event_type` with zero rows nulls the target and violates NOT NULL.
- **`pg_trigger_depth() = 0`** — a team delete would otherwise fan out to one trigger invocation per event, for rows about to be deleted. Also stops a hand-deleted type from silently re-pointing history.
- **`team_id` in `UPDATE OF` now earns its place** — on a team move the id lookup misses, the id is nulled, and the kind branch re-resolves in the new team.

### AGENTS.md ownership statement (verbatim)

> **`events.event_type` is trigger-owned.** App code may write it, but that write is a *request to resolve a type*, never the stored value — `events_sync_event_type()` overwrites it from `event_types.kind` whenever a valid same-team `event_type_id` is present. `events.event_type_id` is app-owned when it names a row of the event's own team, and trigger-derived otherwise. **`event_types.position` is presentation only and must never appear in a query that resolves a kind to an id.** Never read `event_types.name` to make a behavioural decision; route off `kind`.

---

## 2. Domain package

**New `packages/domain/src/models/EventType.ts`** — `EventTypeId` brand; `EventTypeKind` (the 6 literals); `EventTypeColor` (13 literals); `EventTypeName` (NonEmpty, max 50); `eventTypeColorHex: Record<EventTypeColor, number>` (Tailwind-500 hex, for Discord); `defaultColorForKind: Record<EventTypeKind, EventTypeColor>` (seed map **and** rolling-deploy fallback); `EventType` Model.Class. Field comments use `//`, never JSDoc (the barrel codegen hoists JSDoc onto the `export * as` line).

**`models/Event.ts` — 2 lines**: `export const EventType = EventTypeKind`. All ~548 call sites unchanged. Do *not* add `event_type_id` to `Event.Event` — the repository uses local `EventRow` classes.

**New `packages/domain/src/api/EventTypeApi.ts`** mirroring `TrainingTypeApi.ts`. Payloads are **`Schema.Struct`, never `Schema.Class`** (commit d72fa1be — a `Schema.Class` payload fails client-side encode with a generic toast and an *empty* Network tab). `UpdateEventTypeRequest` has **no** `kind`.

| Method | Path | Auth |
|---|---|---|
| GET | `/teams/:teamId/event-types` | membership |
| POST | `/teams/:teamId/event-types` → 201 | `team:manage` |
| PATCH | `/teams/:teamId/event-types/:eventTypeId` | `team:manage` |
| DELETE | `/teams/:teamId/event-types/:eventTypeId` → 204 (archives) | `team:manage` |
| POST | `/teams/:teamId/event-types/reorder` → 204 | `team:manage` |

GET is membership-only so the event pickers can load it without a `team:manage`-gated second call. Returns **active types only** — the archived-current-type case is handled client-side.

**`api/EventApi.ts`** — `EventInfo`/`EventDetail` gain three fields, **all `OptionFromOptionalKey` consistently**:

```ts
eventTypeId:    Schema.OptionFromOptionalKey(EventTypeId),
eventTypeName:  Schema.OptionFromOptionalKey(Schema.OptionFromNullOr(Schema.String)),
eventTypeColor: Schema.OptionFromOptionalKey(EventTypeColor),
```

A *missing* key on `OptionFromNullOr` is a decode **error**, not `none` — it would fail the whole event list against an old server. The inner `OptionFromNullOr` carries the real "seeded row, no name" signal; the web collapses the pair in one helper.

`CreateEventRequest.eventType` becomes optional, plus optional `eventTypeId`, with the existing struct-level `Schema.makeFilter` extended to require at least one. (Precedent for the filter: `EventApi.ts:203-211`, `:228-236`.)

**RPC** — new `EventTypeChoice`; new `GetEventTypesByGuild`; `CreateEvent` gains optional `event_type_id` but **keeps `event_type` required** (bot ships before server). The five render-feeding entries gain `event_type_name` and `event_type_color` wire-compatibly.

---

## 3. Server

**New `EventTypesRepository.ts`** copying `TrainingTypesRepository.ts`. `usageCount` via `LEFT JOIN (… GROUP BY)`, matching `ActivityTypesRepository.ts:72-88`. `reorder` uses `UPDATE … FROM unnest($2::uuid[]) WITH ORDINALITY` and **must scope by `team_id`** — that is the authorization boundary for a client-supplied id array.

**New `api/event-type.ts`** copying `api/training-type.ts`. `deleteEventType` checks `countActiveByTeamId <= 1` → 409 *before* archiving, else a team can archive everything and make event creation impossible. `reorder` rejects duplicate ids or a length ≠ active count. Handlers must construct `new EventTypeApi.EventTypeInfo({…})` explicitly — `scripts/check-rpc-encoding.mjs` fails otherwise, and returning a repo row type-checks fine then dies at encode.

**`EventsRepository.ts`** — insert/update gain `event_type_id`; add `LEFT JOIN event_types ety` selecting `name`/`color` to the **six render-feeding queries only**: `findByTeamId` (:139), `findByIdWithDetails` (:178), `findByChannelId` (~:517), `findUpcomingForDashboard` (~:657), `findUpcomingByGuild` (~:758), `findByUserId` (~:830).

Leave `findStartable`, `findLoggableTrainingsByGuild` (:798), `_findClaimInfo` and the claim UPDATE (:540) **completely alone** — kind-routed behaviour, not rendering.

**`api/event.ts`** — pass the fields through. An explicit team re-check is now **redundant, not load-bearing**: the trigger's `AND et.team_id = NEW.team_id` discards a foreign id. Keep handlers thin.

**`personalChannelBucket.ts` — NO CHANGE.** `eventBucketSql` reads `${alias}.event_type`, which the trigger keeps authoritative. `deprovisionableBucketSql` stays **one** fragment spliced into both `_getObsoleteBuckets` and `_getGuildsNeedingProvisioning` branch (e). Reviewers should reject any diff to this file in this PR.

**`api/event-series.ts` — NO CHANGE.** Lines 162/575 write kind-only; the trigger resolves. Biggest payoff of the bidirectional design.

---

## 4. Web

**`lib/event-colors.ts` rewrite (net deletion)** — delete `TRAINING_PALETTE`, `hashString`, `TrainingTypeColorMap`, `buildTrainingTypeColorMap`, `EVENT_TYPE_COLORS`. Add `EVENT_COLOR_SETS: Record<EventTypeColor, EventColorSet>` with all 13 class strings **literal** (Tailwind's scanner cannot see `bg-${color}-100`). New signature:

```ts
getEventColor(color: Option<EventTypeColor>, kind: Event.EventType): EventColorSet
```

Call sites dropping the `colorMap` memo/prop: `EventCalendarView.tsx:47,247,275,394`, `AssistantResultCard.tsx:55`, `AssistantResultList.tsx`, `CommandPalette.tsx:216`, `AssistantConversation.tsx:448`.

**`lib/event-labels.ts`** — keep `eventTypeLabels` (now kind labels *and* default names; used at 8 sites). Add one helper that also collapses the rolling-deploy double-Option:

```ts
eventTypeName(name: Option<Option<string>>, kind) =>
  Option.getOrElse(Option.flatten(name), () => eventTypeLabels[kind]())
```

**Colour picker — local swatch grid, not `ColorPicker.tsx`.** The existing `atoms/ColorPicker.tsx` renders free **hex** presets via `style={{ backgroundColor }}`, and `ColorDot.tsx` inline-styles a `string`. Neither can carry a dark-mode variant — our sets need `bg-blue-100 dark:bg-blue-900/30`, which only a class can express, and the story forbids free hex. Teaching them a second colour model costs more than the ~20 lines it saves. So: 13 `<button type="button">` inside `EventTypesPage.tsx` with `className={EVENT_COLOR_SETS[c].dot}`, `aria-pressed`, accessible name from `tr('eventType_color_<c>')`, and a live badge preview underneath.

**New page + route** — `components/pages/EventTypesPage.tsx` modelled on `ActivityTypesPage.tsx` (dialog form + list + delete confirm + `withFieldErrors` + `useRun`); `routes/(authenticated)/teams/$teamId/event-types.tsx` copying `activity-types.tsx` (**`ssr: false` mandatory**). Kind select is **create-only**, surfaced as the designer's "Behaves like" with a per-option description; the word "kind" never appears. Reorder is ▲/▼ (`@dnd-kit/sortable` is genuinely absent — only `core` + `utilities`), sending the full id list, with an `aria-live` announcement.

**Two nav entry points** (every management page has both; the earlier claim that training-types is sidebar-only was wrong):
- `components/layouts/AppSidebar.tsx:176-188` — `requiredPermission: 'team:manage'`
- `components/pages/TeamDetailPage.tsx:460-478` — `TeamManagementCard.sections` (not permission-gated, matching existing entries)

**Pickers** (`EventsListPage.tsx:412`, `EventDetailPage.tsx:540`) keep the shadcn `Select` — not `SearchableSelect`, which sorts alphabetically (`:46`) and would destroy `position`, and types `label: string` so no colour dot. The `watchedEventType === 'training'` gates (`EventsListPage.tsx:205,423`, `EventDetailPage.tsx:252,551`) become `selectedType?.kind === 'training'` — **still routed off kind**.

- **B3 — always send both fields.** Submit `{ eventTypeId, eventType: selectedType.kind }` on create *and* update. Strictly safer in every direction, and it demotes "kind-only" to a legacy path.
- **B4 — archived current type.** When `!eventTypes.some(t => t.eventTypeId === current)`, prepend a **disabled, still-selected** `SelectItem` built from the event's own `eventTypeId`/`Name`/`Color`. Without this a shadcn Select renders the placeholder and a title-only edit silently re-types the event. If an old server sends no `eventTypeId`, preselect the first active type **of the event's kind**, never the first type overall.

---

## 5. Bot

**The static-choices trap.** `commands/event/index.ts:27` declares six hardcoded `choices`. Discord registers choices **globally at deploy time, identical for every guild** — they cannot be per-team. Delete the array, set `autocomplete: true`, keep `required: true`. New `interactions/event-type-autocomplete.ts` cloning `event-create-autocomplete.ts`, including its `Effect.catchDefect(… Array.empty())` tail (an autocomplete must never fail the interaction).

**B7 — autocomplete values are NOT constrained.** Discord submits whatever the user typed. With the RPC down, today's `Option.getOrElse(() => 'other')` at `commands/event/create.ts:34` would silently create the event as `other`. **Delete that default**; validate `type` as `isValidUuid` OR `Schema.is(Event.EventType)`, else ephemeral error (`bot_event_unknown_type`), no modal.

**B6 — in-flight modals across the deploy.** A modal opened against the old bot carries `event-create:training:<uuid>`; the new bot would look up `'training'` as an id.

```ts
const selected = Schema.is(Event.EventType)(raw) ? { kind: raw }   // legacy modal
               : isValidUuid(raw)               ? { id: raw }      // current modal
               : null;                                             // → ephemeral error
```

`isValidUuid` already exists at `event-create.ts:46`.

**Other** — `custom_id` is `event-create:${eventTypeId}:${trainingTypeId}` = 13+36+1+36 = **86** chars; do not add `kind` (97, no margin; error 50035 rejects the whole message). `buildUpcomingEventEmbed.ts:13-22,149` drops its local colour table for `eventTypeColorHex`. **Add the `Type` inline embed field** — the `payload_hash` storm objection is moot because `buildPersonalEventMessage.ts:66-73` hashes `embeds` wholesale *including `color`*, so the colour change already invalidates every hash; and `markStalePersonalMessagesDirty` only marks no-longer-visible events, so there is no thundering herd.

`formatPersonalChannelName.ts` and `handleReconcile.ts` are bucket-driven — **no change**.

---

## 6. i18n

**Stays translated:** `event_type_training|match|…|other` — meaning widens to *kind label AND default name for an un-renamed seeded type*.

**Becomes user text:** `event_types.name`, rendered verbatim, never per-viewer. A Czech team renaming "Training" to "Trénink" shows "Trénink" to an English viewer — that is the feature, and the settings copy must say so.

**Removed:** the six `name_localizations` in `commands/event/index.ts:27-34`, which vanish with `choices`.

~28 new keys (en + cs; web = vykání, bot = tykání) including 13 `eventType_color_*` for swatch accessible names, `bot_embed_type` and `bot_event_unknown_type`. Run `pnpm codegen`.

---

## 7. Test specification (TDD — written first, all failing)

### A. Migration integration (15 cases)
Seeding per team · id→kind · legacy kind→id · kind-only update re-resolves · id update drives kind · **A7 rename does not move the bucket** (asserted through `eventBucketSql`, because asserting `events.event_type` alone passes even with the trigger deleted) · **A7b reorder does not re-target resolution** (the B1 regression) · **A8 foreign id discarded, asserted through the RPC path too, not only HTTP** (the B2 regression) · case-insensitive name uniqueness · archived name reuse · colour CHECK · archived-row resolution · backfill · team delete does not storm · **A15 the three literal lists agree** (parse `pg_get_constraintdef` for `events_event_type_check` and the new `event_types.kind` CHECK; assert both equal `Event.EventType.literals`).

### B. Bucket regression (5 cases)
Custom `kind='match'` named "Beach party" → bucket `tournament` · `kind='training'` → `training` · meeting/social/other → `other` · rename changes no bucket · **`deprovisionableBucketSql` and `_getGuildsNeedingProvisioning` branch (e) must still agree** — the tripwire for anyone who edits that file "while they're in there".

### C. Server API (13 cases)
403s · 201 position=max+1 · 409 duplicate name · 400 validation · `kind` ignored on update · 404 cross-team · archive-not-delete · 409 last-remaining · reorder rejects duplicate/short/foreign ids. Transient `position` collisions from a concurrent create are **explicitly tolerated** (ordering stays deterministic via the `created_at` tiebreak) rather than asserted vacuously.

### D. Event create/update (7 cases)
id-only · kind-only (legacy web) · neither → 400 · both agreeing · both disagreeing → id wins · update follows new kind · **D7 title-only update leaves both fields unchanged** (the B4 silent-retype guard).

### E. Domain (6 cases)
Hex map ↔ colour literals total both ways · `defaultColorForKind` total · `Event.EventType.literals` unchanged · request decode validation · **E5 decode of a payload missing all three new keys → `none` for all three** (only testable because all three are `OptionFromOptionalKey`) · `eventTypeName: null` → seeded-row rendering.

### F. Web
`EventTypesPage` render/disabled-kind/disabled-▲/usageCount · `event-colors` totality + `dark:` variants in all four class strings · **new `EventTypePicker.test.tsx`** for B3/B4: archived type renders disabled-but-selected; title-only edit sends the unchanged id; no `eventTypeId` preselects the first active type *of the event's kind* · update 3 tests for the removed `colorMap` prop.

### G. Bot
New autocomplete test (fallback label, RPC failure → `{choices: []}` never a throw) · **new `event-create-legacy-modal.test.ts`** for B6 (legacy kind / current id / garbage → ephemeral, no `CreateEvent` call) · B7 non-UUID type → ephemeral, **no modal** · `custom_id` length ≤ 100 · embed colour from wire, `''` → `eventTypeColorHex.blue` (**deliberately not the old `0x57f287`**) · the new `Type` field renders name or kind label.

---

## 8. Task breakdown

| # | Task | Package |
|---|---|---|
| 1 | Migration + tests A & B | `packages/migrations` + server integration |
| 2 | `EventType.ts`, `Event.ts` re-export, `EventTypeApi`, `EventApi` fields, RPC + test E | `packages/domain` |
| 3 | Repository, `api/event-type.ts`, registrations, `EventsRepository` joins, `api/event.ts`, RPC handlers + tests C & D | `applications/server` |
| 4 | New keys en/cs | `packages/i18n` |
| 5 | `event-colors.ts`, `EventTypesPage` + route + **both** nav entries, pickers (B3/B4) + tests F | `applications/web` |
| 6 | Autocomplete, modal submit (B6/B7), embed colour + `Type` field + tests G | `applications/bot` |
| 7 | `AGENTS.md` × 3 | docs |

Between 2 and 3: `pnpm build:packages` (apps type-check against `packages/domain/dist`, not `src`). Between 2 and 5: `pnpm codegen`. Task 1's tests need `pnpm build` first — **integration tests import compiled migrations**, so rebuild after every migration edit or you are testing the old SQL. If `dist` looks stale, delete `packages/migrations/dist` **and** `.tsbuildinfo`.

---

## 9. Risks & accepted trade-offs

**Risks** — migration id collision (pick the slot at commit time; re-check after every rebase) · rolling deploy is bot → server → web and not symmetric · trigger arity (`DROP FUNCTION IF EXISTS` before `CREATE OR REPLACE` if args change) · free text reaching a behaviour decision · `position` leaking into a resolution query · Tailwind purging interpolated classes · the `personalChannelBucket.ts` temptation · stale domain `dist` · global command re-registration delay.

**Accepted — decisions, not bugs**
- **Discord embed colours change on deploy** (`training` green → blue). Unavoidable once one column drives both surfaces.
- **Series occurrences bind to the oldest `training` type** — no `event_series.event_type_id`; per-series types are a follow-up.
- **A renamed seeded row can never return to NULL** (no "reset to default").
- **Captains cannot reach the Event types page** — reversible with a 4-line grant migration.
- **A team can create a type literally named "Training"** beside the seeded NULL row; the partial unique index cannot see it. Cosmetic.
- **`reorder` tolerates transient `position` collisions.**

**Open questions** — seeded-name locale (chosen: nullable + fallback) · un-archive UI (~30 lines when asked) · wiring `eventTypeColor` into `DashboardApi` (one extra DTO field).
